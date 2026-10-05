// The WebRTC adapter of a live session (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.2–§7.5, §8.4;
// plan Tarefa 8; OpenSim Protocol §23–§26 and §30). One peer connection per participant carries three data channels:
// a reliable ordered one for control and durable traffic, a disposable one for presence and cursors, and one that
// belongs to the object port. The adapter implements **two** ports because session traffic and protocol objects are
// different classes of traffic (§24): `SessionTransport` moves framed messages and knows nothing about meaning, and
// `KernelTransport` publishes, queries, subscribes and resolves the objects of the protocol over the same link.
//
// Three boundaries are deliberate. Signaling arrives through a `Signaling` port that only ever hands over a signal it
// already verified (see `manual-signaling.ts`), so no offer reaches the platform before its signature, session, epoch
// and key binding were checked — the copy/paste text of a person is as untrusted as a public relay. The platform peer
// is injected, so this file compiles and runs where `RTCPeerConnection` does not exist and a test can be exact without
// a network. And TURN is asked for a credential that expires: an app never ships a permanent relay secret, it asks a
// configured service for a short-lived one and refuses to connect with an expired credential.
import {failed,ok} from '../../world/model';
import {WORLD_PROTOCOL,WIRE_VERSION} from '../../world/model';
import type {JsonValue,ObjectRef,WorldError,WorldResult} from '../../world/model';
import type {ContentHasher,WorldCodec} from '../../world/ports';
import type {KernelFilter,KernelTransport} from '../../world/kernel';
import type {OsimEnvelope} from '../../world/osim';
import {checkEnvelope,envelopeOf,timelineUri} from '../../world/osim';
import {decodeMessage,encodeMessage,narrowerLimits,NETWORK_LIMITS} from '../../world/wire';
import type {Limits,TrafficClass,WireEnvelope,WireMessage} from '../../world/wire';
import type {SessionListener,SessionTransport} from '../../session/multiplayer-ports';
import type {ObjectStore} from '../blobs/direct';
import {BUFFER_AGREEMENT,createObjectBudget,createPartialShelf,narrowerBackpressure,serveObjects,transferObject} from './object-transfer';
import type {Backpressure,ObjectLink,PartialShelf,ServedObject} from './object-transfer';
import {signSignal} from './manual-signaling';
import type {SessionScope,SessionSigner,SignalKind,Signaling,} from './manual-signaling';
import {errorText} from '../../core/guards';

// --- the platform surface this adapter needs ---------------------------------------------------------------------
// Deliberately small: what the adapter calls, nothing more. A real `RTCPeerConnection` satisfies it, and so does a
// test double, which is why no test needs a real network to be exact.
export type RtcIceServer = {urls: string | readonly string[]; username?: string; credential?: string};
export type RtcConfiguration = {iceServers: readonly RtcIceServer[]; iceTransportPolicy?: 'all' | 'relay'};
export type RtcDescription = {type: 'offer' | 'answer'; sdp?: string};
export type RtcIceCandidate = {candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null};
export type RtcChannel = {
 readonly label: string;
 binaryType?: string;
 readonly readyState: string;
 bufferedAmount: number;
 bufferedAmountLowThreshold: number;
 send(data: Uint8Array): void;
 close(): void;
 addEventListener(type: string, listener: (event: RtcEvent) => void): void;
 removeEventListener(type: string, listener: (event: RtcEvent) => void): void;
};
export type RtcEvent = {type?: string; channel?: RtcChannel; candidate?: RtcIceCandidate | null; data?: unknown};
export type RtcPeer = {
 createDataChannel(label: string, options?: {ordered?: boolean; maxRetransmits?: number}): RtcChannel;
 createOffer(): Promise<RtcDescription>;
 createAnswer(): Promise<RtcDescription>;
 setLocalDescription(description: RtcDescription): Promise<void>;
 setRemoteDescription(description: RtcDescription): Promise<void>;
 addIceCandidate(candidate?: RtcIceCandidate | null): Promise<void>;
 readonly localDescription: RtcDescription | null;
 readonly remoteDescription: RtcDescription | null;
 readonly connectionState: string;
 close(): void;
 addEventListener(type: string, listener: (event: RtcEvent) => void): void;
 removeEventListener(type: string, listener: (event: RtcEvent) => void): void;
};
export type RtcFactory = (configuration: RtcConfiguration) => RtcPeer;

export type TurnCredentials = {urls: readonly string[]; username: string; credential: string; expiresAt: string};
export type RelayPolicy = {
 policy?: 'direct' | 'relay';
 stun?: readonly string[];
 turn?: () => Promise<TurnCredentials>;
 clock?: () => string;
};
export type WebRtcConfig = {
 codec: WorldCodec;
 actor: string;
 session: SessionScope;
 signer: SessionSigner;
 signaling: Signaling;
 hasher: ContentHasher;
 connection?: RtcFactory;
 relay?: RelayPolicy;
 limits?: Limits;
 backpressure?: Backpressure;
 store?: ObjectStore;
 answerWindowMs?: number;
 delay?: (ms: number) => Promise<void>;
 onRefused?: (peer: string, error: WorldError) => void;
};
export type WebRtcPeers = {
 transport: SessionTransport;
 objects: KernelTransport;
 invite(peer: string): Promise<WorldResult<void>>;
 opened(peer: string): Promise<void>;
 connected(): readonly string[];
 transfer(ref: ObjectRef, peer: string): Promise<WorldResult<Uint8Array>>;
 close(peer?: string): void;
};
// The port refuses with a result code instead of a bare string: `send` returns only a promise, so the failure has to
// travel on the rejection.
export class WireRefused extends Error {
 readonly error: WorldError;
 constructor(error: WorldError) {
  super(error.message);
  this.name = 'WireRefused';
  this.error = error;
 }
}

const CHANNELS: readonly {label: string; ordered: boolean; maxRetransmits?: number}[] = [
 {label:'control', ordered:true},
 {label:'ephemeral', ordered:false, maxRetransmits:0},
 {label:'object', ordered:true},
];
const OBJECT_CHANNEL = 'object';
// A candidate that arrives before its description waits, but a peer cannot make this device wait forever.
const MAX_EARLY_CANDIDATES = 64;
// The plan fixes 64 KiB for control and durable messages and 16 KiB for a segment. An ephemeral frame is disposable,
// so this port bounds it by the segment ceiling even though the wire table lets it share the control one, and a
// platform frame that exceeds its class is refused before it is parsed. Negotiation only ever lowers these numbers.
function ceilingOf(limits: Limits, traffic: TrafficClass): number {
 if (traffic === 'control') return limits.maxControlBytes;
 if (traffic === 'durable') return limits.maxDurableBytes;
 return limits.maxSegmentBytes;
}
function checkFrame(bytes: Uint8Array, limits: Limits): WorldResult<WireMessage> {
 const decoded = decodeMessage(bytes, limits);
 if (!decoded.ok) return decoded;
 const traffic = decoded.value.envelope.class;
 const ceiling = ceilingOf(limits, traffic);
 if (bytes.byteLength > ceiling) return failed('LIMIT', `Mensagem de ${bytes.byteLength} bytes excede o limite de ${ceiling} da classe ${traffic}`);
 if (traffic === 'object') return failed('MALFORMED', 'Objeto não viaja pela porta de sessão: use a transferência de objeto');
 return decoded;
}
function bytesOf(data: unknown): Uint8Array | null {
 if (data instanceof Uint8Array) return data;
 if (data instanceof ArrayBuffer) return new Uint8Array(data);
 return null;
}
type Deferred<T> = {promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void};
function deferred<T>(): Deferred<T> {
 let resolve!: (value: T) => void, reject!: (error: unknown) => void;
 const promise = new Promise<T>((keep, fail) => { resolve = keep; reject = fail; });
 return {promise, resolve, reject};
}
// The platform's own peer, reached only when it exists: in Node there is none, and the adapter says so instead of
// failing at import time.
const platformConnection: RtcFactory = configuration => {
 const platform = (globalThis as unknown as {RTCPeerConnection?: new (config: RtcConfiguration) => unknown}).RTCPeerConnection;
 if (!platform) throw new Error('Esta plataforma não tem RTCPeerConnection: injete a fábrica de pares');
 return new platform(configuration) as RtcPeer;
};
async function iceConfiguration(relay: RelayPolicy | undefined): Promise<WorldResult<RtcConfiguration>> {
 const iceServers: RtcIceServer[] = (relay?.stun ?? []).map(urls => ({urls:[urls]}));
 if (relay?.turn) {
  const temporary = await relay.turn();
  const now = (relay.clock ?? (() => new Date().toISOString()))();
  // A permanent secret never ships in an app: the relay credential is a ticket with a deadline, and an expired ticket
  // is refused here instead of being used to open a connection nobody authorized.
  if (temporary.expiresAt <= now) return failed('PERMISSION', `Credencial temporária de TURN expirada em ${temporary.expiresAt}`);
  iceServers.push({urls:temporary.urls, username:temporary.username, credential:temporary.credential});
 }
 return ok({iceServers, iceTransportPolicy:relay?.policy === 'relay' ? 'relay' : 'all'});
}

// The session descriptor of §23: the object `join` resolves, published over the object port instead of being shipped
// as session traffic, because the session of §24 is not history.
export function sessionDescriptor(session: SessionScope, options: {actor: string; space: string; participants: readonly string[]; mode: 'realtime' | 'async'; startedAt?: string}): OsimEnvelope {
 return envelopeOf('session', `osim:session:${session.sessionId}`, options.actor, {
  space: options.space,
  timeline: timelineUri(session.branchId),
  participants: [...options.participants],
  mode: options.mode,
  epoch: session.epoch,
  ...(options.startedAt ? {startedAt: options.startedAt} : {}),
 });
}

// A payload is JSON, so nothing undefined travels: an absent SDP or candidate is an absent field, not a null one.
function descriptionPayload(description: RtcDescription): JsonValue {
 return {description: description.sdp === undefined ? {type:description.type} : {type:description.type, sdp:description.sdp}};
}
function candidatePayload(candidate: RtcIceCandidate): JsonValue {
 const value: {[key: string]: JsonValue} = {candidate:candidate.candidate ?? ''};
 if (candidate.sdpMid !== undefined && candidate.sdpMid !== null) value['sdpMid'] = candidate.sdpMid;
 if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null) value['sdpMLineIndex'] = candidate.sdpMLineIndex;
 return {candidate:value};
}
type Link = {peer: string; connection: RtcPeer; channels: Map<string, RtcChannel>; closes: Set<() => void>; closed: boolean; readiness: Deferred<void>; served?: ServedObject};
type Ask = {collect: (object: OsimEnvelope) => void};

export function createWebRtcPeers(config: WebRtcConfig): WebRtcPeers {
 const limits = narrowerLimits(NETWORK_LIMITS, config.limits ?? NETWORK_LIMITS);
 const backpressure = narrowerBackpressure(BUFFER_AGREEMENT, config.backpressure ?? BUFFER_AGREEMENT);
 const delay = config.delay ?? ((ms: number) => new Promise<void>(resolve => {setTimeout(resolve, ms);}));
 const connection = config.connection ?? platformConnection;
 const answerWindow = config.answerWindowMs ?? 2000;
 const links = new Map<string, Link>();
 const early = new Map<string, RtcIceCandidate[]>();
 const openings = new Map<string, Deferred<void>>();
 const listeners = new Set<SessionListener>();
 const partials: PartialShelf = createPartialShelf();
 const budget = createObjectBudget(limits.maxInflightObjectBytes);
 const held = new Map<string, OsimEnvelope>();
 const asks = new Map<string, Ask>();
 const subscribers = new Set<{filter: KernelFilter; listener: (object: OsimEnvelope) => void}>();
 let sequence = 0;

 const opening = (peer: string) => {
  let entry = openings.get(peer);
  if (!entry) {
   entry = deferred<void>();
   // A peer that leaves before its channels open must not turn into an unhandled rejection.
   entry.promise.catch(() => {});
   openings.set(peer, entry);
  }
  return entry;
 };
 const hold = (object: OsimEnvelope) => {
  held.set(object.id, object);
  // What this device can hand a peer is bounded: the object port is a holder, not a second repository.
  if (held.size > 256) { const oldest = held.keys().next().value; if (oldest !== undefined) held.delete(oldest); }
 };
 const drop = (link: Link, reason?: Error) => {
  if (link.closed) return;
  link.closed = true;
  if (links.get(link.peer) === link) links.delete(link.peer);
  link.served?.stop();
  link.readiness.reject(reason ?? new WireRefused({code:'NOT_FOUND', message:`Conexão com ${link.peer} caiu`}));
  if (openings.get(link.peer) === link.readiness) openings.delete(link.peer);
  for (const notify of [...link.closes]) notify();
 };
 const objectLinkOf = (link: Link): ObjectLink => ({
  peer: link.peer,
  send(frame) {
   const channel = link.channels.get(OBJECT_CHANNEL);
   if (!channel || channel.readyState !== 'open') throw new Error(`Canal de objeto fechado com ${link.peer}`);
   channel.send(frame);
  },
  bufferedAmount: () => link.channels.get(OBJECT_CHANNEL)?.bufferedAmount ?? 0,
  drain: below => {
   const channel = link.channels.get(OBJECT_CHANNEL);
   return channel ? drain(channel, below) : Promise.resolve();
  },
  receive: listener => {
   const channel = link.channels.get(OBJECT_CHANNEL);
   if (!channel) return () => {};
   const onMessage = (event: RtcEvent) => { const frame = bytesOf(event.data); if (frame) listener(frame); };
   channel.addEventListener('message', onMessage);
   return () => channel.removeEventListener('message', onMessage);
  },
  closed: listener => {
   link.closes.add(listener);
   return () => {link.closes.delete(listener);};
  },
 });

 // --- the message port (§7.3) ------------------------------------------------------------------------------------
 const post = async (link: Link, envelope: WireEnvelope, body: JsonValue): Promise<WorldResult<void>> => {
  if (link.closed) return failed('NOT_FOUND', `Sem conexão com ${link.peer}`);
  const bytes = encodeMessage({envelope, body}, config.codec);
  const ceiling = ceilingOf(limits, envelope.class);
  if (bytes.byteLength > ceiling) return failed('LIMIT', `Mensagem de ${bytes.byteLength} bytes excede o limite de ${ceiling} da classe ${envelope.class}`);
  const channel = link.channels.get(envelope.class === 'ephemeral' ? 'ephemeral' : 'control');
  if (!channel || channel.readyState !== 'open') return failed('NOT_FOUND', `Canal ${envelope.class} fechado com ${link.peer}`);
  // A disposable frame never queues behind a saturated buffer: presence is worth more than a delayed cursor.
  if (channel.bufferedAmount >= backpressure.highWaterBytes) {
   if (envelope.class === 'ephemeral') return ok(undefined);
   await drain(channel, backpressure.lowWaterBytes);
   if (link.closed) return failed('NOT_FOUND', `Conexão com ${link.peer} caiu enquanto o canal drenava`);
  }
  try { channel.send(bytes); } catch (error) { return failed('NOT_FOUND', `O canal recusou a mensagem: ${errorText(error)}`); }
  return ok(undefined);
 };
 const envelopeFor = (traffic: TrafficClass, id: string): WireEnvelope => ({
  worldProtocol:WORLD_PROTOCOL, wireVersion:WIRE_VERSION, kind:'message', class:traffic,
  worldId:config.session.worldId, branchId:config.session.branchId, sessionId:config.session.sessionId,
  epoch:config.session.epoch, id,
 });
 const sendBytes = async (peer: string, envelope: WireEnvelope, body: JsonValue): Promise<WorldResult<void>> => {
  const link = links.get(peer);
  if (!link) return failed('NOT_FOUND', `Sem conexão com ${peer}`);
  return post(link, envelope, body);
 };
 let counter = 0;
 const nextId = (prefix: string) => `${prefix}.${config.session.sessionId}.${config.session.epoch}.${(counter += 1)}`;

 const transport: SessionTransport = {
  async send(peer, message) {
   const envelope = message.envelope;
   if (envelope.worldId !== config.session.worldId || envelope.branchId !== config.session.branchId || envelope.sessionId !== config.session.sessionId || envelope.epoch !== config.session.epoch) throw new WireRefused({code:'CONFLICT', message:'Mensagem para outra sessão, ramificação ou época'});
   if (envelope.class === 'object') throw new WireRefused({code:'MALFORMED', message:'Objeto não viaja pela porta de sessão: use a transferência de objeto'});
   const outcome = await sendBytes(peer, envelope, message.body);
   if (!outcome.ok) throw new WireRefused(outcome.error);
  },
  subscribe(listener) { listeners.add(listener); return () => {listeners.delete(listener);}; },
 };

 // --- the object port of the protocol (§23, §30, §39) ------------------------------------------------------------
 const filterValue = (filter: KernelFilter): JsonValue => {
  // Geography stays out of the transport: a space filter is the profile's index, and the kernel never answers it.
  const value: {[key: string]: JsonValue} = {};
  if (filter.components) value['components'] = [...filter.components];
  if (filter.entity) value['entity'] = filter.entity;
  if (filter.timeline) value['timeline'] = filter.timeline;
  return value;
 };
 const matches = (filter: KernelFilter, object: OsimEnvelope): boolean => {
  if (filter.entity && object.id !== filter.entity) {
   const body = object.body;
   const target = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, JsonValue>)['entity'] : undefined;
   if (target !== filter.entity) return false;
  }
  if (filter.timeline) {
   const body = object.body;
   const timeline = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, JsonValue>)['timeline'] : undefined;
   if (timeline !== undefined && timeline !== filter.timeline) return false;
  }
  if (filter.components?.length) {
   const body = object.body;
   if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
   const source = body as Record<string, JsonValue>;
   const named = object.type === 'entity' && source['components'] && typeof source['components'] === 'object'
    ? Object.keys(source['components'] as Record<string, JsonValue>)
    : typeof source['component'] === 'string' ? [source['component']] : [];
   if (!named.some(key => filter.components!.includes(key))) return false;
  }
  return true;
 };
 const notifyObjects = (object: OsimEnvelope) => { for (const entry of [...subscribers]) if (matches(entry.filter, object)) entry.listener(object); };
 const askPeers = async (peers: Link[], body: {[key: string]: JsonValue}, done: (collected: OsimEnvelope[]) => boolean): Promise<OsimEnvelope[]> => {
  const id = nextId('ask');
  const collected: OsimEnvelope[] = [];
  const settled = deferred<void>();
  asks.set(id, {collect: object => { collected.push(object); if (done(collected)) settled.resolve(undefined); }});
  for (const link of peers) await post(link, envelopeFor('control', `${id}.${link.peer}`), {...body, id});
  await Promise.race([settled.promise, delay(answerWindow)]);
  asks.delete(id);
  return collected;
 };
 const objects: KernelTransport = {
  async publish(object) {
   const checked = checkEnvelope(object);
   if (!checked.ok) return checked;
   // Local first (§2.1): the object is held before any peer is asked to keep it, and a transport that refuses is a
   // report, not a rollback.
   hold(checked.value);
   const peers = openLinks();
   if (!peers.length) return failed('NOT_FOUND', 'Nenhum par conectado nesta sessão');
   for (const link of peers) {
    const posted = await post(link, envelopeFor('durable', nextId('publish')), {kind:'osim.publish', object:checked.value as unknown as JsonValue});
    if (!posted.ok) return posted;
   }
   return ok(undefined);
  },
  async resolve(uri) {
   const local = held.get(uri);
   if (local) return ok(local);
   const peers = openLinks();
   if (!peers.length) return ok(null);
   const found = await askPeers(peers, {kind:'osim.ask', ask:'resolve', uri}, collected => collected.length > 0);
   return ok(found[0] ?? null);
  },
  async query(filter) {
   const peers = openLinks();
   if (!peers.length) return ok([]);
   const found = await askPeers(peers, {kind:'osim.ask', ask:'query', filter:filterValue(filter)}, () => false);
   const unique = new Map<string, OsimEnvelope>();
   for (const object of found) unique.set(object.id, object);
   return ok([...unique.values()]);
  },
  subscribe(filter, listener) {
   const entry = {filter, listener};
   subscribers.add(entry);
   return () => {subscribers.delete(entry);};
  },
 };
 // What a peer asks of this device, answered from what it holds. It is the same `receive` path as its own publishes,
 // so a peer never gets a second opinion about which world it is in.
 const answer = (peer: string, message: WireMessage) => {
  const body = message.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const source = body as Record<string, JsonValue>;
  const kind = source['kind'];
  const link = links.get(peer);
  if (!link) return;
  if (kind === 'osim.publish') { const received = readEnvelope(source['object']); if (received) { hold(received); notifyObjects(received); } return; }
  if (kind === 'osim.ask') {
   const id = source['id'], which = source['ask'];
   if (typeof id !== 'string') return;
   const found = which === 'resolve' ? resolveFor(source['uri']) : which === 'query' ? queryFor(source['filter']) : [];
   void post(link, envelopeFor('control', `${id}.answer`), {kind:'osim.answer', id, objects:found as unknown as JsonValue});
   return;
  }
  if (kind === 'osim.answer') {
   const id = source['id'];
   const waiting = typeof id === 'string' ? asks.get(id) : undefined;
   const list = source['objects'];
   if (!waiting || !Array.isArray(list)) return;
   for (const entry of list) { const object = readEnvelope(entry); if (object) waiting.collect(object); }
  }
 };
 const resolveFor = (uri: JsonValue | undefined): OsimEnvelope[] => {
  if (typeof uri !== 'string') return [];
  const object = held.get(uri);
  return object ? [object] : [];
 };
 const queryFor = (filter: JsonValue | undefined): OsimEnvelope[] => {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return [];
  const declared = filter as Record<string, JsonValue>;
  const components = Array.isArray(declared['components']) ? declared['components'].filter((key): key is string => typeof key === 'string') : undefined;
  return [...held.values()].filter(object => matches({components, entity:typeof declared['entity'] === 'string' ? declared['entity'] : undefined, timeline:typeof declared['timeline'] === 'string' ? declared['timeline'] : undefined}, object));
 };
 const readEnvelope = (value: JsonValue | undefined): OsimEnvelope | null => {
  const checked = checkEnvelope(value);
  return checked.ok ? checked.value : null;
 };

 // --- the link ---------------------------------------------------------------------------------------------------
 function openLinks(): Link[] { return [...links.values()].filter(link => !link.closed); }
 const receive = (link: Link, data: unknown) => {
  const bytes = bytesOf(data);
  if (!bytes) return;
  const checked = checkFrame(bytes, limits);
  if (!checked.ok) { config.onRefused?.(link.peer, checked.error); return; }
  const message = checked.value;
  const envelope = message.envelope;
  // An epoch fences the previous writer (§7.5): a frame of another session, branch or epoch is not late, it belongs to
  // a conversation this device is no longer having.
  if (envelope.worldId !== config.session.worldId || envelope.branchId !== config.session.branchId || envelope.sessionId !== config.session.sessionId || envelope.epoch !== config.session.epoch) {
   config.onRefused?.(link.peer, {code:'CONFLICT', message:`Mensagem de ${envelope.worldId}/${envelope.branchId}/${envelope.sessionId}@${envelope.epoch}, não desta sessão`});
   return;
  }
  answer(link.peer, message);
  for (const listener of [...listeners]) listener(link.peer, message);
 };
 const attach = (link: Link, channel: RtcChannel, label: string) => {
  if (link.closed) { channel.close(); return; }
  link.channels.set(label, channel);
  channel.binaryType = 'arraybuffer';
  const opened = () => { if (!link.closed && CHANNELS.every(one => link.channels.get(one.label)?.readyState === 'open')) link.readiness.resolve(undefined); };
  if (label === OBJECT_CHANNEL) {
   // The object channel carries binary segment frames, not session messages: the two ports share the link but never
   // parse each other's traffic. Serving is registered here so a peer that asks for a frozen base gets an answer from
   // this device the moment the channel exists.
   if (config.store) link.served = serveObjects({link:objectLinkOf(link), store:config.store, limits, backpressure, onRefused:error => config.onRefused?.(link.peer, error)});
  } else {
   channel.addEventListener('message', event => receive(link, event.data));
  }
  channel.addEventListener('close', () => drop(link));
  if (channel.readyState === 'open') opened(); else channel.addEventListener('open', opened);
 };
 const watch = (link: Link) => {
  link.connection.addEventListener('datachannel', event => { const channel = event.channel; if (channel && CHANNELS.some(one => one.label === channel.label)) attach(link, channel, channel.label); });
  link.connection.addEventListener('icecandidate', event => {
   const candidate = event.candidate;
   if (!candidate) return;
   void sendSignal(link.peer, 'ice', candidatePayload(candidate));
  });
  link.connection.addEventListener('connectionstatechange', () => {
   // "disconnected" is often transient and is reported, not declared fatal; "failed" and "closed" are the end.
   const state = link.connection.connectionState;
   if (state === 'failed' || state === 'closed') drop(link);
  });
 };
 const connect = async (peer: string, ice: RtcConfiguration, incoming?: RtcDescription): Promise<WorldResult<void>> => {
  // ICE credentials may yield while another invitation or incoming offer creates the link.
  // Recheck at the synchronous creation boundary so both callers use that connection's readiness.
  const existing = links.get(peer);
  if (existing && !existing.closed) return ok(undefined);
  const conn = connection(ice);
  const link: Link = {peer, connection:conn, channels:new Map(), closes:new Set(), closed:false, readiness:opening(peer)};
  links.set(peer, link);
  opening(peer);
  watch(link);
  if (incoming) {
   // The answering side never creates a channel of its own: the channels of the session belong to the participant
   // that offered, and duplicating them here would give one session two sets of streams.
   await conn.setRemoteDescription(incoming);
   await flushCandidates(link);
   const answer = await conn.createAnswer();
   await conn.setLocalDescription(answer);
   return sendSignal(peer, 'answer', descriptionPayload(answer));
  }
  for (const one of CHANNELS) attach(link, conn.createDataChannel(one.label, {ordered:one.ordered, maxRetransmits:one.maxRetransmits}), one.label);
  const offer = await conn.createOffer();
  await conn.setLocalDescription(offer);
  return sendSignal(peer, 'offer', descriptionPayload(offer));
 };
 const sendSignal = async (peer: string, signal: SignalKind, payload: JsonValue): Promise<WorldResult<void>> => {
  sequence += 1;
  const signed = await signSignal({codec:config.codec, signer:config.signer, actor:config.actor, session:config.session, signal, id:nextId('signal'), sequence, payload});
  try { await config.signaling.send(peer, signed); return ok(undefined); } catch (error) { return failed('NOT_FOUND', `A sinalização não entregou o sinal: ${errorText(error)}`); }
 };
 // A candidate that waited for its description is applied now, in the order it arrived.
const flushCandidates = async (link: Link) => {
 const waiting = early.get(link.peer);
 if (!waiting) return;
 early.delete(link.peer);
 for (const candidate of waiting) await link.connection.addIceCandidate(candidate);
};
const descriptionOf = (payload: JsonValue): RtcDescription | null => {
 if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const wrapped = (payload as Record<string, JsonValue>)['description'];
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) return null;
  const source = wrapped as Record<string, JsonValue>;
  const type = source['type'], sdp = source['sdp'];
  if (type !== 'offer' && type !== 'answer') return null;
  if (sdp !== undefined && typeof sdp !== 'string') return null;
  return sdp === undefined ? {type} : {type, sdp};
 };
 const candidateOf = (payload: JsonValue): RtcIceCandidate | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const wrapped = (payload as Record<string, JsonValue>)['candidate'];
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped)) return null;
  const source = wrapped as Record<string, JsonValue>;
  const candidate = source['candidate'];
  if (typeof candidate !== 'string') return null;
  return {candidate, sdpMid:typeof source['sdpMid'] === 'string' ? source['sdpMid'] : null, sdpMLineIndex:typeof source['sdpMLineIndex'] === 'number' ? source['sdpMLineIndex'] : null};
 };
 config.signaling.subscribe(async (peer, signal) => {
  // The signaling adapter already verified the signature, the session, the epoch and the key binding; the fence here
  // is the transport's own reading of the same address, so a mismatch can never be acted on.
  if (signal.worldId !== config.session.worldId || signal.branchId !== config.session.branchId || signal.sessionId !== config.session.sessionId || signal.epoch !== config.session.epoch) {
   config.onRefused?.(peer, {code:'CONFLICT', message:`Sinal de ${signal.worldId}/${signal.branchId}/${signal.sessionId}@${signal.epoch}, não desta sessão`});
   return;
  }
  const restarted = links.get(peer);
  if (signal.signal === 'offer') {
   // An offer for a link this device already has is not a new session: the answer is on its way.
   if (restarted && !restarted.closed) return;
   const description = descriptionOf(signal.payload);
   if (!description) { config.onRefused?.(peer, {code:'MALFORMED', message:`Oferta de ${peer} sem descrição de sessão`}); return; }
   const ice = await iceConfiguration(config.relay);
   if (!ice.ok) { config.onRefused?.(peer, ice.error); return; }
   const connected = await connect(peer, ice.value, description);
   if (!connected.ok) config.onRefused?.(peer, connected.error);
   return;
  }
  const link = links.get(peer);
  if (signal.signal === 'answer') {
   if (!link) { config.onRefused?.(peer, {code:'NOT_FOUND', message:`Resposta de ${peer} sem conexão aberta`}); return; }
   const description = descriptionOf(signal.payload);
   if (!description) { config.onRefused?.(peer, {code:'MALFORMED', message:`Resposta de ${peer} sem descrição de sessão`}); return; }
   await link.connection.setRemoteDescription(description);
   await flushCandidates(link);
   return;
  }
  const candidate = candidateOf(signal.payload);
  if (!candidate) {
   config.onRefused?.(peer, {code:'MALFORMED', message:`Candidato de ${peer} sem endereço utilizável`});
   return;
  }
  // Each side signs its own descriptions and candidates independently, so a candidate can reach this device before the
  // offer or answer it belongs to. The platform refuses a candidate without a remote description, so it waits here and
  // is applied the moment the description arrives — it is not a late signal, it is an early one. The wait is bounded,
  // because a peer that only ever sends candidates must not be able to fill memory.
  if (!link || link.connection.remoteDescription === null) {
   const waiting = (early.get(peer) ?? []).slice(-MAX_EARLY_CANDIDATES + 1);
   early.set(peer, [...waiting, candidate]);
   return;
  }
  await link.connection.addIceCandidate(candidate);
 });

 return {
  transport,
  objects,
  async invite(peer) {
   const open = links.get(peer);
   if (open && !open.closed) return ok(undefined);
   const ice = await iceConfiguration(config.relay);
   if (!ice.ok) return ice;
   return connect(peer, ice.value);
  },
  opened(peer) { return opening(peer).promise; },
  connected: () => openLinks().map(link => link.peer).sort(),
  transfer(ref, peer) {
   return transferObject(ref, peer, {
    links:{get:target => { const link = links.get(target); return link && !link.closed ? objectLinkOf(link) : null; }},
    hasher:config.hasher,
    budget,
    store:config.store,
    limits,
    backpressure,
    resume:partials,
    onRefused:error => config.onRefused?.(peer, error),
   });
  },
  close(peer) {
   const targets = peer ? [links.get(peer)] : [...links.values()];
   for (const link of targets) {
    if (!link) continue;
    drop(link);
    link.connection.close();
   }
  },
 };
}

// The two ports of one link. Passing the same `peers` keeps a single connection per participant; without it each port
// would open its own, which is exactly what §24 says not to do for two classes of traffic that share a session.
export function createWebRtcTransport(config: WebRtcConfig, options: {peers?: WebRtcPeers} = {}): SessionTransport {
 return (options.peers ?? createWebRtcPeers(config)).transport;
}
export function createWebRtcObjectTransport(config: WebRtcConfig, options: {peers?: WebRtcPeers} = {}): KernelTransport {
 return (options.peers ?? createWebRtcPeers(config)).objects;
}
// The throttle of every channel: the platform buffer is what says "enough for now", and the negotiation says when the
// stream may continue.
async function drain(channel: RtcChannel, below: number): Promise<void> {
 channel.bufferedAmountLowThreshold = below;
 while (channel.readyState === 'open' && channel.bufferedAmount >= below) {
  await new Promise<void>(resolve => {
   const wake = () => { channel.removeEventListener('bufferedamountlow', wake); channel.removeEventListener('close', wake); resolve(); };
   channel.addEventListener('bufferedamountlow', wake);
   channel.addEventListener('close', wake);
  });
 }
}
