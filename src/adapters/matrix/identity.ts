import {bytesHasher} from '../hash/content';
import {ed25519Verifier,signEd25519} from '../crypto/session-keys';
import type {KeyPair} from '../crypto/session-keys';
import {identityBytes} from '../../world/permissions';
import type {IdentityProof,IdentityProvider,Principal,Proof,SessionBindingRequest,SignatureVerifier} from '../../world/permissions';
import {failed,ok} from '../../world/model';
import type {JsonValue,WorldResult} from '../../world/model';
import type {WorldCodec} from '../../world/ports';
import {errorText,isPlainObject} from '../../core/guards';

// Matrix as an identity adapter (docs/superpowers/plans/2026-09-29-federated-world.md task 11, docs/kernel.md delta:
// `matrix:…` is the actor URI). This is the only place a Matrix account is spoken to, and it exists to answer one
// question: who is this peer? The answer is an actor URI — `matrix:@user:server` is a valid protocol identifier (§4)
// — and nothing else in this project has to know how a Matrix account is written down.
//
// Matrix has no client signature: an event exists because a homeserver accepted it, and the homeserver is the one
// saying `sender`. So the chain has three links, and only two of them are cryptography:
//
//   @user:server  --(a room event the homeserver attributes to that account)-->  device root (Ed25519)
//                 --(Ed25519 delegation)-->  session key (Ed25519)
//
// The middle step is a `MatrixBinding`: an ordinary event of this project's own type, written into a room both sides
// can read. Its content is the device key and the account. The last step is the `IdentityProof` task 6 already
// verifies. Two consequences a caller has to know about are explicit and load-bearing:
//
//   * `matrixVerifier(binding)` alone proves that *some* device root delegated a session key and that the document
//     names this account. It does **not** prove the account exists: that is `confirmBinding`, which reads the event
//     back and believes the homeserver about who wrote it. A host that grants authority to a `matrix:` principal has
//     to confirm the binding in the room first.
//   * A room role — a power level — is not an identity and not a permission. Nothing here reads power levels to
//     decide anything; what this account may do in the world is a `Grant` evaluated by `authorize` (task 6).
//
// Registration uses the shared-secret endpoint Synapse exposes (`/_synapse/admin/v1/register`), which is how a test
// homeserver with registration closed still accepts a named account. A caller that already holds a token uses
// `loginAccount` or builds the account itself; `verifyAccount` is what says whether a token speaks for the user id it
// claims.
export type MatrixAccount = {homeserver: string; userId: string; accessToken: string; deviceId?: string};
// The smallest slice of `Response` this adapter uses, so a test can run a whole homeserver in process and a runtime
// can replace `fetch` without touching this file.
export type MatrixResponse = {status: number; text(): Promise<string>};
export type MatrixFetch = (url: string, init: {method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal}) => Promise<MatrixResponse>;
export const platformFetch: MatrixFetch = (url, init) => fetch(url, init);
export type MatrixRequest = {method?: 'GET' | 'POST' | 'PUT'; path: string; query?: Record<string, string>; body?: JsonValue; token?: string | null; timeoutMs?: number};
export type MatrixClient = (request: MatrixRequest) => Promise<WorldResult<JsonValue>>;
export type MatrixHttpOptions = {fetch?: MatrixFetch; timeoutMs?: number};

export const IDENTITY_EVENT_TYPE = 'org.opensim.identity.v0';
const USER_ID = /^@[a-z0-9._=/+-]{1,200}:[a-z0-9.-]+(?::\d+)?$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, HEX = /^[0-9a-f]{64}$/, ROOM_ID = /^![^\s:]{1,200}:[^\s/]{1,200}$/, EVENT_ID = /^\$[^\s]{1,200}$/;
// A response is somebody else's bytes: the ceiling stops a homeserver from making this client allocate a gigabyte of
// text before it decides whether the answer was even JSON.
const RESPONSE_CEILING = 8 * 1024 * 1024;

// The homeserver's own answer, mapped to the codes this project already speaks. `errcode`/`error` is the Matrix
// specification's shape and is carried into the message verbatim: a caller deciding whether to retry needs the
// service's words, not this adapter's guess at them.
function failureOf(status: number, raw: string): WorldResult<never> {
 let detail = '';
 try {
  const body = JSON.parse(raw) as unknown;
  if (isPlainObject(body) && typeof body['error'] === 'string') detail = body['error'];
 } catch {
  detail = raw.slice(0, 200);
 }
 const message = `Homeserver respondeu ${status}${detail ? `: ${detail}` : ''}`;
 if (status === 401 || status === 403) return failed('PERMISSION', message);
 if (status === 404) return failed('NOT_FOUND', message);
 // 413 is the homeserver's own ceiling (M_TOO_LARGE): it is a limit, not a malformed object, and a caller that
 // narrows what it sends is the one who can answer it.
 if (status === 413 || status === 429) return failed('LIMIT', message);
 if (status >= 500 || status === 0) return failed('NOT_FOUND', message);
 return failed('MALFORMED', message);
}
// A Matrix transaction id is what makes a retry idempotent: the homeserver answers a repeated id from its cache
// instead of writing twice. It must therefore be stable for the same logical request and different for another, so
// it is a digest of what the request is about rather than a counter or a sanitized identifier.
export async function txnIdFor(label: string): Promise<string> {
 return `osim-${(await bytesHasher().ref(new TextEncoder().encode(label))).hash.slice(0, 32)}`;
}

// --- the client-server API --------------------------------------------------------------------------------------
export function matrixClient(homeserver: string, options: MatrixHttpOptions = {}): MatrixClient {
 const base = homeserver.trim().replace(/\/+$/, '');
 if (!/^https?:\/\/[^\s]+$/i.test(base)) throw new Error(`Homeserver precisa de um endereço http(s): ${homeserver}`);
 const send = options.fetch ?? platformFetch, defaultTimeout = options.timeoutMs ?? 10000;
 return async request => {
  const query = request.query && Object.keys(request.query).length ? `?${new URLSearchParams(request.query).toString()}` : '';
  const headers: Record<string, string> = {}, body = request.body === undefined ? undefined : JSON.stringify(request.body);
  if (request.token) headers['Authorization'] = `Bearer ${request.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? defaultTimeout);
  let answer: MatrixResponse;
  try {
   answer = await send(`${base}${request.path}${query}`, body === undefined ? {method: request.method ?? 'GET', headers, signal: controller.signal} : {method: request.method ?? 'GET', headers, body, signal: controller.signal});
  } catch (error) {
   return failed('NOT_FOUND', `Homeserver ${base} inacessível: ${errorText(error)}`);
  } finally {
   clearTimeout(timer);
  }
  let raw: string;
  try {
   raw = await answer.text();
  } catch (error) {
   return failed('NOT_FOUND', `Resposta do homeserver ${base} ilegível: ${errorText(error)}`);
  }
  if (raw.length > RESPONSE_CEILING) return failed('LIMIT', `Resposta de ${raw.length} bytes acima do teto de ${RESPONSE_CEILING}`);
  if (answer.status < 200 || answer.status >= 300) return failureOf(answer.status, raw);
  if (!raw.length) return ok(null);
  try {
   return ok(JSON.parse(raw) as JsonValue);
  } catch {
   return failed('MALFORMED', `Resposta do homeserver ${base} não é JSON (${answer.status})`);
  }
 };
}
// A user id is the account's name on a homeserver, and the server name after the colon is what identifies that
// homeserver in a federation: the base URL is where this client happens to reach it.
export function userIdOf(userId: string): WorldResult<string> {
 if (!USER_ID.test(userId)) return failed('MALFORMED', `Identificador Matrix inválido: ${userId}`);
 return ok(userId);
}
export function matrixUriOf(userId: string): string {
 return `matrix:${userId}`;
}
export function matrixPrincipalOf(userId: string): WorldResult<Principal> {
 const checked = userIdOf(userId);
 return checked.ok ? ok({scheme: 'matrix', id: matrixUriOf(checked.value)}) : checked;
}
export function userIdOfPrincipal(principal: Principal): WorldResult<string> {
 if (principal.scheme !== 'matrix') return failed('MALFORMED', `Principal não é Matrix: ${principal.scheme}`);
 return userIdOf(principal.id.startsWith('matrix:') ? principal.id.slice('matrix:'.length) : principal.id);
}
const serverNameOf = (userId: string): string => userId.slice(userId.indexOf(':') + 1);

function accountOf(value: JsonValue, homeserver: string): WorldResult<MatrixAccount> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Resposta de registro sem conta');
 const userId = value['user_id'], accessToken = value['access_token'], deviceId = value['device_id'];
 if (typeof userId !== 'string' || !userIdOf(userId).ok) return failed('MALFORMED', `Resposta de registro com user_id inválido: ${String(userId)}`);
 if (typeof accessToken !== 'string' || !accessToken.length) return failed('MALFORMED', 'Resposta de registro sem token de acesso');
 return ok({homeserver: homeserver.trim().replace(/\/+$/, ''), userId, accessToken, ...(typeof deviceId === 'string' && deviceId.length ? {deviceId} : {})});
}
async function hmacSha1(secret: string, message: string): Promise<string> {
 const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-1'}, false, ['sign']);
 const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
 return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// The shared-secret registration: Synapse hands out a nonce, the caller proves it holds the registration secret over
// `nonce\0user\0pass\0admin`, and the account comes back with a token. Registration being closed for the public does
// not matter: this is the administrator's door, which is exactly what a lab homeserver and a self-hosted one offer.
export async function registerAccount(input: {homeserver: string; secret: string; username: string; password: string; admin?: boolean} & MatrixHttpOptions): Promise<WorldResult<MatrixAccount>> {
 const client = matrixClient(input.homeserver, input);
 const nonce = await client({path: '/_synapse/admin/v1/register'});
 if (!nonce.ok) return nonce;
 if (!isPlainObject(nonce.value) || typeof nonce.value['nonce'] !== 'string' || !nonce.value['nonce'].length) return failed('MALFORMED', 'Homeserver não devolveu o nonce do registro');
 const mac = await hmacSha1(input.secret, [nonce.value['nonce'], input.username, input.password, input.admin ? 'admin' : 'notadmin'].join('\u0000'));
 const registered = await client({method: 'POST', path: '/_synapse/admin/v1/register', body: {nonce: nonce.value['nonce'], username: input.username, password: input.password, admin: !!input.admin, mac}});
 if (!registered.ok) return registered;
 return accountOf(registered.value, input.homeserver);
}
export async function loginAccount(input: {homeserver: string; user: string; password: string; deviceDisplayName?: string} & MatrixHttpOptions): Promise<WorldResult<MatrixAccount>> {
 const client = matrixClient(input.homeserver, input);
 const logged = await client({method: 'POST', path: '/_matrix/client/v3/login', body: {type: 'm.login.password', identifier: {type: 'm.id.user', user: input.user}, password: input.password, ...(input.deviceDisplayName === undefined ? {} : {initial_device_display_name: input.deviceDisplayName})}});
 if (!logged.ok) return logged;
 return accountOf(logged.value, input.homeserver);
}
// The token decides who the account is: a caller that believes a user id without asking is a caller that can be
// handed somebody else's account.
export async function verifyAccount(account: MatrixAccount, options: MatrixHttpOptions = {}): Promise<WorldResult<MatrixAccount>> {
 const client = matrixClient(account.homeserver, options);
 const answer = await client({path: '/_matrix/client/v3/account/whoami', token: account.accessToken});
 if (!answer.ok) return answer;
 if (!isPlainObject(answer.value) || typeof answer.value['user_id'] !== 'string') return failed('MALFORMED', 'Resposta de whoami sem conta');
 if (answer.value['user_id'] !== account.userId) return failed('SIGNATURE', `O token é da conta ${answer.value['user_id']}, não de ${account.userId}`);
 const deviceId = answer.value['device_id'];
 return ok({...account, ...(typeof deviceId === 'string' && deviceId.length ? {deviceId} : {})});
}

// --- sending an event -------------------------------------------------------------------------------------------
// One place knows how to write into a room, so the binding, the invitation and the object transport all agree on the
// path, the transaction id and what a refusal looks like.
export async function sendRoomEvent(account: MatrixAccount, input: {roomId: string; type: string; content: JsonValue; txnId: string}, options: MatrixHttpOptions = {}): Promise<WorldResult<string>> {
 if (!ROOM_ID.test(input.roomId)) return failed('MALFORMED', `Sala inválida: ${input.roomId}`);
 if (!input.type.length || /[^A-Za-z0-9._-]/.test(input.type)) return failed('MALFORMED', `Tipo de evento inválido: ${input.type}`);
 const client = matrixClient(account.homeserver, options);
 const path = `/_matrix/client/v3/rooms/${encodeURIComponent(input.roomId)}/send/${encodeURIComponent(input.type)}/${encodeURIComponent(input.txnId)}`;
 const answer = await client({method: 'PUT', path, body: input.content, token: account.accessToken});
 if (!answer.ok) return answer;
 if (!isPlainObject(answer.value) || typeof answer.value['event_id'] !== 'string' || !EVENT_ID.test(answer.value['event_id'])) return failed('MALFORMED', 'Homeserver aceitou o evento sem devolver o seu identificador');
 return ok(answer.value['event_id']);
}

// --- the device binding: what a Matrix account authorizes on this device ---------------------------------------
export type MatrixBinding = {
 kind: 'matrix-binding';
 version: 1;
 userId: string;
 serverName: string;
 homeserver: string;
 deviceKey: string;
 issuedAt: string;
 // The room event the homeserver attributed to this account: the anchor `confirmBinding` reads back. The document
 // alone proves nothing about the account, and this is where that boundary is written down.
 attestation: {roomId: string; eventId: string};
};
export const bindingBody = (binding: MatrixBinding): JsonValue => ({
 kind: binding.kind, version: binding.version, userId: binding.userId, serverName: binding.serverName,
 homeserver: binding.homeserver, deviceKey: binding.deviceKey, issuedAt: binding.issuedAt,
});
// Pure validation, no network: the document has to be internally consistent — the account and its server name, a
// device key of the right shape, an instant, and an attestation that names a room and an event. Whether that account
// exists is the room's answer, not this function's.
export function verifyMatrixBinding(binding: MatrixBinding): WorldResult<MatrixBinding> {
 if (binding.kind !== 'matrix-binding' || binding.version !== 1) return failed('MALFORMED', 'Vínculo Matrix de versão desconhecida');
 if (!userIdOf(binding.userId).ok) return failed('MALFORMED', `Vínculo Matrix com conta inválida: ${binding.userId}`);
 if (binding.serverName !== serverNameOf(binding.userId)) return failed('MALFORMED', `Vínculo Matrix diz ser de ${binding.serverName} e a conta é de ${serverNameOf(binding.userId)}`);
 if (!/^https?:\/\/[^\s]+$/i.test(binding.homeserver)) return failed('MALFORMED', `Vínculo Matrix sem endereço de homeserver: ${binding.homeserver}`);
 if (!HEX.test(binding.deviceKey)) return failed('MALFORMED', 'Vínculo Matrix com chave de dispositivo inválida');
 if (!INSTANT.test(binding.issuedAt)) return failed('MALFORMED', 'Vínculo Matrix sem instante válido');
 if (!ROOM_ID.test(binding.attestation.roomId)) return failed('MALFORMED', `Vínculo Matrix sem sala de atestação: ${binding.attestation.roomId}`);
 if (!EVENT_ID.test(binding.attestation.eventId)) return failed('MALFORMED', `Vínculo Matrix sem evento de atestação: ${binding.attestation.eventId}`);
 return ok(binding);
}
export async function bindMatrixDevice(input: {account: MatrixAccount; device: KeyPair; roomId: string; now: () => string} & MatrixHttpOptions): Promise<WorldResult<MatrixBinding>> {
 const {account, device, roomId, now} = input;
 const accountId = userIdOf(account.userId);
 if (!accountId.ok) return accountId;
 if (!HEX.test(device.publicKey)) return failed('MALFORMED', 'Chave do dispositivo inválida');
 const issuedAt = now();
 if (!INSTANT.test(issuedAt)) return failed('MALFORMED', `Relógio do vínculo inválido: ${issuedAt}`);
 const binding: MatrixBinding = {
  kind: 'matrix-binding', version: 1, userId: account.userId, serverName: serverNameOf(account.userId),
  homeserver: account.homeserver, deviceKey: device.publicKey, issuedAt, attestation: {roomId, eventId: ''},
 };
 const written = await sendRoomEvent(account, {roomId, type: IDENTITY_EVENT_TYPE, content: bindingBody(binding), txnId: await txnIdFor(`${IDENTITY_EVENT_TYPE}\u0000${account.userId}\u0000${device.publicKey}`)}, input);
 if (!written.ok) return written;
 return verifyMatrixBinding({...binding, attestation: {roomId, eventId: written.value}});
}
// The anchor: the room event exists, the homeserver says this account wrote it, and what it wrote is exactly this
// document. This is the step a host performs before it believes a `matrix:` principal, and the step that makes the
// binding mean "this account" instead of "somebody who can write JSON".
export async function confirmBinding(account: MatrixAccount, binding: MatrixBinding, options: MatrixHttpOptions = {}): Promise<WorldResult<MatrixBinding>> {
 const checked = verifyMatrixBinding(binding);
 if (!checked.ok) return checked;
 const client = matrixClient(account.homeserver, options);
 const path = `/_matrix/client/v3/rooms/${encodeURIComponent(binding.attestation.roomId)}/event/${encodeURIComponent(binding.attestation.eventId)}`;
 const answer = await client({path, token: account.accessToken});
 if (!answer.ok) return answer;
 if (!isPlainObject(answer.value)) return failed('MALFORMED', 'Evento de atestação inválido');
 const event = answer.value;
 if (event['type'] !== IDENTITY_EVENT_TYPE) return failed('SIGNATURE', `O evento de atestação é do tipo ${String(event['type'])}`);
 if (event['sender'] !== binding.userId) return failed('SIGNATURE', `O evento de atestação foi escrito por ${String(event['sender'])}, não por ${binding.userId}`);
 if (!isPlainObject(event['content'])) return failed('MALFORMED', 'Evento de atestação sem conteúdo');
 const expected = bindingBody(binding) as Record<string, JsonValue>;
 for (const field of ['kind', 'version', 'userId', 'serverName', 'homeserver', 'deviceKey', 'issuedAt']) {
  if (event['content'][field] !== expected[field]) return failed('SIGNATURE', `O evento de atestação diz outra coisa em ${field}`);
 }
 return ok(binding);
}

// --- the identity provider: a device root delegating the short session key ------------------------------------
export function matrixIdentityProvider(input: {binding: MatrixBinding; device: KeyPair; session: KeyPair; codec: WorldCodec}): IdentityProvider {
 const {binding, device, session, codec} = input;
 return {
  bindSession: async (request: SessionBindingRequest): Promise<WorldResult<IdentityProof>> => {
   const verified = verifyMatrixBinding(binding);
   if (!verified.ok) return verified;
   const userId = userIdOfPrincipal(request.principal);
   if (!userId.ok) return userId;
   // The identity a caller asks for is never the identity it gets: the binding decides, and a request that names
   // another account is a forgery attempt rather than a binding error.
   if (userId.value !== binding.userId) return failed('SIGNATURE', 'A identidade pedida não é a conta que autenticou o vínculo');
   const scope = request.scope;
   if (!scope.worldId || !scope.branchId || !scope.sessionId) return failed('MALFORMED', 'Vínculo de sessão sem mundo, ramificação ou sessão');
   if (!INSTANT.test(scope.notBefore) || !INSTANT.test(scope.notAfter)) return failed('MALFORMED', 'Vínculo de sessão fora do formato de instante');
   if (scope.notAfter <= scope.notBefore) return failed('MALFORMED', 'Vínculo de sessão com validade vazia');
   const unsigned: IdentityProof = {kind: 'identity', principal: request.principal, sessionKey: session.publicKey, scope, delegation: {algorithm: 'Ed25519', key: device.publicKey, value: ''}};
   return ok({...unsigned, delegation: {algorithm: 'Ed25519', key: device.publicKey, value: await signEd25519(device, identityBytes(unsigned, codec))}});
  },
 };
}
// The verifier a host uses for a `matrix:` principal, once the binding has been confirmed in the room. `base` is the
// Ed25519 half; the Matrix half is the document, and it is the only thing that makes the principal mean an account.
export function matrixVerifier(binding: MatrixBinding, base: SignatureVerifier = ed25519Verifier()): SignatureVerifier {
 return {
  verify: async (proof: Proof, bytes: Uint8Array): Promise<boolean> => {
   if (proof.kind === 'identity') {
    if (!verifyMatrixBinding(binding).ok) return false;
    if (proof.principal.scheme !== 'matrix' || proof.principal.id !== matrixUriOf(binding.userId)) return false;
    if (proof.delegation.key !== binding.deviceKey) return false;
   }
   return base.verify(proof, bytes);
  },
 };
}
export type MatrixIdentity = {
 principal: Principal;
 account: MatrixAccount;
 binding: MatrixBinding;
 device: KeyPair;
 session: KeyPair;
 provider(codec: WorldCodec): IdentityProvider;
 verifier(base?: SignatureVerifier): SignatureVerifier;
};
export async function createMatrixIdentity(input: {account: MatrixAccount; device: KeyPair; session: KeyPair; codec: WorldCodec; now: () => string; roomId: string} & MatrixHttpOptions): Promise<WorldResult<MatrixIdentity>> {
 const {account, device, session, roomId, now} = input;
 // The account authenticates before anything binds to it: a token that does not speak for its user id is not an
 // identity this client may write into a room.
 const verified = await verifyAccount(account, input);
 if (!verified.ok) return verified;
 const bound = await bindMatrixDevice({account: verified.value, device, roomId, now, fetch: input.fetch, timeoutMs: input.timeoutMs});
 if (!bound.ok) return bound;
 const binding = bound.value, principal = matrixPrincipalOf(binding.userId);
 if (!principal.ok) return principal;
 return ok({
  principal: principal.value,
  account: verified.value,
  binding,
  device,
  session,
  provider: (codec: WorldCodec) => matrixIdentityProvider({binding, device, session, codec}),
  verifier: (base?: SignatureVerifier) => matrixVerifier(binding, base),
 });
}
