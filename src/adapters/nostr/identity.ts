import {finalizeEvent,getPublicKey,verifyEvent} from 'nostr-tools/pure';
import type {EventTemplate} from 'nostr-tools/pure';
import {decode as decodeNip19,npubEncode} from 'nostr-tools/nip19';
import {decrypt as nip04Decrypt,encrypt as nip04Encrypt} from 'nostr-tools/nip04';
import {ed25519Verifier,signEd25519} from '../crypto/session-keys';
import type {KeyPair} from '../crypto/session-keys';
import {identityBytes} from '../../world/permissions';
import type {IdentityProof,IdentityProvider,Principal,Proof,SessionBindingRequest,SignatureVerifier} from '../../world/permissions';
import {failed,ok} from '../../world/model';
import type {JsonValue,WorldResult} from '../../world/model';
import type {WorldCodec} from '../../world/ports';

// Nostr as an identity adapter (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.2 and the task 10
// delta in docs/kernel.md). This is the only place a Nostr SDK is allowed to appear, and it exists to answer one
// question: who is this peer? The answer is an actor URI — `nostr:npub1…` is a valid protocol identifier (§4) — and
// nothing else in this project has to know how a Nostr key is written down.
//
// The wire contract of task 6 knows one signature algorithm (`Signature.algorithm` is the literal `'Ed25519'`), while
// Nostr signs with BIP-340 over secp256k1 and never hands over the key (NIP-07 holds it inside the extension). So the
// chain has three links, each one verifiable on its own:
//
//   npub  --(NIP-07 event signature)-->  device root (Ed25519)  --(Ed25519 delegation)-->  session key (Ed25519)
//
// The middle step is a `NostrBinding`: an ordinary signed event whose content is the device key and the npub. The
// last step is the `IdentityProof` task 6 already verifies. The consequence a caller has to know about is explicit
// and load-bearing: `ed25519Verifier()` alone proves that *some* Ed25519 root delegated a session key, never that
// the root speaks for an npub. `nostrVerifier(binding)` is the verifier that closes that gap, and a host that grants
// authority to a `nostr:` principal has to use it.

// The shape NIP-07 exposes through `window.nostr`, narrowed to the three things this adapter uses. A NIP-46 bunker
// fits the same shape, which is why a bunker is a signer here and never an identity by itself: the identity is the
// npub it signs with, and a bunker that holds another key cannot bind the user's.
export type NostrEventTemplate = {kind: number; created_at: number; tags: string[][]; content: string};
export type NostrEvent = NostrEventTemplate & {pubkey: string; id: string; sig: string};
export interface NostrSigner {
 getPublicKey(): Promise<string>;
 signEvent(event: NostrEventTemplate): Promise<NostrEvent>;
 // NIP-04 is optional: a signer that cannot encrypt makes the direct-message path unavailable, not the manual path.
 nip04?: {encrypt(pubkey: string, plaintext: string): Promise<string>; decrypt(pubkey: string, ciphertext: string): Promise<string>};
}
// NIP-78 (kind 30078) is application data addressed by a key, and this client never uses it: it is not a discovery
// channel and not a place to publish an invite, so nothing here names it. The binding travels as an ordinary note,
// kind 1, which is also the only kind the reference relay accepts from an unlisted writer.
export const BINDING_KIND = 1;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, PUBKEY = /^[0-9a-f]{64}$/, NPUB = /^npub1[02-9ac-hj-np-z]{58}$/;

function plain(value: unknown): value is Record<string, unknown> {
 return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
// The event content is the canonical bytes of a body, decoded back to text: whatever codec the world layer uses is
// the codec here too, so a body carries the same characters a proposal or a grant would.
export function contentText(codec: WorldCodec, body: JsonValue): string {
 return new TextDecoder().decode(codec.encode(body));
}
// Instant of the session clock to the seconds a Nostr event carries; no clock is read here, the caller injected it.
export function epochSeconds(instant: string): number {
 return Math.floor(Date.parse(instant) / 1000);
}
export function npubOf(pubkey: string): string {
 return npubEncode(pubkey);
}
export function pubkeyFromNpub(npub: string): WorldResult<string> {
 const decoded = decodeNip19(npub);
 if (decoded.type !== 'npub' || !PUBKEY.test(decoded.data)) return failed('MALFORMED', `Identificador Nostr inválido: ${npub}`);
 return ok(decoded.data);
}
// Any of the three ways a Nostr key is written down, because a peer, a relay and a config file do not agree on one.
export function pubkeyOf(value: string): WorldResult<string> {
 if (PUBKEY.test(value)) return ok(value);
 const bare = value.startsWith('nostr:') ? value.slice('nostr:'.length) : value;
 return pubkeyFromNpub(bare);
}
// A principal from any of the three ways a key is written down; the actor URI is the npub, which is what the
// protocol carries (§4) and what a peer can check a signature against.
export function principalOf(key: string): WorldResult<Principal> {
 const pubkey = pubkeyOf(key);
 if (!pubkey.ok) return pubkey;
 return ok({scheme: 'nostr', id: `nostr:${npubOf(pubkey.value)}`});
}
export function npubOfPrincipal(principal: Principal): WorldResult<string> {
 if (principal.scheme !== 'nostr') return failed('MALFORMED', `Principal não é Nostr: ${principal.scheme}`);
 const bare = principal.id.startsWith('nostr:') ? principal.id.slice('nostr:'.length) : principal.id;
 if (!NPUB.test(bare)) return failed('MALFORMED', `Identidade Nostr inválida: ${principal.id}`);
 return ok(bare);
}

// The local signer: an in-memory key for tests and for a headless client. It holds the secret, so it also encrypts,
// which is what makes the direct-message path testable without an extension.
export function localNostrSigner(secret: Uint8Array): NostrSigner {
 return {
  getPublicKey: async () => getPublicKey(secret),
  signEvent: async template => eventFrom(finalizeEvent(template as EventTemplate, secret)),
  nip04: {
   encrypt: async (pubkey, plaintext) => nip04Encrypt(secret, pubkey, plaintext),
   decrypt: async (pubkey, ciphertext) => nip04Decrypt(secret, pubkey, ciphertext),
  },
 };
}
// A signer arrives as an untrusted object: it is the extension's, so every answer is validated before it is believed.
export function nip07Signer(source: unknown): WorldResult<NostrSigner> {
 if (source === undefined || source === null) return failed('NOT_FOUND', 'Sem assinador Nostr disponível');
 if (!plain(source)) return failed('MALFORMED', 'Assinador Nostr inválido');
 const getPublicKey = source['getPublicKey'], signEvent = source['signEvent'], nip04 = source['nip04'];
 if (typeof getPublicKey !== 'function' || typeof signEvent !== 'function') return failed('MALFORMED', 'Assinador Nostr sem getPublicKey/signEvent');
 const encrypt = plain(nip04) && typeof nip04['encrypt'] === 'function' ? nip04['encrypt'] : undefined;
 const decrypt = plain(nip04) && typeof nip04['decrypt'] === 'function' ? nip04['decrypt'] : undefined;
 const signer: NostrSigner = {
  getPublicKey: async () => {
   const answer = await getPublicKey.call(source);
   if (typeof answer !== 'string' || !PUBKEY.test(answer)) throw new Error('Assinador devolveu chave pública inválida');
   return answer;
  },
  signEvent: async template => {
   const answer = await signEvent.call(source, template);
   const event = nostrEventOf(answer);
   if (!event) throw new Error('Assinador devolveu evento inválido');
   return event;
  },
 };
 if (encrypt && decrypt) signer.nip04 = {encrypt: async (pubkey, plaintext) => String(await encrypt.call(nip04, pubkey, plaintext)), decrypt: async (pubkey, ciphertext) => String(await decrypt.call(nip04, pubkey, ciphertext))};
 return ok(signer);
}
// The shape of an event as it arrives from a signer or a relay: validated once here, so nothing downstream has to
// trust a field that may not be there.
export function nostrEventOf(value: unknown): NostrEvent | null {
 if (!plain(value)) return null;
 const {kind, created_at, tags, content, pubkey, id, sig} = value as Record<string, unknown>;
 if (typeof kind !== 'number' || typeof created_at !== 'number' || typeof content !== 'string') return null;
 if (typeof pubkey !== 'string' || typeof id !== 'string' || typeof sig !== 'string') return null;
 if (!Array.isArray(tags) || tags.some(tag => !Array.isArray(tag) || tag.some(entry => typeof entry !== 'string'))) return null;
 return {kind, created_at, tags: tags as string[][], content, pubkey, id, sig};
}
// Only the fields the SDK cares about, copied on purpose: a `VerifiedEvent` carries a cached verdict symbol, and this
// adapter does not want to inherit a verdict from whoever produced the object.
function eventFrom(event: {kind: number; created_at: number; tags: string[][]; content: string; pubkey: string; id: string; sig: string}): NostrEvent {
 return {kind: event.kind, created_at: event.created_at, tags: event.tags.map(tag => [...tag]), content: event.content, pubkey: event.pubkey, id: event.id, sig: event.sig};
}

// --- the npub binding: what a Nostr key authorizes on this device ---------------------------------------------
export type NostrBinding = {kind: 'nostr-binding'; version: 1; npub: string; deviceKey: string; issuedAt: string; event: NostrEvent};
export const bindingBody = (binding: NostrBinding) => ({kind: binding.kind, version: binding.version, npub: binding.npub, deviceKey: binding.deviceKey, issuedAt: binding.issuedAt});
// Pure verification, no clock: the binding says which device the npub authorized and when it said so; whether that
// authorization is still wanted is a decision for a clock-holding caller, not for a signature check.
export function verifyBinding(binding: NostrBinding): WorldResult<NostrBinding> {
 if (binding.kind !== 'nostr-binding' || binding.version !== 1) return failed('MALFORMED', 'Vínculo Nostr de versão desconhecida');
 if (!NPUB.test(binding.npub) || !PUBKEY.test(binding.deviceKey)) return failed('MALFORMED', 'Vínculo Nostr com chaves inválidas');
 if (!INSTANT.test(binding.issuedAt)) return failed('MALFORMED', 'Vínculo Nostr sem instante válido');
 const pubkey = pubkeyFromNpub(binding.npub);
 if (!pubkey.ok) return pubkey;
 const event = binding.event;
 if (event.kind !== BINDING_KIND) return failed('MALFORMED', `Vínculo Nostr no kind ${event.kind}`);
 if (event.pubkey !== pubkey.value) return failed('SIGNATURE', 'O evento do vínculo não foi assinado pela chave que ele nomeia');
 if (!verifyEvent(event)) return failed('SIGNATURE', 'Assinatura do vínculo não verificada');
 let content: unknown;
 try {
  content = JSON.parse(event.content);
 } catch {
  return failed('MALFORMED', 'Conteúdo do vínculo não é JSON');
 }
 if (!plain(content)) return failed('MALFORMED', 'Conteúdo do vínculo não é um objeto');
 const expected = bindingBody(binding) as Record<string, unknown>;
 for (const key of ['kind', 'version', 'npub', 'deviceKey', 'issuedAt']) if (content[key] !== expected[key]) return failed('SIGNATURE', `O evento assinado diz outra coisa em ${key}`);
 return ok(binding);
}

// Binding a device asks the npub to sign once: the signature is what makes every later session key on this device
// mean "npub" instead of "some Ed25519 key". A signer that is absent, refuses or answers something else is a refusal.
export async function bindNostrDevice(input: {signer?: NostrSigner; device: KeyPair; now: () => string; codec: WorldCodec}): Promise<WorldResult<NostrBinding>> {
 const {signer, device, now, codec} = input;
 if (!signer) return failed('NOT_FOUND', 'Sem assinador Nostr para vincular o dispositivo');
 if (!PUBKEY.test(device.publicKey)) return failed('MALFORMED', 'Chave do dispositivo inválida');
 const issuedAt = now();
 if (!INSTANT.test(issuedAt)) return failed('MALFORMED', `Relógio do vínculo inválido: ${issuedAt}`);
 let publicKey: string;
 try {
  publicKey = await signer.getPublicKey();
 } catch (error) {
  return failed('SIGNATURE', `Assinador não devolveu a chave pública: ${messageOf(error)}`);
 }
 if (!PUBKEY.test(publicKey)) return failed('MALFORMED', `Chave pública do assinador inválida: ${publicKey}`);
 const binding: NostrBinding = {kind: 'nostr-binding', version: 1, npub: npubOf(publicKey), deviceKey: device.publicKey, issuedAt, event: {kind: BINDING_KIND, created_at: epochSeconds(issuedAt), tags: [], content: '', pubkey: publicKey, id: '', sig: ''}};
 const template: NostrEventTemplate = {kind: BINDING_KIND, created_at: binding.event.created_at, tags: [['t', 'osim-0.1'], ['t', 'osim-binding']], content: contentText(codec, bindingBody(binding))};
 let event: NostrEvent;
 try {
  event = await signer.signEvent(template);
 } catch (error) {
  return failed('SIGNATURE', `Assinador recusou o vínculo: ${messageOf(error)}`);
 }
 if (event.pubkey !== publicKey) return failed('SIGNATURE', 'O assinador assinou o vínculo com outra chave');
 if (!verifyEvent(event)) return failed('SIGNATURE', 'O assinador devolveu um vínculo com assinatura inválida');
 return ok({...binding, event});
}
function messageOf(error: unknown): string {
 return error instanceof Error ? error.message : String(error);
}

// --- the identity provider: a device root delegating the short session key ------------------------------------
export type NostrIdentity = {
 principal: Principal;
 signer: NostrSigner;
 binding: NostrBinding;
 device: KeyPair;
 session: KeyPair;
 provider(codec: WorldCodec): IdentityProvider;
 verifier(base?: SignatureVerifier): SignatureVerifier;
};
export function nostrIdentityProvider(input: {binding: NostrBinding; device: KeyPair; session: KeyPair; codec: WorldCodec}): IdentityProvider {
 const {binding, device, session, codec} = input;
 return {
  bindSession: async (request: SessionBindingRequest): Promise<WorldResult<IdentityProof>> => {
   const verified = verifyBinding(binding);
   if (!verified.ok) return verified;
   const npub = npubOfPrincipal(request.principal);
   if (!npub.ok) return npub;
   // The identity a caller asks for is never the identity it gets: the binding decides, and a request that names
   // another npub is a forgery attempt rather than a binding error.
   if (npub.value !== binding.npub) return failed('SIGNATURE', 'A identidade pedida não é a chave que assinou o vínculo');
   const scope = request.scope;
   if (!scope.worldId || !scope.branchId || !scope.sessionId) return failed('MALFORMED', 'Vínculo de sessão sem mundo, ramificação ou sessão');
   if (!INSTANT.test(scope.notBefore) || !INSTANT.test(scope.notAfter)) return failed('MALFORMED', 'Vínculo de sessão fora do formato de instante');
   const unsigned: IdentityProof = {kind: 'identity', principal: request.principal, sessionKey: session.publicKey, scope, delegation: {algorithm: 'Ed25519', key: device.publicKey, value: ''}};
   return ok({...unsigned, delegation: {algorithm: 'Ed25519', key: device.publicKey, value: await signEd25519(device, identityBytes(unsigned, codec))}});
  },
 };
}
// The verifier a host uses for a `nostr:` principal. `base` is the Ed25519 half; the nostr half is this wrapper, and
// the wrapper is the only thing that makes the principal mean something.
export function nostrVerifier(binding: NostrBinding, base: SignatureVerifier = ed25519Verifier()): SignatureVerifier {
 return {
  verify: async (proof: Proof, bytes: Uint8Array): Promise<boolean> => {
   if (proof.kind === 'identity') {
    if (!verifyBinding(binding).ok) return false;
    if (proof.principal.scheme !== 'nostr' || proof.principal.id !== `nostr:${binding.npub}`) return false;
    if (proof.delegation.key !== binding.deviceKey) return false;
   }
   return base.verify(proof, bytes);
  },
 };
}
export async function createNostrIdentity(input: {signer?: NostrSigner; device: KeyPair; session: KeyPair; codec: WorldCodec; now: () => string}): Promise<WorldResult<NostrIdentity>> {
 const {signer, device, session, codec, now} = input;
 if (!signer) return failed('NOT_FOUND', 'Sem assinador Nostr');
 const bound = await bindNostrDevice({signer, device, now, codec});
 if (!bound.ok) return bound;
 // The binding already proved which key signed it, so the principal comes from the verified document and the signer
 // is not asked twice: an extension prompt is a user gesture, not a step to repeat for convenience.
 const binding = bound.value, principal = principalOf(binding.npub);
 if (!principal.ok) return principal;
 return ok({
  principal: principal.value,
  signer,
  binding,
  device,
  session,
  provider: (codec: WorldCodec) => nostrIdentityProvider({binding, device, session, codec}),
  verifier: (base?: SignatureVerifier) => nostrVerifier(binding, base),
 });
}
