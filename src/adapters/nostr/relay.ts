import {verifyEvent} from 'nostr-tools/pure';
import {checkEnvelope} from '../../world/osim';
import {DEFAULT_LIMITS,parseStrictJson} from '../../world/codec';
import type {OsimEnvelope} from '../../world/osim';
import type {KernelFilter,KernelTransport} from '../../world/kernel';
import {NETWORK_LIMITS,narrowerLimits} from '../../world/wire';
import type {Limits} from '../../world/wire';
import {MAX_DEPTH,failed,ok} from '../../world/model';
import type {WorldResult} from '../../world/model';
import type {WorldCodec} from '../../world/ports';
import {epochSeconds,nostrEventOf,pubkeyOf} from './identity';
import type {NostrEvent,NostrEventTemplate,NostrSigner} from './identity';

// A Nostr relay as a `KernelTransport` (docs/OpenSim-Protocol-0.1.txt §30: publish, query, subscribe, resolve; the
// task 10 delta in docs/kernel.md). This adapter carries objects and decides nothing about authority, economies or
// geography: it frames an envelope into a NIP-01 event, reads events back, and reports the relay's own refusals
// instead of inventing success. It is one of several transports a client may hold at once, and none of them is
// required for the world to exist.
//
// Two policies live here because a relay is somebody else's infrastructure:
//
//   * Kinds. The project's reference relay accepts public writes in kinds 0, 1, 3, 5, 6, 7 and 10002 only, so a public
//     object leaves as kind 1 (a note) and a private object as kind 4 (a NIP-04 message to one recipient). NIP-78
//     (kind 30078) is application data addressed by a key: it is never a public discovery channel here, and a
//     configuration that asks for it is refused before a socket is opened.
//   * Limits. The wire's ceilings are never raised: `limits` is narrowed with NETWORK_LIMITS, an object larger than
//     `maxDurableBytes` is refused before its content is built, and an incoming content longer than that ceiling is
//     dropped instead of parsed. What a relay announces about itself is input to a caller's negotiation, never
//     permission to allocate more.
//
// Known boundary: an event whose envelope this client cannot read — another `osim` version, or a body that is not an
// envelope — is dropped rather than reported, because the transport's port carries `OsimEnvelope` and nothing else.
// Reporting those belongs to the caller's version negotiation, which this wave does not implement.
export const PUBLIC_KINDS: readonly number[] = [0, 1, 3, 5, 6, 7, 10002];
export const PUBLIC_OBJECT_KIND = 1;
export const DIRECT_MESSAGE_KIND = 4;
export const APP_DATA_KIND = 30078;
export const OBJECT_TAG = 'osim-0.1';

// --- the socket ------------------------------------------------------------------------------------------------
// A tiny shape rather than a WebSocket: the platform socket lives behind one factory, which is what lets a test run a
// whole relay in process and lets another runtime (a worker, a native client) replace it without touching this file.
export type RelaySocket = {
 send(frame: string): void;
 close(): void;
 onOpen(listener: () => void): void;
 onMessage(listener: (frame: string) => void): void;
 onClose(listener: (reason: string) => void): void;
};
export type RelaySocketFactory = (url: string) => RelaySocket;
export function webSocketFactory(): RelaySocketFactory {
 return url => {
  const socket = new WebSocket(url);
  return {
   send: frame => socket.send(frame),
   close: () => socket.close(),
   onOpen: listener => {
    if (socket.readyState === 1) listener();
    else socket.addEventListener('open', () => listener());
   },
   onMessage: listener => socket.addEventListener('message', event => listener(typeof event.data === 'string' ? event.data : '')),
   onClose: listener => {
    socket.addEventListener('close', event => listener(String(event.code)));
    socket.addEventListener('error', () => listener('erro de socket'));
   },
  };
 };
}
type Frame = readonly unknown[];
type Waiter = {test: (frame: Frame) => boolean; settle: (frame: Frame | null) => void};
type Link = {
 send(frame: Frame): void;
 // Waits for a frame the caller recognises; `null` is the honest answer for "the relay said nothing in time", and a
 // socket that closes answers immediately instead of holding the caller until the clock runs out.
 waitFor(test: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame | null>;
 close(): void;
};
function dial(url: string, factory: RelaySocketFactory, receive: (frame: Frame) => void, options: {retain?: boolean; frameCeiling?: number} = {}): WorldResult<Link> {
 const {retain = true, frameCeiling = Number.MAX_SAFE_INTEGER} = options;
 let socket: RelaySocket;
 try {
  socket = factory(url);
 } catch (error) {
  return failed('NOT_FOUND', `Relay ${url} indisponível: ${error instanceof Error ? error.message : String(error)}`);
 }
 const backlog: Frame[] = [], seen: Frame[] = [], waiters: Waiter[] = [];
 let opened = false, shut = false;
 socket.onOpen(() => {
  opened = true;
  for (const frame of backlog.splice(0)) socket.send(JSON.stringify(frame));
 });
 socket.onClose(() => {
  shut = true;
  for (const waiter of waiters.splice(0)) waiter.settle(null);
 });
 socket.onMessage(raw => {
  // Frames are somebody else's bytes: one too large to be a message of ours is never parsed. A subscription keeps no
  // history (`retain` false), because the only reason to remember a frame is to answer a `waitFor` that already ran.
  if (raw.length > frameCeiling) return;
  let frame: unknown;
  try {
   frame = JSON.parse(raw);
  } catch {
   return;
  }
  if (!Array.isArray(frame)) return;
  if (retain) seen.push(frame);
  receive(frame);
  for (const waiter of [...waiters]) {
   if (!waiter.test(frame)) continue;
   waiters.splice(waiters.indexOf(waiter), 1);
   waiter.settle(frame);
  }
 });
 return ok({
  send(frame) {
   if (shut) return;
   if (opened) socket.send(JSON.stringify(frame));
   else backlog.push(frame);
  },
  waitFor(test, timeoutMs) {
   const arrived = seen.find(test);
   if (arrived) return Promise.resolve(arrived);
   if (shut) return Promise.resolve(null);
   // This project compiles against the ES2022 library, which has no `Promise.withResolvers`, so the executor form is
   // the one available here.
   return new Promise<Frame | null>(resolve => {
    const waiter: Waiter = {test, settle: resolve};
    waiters.push(waiter);
    setTimeout(() => {
     if (!waiters.includes(waiter)) return;
     waiters.splice(waiters.indexOf(waiter), 1);
     resolve(null);
    }, timeoutMs);
   });
  },
  close() {
   shut = true;
   try {
    socket.close();
   } catch {
    // A socket that is already gone leaves nothing for this transport to do with it.
   }
  },
 });
}

// --- configuration ---------------------------------------------------------------------------------------------
export type NostrRelayConfig = {
 url: string;
 codec: WorldCodec;
 // No signer is not a broken adapter: reading a relay is a legitimate way to use one, and publishing without a signer
 // reports that instead of inventing an author.
 signer?: NostrSigner;
 // One direct channel per recipient: a NIP-04 content holds one ciphertext, so a session opens one channel per peer.
 // A relay whose writer policy allows kind 4 accepts it; the reference relay does not, and says so.
 recipients?: readonly string[];
 kinds?: {public?: number; direct?: number};
 limits?: Limits;
 timeoutMs?: number;
 pageSize?: number;
 now?: () => string;
 socket?: RelaySocketFactory;
};
export type NostrRelay = KernelTransport & {limits(): Limits; url(): string; close(): void};
type Channel = {public: number; direct?: {kind: number; own: string; peer: string}};
type Request = {subscription: string; filter: Record<string, unknown>};

export function createNostrRelay(config: NostrRelayConfig): NostrRelay {
 const codec = config.codec, signer = config.signer, url = config.url;
 const socket = config.socket ?? webSocketFactory();
 const limits = narrowerLimits(NETWORK_LIMITS, config.limits ?? NETWORK_LIMITS);
 const timeoutMs = config.timeoutMs ?? 8000, pageSize = config.pageSize ?? 128;
 const publicKind = config.kinds?.public ?? PUBLIC_OBJECT_KIND, directKind = config.kinds?.direct ?? DIRECT_MESSAGE_KIND;
 const now = config.now ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
 // A direct message is a base64 ciphertext inside a JSON frame, so a frame may be larger than the object it carries
 // and still small: four times the durable ceiling is the point where a frame stops being one of ours at all.
 const frameCeiling = limits.maxDurableBytes * 4;
 const live = new Set<Link>();
 let resolved: Promise<WorldResult<Channel>> | null = null;

 // The kind this client may publish where anyone can read it. NIP-78 is refused by name: kind 30078 is application
 // data addressed by a key, and using it as public discovery is exactly what this task forbids.
 function publicKindOr(): WorldResult<number> {
  if (publicKind === APP_DATA_KIND) return failed('PERMISSION', 'NIP-78 (kind 30078) é dado de aplicação privado e não descoberta pública');
  return PUBLIC_KINDS.includes(publicKind) ? ok(publicKind) : failed('PERMISSION', `kind ${publicKind} fora da lista pública do relay`);
 }
 // The channel is a pure function of an immutable configuration, so it is decided once: a subscription must not
 // re-decode the recipient key for every event that arrives.
 function channel(): Promise<WorldResult<Channel>> {
  return resolved ??= resolveChannel();
 }
 async function resolveChannel(): Promise<WorldResult<Channel>> {
  const kind = publicKindOr();
  if (!kind.ok) return kind;
  if (!config.recipients) return ok({public: kind.value});
  if (config.recipients.length !== 1) return failed('MALFORMED', 'Canal direto exige exatamente um destinatário');
  if (!signer) return failed('NOT_FOUND', 'Sem assinador para um canal direto');
  if (!signer.nip04) return failed('NOT_FOUND', 'Assinador sem NIP-04 para cifrar o canal direto');
  const peer = pubkeyOf(config.recipients[0]!);
  if (!peer.ok) return peer;
  // The key this client is addressed by is asked once: a direct message is found by its recipient, not by its content.
  const mine: WorldResult<string> = await signer.getPublicKey().then(key => pubkeyOf(key), error => failed('SIGNATURE', `Assinador não devolveu a chave pública: ${error instanceof Error ? error.message : String(error)}`));
  if (!mine.ok) return mine;
  return ok({public: kind.value, direct: {kind: directKind, own: mine.value, peer: peer.value}});
 }
 // One REQ per channel, because the two are addressed differently: a public object answers to its own identifier, a
 // private one is found by the key it was sent to. A private read deliberately does not filter by the family tag: a
 // relay that does not index tags on a direct message would answer nothing, and dropping a message in silence is
 // worse than decrypting a few that are not ours.
 function requestsFor(filter: KernelFilter, channels: Channel, limit: number): Request[] {
  const subscription = () => `osim-${Math.random().toString(36).slice(2, 10)}`;
  const requests: Request[] = [{subscription: subscription(), filter: {kinds: [channels.public], '#t': [OBJECT_TAG], ...(filter.entity ? {'#d': [filter.entity]} : {}), limit}}];
  const direct = channels.direct;
  if (direct) requests.push({subscription: subscription(), filter: {kinds: [direct.kind], '#p': [direct.own], limit}});
  return requests;
 }
 // An event is only an object if it is signed and, when the object claims a `nostr:` actor, if the key that signed it
 // is that actor. Anything else is somebody else's message and is dropped rather than handed to the kernel.
 async function objectOf(event: NostrEvent, channels: Channel): Promise<OsimEnvelope | null> {
  if (!verifyEvent(event)) return null;
  let text = event.content;
  if (channels.direct && event.kind === channels.direct.kind) {
   const cipher = signer?.nip04;
   if (!cipher) return null;
   try {
    text = await cipher.decrypt(event.pubkey, event.content);
   } catch {
    return null;
   }
  }
  // The ceiling is checked first and the parse is bounded (depth, node count) exactly like every other entry point
  // for text this client did not write: hostile content is refused before it becomes a structure.
  if (text.length > limits.maxDurableBytes) return null;
  const parsed = parseStrictJson(text, MAX_DEPTH, Math.min(DEFAULT_LIMITS.maxNodes, limits.maxDurableBytes));
  if (!parsed.ok) return null;
  const checked = checkEnvelope(parsed.value);
  if (!checked.ok) return null;
  if (checked.value.actor.startsWith('nostr:')) {
   const actor = pubkeyOf(checked.value.actor);
   if (!actor.ok || actor.value !== event.pubkey) return null;
  }
  return checked.value;
 }
 // A relay can only answer with what an object declares about itself; a filter the relay cannot express is applied
 // here to what arrived, and an object that declares nothing about the requested dimension is not a match.
 function matches(filter: KernelFilter, envelope: OsimEnvelope): boolean {
  const body = envelope.body && typeof envelope.body === 'object' && !Array.isArray(envelope.body) ? envelope.body as Record<string, unknown> : {};
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
  const channels = await channel();
  if (!channels.ok) return channels;
  const raw: NostrEvent[] = [];
  const link = dial(url, socket, frame => {
   if (frame[0] !== 'EVENT') return;
   const event = nostrEventOf(frame[2]);
   if (event) raw.push(event);
  }, {frameCeiling});
  if (!link.ok) return link;
  live.add(link.value);
  try {
   const requests = requestsFor(filter, channels.value, limit);
   for (const request of requests) link.value.send(['REQ', request.subscription, request.filter]);
   await Promise.all(requests.map(request => link.value.waitFor(frame => frame[0] === 'EOSE' && frame[1] === request.subscription, timeoutMs)));
   for (const request of requests) link.value.send(['CLOSE', request.subscription]);
   const objects: OsimEnvelope[] = [];
   for (const event of raw) {
    const envelope = await objectOf(event, channels.value);
    if (envelope && matches(filter, envelope)) objects.push(envelope);
   }
   return ok(objects);
  } finally {
   link.value.close();
   live.delete(link.value);
  }
 }
 async function publishEnvelope(object: unknown): Promise<WorldResult<void>> {
  const checked = checkEnvelope(object);
  if (!checked.ok) return checked;
  const channels = await channel();
  if (!channels.ok) return channels;
  const envelope = checked.value, bytes = codec.encode(envelope);
  if (bytes.byteLength > limits.maxDurableBytes) return failed('LIMIT', `Objeto de ${bytes.byteLength} bytes acima do teto de ${limits.maxDurableBytes}`);
  if (!signer) return failed('NOT_FOUND', 'Sem assinador para publicar no relay');
  const direct = channels.value.direct, cipher = signer.nip04;
  if (direct && !cipher) return failed('NOT_FOUND', 'Assinador sem NIP-04 para cifrar o canal direto');
  const text = new TextDecoder().decode(bytes);
  let content = text;
  if (direct && cipher) {
   try {
    content = await cipher.encrypt(direct.peer, text);
   } catch (error) {
    return failed('SIGNATURE', `Não foi possível cifrar a mensagem direta: ${error instanceof Error ? error.message : String(error)}`);
   }
  }
  const template: NostrEventTemplate = {
   kind: direct ? direct.kind : channels.value.public, created_at: epochSeconds(now()),
   // A public object is addressed by its identifier; a private one carries only the recipient, because the relay has
   // no business knowing which object a ciphertext holds.
   tags: direct ? [['p', direct.peer], ['t', OBJECT_TAG]] : [['d', envelope.id], ['t', OBJECT_TAG], ['o', envelope.type]],
   content,
  };
  let event: NostrEvent;
  try {
   event = await signer.signEvent(template);
  } catch (error) {
   return failed('SIGNATURE', `Assinador recusou a assinatura da mensagem: ${error instanceof Error ? error.message : String(error)}`);
  }
  const link = dial(url, socket, () => undefined, {frameCeiling});
  if (!link.ok) return link;
  live.add(link.value);
  try {
   link.value.send(['EVENT', event]);
   const answer = await link.value.waitFor(frame => frame[0] === 'OK' && frame[1] === event.id, timeoutMs);
   if (!answer) return failed('NOT_FOUND', `Relay ${url} não confirmou o evento ${event.id}`);
   if (answer[2] !== true) return failed('PERMISSION', String(answer[3] ?? '').trim() || `Relay ${url} recusou o evento`);
   return ok(undefined);
  } finally {
   link.value.close();
   live.delete(link.value);
  }
 }
 return {
  limits: () => limits,
  url: () => url,
  close() {
   for (const link of [...live]) link.close();
   live.clear();
  },
  publish: publishEnvelope,
  async resolve(uri) {
   if (typeof uri !== 'string' || !uri.length) return failed('MALFORMED', 'Identificador vazio');
   const found = await collect({entity: uri}, pageSize);
   if (!found.ok) return found;
   return ok(found.value.find(entry => entry.id === uri) ?? null);
  },
  async query(filter) {
   if (filter.space && !('space' in filter.space)) return failed('MALFORMED', 'Consulta por raio pertence ao índice do perfil, não ao transporte do relay');
   return collect(filter, pageSize);
  },
  subscribe(filter, listener) {
   if (filter.space && !('space' in filter.space)) return () => undefined;
   const frames: Request[] = [];
   const onEvent = async (event: NostrEvent): Promise<void> => {
    const channels = await channel();
    if (!channels.ok) return;
    const envelope = await objectOf(event, channels.value);
    if (envelope && matches(filter, envelope)) listener(envelope);
   };
   const link = dial(url, socket, frame => {
    if (frame[0] !== 'EVENT') return;
    const event = nostrEventOf(frame[2]);
    if (event) void onEvent(event);
   }, {retain: false, frameCeiling});
   if (!link.ok) return () => undefined;
   live.add(link.value);
   const opened = link.value;
   void channel().then(channels => {
    if (!channels.ok) return;
    for (const request of requestsFor(filter, channels.value, pageSize)) {
     frames.push(request);
     opened.send(['REQ', request.subscription, request.filter]);
    }
   });
   // Decoding is asynchronous (a direct message is decrypted first), so an envelope reaches the listener in its own
   // microtask: the order of unrelated messages is not a promise this transport makes.
   return () => {
    for (const request of frames) opened.send(['CLOSE', request.subscription]);
    opened.close();
    live.delete(opened);
   };
  },
 };
}
