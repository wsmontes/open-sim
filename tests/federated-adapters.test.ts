import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {ed25519Verifier,generateSessionKeyPair,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {createKernel} from '../src/world/kernel';
import type {KernelTransport} from '../src/world/kernel';
import {envelopeOf} from '../src/world/osim';
import type {OsimEnvelope} from '../src/world/osim';
import {durableJson} from '../src/core/protocol';
import {WORLD_PROTOCOL,WIRE_VERSION} from '../src/world/model';
import type {JsonValue,WorldError} from '../src/world/model';
import type {SessionTransport} from '../src/session/multiplayer-ports';
import {createManualSignaling} from '../src/adapters/network/manual-signaling';
import type {ManualSignaling,SessionSigner} from '../src/adapters/network/manual-signaling';
import {createWebRtcPeers,createWebRtcTransport} from '../src/adapters/network/webrtc';
import type {RtcFactory,WebRtcPeers} from '../src/adapters/network/webrtc';
import {wiredPair} from './fixtures/rtc-pair';
import {createGame} from '../src/core/commands';
import type {GameState} from '../src/core/model';
import {blank} from './fixtures/world';
import {fakeHomeserver} from './fixtures/matrix-homeserver';
import type {FakeHomeserver} from './fixtures/matrix-homeserver';
import {createMatrixIdentity,registerAccount} from '../src/adapters/matrix/identity';
import type {MatrixAccount,MatrixIdentity} from '../src/adapters/matrix/identity';
import {createMatrixRooms,createRoom,inviteToRoom,joinRoom,roomBinding,roomStanding} from '../src/adapters/matrix/rooms';
import type {MatrixRooms} from '../src/adapters/matrix/rooms';
import {createNostrIdentity,localNostrSigner} from '../src/adapters/nostr/identity';
import type {NostrEvent,NostrIdentity} from '../src/adapters/nostr/identity';
import {createNostrRelay} from '../src/adapters/nostr/relay';
import type {RelaySocketFactory} from '../src/adapters/nostr/relay';

// The same scenario over two different federations (task 11 of docs/superpowers/plans/2026-09-29-federated-world.md).
// A transport carries objects and decides nothing about their meaning, so the world two clients end up with is the
// world, whichever community carried it: the assertion the plan asks for is that the semantic hash of the durable
// state — `durableJson` of the core — is the same on both sides, in the same order of operations.
const codec = createJcsCodec(), hasher = bytesHasher();
const NOW = '2026-09-29T12:00:00Z';
const SESSION = {worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', epoch: 1};
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const head = {worldId: 'victoria', branchId: 'main', commit: {hash: 'aa'.repeat(32), bytes: 64}, generation: 7};
const world = (components: GameState['components'] = {}): GameState => ({...createGame('victoria', 7, blank('9:9')), components});

// Three operations, two of them touching the same entity: the order of delivery is part of the scenario.
const OPERATIONS: readonly {id: string; entity: string; value: JsonValue}[] = [
 {id: 'evt-1', entity: 'casa-1', value: {level: 1}},
 {id: 'evt-2', entity: 'casa-2', value: {level: 2, demanda: 3}},
 {id: 'evt-3', entity: 'casa-1', value: {level: 5}},
];
function objectsFor(actor: string): OsimEnvelope[] {
 return OPERATIONS.map((operation, index) => envelopeOf('event', `osim:event:${operation.id}`, actor, {
  type: 'event', entity: `osim:entity:${operation.entity}`, component: 'cidade.transito', op: 'set',
  value: operation.value, timeline: 'osim:timeline:main', time: at(index * 60),
 }));
}
type Run = {semanticHash: string; ids: string[]};
async function hashOf(components: GameState['components']): Promise<string> {
 return (await hasher.ref(new TextEncoder().encode(durableJson(world(components))))).hash;
}
// The client side of a session: the origin applies locally first and replicates, the replica receives through the
// transport's own subscription — the same path a real player takes, and the only path this test uses.
async function scenario(origin: KernelTransport, replica: KernelTransport, objects: readonly OsimEnvelope[]): Promise<Run> {
 const writer = createKernel({transports: [origin]});
 const reader = createKernel({transports: [replica]});
 const arrived: string[] = [];
 const stop = reader.subscribe({}, object => { arrived.push(object.id); });
 for (const object of objects) {
  const published = await writer.publish(object);
  if (!published.ok) throw new Error(published.error.message);
 }
 await expect.poll(() => arrived.length, {timeout: 5000}).toBe(objects.length);
 // Both sides persist the same durable world: the origin applied it locally, the replica applied what arrived.
 const local = await hashOf(writer.state().components), delivered = await hashOf(reader.state().components);
 expect(delivered).toBe(local);
 stop();
 return {semanticHash: delivered, ids: arrived};
}

// --- one in-process Nostr relay --------------------------------------------------------------------------------
// A NIP-01 relay narrow enough to be readable: it stores what a writer sends, answers OK, and pushes new events to
// open subscriptions the way a real relay does. Nothing here leaves the process.
type FakeRelay = {factory: RelaySocketFactory; stored: NostrEvent[]};
function fakeRelay(): FakeRelay {
 const stored: NostrEvent[] = [], open: {subscription: string; send: (frame: unknown) => void}[] = [];
 const factory: RelaySocketFactory = () => {
  const messages: ((frame: string) => void)[] = [], closes: ((reason: string) => void)[] = [];
  let ready = false;
  const emit = (frame: unknown) => queueMicrotask(() => { for (const listener of [...messages]) listener(JSON.stringify(frame)); });
  const deliver = (subscription: string, event: NostrEvent) => emit(['EVENT', subscription, event]);
  return {
   send(raw) {
    const frame = JSON.parse(raw) as unknown[];
    if (frame[0] === 'EVENT') {
     const event = frame[1] as NostrEvent;
     stored.push(event);
     emit(['OK', event.id, true, '']);
     // A real relay pushes to the subscription's own connection, which is why the frame carries the subscription id.
     for (const subscription of [...open]) subscription.send(['EVENT', subscription.subscription, event]);
    }
    if (frame[0] === 'REQ') {
     const subscription = String(frame[1]);
     for (const event of stored) deliver(subscription, event);
     emit(['EOSE', subscription]);
     open.push({subscription, send: frame => emit(frame)});
    }
    if (frame[0] === 'CLOSE') {
     const index = open.findIndex(entry => entry.subscription === frame[1]);
     if (index >= 0) open.splice(index, 1);
    }
   },
   close() { for (const listener of closes) listener('1000'); },
   onOpen(listener) {
    if (ready) queueMicrotask(listener);
    else queueMicrotask(() => { ready = true; listener(); });
   },
   onMessage(listener) { messages.push(listener); },
   onClose(listener) { closes.push(listener); },
  };
 };
 return {factory, stored};
}
async function nostrIdentity(secret: number): Promise<NostrIdentity> {
 const device = await generateSessionKeyPair(), session = await generateSessionKeyPair();
 const built = await createNostrIdentity({signer: localNostrSigner(new Uint8Array(32).fill(secret)), device, session, codec, now: () => NOW});
 if (!built.ok) throw new Error(built.error.message);
 return built.value;
}
async function overNostr(): Promise<Run> {
 const relay = fakeRelay(), identity = await nostrIdentity(31);
 const writer = createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: relay.factory});
 const reader = createNostrRelay({url: 'ws://relay.example', codec, socket: relay.factory});
 const run = await scenario(writer, reader, objectsFor(identity.principal.id));
 writer.close();
 reader.close();
 return run;
}

// --- one in-process Matrix homeserver, with a private room both accounts are in ---------------------------------
type MatrixLab = {
 rooms(account: MatrixAccount, identity: MatrixIdentity): Promise<MatrixRooms>;
 server: FakeHomeserver;
 roomId: string;
 host: MatrixAccount;
 guest: MatrixAccount;
 hostIdentity: MatrixIdentity;
 guestIdentity: MatrixIdentity;
};
async function matrixLab(): Promise<MatrixLab> {
 const server = fakeHomeserver(), homeserver = `http://${server.serverName}`;
 const host = await registerAccount({homeserver, secret: server.secret, username: 'alice', password: 'segredo-de-alice', fetch: server.fetch});
 const guest = await registerAccount({homeserver, secret: server.secret, username: 'bob', password: 'segredo-de-bob', fetch: server.fetch});
 if (!host.ok) throw new Error(host.error.message);
 if (!guest.ok) throw new Error(guest.error.message);
 const created = await createRoom(host.value, {name: 'Mundo Victoria'}, {fetch: server.fetch});
 if (!created.ok) throw new Error(created.error.message);
 // The guest is invited into the room and joins it: membership is an invitation, not a link anyone can open.
 const invited = await inviteToRoom(host.value, created.value, guest.value.userId, {fetch: server.fetch});
 if (!invited.ok) throw new Error(invited.error.message);
 const joined = await joinRoom(guest.value, created.value, {fetch: server.fetch});
 if (!joined.ok) throw new Error(joined.error.message);
 const standing = await roomStanding(host.value, created.value, {fetch: server.fetch});
 if (!standing.ok) throw new Error(standing.error.message);
 const identityOf = async (account: MatrixAccount): Promise<MatrixIdentity> => {
  const device = await generateSessionKeyPair(), sessionKey = await generateSessionKeyPair();
  const built = await createMatrixIdentity({account, device, session: sessionKey, codec, now: () => NOW, roomId: created.value, fetch: server.fetch});
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
 };
 const hostIdentity = await identityOf(host.value), guestIdentity = await identityOf(guest.value);
 const rooms = async (account: MatrixAccount, identity: MatrixIdentity): Promise<MatrixRooms> => {
  const proof = await identity.provider(codec).bindSession({principal: identity.principal, scope: {...SESSION, notBefore: at(-60), notAfter: at(3600)}});
  if (!proof.ok) throw new Error(proof.error.message);
  const binding = roomBinding({account, roomId: created.value, standing: standing.value, session: SESSION, sessionKey: identity.session.publicKey, identity: proof.value, approval: {policy: 'open', invite: 'osim:capability:invite-1'}});
  if (!binding.ok) throw new Error(binding.error.message);
  return createMatrixRooms({account, binding: binding.value, codec, fetch: server.fetch, pollMs: 2});
 };
 return {rooms, server, roomId: created.value, host: host.value, guest: guest.value, hostIdentity, guestIdentity};
}
async function overMatrix(): Promise<{run: Run; lab: MatrixLab}> {
 const lab = await matrixLab();
 const run = await scenario(await lab.rooms(lab.host, lab.hostIdentity), await lab.rooms(lab.guest, lab.guestIdentity), objectsFor(lab.hostIdentity.principal.id));
 return {run, lab};
}

// The durable world the scenario must produce, whichever transport carried it: the last operation on `casa-1` wins,
// and the field `casa-2` declared is the only one there.
const EXPECTED = {'cidade.transito': {'casa-1': {level: 5}, 'casa-2': {level: 2, demanda: 3}}} as unknown as GameState['components'];

test('the same scenario and the same order of operations give the same semantic hash over Matrix and Nostr', async () => {
 const matrixResult = await overMatrix().then(result => result.run);
 const nostrResult = await overNostr();
 expect(matrixResult.semanticHash).toBe(nostrResult.semanticHash);
 expect(matrixResult.ids).toEqual(OPERATIONS.map(operation => `osim:event:${operation.id}`));
 expect(nostrResult.ids).toEqual(matrixResult.ids);
 expect(matrixResult.semanticHash).toBe(await hashOf(EXPECTED));
});

test('an object a second transport delivers again is applied once', async () => {
 const matrix = await overMatrix(), relay = fakeRelay();
 const signer = await nostrIdentity(32);
 const relayWriter = createNostrRelay({url: 'ws://relay.example', codec, signer: signer.signer, socket: relay.factory});
 // The origin replicates to the room and to the relay; the replica holds both communities as transports at once.
 const writer = createKernel({transports: [await matrix.lab.rooms(matrix.lab.host, matrix.lab.hostIdentity), relayWriter]});
 const reader = createKernel({transports: [await matrix.lab.rooms(matrix.lab.guest, matrix.lab.guestIdentity), createNostrRelay({url: 'ws://relay.example', codec, socket: relay.factory})]});
 const arrived: string[] = [];
 const stop = reader.subscribe({}, object => { arrived.push(object.id); });
 const objects = objectsFor(matrix.lab.hostIdentity.principal.id);
 for (const object of objects) expect((await writer.publish(object)).ok).toBe(true);
 // Every object arrives twice, once from each transport, and the state changes once.
 await expect.poll(() => arrived.length, {timeout: 5000}).toBe(objects.length * 2);
 expect(Object.keys(reader.state().seen).sort()).toEqual(objects.map(object => object.id).sort());
 expect(await hashOf(reader.state().components)).toBe(await hashOf(EXPECTED));
 expect(reader.state().components['cidade.transito']).toEqual(EXPECTED['cidade.transito']);
 // A repeated delivery is answered from what was already applied, not applied again.
 expect(await writer.publish(objects[0]!)).toMatchObject({ok: true, status: 'duplicate'});
 stop();
 relayWriter.close();
});

// --- one WebRTC session across two communities -------------------------------------------------------------------
// The session link of the two guests, in process: two fake peer connections paired by one factory, with the
// descriptions travelling through the manual signals the guests carry. It is the WebRTC adapter's real code (channels,
// descriptions, ICE, backpressure) without a network — and two in-process peers are still not evidence about NAT, so
// nothing here claims that.
type Guest = {actor: string; keys: KeyPair; signaling: ManualSignaling; peers: WebRtcPeers; transport: SessionTransport; refused: WorldError[]};
function guestOf(options: {actor: string; keys: KeyPair; network: {factory: RtcFactory}; bindings: Record<string, string>}): Guest {
 const signaling = createManualSignaling({codec, verifier: ed25519Verifier(), session: SESSION, bindings: options.bindings});
 const refused: WorldError[] = [];
 const config = {
  codec, hasher, actor: options.actor, session: SESSION, signer: {key: options.keys.publicKey, sign: (bytes: Uint8Array) => signEd25519(options.keys, bytes)} as SessionSigner,
  signaling, connection: options.network.factory, onRefused: (_peer: string, error: WorldError) => {refused.push(error);},
 };
 const peers = createWebRtcPeers(config);
 return {actor: options.actor, keys: options.keys, signaling, peers, transport: createWebRtcTransport(config, {peers}), refused};
}
// The players carrying the signals by hand, exactly like the Tarefa 8 session test: a community is not required to
// connect two guests, which is what makes "the same WebRTC session" a session and not a bridge.
const turn = async () => {for (let i = 0; i < 16; i += 1) await Promise.resolve();};
async function carry(guests: Guest[], until: Promise<unknown>): Promise<void> {
 const open = until.then(() => true);
 let done = false;
 void open.then(() => {done = true;});
 for (let round = 0; round < 32; round += 1) {
  const outbox = guests.flatMap(from => from.signaling.pending().map(entry => ({from, ...entry})));
  for (const item of outbox) {
   const to = guests.find(other => other.actor === item.peer);
   if (!to) throw new Error(`Sem destinatário para ${item.peer}`);
   const text = item.from.signaling.copy(item.peer);
   if (text === null) continue;
   const accepted = await to.signaling.paste(text);
   if (!accepted.ok) throw new Error(`Sinal recusado: ${accepted.error.message}`);
  }
  if (!outbox.length && done) break;
  await turn();
 }
 await open;
}

test('a Nostr guest and a Matrix guest share one WebRTC session and the same world, with no chat bridged', async () => {
 const lab = await matrixLab(), relay = fakeRelay();
 const hostNostr = await nostrIdentity(61), guestNostr = await nostrIdentity(62);
 const relayWriter = createNostrRelay({url: 'ws://relay.example', codec, signer: hostNostr.signer, socket: relay.factory});
 const relayGuest = createNostrRelay({url: 'ws://relay.example', codec, socket: relay.factory});
 const roomHost = await lab.rooms(lab.host, lab.hostIdentity), roomGuest = await lab.rooms(lab.guest, lab.guestIdentity);
 const matrixGuest = createKernel({transports: [roomGuest]}), nostrGuest = createKernel({transports: [relayGuest]});
 const matrixSeen: string[] = [], nostrSeen: string[] = [];
 const stopMatrix = matrixGuest.subscribe({}, object => {matrixSeen.push(object.id);});
 const stopNostr = nostrGuest.subscribe({}, object => {nostrSeen.push(object.id);});
 // One session, two communities: the descriptor names the Matrix guest and the Nostr guest, and each one resolves it
 // from its own carrier.
 const participants = [lab.hostIdentity.principal.id, lab.guestIdentity.principal.id, guestNostr.principal.id];
 const descriptor = (actor: string) => envelopeOf('session', `osim:session:${SESSION.sessionId}`, actor, {type: 'session', timeline: 'osim:timeline:main', epoch: SESSION.epoch, mode: 'realtime', participants, startedAt: NOW});
 expect((await roomHost.publish(descriptor(lab.hostIdentity.principal.id))).ok).toBe(true);
 expect((await relayWriter.publish(descriptor(hostNostr.principal.id))).ok).toBe(true);
 for (const object of objectsFor(lab.hostIdentity.principal.id)) expect((await roomHost.publish(object)).ok).toBe(true);
 for (const object of objectsFor(hostNostr.principal.id)) expect((await relayWriter.publish(object)).ok).toBe(true);
 const events = OPERATIONS.map(operation => `osim:event:${operation.id}`);
 const expected = [`osim:session:${SESSION.sessionId}`, ...events];
 await expect.poll(() => matrixSeen.length, {timeout: 5000}).toBe(expected.length);
 await expect.poll(() => nostrSeen.length, {timeout: 5000}).toBe(expected.length);
 expect(matrixSeen).toEqual(expected);
 expect(nostrSeen).toEqual(expected);
 // The session link is one session: a Matrix guest and a Nostr guest, connected to each other with no community in
 // between carrying their signaling.
 const network = wiredPair();
 const bob = guestOf({actor: lab.guestIdentity.principal.id, keys: lab.guestIdentity.session, network, bindings: {[guestNostr.principal.id]: guestNostr.session.publicKey}});
 const carol = guestOf({actor: guestNostr.principal.id, keys: guestNostr.session, network, bindings: {[lab.guestIdentity.principal.id]: lab.guestIdentity.session.publicKey}});
 await bob.peers.invite(carol.actor);
 await carry([bob, carol], bob.peers.opened(carol.actor));
 expect(bob.peers.connected()).toEqual([carol.actor]);
 expect(carol.peers.connected()).toEqual([bob.actor]);
 const heard: string[] = [];
 const stopHeard = carol.transport.subscribe((peer, message) => {heard.push(`${peer}:${String((message.body as {kind?: string}).kind)}`);});
 await bob.transport.send(carol.actor, {envelope: {worldProtocol: WORLD_PROTOCOL, wireVersion: WIRE_VERSION, kind: 'message', class: 'control', worldId: SESSION.worldId, branchId: SESSION.branchId, sessionId: SESSION.sessionId, epoch: SESSION.epoch, id: 'controle-1'}, body: {kind: 'probe'}});
 await expect.poll(() => heard.length, {timeout: 5000}).toBe(1);
 expect(heard).toEqual([`${bob.actor}:probe`]);
 stopHeard();
 // Chats stay where they were written: a relay note without the protocol tag and a room event of another application
 // are never objects, and an object one community cannot vouch for is not bridged into the other.
 const socket = relay.factory('ws://relay.example');
 socket.send(JSON.stringify(['EVENT', await guestNostr.signer.signEvent({kind: 1, created_at: 0, tags: [], content: 'oi, tudo bem?'})]));
 lab.server.inject(lab.roomId, {type: 'com.example.chat.v0', sender: lab.guest.userId, content: {text: 'oi, tudo bem?'}});
 lab.server.inject(lab.roomId, {type: 'org.opensim.world.v0', sender: lab.host.userId, content: envelopeOf('event', 'osim:event:ponte', guestNostr.principal.id, {type: 'event', entity: 'osim:entity:casa-1', component: 'cidade.transito', op: 'set', value: {level: 9}, timeline: 'osim:timeline:main', time: NOW}) as unknown as JsonValue});
 const marker = (actor: string) => envelopeOf('event', 'osim:event:evt-marcador', actor, {type: 'event', entity: 'osim:entity:casa-2', component: 'cidade.transito', op: 'set', value: {level: 3}, timeline: 'osim:timeline:main', time: NOW});
 expect((await roomHost.publish(marker(lab.hostIdentity.principal.id))).ok).toBe(true);
 expect((await relayWriter.publish(marker(hostNostr.principal.id))).ok).toBe(true);
 await expect.poll(() => matrixSeen.length, {timeout: 5000}).toBe(expected.length + 1);
 await expect.poll(() => nostrSeen.length, {timeout: 5000}).toBe(expected.length + 1);
 expect(Object.keys(matrixGuest.state().seen).sort()).toEqual([...events, 'osim:event:evt-marcador'].sort());
 expect(Object.keys(nostrGuest.state().seen).sort()).toEqual([...events, 'osim:event:evt-marcador'].sort());
 expect(matrixSeen).not.toContain('osim:event:ponte');
 expect(roomGuest.refusals().some(refusal => refusal.message.includes('ponte entre comunidades'))).toBe(true);
 expect(relay.stored.some(event => event.kind === 1 && event.content === 'oi, tudo bem?')).toBe(true);
 // Both guests end in the same durable world, whichever community carried it.
 expect(await hashOf(matrixGuest.state().components)).toBe(await hashOf(nostrGuest.state().components));
 expect(await hashOf(matrixGuest.state().components)).toBe(await hashOf({'cidade.transito': {'casa-1': {level: 5}, 'casa-2': {level: 3}}} as unknown as GameState['components']));
 // And the session each of them resolved is the same session, naming both communities.
 const fromRoom = await matrixGuest.join(`osim:session:${SESSION.sessionId}`), fromRelay = await nostrGuest.join(`osim:session:${SESSION.sessionId}`);
 const named = (resolved: {ok: boolean; value: OsimEnvelope | null} | {ok: false; error: WorldError}) => resolved.ok && resolved.value ? (resolved.value.body as {participants?: string[]}).participants : null;
 expect(named(fromRoom)).toEqual(participants);
 expect(named(fromRelay)).toEqual(participants);
 stopMatrix();
 stopNostr();
 bob.peers.close();
 carol.peers.close();
 roomHost.close();
 roomGuest.close();
 relayWriter.close();
 relayGuest.close();
});
