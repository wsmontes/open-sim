import {bytesHasher} from '../hash/content';
import {signEd25519} from '../crypto/session-keys';
import {DEFAULT_LIMITS,parseStrictJson} from '../../world/codec';
import {checkEnvelope} from '../../world/osim';
import type {OsimEnvelope} from '../../world/osim';
import {identityBytes} from '../../world/permissions';
import type {ActionCapability,Grant,IdentityProof,MessageProof,Principal,SignatureVerifier} from '../../world/permissions';
import {MAX_DEPTH,failed,isRef,ok} from '../../world/model';
import type {Head,JsonValue,WorldErrorCode,WorldResult} from '../../world/model';
import {NETWORK_LIMITS,narrowerLimits} from '../../world/wire';
import type {Limits} from '../../world/wire';
import type {ContentHasher,WorldCodec} from '../../world/ports';
import type {KernelFilter,KernelTransport} from '../../world/kernel';
import {matrixClient,sendRoomEvent,txnIdFor,userIdOf,userIdOfPrincipal,verifyMatrixBinding} from './identity';
import type {MatrixAccount,MatrixBinding,MatrixClient,MatrixFetch,MatrixHttpOptions,MatrixIdentity,MatrixRequest} from './identity';
import {isPlainObject} from '../../core/guards';
import {instantOf,stringOf,uriOf} from '../../world/readers';

// Matrix rooms as the community a world travels through (task 11 of docs/superpowers/plans/2026-09-29-federated-world
// .md; docs/OpenSim-Protocol-0.1.txt §30). A private room is the community: membership is an invitation, the
// homeserver attests who wrote what, and this adapter carries objects and decides nothing about authority, economies
// or geography. It is one of several transports a client may hold at once, and none of them is required for the world
// to exist.
//
// Four policies live here because a room is somebody else's infrastructure and a homeserver is a third party:
//
//   * Namespace. Only an event type this project controls is written (`org.opensim.*`) and only that type is read as
//     an object. A room is also full of membership, names and chat, and none of it is a world object; configuring
//     another application's type is refused before a request is made.
//   * Vouching. A room event says `sender`, and the homeserver is the one saying it. An object whose actor is that
//     account's `matrix:` URI is the account's word; an object that claims another account, or a `nostr:` actor, is
//     dropped — this adapter relays nothing between communities, and a chat message is never an object.
//   * Encryption. A Matrix event the client cannot open is reported, never silently treated as an object: without a
//     decryption port an `m.room.encrypted` event is a refusal that names it. A room that declares itself encrypted
//     refuses plaintext publishing, because writing a world in the clear into a room its members believe is
//     encrypted is a privacy failure, not a convenience.
//   * Ceilings. `limits` is narrowed with NETWORK_LIMITS and never raised: an object larger than `maxDurableBytes`
//     (and the homeserver's own per-event ceiling) is refused before it is sent, and an incoming content longer than
//     that ceiling is dropped instead of parsed.
//
// Known boundary: a room binding carries the account, the room, the session and the proof of approval, and nothing
// about it enters `GameState` or the economy. What a member may do in the world is a `Grant` evaluated by `authorize`
// (task 6): a room power level is a room role, and this file never reads one to decide anything about the game.
export const WORLD_EVENT_TYPE = 'org.opensim.world.v0';
export const CAPABILITY_EVENT_TYPE = 'org.opensim.capability.v0';
export const OBJECT_NAMESPACE = 'org.opensim.';
export const ENCRYPTED_EVENT_TYPE = 'm.room.encrypted';
// A homeserver bounds the *event*, not its content: Synapse refuses an event over 64 KiB with 413 M_TOO_LARGE, and the
// event carries ids, a sender, a type and a transaction around the object. The ceiling here is deliberately below that
// limit so a publish never becomes a 413 after the bytes have left the client — measured against the real homeserver,
// an object of 60 KiB still travels and one of 64 KiB does not.
export const MATRIX_EVENT_CEILING = 60 * 1024;
const SESSION_PREFIX = 'osim:session:', INVITE_PREFIX = 'osim:capability:invite-', TIMELINE_PREFIX = 'osim:timeline:';
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, ROOM_ID = /^![^\s:]{1,200}:[^\s/]{1,200}$/;
const CAPABILITY: Record<string, ActionCapability> = {admin: 'admin', host: 'host', build: 'build', demolish: 'demolish', tick: 'tick', component: 'component'};
const TRANSPORTS = ['matrix', 'nostr', 'webrtc', 'manual'] as const;
// A room can be large and hostile; the refusals a caller can read are a bounded window, not a log.
const REFUSAL_WINDOW = 64;
const hasher = bytesHasher();

function samePrincipal(left: Principal, right: Principal): boolean {
 return left.scheme === right.scheme && left.id === right.id;
}
function actionsOf(value: unknown): WorldResult<ActionCapability[]> {
 if (!Array.isArray(value) || !value.length) return failed('MALFORMED', 'Convite sem ações propostas');
 const actions: ActionCapability[] = [];
 for (const entry of value) {
  const action = typeof entry === 'string' ? CAPABILITY[entry] : undefined;
  if (!action) return failed('MALFORMED', `Ação desconhecida no convite: ${String(entry)}`);
  if (!actions.includes(action)) actions.push(action);
 }
 return ok(actions);
}
function headOf(value: unknown, worldId: string, branchId: string): WorldResult<Head> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Cabeça de mundo inválida');
 if (value['worldId'] !== worldId || value['branchId'] !== branchId) return failed('MALFORMED', 'Cabeça de outro mundo ou ramificação');
 const commit = value['commit'], generation = value['generation'];
 if (!isRef(commit)) return failed('MALFORMED', 'Cabeça sem referência de commit');
 if (!Number.isSafeInteger(generation) || (generation as number) < 0) return failed('MALFORMED', 'Cabeça sem geração');
 return ok({worldId, branchId, commit, generation: generation as number});
}

// --- reading the room ------------------------------------------------------------------------------------------
export type RoomEvent = {event_id: string; type: string; sender: string; room_id: string; origin_server_ts: number; content: JsonValue; state_key?: string};
// A timeline event of `/sync` does not repeat the room it belongs to — the room is the key it sits under — while an
// event of `/messages` carries it. The caller knows which room it asked for, so that is the fallback; an event that
// names another room keeps its own answer, which is what lets a misrouted read be recognised instead of believed.
export function roomEventOf(value: unknown, roomId?: string): RoomEvent | null {
 if (!isPlainObject(value)) return null;
 const {event_id, type, sender, room_id, origin_server_ts, content, state_key} = value;
 if (typeof event_id !== 'string' || typeof type !== 'string' || typeof sender !== 'string') return null;
 if (typeof room_id !== 'string' && roomId === undefined) return null;
 if (typeof origin_server_ts !== 'number' || !Number.isFinite(origin_server_ts)) return null;
 if (content === undefined) return null;
 return {event_id, type, sender, room_id: typeof room_id === 'string' ? room_id : roomId!, origin_server_ts, content: content as JsonValue, ...(typeof state_key === 'string' ? {state_key} : {})};
}
async function stateOf(client: MatrixClient, account: MatrixAccount, roomId: string, type: string): Promise<WorldResult<Record<string, JsonValue> | null>> {
 const answer = await client({path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}`, token: account.accessToken});
 // A room that never declared this state has no state event: the homeserver's 404 is the answer "not set".
 if (!answer.ok) return answer.error.code === 'NOT_FOUND' ? ok(null) : failed(answer.error.code, answer.error.message);
 if (answer.value === null) return ok(null);
 return isPlainObject(answer.value) ? ok(answer.value as Record<string, JsonValue>) : failed('MALFORMED', `Estado ${type} inválido`);
}
// What a room is, as the homeserver reports it: the join rule, who can read the history, whether the room is
// encrypted and what room roles exist. It is evidence a caller records in a `RoomBinding` and shows a person; it is
// never a permission in the world.
export type RoomStanding = {joinRule: string; historyVisibility: string; encrypted: boolean; powerLevel: number; users: Record<string, number>};
export async function roomStanding(account: MatrixAccount, roomId: string, options: MatrixHttpOptions = {}): Promise<WorldResult<RoomStanding>> {
 if (!ROOM_ID.test(roomId)) return failed('MALFORMED', `Sala inválida: ${roomId}`);
 const client = matrixClient(account.homeserver, options);
 const joinRules = await stateOf(client, account, roomId, 'm.room.join_rules');
 if (!joinRules.ok) return joinRules;
 const history = await stateOf(client, account, roomId, 'm.room.history_visibility');
 if (!history.ok) return history;
 const power = await stateOf(client, account, roomId, 'm.room.power_levels');
 if (!power.ok) return power;
 const encryption = await stateOf(client, account, roomId, 'm.room.encryption');
 if (!encryption.ok) return encryption;
 const users: Record<string, number> = {};
 if (power.value && isPlainObject(power.value['users'])) {
  for (const [userId, level] of Object.entries(power.value['users'])) if (typeof level === 'number') users[userId] = level;
 }
 const fallback = typeof power.value?.['users_default'] === 'number' ? power.value['users_default'] as number : 0;
 const joinRule = typeof joinRules.value?.['join_rule'] === 'string' ? joinRules.value['join_rule'] as string : 'invite';
 const historyVisibility = typeof history.value?.['history_visibility'] === 'string' ? history.value['history_visibility'] as string : 'shared';
 return ok({joinRule, historyVisibility, encrypted: encryption.value !== null, powerLevel: users[account.userId] ?? fallback, users});
}
export async function createRoom(account: MatrixAccount, input: {name?: string; topic?: string; invite?: readonly string[]} = {}, options: MatrixHttpOptions = {}): Promise<WorldResult<string>> {
 const client = matrixClient(account.homeserver, options);
 const answer = await client({
  method: 'POST', path: '/_matrix/client/v3/createRoom', token: account.accessToken,
  body: {...(input.name === undefined ? {} : {name: input.name}), ...(input.topic === undefined ? {} : {topic: input.topic}), preset: 'private_chat', invite: [...(input.invite ?? [])]},
 });
 if (!answer.ok) return answer;
 if (!isPlainObject(answer.value) || typeof answer.value['room_id'] !== 'string' || !ROOM_ID.test(answer.value['room_id'])) return failed('MALFORMED', 'Homeserver criou a sala sem devolver o identificador');
 return ok(answer.value['room_id']);
}
export async function joinRoom(account: MatrixAccount, roomId: string, options: MatrixHttpOptions = {}): Promise<WorldResult<string>> {
 if (!ROOM_ID.test(roomId)) return failed('MALFORMED', `Sala inválida: ${roomId}`);
 const answer = await matrixClient(account.homeserver, options)({method: 'POST', path: `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, body: {}, token: account.accessToken});
 if (!answer.ok) return answer;
 if (!isPlainObject(answer.value) || answer.value['room_id'] !== roomId) return failed('MALFORMED', 'Homeserver não confirmou a entrada na sala');
 return ok(roomId);
}
export async function inviteToRoom(account: MatrixAccount, roomId: string, userId: string, options: MatrixHttpOptions = {}): Promise<WorldResult<void>> {
 const invited = userIdOf(userId);
 if (!invited.ok) return invited;
 const answer = await matrixClient(account.homeserver, options)({method: 'POST', path: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, body: {user_id: userId}, token: account.accessToken});
 return answer.ok ? ok(undefined) : answer;
}

// --- the room binding -------------------------------------------------------------------------------------------
export type InvitePolicy = {kind: 'open'} | {kind: 'approval'} | {kind: 'recipient'; subject: Principal};
export type MatrixEndpoint = {transport: 'matrix' | 'nostr' | 'webrtc' | 'manual'; uri: string};
// The proof of approval: with an open policy the link is enough to ask, and with an approval or recipient policy the
// host's `Grant` is what says the ask was approved. Either way the grant is what `authorize` later evaluates — a
// binding is membership in a community, never authority in the world.
export type RoomApproval = {policy: 'open' | 'approval' | 'recipient'; invite: string; grant?: Grant};
export type RoomBinding = {
 kind: 'room-binding';
 version: 1;
 account: {userId: string; homeserver: string};
 room: {roomId: string; joinRule: string; historyVisibility: string; powerLevel: number; encrypted: boolean};
 session: {worldId: string; branchId: string; sessionId: string; epoch: number};
 sessionKey: string;
 approval: RoomApproval;
};
export type RoomBindingInput = {
 account: MatrixAccount;
 roomId: string;
 standing: RoomStanding;
 session: RoomBinding['session'];
 sessionKey: string;
 identity: IdentityProof;
 approval: RoomApproval;
 // A room that is encrypted is refused unless the caller says it holds a way to open it: publishing a world in the
 // clear into an encrypted room is a leak, not a fallback.
 acceptEncrypted?: boolean;
};
export function roomBinding(input: RoomBindingInput): WorldResult<RoomBinding> {
 const {account, roomId, standing, session, sessionKey, identity, approval} = input;
 const accountId = userIdOf(account.userId);
 if (!accountId.ok) return accountId;
 if (!ROOM_ID.test(roomId)) return failed('MALFORMED', `Sala inválida: ${roomId}`);
 // A public room, or one whose history anyone may read, is not a community for a private world.
 if (standing.joinRule === 'public') return failed('PERMISSION', 'Sala pública não é uma comunidade para um mundo privado');
 if (standing.historyVisibility === 'world_readable') return failed('PERMISSION', 'Sala com histórico legível por qualquer um não guarda um mundo privado');
 if (standing.encrypted && !input.acceptEncrypted) return failed('PERMISSION', 'Sala cifrada exige a porta de cifra explicitamente aceita');
 if (!session.worldId || !session.branchId || !session.sessionId) return failed('MALFORMED', 'Vínculo de sala sem mundo, ramificação ou sessão');
 if (!Number.isSafeInteger(session.epoch) || session.epoch < 0) return failed('MALFORMED', 'Vínculo de sala com época inválida');
 const principal = userIdOfPrincipal(identity.principal);
 if (!principal.ok) return principal;
 if (principal.value !== account.userId) return failed('SIGNATURE', 'O vínculo de identidade é de outra conta que não a autenticada');
 if (identity.sessionKey !== sessionKey) return failed('SIGNATURE', 'A chave de sessão do vínculo não foi delegada por esta identidade');
 if (identity.scope.worldId !== session.worldId || identity.scope.branchId !== session.branchId || identity.scope.sessionId !== session.sessionId) return failed('SIGNATURE', 'Vínculo de identidade para outra sessão');
 if (!approval.invite.startsWith(INVITE_PREFIX)) return failed('MALFORMED', `Prova de aprovação sem convite: ${approval.invite}`);
 if (approval.policy === 'open') {
  if (approval.grant) return failed('MALFORMED', 'Política aberta não carrega concessão de aprovação');
 } else {
  const grant = approval.grant;
  if (!grant) return failed('MALFORMED', `Política ${approval.policy} exige a concessão que aprova o convite`);
  if (grant.kind !== 'grant') return failed('MALFORMED', 'Aprovação sem concessão');
  if (grant.worldId !== session.worldId || grant.branchId !== session.branchId) return failed('MALFORMED', 'Concessão de aprovação para outro mundo ou ramificação');
  if (grant.epoch !== undefined && grant.epoch !== session.epoch) return failed('PERMISSION', `Concessão da época ${grant.epoch} não vale na época ${session.epoch}`);
  if (!samePrincipal(grant.principal, identity.principal)) return failed('PERMISSION', 'Concessão de aprovação para outro principal');
 }
 return ok({
  kind: 'room-binding', version: 1,
  account: {userId: account.userId, homeserver: account.homeserver},
  room: {roomId, joinRule: standing.joinRule, historyVisibility: standing.historyVisibility, powerLevel: standing.powerLevel, encrypted: standing.encrypted},
  session: {...session}, sessionKey, approval: {...approval},
 });
}
// The one thing a binding says about an event: it has to be an event of this room. A server that answers a read with
// an event of another room is not answering a read of this room.
export function bindingAllowsRoom(binding: RoomBinding, event: RoomEvent): boolean {
 return event.room_id === binding.room.roomId;
}

// --- the room as a transport ------------------------------------------------------------------------------------
export type MatrixRefusal = {eventId: string; code: WorldErrorCode; message: string};
// The two cipher ports. Matrix end-to-end encryption is a client-side protocol, so this adapter takes it as a port:
// a client that can open a sealed event (an olm/megolm implementation, or the SDK) opens it, and a client that cannot
// reports that instead of pretending the event was not there.
export type UnsealPort = (event: RoomEvent) => Promise<WorldResult<JsonValue>>;
export type SealPort = (envelope: OsimEnvelope) => Promise<WorldResult<JsonValue>>;
export type MatrixRoomsConfig = {
 account: MatrixAccount;
 binding: RoomBinding;
 codec: WorldCodec;
 fetch?: MatrixFetch;
 timeoutMs?: number;
 limits?: Limits;
 pageSize?: number;
 // How many pages of `/messages` one read walks before it stops: a room is unbounded and a read is not.
 pages?: number;
 eventType?: string;
 unseal?: UnsealPort;
 seal?: SealPort;
 // How often a subscription asks `/sync` for what is new. The cursor is the homeserver's `next_batch`, so a slow
 // poll costs latency and never loses an event.
 pollMs?: number;
};
export type MatrixRooms = KernelTransport & {limits(): Limits; roomId(): string; refusals(): readonly MatrixRefusal[]; close(): void};

export function createMatrixRooms(config: MatrixRoomsConfig): MatrixRooms {
 const {account, binding, codec} = config;
 const limits = narrowerLimits(NETWORK_LIMITS, config.limits ?? NETWORK_LIMITS);
 const eventType = config.eventType ?? WORLD_EVENT_TYPE;
 const client = matrixClient(account.homeserver, {fetch: config.fetch, timeoutMs: config.timeoutMs});
 const options: MatrixHttpOptions = {fetch: config.fetch, timeoutMs: config.timeoutMs};
 const pageSize = config.pageSize ?? 64, pages = config.pages ?? 8, pollMs = config.pollMs ?? 2000;
 const ceiling = Math.min(limits.maxDurableBytes, MATRIX_EVENT_CEILING);
 const room = binding.room.roomId, path = `/_matrix/client/v3/rooms/${encodeURIComponent(room)}`;
 const refusals: MatrixRefusal[] = [];
 const live = new Set<() => void>();
 // Two configurations are refused before any request is made, and both are about reaching the wrong thing: a binding
 // is evidence about one account, and only a type this project controls is an object. A transport in either state
 // answers every call with the reason instead of writing as the wrong person or reading another application's chat.
 const blocked: WorldResult<never> | null = binding.account.userId !== account.userId
  ? failed('MALFORMED', `Vínculo da conta ${binding.account.userId} usado pela conta ${account.userId}`)
  : !eventType.startsWith(OBJECT_NAMESPACE)
   ? failed('PERMISSION', `O tipo de evento ${eventType} está fora do namespace ${OBJECT_NAMESPACE} deste cliente`)
   : null;
 function remember(event: RoomEvent, code: WorldErrorCode, message: string): void {
  if (refusals.length >= REFUSAL_WINDOW) refusals.shift();
  refusals.push({eventId: event.event_id, code, message});
 }
 // Everything this client writes into the room goes through one door, so the namespace rule and the cipher port are
 // decided once.
 async function write(type: string, content: JsonValue, label: string): Promise<WorldResult<string>> {
  return sendRoomEvent(account, {roomId: room, type, content, txnId: await txnIdFor(`${type}\u0000${label}`)}, options);
 }
 // Pagination is the homeserver's: `/messages` answers a chunk and a token for the next one, and this walks at most
 // `pages` of them. A page that brings nothing ends the walk even if the homeserver keeps offering tokens.
 async function readRoom(limit: number): Promise<WorldResult<RoomEvent[]>> {
  const found: RoomEvent[] = [];
  let from: string | null = null;
  for (let page = 0; page < pages; page++) {
   const answer = await client({path: `${path}/messages`, query: {dir: 'b', limit: String(limit), ...(from === null ? {} : {from})}, token: account.accessToken});
   if (!answer.ok) return answer;
   if (!isPlainObject(answer.value) || !Array.isArray(answer.value['chunk'])) return failed('MALFORMED', 'Resposta de mensagens sem bloco de eventos');
   const chunk: readonly JsonValue[] = answer.value['chunk'];
   for (const raw of chunk) {
    const event = roomEventOf(raw, room);
    if (event) found.push(event);
   }
   const end = answer.value['end'];
   if (chunk.length === 0 || typeof end !== 'string' || !end.length || end === from) break;
   from = end;
  }
  return ok(found);
 }
 // An event is only an object if this room vouches for the account that wrote it: the actor of a Matrix-carried
 // object is the account's URI, and an object that claims another account — or another community — is dropped rather
 // than bridged. The bounds are checked before anything is parsed.
 async function objectOf(event: RoomEvent): Promise<OsimEnvelope | null> {
  if (!bindingAllowsRoom(binding, event)) {
   remember(event, 'PERMISSION', `Evento ${event.event_id} é da sala ${event.room_id}, não de ${room}`);
   return null;
  }
  if (event.type === ENCRYPTED_EVENT_TYPE) {
   const unseal = config.unseal;
   if (!unseal) {
    remember(event, 'NOT_FOUND', `Evento cifrado ${event.event_id} sem chave para abrir neste cliente`);
    return null;
   }
   let opened: WorldResult<JsonValue>;
   try {
    opened = await unseal(event);
   } catch (error) {
    opened = failed('SIGNATURE', `Falha ao abrir o evento cifrado ${event.event_id}: ${error instanceof Error ? error.message : String(error)}`);
   }
   if (!opened.ok) {
    remember(event, opened.error.code, opened.error.message);
    return null;
   }
   return objectOfContent(opened.value, event);
  }
  if (event.type !== eventType) return null;
  return objectOfContent(event.content, event);
 }
 function objectOfContent(content: JsonValue, event: RoomEvent): OsimEnvelope | null {
  const bytes = codec.encode(content);
  if (bytes.byteLength > ceiling) {
   remember(event, 'LIMIT', `Conteúdo de ${bytes.byteLength} bytes acima do teto de ${ceiling}`);
   return null;
  }
  const parsed = parseStrictJson(new TextDecoder().decode(bytes), MAX_DEPTH, Math.min(DEFAULT_LIMITS.maxNodes, ceiling));
  if (!parsed.ok) {
   remember(event, 'MALFORMED', parsed.error.message);
   return null;
  }
  const checked = checkEnvelope(parsed.value);
  if (!checked.ok) {
   remember(event, 'MALFORMED', checked.error.message);
   return null;
  }
  if (!checked.value.actor.startsWith('matrix:')) {
   remember(event, 'PERMISSION', `Objeto com ator ${checked.value.actor} não é de uma conta Matrix; este transporte não faz ponte entre comunidades`);
   return null;
  }
  if (checked.value.actor.slice('matrix:'.length) !== event.sender) {
   remember(event, 'PERMISSION', `O evento é de ${event.sender}, mas o objeto diz ser de ${checked.value.actor}`);
   return null;
  }
  return checked.value;
 }
 // The transport knows what an event declares about itself, and nothing more: a filter the room cannot express is
 // applied here to what arrived, and an object that declares nothing about the requested dimension is not a match.
 function matches(filter: KernelFilter, envelope: OsimEnvelope): boolean {
  const body = envelope.body && typeof envelope.body === 'object' && !Array.isArray(envelope.body) ? envelope.body as Record<string, JsonValue> : {};
  if (filter.entity && envelope.id !== filter.entity && body['entity'] !== filter.entity) return false;
  if (filter.components?.length) {
   const components = body['components'];
   if (!components || typeof components !== 'object' || Array.isArray(components)) return false;
   if (!filter.components.every(key => Object.prototype.hasOwnProperty.call(components, key))) return false;
  }
  if (filter.timeline && body['timeline'] !== filter.timeline) return false;
  if (filter.space) return 'space' in filter.space ? body['space'] === filter.space.space : false;
  return true;
 }
 async function collect(filter: KernelFilter, limit: number): Promise<WorldResult<OsimEnvelope[]>> {
  if (blocked) return blocked;
  const events = await readRoom(limit);
  if (!events.ok) return events;
  // `/messages` walks the timeline backwards, and a caller replaying what it reads needs the order things happened
  // in: the objects come back oldest first, which is the order the room was written in.
  events.value.reverse();
  const objects: OsimEnvelope[] = [], seen = new Set<string>();
  for (const event of events.value) {
   const envelope = await objectOf(event);
   if (!envelope || seen.has(envelope.id) || !matches(filter, envelope)) continue;
   seen.add(envelope.id);
   objects.push(envelope);
  }
  return ok(objects);
 }
 async function syncOnce(since: string | null): Promise<WorldResult<{next: string; events: RoomEvent[]}>> {
  const request: MatrixRequest = {
   path: '/_matrix/client/v3/sync', token: account.accessToken,
   query: {timeout: '0', ...(since === null ? {} : {since}), filter: JSON.stringify({room: {rooms: [room], timeline: {limit: pageSize}}})},
  };
  const answer = await client(request);
  if (!answer.ok) return answer;
  if (!isPlainObject(answer.value) || typeof answer.value['next_batch'] !== 'string') return failed('MALFORMED', 'Resposta de sync sem cursor');
  const next = answer.value['next_batch'];
  const rooms = isPlainObject(answer.value['rooms']) ? answer.value['rooms'] as Record<string, unknown> : {};
  const joined = isPlainObject(rooms['join']) ? rooms['join'] as Record<string, unknown> : {};
  const joinedRoom = isPlainObject(joined[room]) ? joined[room] as Record<string, unknown> : {};
  const timeline = isPlainObject(joinedRoom['timeline']) ? joinedRoom['timeline'] as Record<string, unknown> : {};
  const events: RoomEvent[] = [];
  for (const raw of Array.isArray(timeline['events']) ? timeline['events'] : []) {
   const event = roomEventOf(raw, room);
   if (event) events.push(event);
  }
  return ok({next, events});
 }
 return {
  limits: () => limits,
  roomId: () => room,
  refusals: () => [...refusals],
  close() {
   for (const stop of [...live]) stop();
   live.clear();
  },
  async publish(object) {
   if (blocked) return blocked;
   const checked = checkEnvelope(object);
   if (!checked.ok) return checked;
   const envelope = checked.value, content = envelope as unknown as JsonValue;
   const bytes = codec.encode(content);
   if (bytes.byteLength > ceiling) return failed('LIMIT', `Objeto de ${bytes.byteLength} bytes acima do teto de ${ceiling}`);
   // A room that declares itself encrypted takes a sealed content or nothing: the plaintext never leaves the client.
   if (binding.room.encrypted) {
    const seal = config.seal;
    if (!seal) return failed('PERMISSION', 'Sala cifrada exige a porta de cifra para publicar um objeto');
    const sealed = await seal(envelope);
    if (!sealed.ok) return sealed;
    const written = await write(ENCRYPTED_EVENT_TYPE, sealed.value, envelope.id);
    return written.ok ? ok(undefined) : written;
   }
   const written = await write(eventType, content, envelope.id);
   return written.ok ? ok(undefined) : written;
  },
  async resolve(uri) {
   if (typeof uri !== 'string' || !uri.length) return failed('MALFORMED', 'Identificador vazio');
   const found = await collect({entity: uri}, pageSize);
   if (!found.ok) return found;
   return ok(found.value.find(entry => entry.id === uri) ?? null);
  },
  async query(filter) {
   if (filter.space && !('space' in filter.space)) return failed('MALFORMED', 'Consulta por raio pertence ao índice do perfil, não ao transporte da sala');
   return collect(filter, pageSize);
  },
  subscribe(filter, listener) {
   if (blocked) return () => undefined;
   let since: string | null = null, stopped = false, timer: ReturnType<typeof setTimeout> | null = null;
   const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    live.delete(stop);
   };
   const pump = async (): Promise<void> => {
    const synced = await syncOnce(since);
    if (synced.ok) {
     since = synced.value.next;
     for (const event of synced.value.events) {
      const envelope = await objectOf(event);
      if (envelope && matches(filter, envelope)) listener(envelope);
     }
    }
    if (!stopped) timer = setTimeout(() => { void pump(); }, pollMs);
   };
   live.add(stop);
   void pump();
   return stop;
  },
 };
}

// --- the invitation: a capability document written into the room -----------------------------------------------
export type MatrixSessionDescriptor = {
 type: 'session';
 id: string;
 timeline: string;
 space?: string;
 participants: string[];
 mode: 'realtime';
 startedAt: string;
 world: {worldId: string; branchId: string; epoch: number};
 head: Head;
 host: string;
 endpoints: MatrixEndpoint[];
};
export type MatrixInviteBody = {
 type: 'capability';
 version: 1;
 id: string;
 issuer: string;
 subject?: string;
 entity: string;
 actions: ActionCapability[];
 policy: InvitePolicy;
 session: MatrixSessionDescriptor;
 notBefore: string;
 notAfter: string;
};
export type MatrixInviteInput = {
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 head: Head;
 startedAt: string;
 space?: string;
 endpoints: readonly MatrixEndpoint[];
 policy: InvitePolicy;
 actions: readonly ActionCapability[];
 notBefore: string;
 notAfter: string;
};
export type MatrixInvite = {id: string; roomId: string; eventId: string; sender: string; body: MatrixInviteBody};
// The invitation is a document, and the digest of its own content is its identity: whoever reads it out of the room
// recomputes the id from what arrived, so a document cannot be silently re-labelled under an id somebody asserted.
// (A Matrix event has no client signature — the room attests the sender, and that is the whole of the anchor.)
async function inviteIdOf(body: JsonValue, codec: WorldCodec): Promise<string> {
 return `${INVITE_PREFIX}${(await hasher.ref(codec.encode(body))).hash.slice(0, 16)}`;
}
function endpointsOf(value: unknown): WorldResult<MatrixEndpoint[]> {
 if (!Array.isArray(value) || !value.length) return failed('MALFORMED', 'Convite sem ponto de encontro');
 const endpoints: MatrixEndpoint[] = [];
 for (const entry of value) {
  if (!isPlainObject(entry)) return failed('MALFORMED', 'Ponto de encontro inválido');
  const uri = stringOf(entry['uri'], 'Endereço do ponto de encontro');
  if (!uri.ok) return uri;
  const transport = entry['transport'];
  if (typeof transport !== 'string' || !(TRANSPORTS as readonly string[]).includes(transport)) return failed('MALFORMED', `Transporte desconhecido: ${String(transport)}`);
  endpoints.push({transport: transport as MatrixEndpoint['transport'], uri: uri.value});
 }
 return ok(endpoints);
}
function policyOf(value: unknown): WorldResult<InvitePolicy> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Política de convite inválida');
 if (value['kind'] === 'open' || value['kind'] === 'approval') return ok({kind: value['kind']});
 if (value['kind'] !== 'recipient') return failed('MALFORMED', `Política de convite desconhecida: ${String(value['kind'])}`);
 if (!isPlainObject(value['subject'])) return failed('MALFORMED', 'Política de destinatário sem principal');
 const scheme = stringOf(value['subject']['scheme'], 'Esquema do destinatário'), id = stringOf(value['subject']['id'], 'Identidade do destinatário');
 if (!scheme.ok) return scheme;
 if (!id.ok) return id;
 return ok({kind: 'recipient', subject: {scheme: scheme.value, id: id.value}});
}
// The single validation point for an invitation read out of a room: the event has to be of this room, the content has
// to be a capability document this client can read, and the id has to be the digest of that content.
export async function inviteFromEvent(event: RoomEvent, context: {roomId: string; codec: WorldCodec}): Promise<WorldResult<MatrixInvite>> {
 if (!ROOM_ID.test(context.roomId)) return failed('MALFORMED', `Sala inválida: ${context.roomId}`);
 if (event.room_id !== context.roomId) return failed('PERMISSION', `Evento da sala ${event.room_id} lido como convite da sala ${context.roomId}`);
 const content = event.content;
 if (!isPlainObject(content)) return failed('MALFORMED', 'Convite sem corpo');
 if (content['type'] !== 'capability' || content['version'] !== 1) return failed('MALFORMED', `Convite de tipo ou versão desconhecida: ${String(content['type'])}/${String(content['version'])}`);
 const {id: declared, ...rest} = content;
 const id = await inviteIdOf(rest as JsonValue, context.codec);
 if (declared !== id) return failed('MALFORMED', 'O identificador do convite não é o resumo do seu corpo');
 const issuer = uriOf(content['issuer'], 'Emissor'), entity = stringOf(content['entity'], 'Entidade do convite');
 if (!issuer.ok) return issuer;
 if (!entity.ok) return entity;
 const actions = actionsOf(content['actions']), policy = policyOf(content['policy']);
 if (!actions.ok) return actions;
 if (!policy.ok) return policy;
 const notBefore = instantOf(content['notBefore'], 'Início da validade'), notAfter = instantOf(content['notAfter'], 'Fim da validade');
 if (!notBefore.ok) return notBefore;
 if (!notAfter.ok) return notAfter;
 if (notAfter.value <= notBefore.value) return failed('MALFORMED', 'Convite com validade vazia');
 const session = content['session'];
 if (!isPlainObject(session)) return failed('MALFORMED', 'Convite sem descritor de sessão');
 if (session['type'] !== 'session' || session['mode'] !== 'realtime') return failed('MALFORMED', 'Descritor de sessão de outro tipo ou modo');
 const sessionId = stringOf(session['id'], 'Sessão'), timeline = stringOf(session['timeline'], 'Linha do tempo'), host = uriOf(session['host'], 'Anfitrião'), startedAt = instantOf(session['startedAt'], 'Início da sessão');
 if (!sessionId.ok) return sessionId;
 if (!timeline.ok) return timeline;
 if (!host.ok) return host;
 if (!startedAt.ok) return startedAt;
 if (!sessionId.value.startsWith(SESSION_PREFIX) || !timeline.value.startsWith(TIMELINE_PREFIX)) return failed('MALFORMED', 'Sessão ou linha do tempo fora do vocabulário do protocolo');
 if (host.value !== issuer.value) return failed('MALFORMED', 'Anfitrião diferente do emissor do convite');
 const world = session['world'];
 if (!isPlainObject(world)) return failed('MALFORMED', 'Descritor sem mundo');
 const worldId = stringOf(world['worldId'], 'Mundo'), branchId = stringOf(world['branchId'], 'Ramificação'), epoch = world['epoch'];
 if (!worldId.ok) return worldId;
 if (!branchId.ok) return branchId;
 if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) return failed('MALFORMED', 'Descritor sem época');
 const head = headOf(session['head'], worldId.value, branchId.value), endpoints = endpointsOf(session['endpoints']);
 if (!head.ok) return head;
 if (!endpoints.ok) return endpoints;
 const participants = session['participants'];
 if (!Array.isArray(participants) || participants.some(entry => typeof entry !== 'string')) return failed('MALFORMED', 'Descritor com participantes inválidos');
 const space = session['space'] === undefined ? ok(undefined) : stringOf(session['space'], 'Espaço');
 if (!space.ok) return space;
 const subject = content['subject'] === undefined ? ok(undefined) : uriOf(content['subject'], 'Destinatário');
 if (!subject.ok) return subject;
 if (policy.value.kind === 'recipient' && subject.value !== `${policy.value.subject.scheme}:${policy.value.subject.id}`) return failed('MALFORMED', 'Destinatário diferente do sujeito da política');
 return ok({
  id: id, roomId: event.room_id, eventId: event.event_id, sender: event.sender,
  body: {
   type: 'capability', version: 1, id, issuer: issuer.value, ...(subject.value === undefined ? {} : {subject: subject.value}),
   entity: entity.value, actions: actions.value, policy: policy.value,
   session: {
    type: 'session', id: sessionId.value, timeline: timeline.value, ...(space.value === undefined ? {} : {space: space.value}),
    participants: [...participants] as string[], mode: 'realtime', startedAt: startedAt.value,
    world: {worldId: worldId.value, branchId: branchId.value, epoch: epoch as number}, head: head.value, host: host.value, endpoints: endpoints.value,
   },
   notBefore: notBefore.value, notAfter: notAfter.value,
  },
 });
}

// --- joining: an ask, never a grant ----------------------------------------------------------------------------
export type MatrixJoinRequest = {
 kind: 'join-request';
 version: 1;
 id: string;
 invite: {id: string; roomId: string; eventId: string};
 session: {worldId: string; branchId: string; sessionId: string; epoch: number; head: Head};
 principal: Principal;
 sessionKey: string;
 actions: ActionCapability[];
 approval: 'none' | 'required';
 binding: MatrixBinding;
 identity: IdentityProof;
 proof: MessageProof;
};
// The signed body, written out field by field: what a signature covers is the one thing a reader must be able to see
// at a glance, and a field added to the type later is not silently signed.
export const joinRequestBody = (request: MatrixJoinRequest): JsonValue => ({
 kind: request.kind, version: request.version,
 invite: {id: request.invite.id, roomId: request.invite.roomId, eventId: request.invite.eventId},
 session: {
  worldId: request.session.worldId, branchId: request.session.branchId, sessionId: request.session.sessionId, epoch: request.session.epoch,
  head: {worldId: request.session.head.worldId, branchId: request.session.head.branchId, commit: {hash: request.session.head.commit.hash, bytes: request.session.head.commit.bytes}, generation: request.session.head.generation},
 },
 principal: {scheme: request.principal.scheme, id: request.principal.id},
 sessionKey: request.sessionKey,
 actions: [...request.actions],
 approval: request.approval,
 binding: {
  kind: request.binding.kind, version: request.binding.version, userId: request.binding.userId, serverName: request.binding.serverName,
  homeserver: request.binding.homeserver, deviceKey: request.binding.deviceKey, issuedAt: request.binding.issuedAt,
  attestation: {roomId: request.binding.attestation.roomId, eventId: request.binding.attestation.eventId},
 },
 identity: {
  kind: request.identity.kind, principal: {scheme: request.identity.principal.scheme, id: request.identity.principal.id},
  sessionKey: request.identity.sessionKey,
  scope: {worldId: request.identity.scope.worldId, branchId: request.identity.scope.branchId, sessionId: request.identity.scope.sessionId, notBefore: request.identity.scope.notBefore, notAfter: request.identity.scope.notAfter},
  delegation: {algorithm: request.identity.delegation.algorithm, key: request.identity.delegation.key, value: request.identity.delegation.value},
 },
});
export function joinRequestBytes(request: MatrixJoinRequest, codec: WorldCodec): Uint8Array {
 return codec.encode(joinRequestBody(request));
}
// The whole chain in one place, because a host holding only this document has to be able to check it: the session key
// signed the request, the device root the account authorized delegated that session key, and the binding is the
// document the room attests. None of this makes the request authority — it makes it an ask from who it claims.
export async function verifyMatrixJoinRequest(request: MatrixJoinRequest, context: {codec: WorldCodec; verifier: SignatureVerifier; hasher: ContentHasher}): Promise<WorldResult<MatrixJoinRequest>> {
 if (request.kind !== 'join-request' || request.version !== 1) return failed('MALFORMED', 'Pedido de entrada de versão desconhecida');
 const binding = verifyMatrixBinding(request.binding);
 if (!binding.ok) return binding;
 const userId = userIdOfPrincipal(request.principal);
 if (!userId.ok) return userId;
 if (userId.value !== binding.value.userId) return failed('SIGNATURE', 'O pedido diz ser de outra identidade que não a do vínculo');
 if (!samePrincipal(request.identity.principal, request.principal)) return failed('SIGNATURE', 'A prova de identidade é de outro principal');
 if (request.identity.sessionKey !== request.sessionKey || request.identity.delegation.key !== binding.value.deviceKey) return failed('SIGNATURE', 'A chave de sessão não foi delegada pelo dispositivo que o vínculo nomeia');
 const scope = request.identity.scope;
 if (scope.worldId !== request.session.worldId || scope.branchId !== request.session.branchId || scope.sessionId !== request.session.sessionId) return failed('SIGNATURE', 'Vínculo de identidade para outra sessão');
 const bytes = joinRequestBytes(request, context.codec);
 if (request.id !== (await context.hasher.ref(bytes)).hash) return failed('MALFORMED', 'O identificador do pedido não é o resumo do seu corpo');
 if (!await context.verifier.verify(request.identity, identityBytes(request.identity, context.codec))) return failed('SIGNATURE', 'Vínculo de identidade do pedido não verificado');
 if (!await context.verifier.verify(request.proof, bytes)) return failed('SIGNATURE', 'Assinatura do pedido não verificada');
 return ok(request);
}
// --- the service -------------------------------------------------------------------------------------------------
export type MatrixInviteServiceOptions = {codec: WorldCodec; now: () => string; identity?: MatrixIdentity; binding?: RoomBinding; fetch?: MatrixFetch; timeoutMs?: number};
export type MatrixInviteService = {
 create(input: MatrixInviteInput): Promise<WorldResult<MatrixInvite>>;
 open(invite: MatrixInvite): Promise<WorldResult<MatrixJoinRequest>>;
 read(event: RoomEvent): Promise<WorldResult<MatrixInvite>>;
 spent(): readonly string[];
};
export function createMatrixInviteService(options: MatrixInviteServiceOptions): MatrixInviteService {
 const {codec, now, identity, binding} = options;
 const http: MatrixHttpOptions = {fetch: options.fetch, timeoutMs: options.timeoutMs};
 // A link opened here was spent here: the same invitation is not a second join, and another session key does not make
 // it one. The host keeps its own ledger of receipts; this one keeps the link from behaving like a bearer token.
 const opened = new Map<string, string>();
 const service: MatrixInviteService = {
  async create(input) {
   if (!identity || !binding) return failed('NOT_FOUND', 'Sem identidade e vínculo de sala para convidar');
   if (binding.account.userId !== identity.account.userId) return failed('MALFORMED', 'Vínculo de sala de outra conta');
   if (input.head.worldId !== input.worldId || input.head.branchId !== input.branchId) return failed('MALFORMED', 'Cabeça de outro mundo ou ramificação');
   if (!input.worldId || !input.branchId || !input.sessionId) return failed('MALFORMED', 'Convite sem mundo, ramificação ou sessão');
   if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) return failed('MALFORMED', 'Época inválida');
   const actions = actionsOf([...input.actions]), policy = policyOf(input.policy), endpoints = endpointsOf([...input.endpoints]);
   if (!actions.ok) return actions;
   if (!policy.ok) return policy;
   if (!endpoints.ok) return endpoints;
   const startedAt = instantOf(input.startedAt, 'Início da sessão'), notBefore = instantOf(input.notBefore, 'Início da validade'), notAfter = instantOf(input.notAfter, 'Fim da validade');
   if (!startedAt.ok) return startedAt;
   if (!notBefore.ok) return notBefore;
   if (!notAfter.ok) return notAfter;
   if (notAfter.value <= notBefore.value) return failed('MALFORMED', 'Convite com validade vazia');
   // The issuer is the account that writes the event, never a field someone handed in: a document nobody wrote into
   // the room is not an invitation.
   const subject = policy.value.kind === 'recipient' ? `${policy.value.subject.scheme}:${policy.value.subject.id}` : undefined;
   const body: Omit<MatrixInviteBody, 'id'> = {
    type: 'capability', version: 1, issuer: identity.principal.id, ...(subject === undefined ? {} : {subject}),
    entity: `${SESSION_PREFIX}${input.sessionId}`, actions: actions.value, policy: policy.value,
    session: {
     type: 'session', id: `${SESSION_PREFIX}${input.sessionId}`, timeline: `${TIMELINE_PREFIX}${input.branchId}`,
     ...(input.space === undefined ? {} : {space: input.space}),
     participants: [identity.principal.id], mode: 'realtime', startedAt: startedAt.value,
     world: {worldId: input.worldId, branchId: input.branchId, epoch: input.epoch}, head: input.head,
     host: identity.principal.id, endpoints: endpoints.value,
    },
    notBefore: notBefore.value, notAfter: notAfter.value,
   };
   const id = await inviteIdOf(body as unknown as JsonValue, codec);
   const content = {...body, id} as unknown as JsonValue;
   const written = await sendRoomEvent(identity.account, {roomId: binding.room.roomId, type: CAPABILITY_EVENT_TYPE, content, txnId: await txnIdFor(`${CAPABILITY_EVENT_TYPE}\u0000${id}`)}, http);
   if (!written.ok) return written;
   return service.read({event_id: written.value, type: CAPABILITY_EVENT_TYPE, sender: identity.account.userId, room_id: binding.room.roomId, origin_server_ts: Number(Date.parse(now())), content});
  },
  async read(event) {
   if (!binding) return failed('NOT_FOUND', 'Sem vínculo de sala para ler um convite');
   return inviteFromEvent(event, {roomId: binding.room.roomId, codec});
  },
  async open(invite) {
   if (!identity || !binding) return failed('NOT_FOUND', 'Sem identidade e vínculo de sala para entrar');
   const verified = await service.read({event_id: invite.eventId, type: CAPABILITY_EVENT_TYPE, sender: invite.sender, room_id: invite.roomId, origin_server_ts: 0, content: {...invite.body}});
   if (!verified.ok) return verified;
   const body = verified.value.body, descriptor = body.session, instant = now();
   if (!INSTANT.test(instant)) return failed('MALFORMED', `Relógio da sessão inválido: ${instant}`);
   if (instant < body.notBefore) return failed('PERMISSION', 'Convite ainda não vale');
   if (instant >= body.notAfter) return failed('PERMISSION', 'Convite expirado');
   if (body.policy.kind === 'recipient' && !samePrincipal(body.policy.subject, identity.principal)) return failed('PERMISSION', 'Convite para outro destinatário');
   if (opened.has(verified.value.id)) return failed('CONFLICT', `Convite já usado nesta sessão (${opened.get(verified.value.id)})`);
   const sessionId = descriptor.id.slice(SESSION_PREFIX.length);
   const scope = {worldId: descriptor.world.worldId, branchId: descriptor.world.branchId, sessionId, notBefore: body.notBefore, notAfter: body.notAfter};
   const bound = await identity.provider(codec).bindSession({principal: identity.principal, scope});
   if (!bound.ok) return bound;
   const unsigned: MatrixJoinRequest = {
    kind: 'join-request', version: 1, id: '', invite: {id: verified.value.id, roomId: verified.value.roomId, eventId: verified.value.eventId},
    session: {worldId: scope.worldId, branchId: scope.branchId, sessionId, epoch: descriptor.world.epoch, head: descriptor.head},
    principal: identity.principal, sessionKey: bound.value.sessionKey, actions: [...body.actions],
    approval: body.policy.kind === 'open' ? 'none' : 'required',
    binding: identity.binding, identity: bound.value,
    proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: bound.value.sessionKey, signature: ''},
   };
   const bytes = joinRequestBytes(unsigned, codec);
   const request: MatrixJoinRequest = {...unsigned, id: (await hasher.ref(bytes)).hash, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: unsigned.sessionKey, signature: await signEd25519(identity.session, bytes)}};
   opened.set(verified.value.id, sessionId);
   return ok(request);
  },
  spent: () => [...opened.keys()],
 };
 return service;
}
