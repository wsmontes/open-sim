import {afterEach,expect,test} from 'vitest';
import {readFileSync} from 'node:fs';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {generateSessionKeyPair,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {signSignal} from '../src/adapters/network/manual-signaling';
import type {SessionScope,SessionSigner,SignalKind,Signaling,SignedSignal} from '../src/adapters/network/manual-signaling';
import {createWebRtcPeers,createWebRtcTransport} from '../src/adapters/network/webrtc';
import type {RtcFactory,WebRtcPeers} from '../src/adapters/network/webrtc';
import {createMatrixIdentity,matrixUriOf,registerAccount} from '../src/adapters/matrix/identity';
import type {MatrixAccount,MatrixIdentity} from '../src/adapters/matrix/identity';
import {ENCRYPTED_EVENT_TYPE,createMatrixRooms,createRoom,joinRoom,roomBinding,roomStanding} from '../src/adapters/matrix/rooms';
import type {RoomBinding,RoomStanding} from '../src/adapters/matrix/rooms';
import {SIGNAL_EVENT_TYPE,createMatrixSignaling,signalEnvelope} from '../src/adapters/matrix/signaling';
import type {MatrixSignaling,MatrixSignalingConfig} from '../src/adapters/matrix/signaling';
import {fakeHomeserver} from './fixtures/matrix-homeserver';
import type {FakeHomeserver} from './fixtures/matrix-homeserver';
import {wiredPair} from './fixtures/rtc-pair';
import type {SessionTransport} from '../src/session/multiplayer-ports';
import {WORLD_PROTOCOL,WIRE_VERSION} from '../src/world/model';
import type {JsonValue,WorldError} from '../src/world/model';

const codec = createJcsCodec(), hasher = bytesHasher();
const NOW = '2026-09-29T12:00:00Z';
const SECRET = 'lab-registration-secret-value';
const SESSION: SessionScope = {worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', epoch: 1};
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const signerOf = (keys: KeyPair): SessionSigner => ({key: keys.publicKey, sign: bytes => signEd25519(keys, bytes)});

// Everything a test opens is closed when it ends: a signaling adapter owns a poll loop and a room subscription, and a
// leaked one would keep talking to the homeserver after the test that built it.
const closers: (() => void)[] = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

// --- the lab: two accounts in one private room, each with an identity the room attests --------------------------
type Lab = {server: FakeHomeserver; alice: MatrixAccount; bob: MatrixAccount; roomId: string; standing: RoomStanding; aliceIdentity: MatrixIdentity; bobIdentity: MatrixIdentity; aliceBinding: RoomBinding; bobBinding: RoomBinding};
async function lab(): Promise<Lab> {
 const server = fakeHomeserver({secret: SECRET}), homeserver = `http://${server.serverName}`;
 const alice = await registerAccount({homeserver, secret: SECRET, username: 'alice', password: 'segredo-de-alice', fetch: server.fetch});
 const bob = await registerAccount({homeserver, secret: SECRET, username: 'bob', password: 'segredo-de-bob', fetch: server.fetch});
 if (!alice.ok) throw new Error(alice.error.message);
 if (!bob.ok) throw new Error(bob.error.message);
 const created = await createRoom(alice.value, {name: 'Mundo Victoria', invite: [bob.value.userId]}, {fetch: server.fetch});
 if (!created.ok) throw new Error(created.error.message);
 const joined = await joinRoom(bob.value, created.value, {fetch: server.fetch});
 if (!joined.ok) throw new Error(joined.error.message);
 const identityOf = async (account: MatrixAccount): Promise<MatrixIdentity> => {
  const device = await generateSessionKeyPair(), session = await generateSessionKeyPair();
  const built = await createMatrixIdentity({account, device, session, codec, now: () => NOW, roomId: created.value, fetch: server.fetch});
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
 };
 const aliceIdentity = await identityOf(alice.value), bobIdentity = await identityOf(bob.value);
 const standing = await roomStanding(alice.value, created.value, {fetch: server.fetch});
 if (!standing.ok) throw new Error(standing.error.message);
 const bindingOf = async (account: MatrixAccount, identity: MatrixIdentity): Promise<RoomBinding> => {
  const proof = await identity.provider(codec).bindSession({principal: identity.principal, scope: {...SESSION, notBefore: at(-60), notAfter: at(3600)}});
  if (!proof.ok) throw new Error(proof.error.message);
  const binding = roomBinding({account, roomId: created.value, standing: standing.value, session: SESSION, sessionKey: identity.session.publicKey, identity: proof.value, approval: {policy: 'open', invite: 'osim:capability:invite-1'}});
  if (!binding.ok) throw new Error(binding.error.message);
  return binding.value;
 };
 return {server, alice: alice.value, bob: bob.value, roomId: created.value, standing: standing.value, aliceIdentity, bobIdentity, aliceBinding: await bindingOf(alice.value, aliceIdentity), bobBinding: await bindingOf(bob.value, bobIdentity)};
}
// The two participants of the session, each carrying its own side of the exchange over the room.
function signalingFor(opened: Lab, account: MatrixAccount, identity: MatrixIdentity, binding: RoomBinding, overrides: Partial<MatrixSignalingConfig> = {}): MatrixSignaling {
 const built = createMatrixSignaling({account, binding, codec, verifier: identity.verifier(), session: SESSION, bindings: {}, fetch: opened.server.fetch, pollMs: 1, ...overrides});
 closers.push(() => built.close());
 return built;
}
async function signalOf(keys: KeyPair, actor: string, session: SessionScope = SESSION, id = 'sinal-1', kind: SignalKind = 'offer'): Promise<SignedSignal> {
 return signSignal({codec, signer: signerOf(keys), actor, session, signal: kind, id, sequence: 1, payload: {description: {type: 'offer', sdp: 'v=0'}}});
}
// A signal written straight into the room, the way a participant that is not this client would write one: the port
// under test only ever reads, so the writer here is the room transport itself.
async function publish(opened: Lab, account: MatrixAccount, binding: RoomBinding, signal: SignedSignal): Promise<void> {
 const rooms = createMatrixRooms({account, binding, codec, fetch: opened.server.fetch, eventType: SIGNAL_EVENT_TYPE});
 try {
  const envelope = signalEnvelope(signal);
  if (!envelope.ok) throw new Error(envelope.error.message);
  const written = await rooms.publish(envelope.value);
  if (!written.ok) throw new Error(written.error.message);
 } finally { rooms.close(); }
}
// The same event the room would deliver twice: a homeserver that repeats what a client already read.
function injectSignal(opened: Lab, signal: SignedSignal, overrides: {room_id?: string; sender?: string; type?: string; envelope?: JsonValue} = {}): string {
 const envelope = signalEnvelope(signal);
 if (!envelope.ok) throw new Error(envelope.error.message);
 return opened.server.inject(opened.roomId, {type: overrides.type ?? SIGNAL_EVENT_TYPE, sender: overrides.sender ?? opened.alice.userId, content: overrides.envelope ?? (envelope.value as unknown as JsonValue), ...(overrides.room_id === undefined ? {} : {room_id: overrides.room_id})});
}
const aliceUri = (opened: Lab) => matrixUriOf(opened.alice.userId), bobUri = (opened: Lab) => matrixUriOf(opened.bob.userId);

test('a signed offer travels as a room event, and the signal does not come back to its sender', async () => {
 const opened = await lab();
 const alice = signalingFor(opened, opened.alice, opened.aliceIdentity, opened.aliceBinding, {bindings: {[bobUri(opened)]: opened.bobIdentity.session.publicKey}});
 const bob = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {bindings: {[aliceUri(opened)]: opened.aliceIdentity.session.publicKey}});
 const mine: string[] = [], theirs: SignedSignal[] = [];
 closers.push(alice.subscribe(peer => {mine.push(peer);}), bob.subscribe((_peer, signal) => {theirs.push(signal);}));
 await alice.send(bobUri(opened), await signalOf(opened.aliceIdentity.session, aliceUri(opened)));
 await expect.poll(() => theirs.length, {timeout: 5000}).toBe(1);
 expect(theirs[0]).toMatchObject({kind: 'signal', signal: 'offer', actor: aliceUri(opened), sessionId: SESSION.sessionId, epoch: SESSION.epoch});
 expect(theirs[0]!.proof.sessionKey).toBe(opened.aliceIdentity.session.publicKey);
 expect(theirs[0]!.payload).toEqual({description: {type: 'offer', sdp: 'v=0'}});
 // The room hands this client back what it wrote, in the order it was written. Bob answers afterwards: by the time
 // this device has read the answer, the earlier event it wrote itself has been read and skipped, not delivered.
 await bob.send(aliceUri(opened), await signalOf(opened.bobIdentity.session, bobUri(opened), SESSION, 'resposta-1', 'answer'));
 await expect.poll(() => mine.length, {timeout: 5000}).toBe(1);
 expect(mine).toEqual([bobUri(opened)]);
 expect(theirs.map(signal => signal.id)).toEqual(['sinal-1']);
});

test('a signal of another room, of another session or of another epoch never reaches the transport', async () => {
 const opened = await lab();
 const bob = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {bindings: {[aliceUri(opened)]: opened.aliceIdentity.session.publicKey}});
 const theirs: SignedSignal[] = [];
 closers.push(bob.subscribe((_peer, signal) => {theirs.push(signal);}));
 const aliceKeys = opened.aliceIdentity.session;
 // A homeserver answering a read of this room with an event of another room is not answering this room.
 injectSignal(opened, await signalOf(aliceKeys, aliceUri(opened), SESSION, 'sinal-outra-sala'), {room_id: '!outra:matrix.test'});
 await publish(opened, opened.alice, opened.aliceBinding, await signalOf(aliceKeys, aliceUri(opened), {...SESSION, sessionId: 'outra-sessao'}, 'sinal-outra-sessao'));
 await publish(opened, opened.alice, opened.aliceBinding, await signalOf(aliceKeys, aliceUri(opened), {...SESSION, epoch: SESSION.epoch - 1}, 'sinal-antiga'));
 await publish(opened, opened.alice, opened.aliceBinding, await signalOf(aliceKeys, aliceUri(opened), {...SESSION, epoch: SESSION.epoch + 1}, 'sinal-futura'));
 await publish(opened, opened.alice, opened.aliceBinding, await signalOf(aliceKeys, aliceUri(opened), SESSION, 'sinal-desta'));
 await expect.poll(() => theirs.length, {timeout: 5000}).toBe(1);
 expect(theirs.map(signal => signal.id)).toEqual(['sinal-desta']);
 // The gate's own refusals come first, then what the room refused to hand over at all.
 const refusals = bob.refused();
 expect(refusals.map(error => error.code)).toEqual(['CONFLICT', 'CONFLICT', 'CONFLICT', 'PERMISSION']);
 expect(refusals[3]!.message).toContain('!outra:matrix.test');
 expect(refusals[0]!.message).toContain('outra sessão');
 expect(refusals[1]!.message).toContain(`época anterior ${SESSION.epoch - 1}`);
 expect(refusals[2]!.message).toContain(`época ${SESSION.epoch + 1}`);
});

test('a room member without a session binding is not a peer of this session', async () => {
 const opened = await lab();
 const unbound = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding);
 const theirs: SignedSignal[] = [];
 closers.push(unbound.subscribe((_peer, signal) => {theirs.push(signal);}));
 await publish(opened, opened.alice, opened.aliceBinding, await signalOf(opened.aliceIdentity.session, aliceUri(opened), SESSION, 'sinal-sem-vinculo'));
 await expect.poll(() => unbound.refused().length, {timeout: 5000}).toBe(1);
 expect(unbound.refused()[0]).toMatchObject({code: 'SIGNATURE'});
 expect(unbound.refused()[0]!.message).toContain('não está vinculado');
 expect(theirs).toEqual([]);
});

test('the session key of the binding decides which signal is the account s', async () => {
 const opened = await lab();
 // The binding of the room names the session key of the account; a signal signed by another key is refused before it
 // is an offer — even when it names the account the room attests.
 const swapped = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {bindings: {[aliceUri(opened)]: opened.bobIdentity.session.publicKey}});
 const theirs: SignedSignal[] = [];
 closers.push(swapped.subscribe((_peer, signal) => {theirs.push(signal);}));
 await publish(opened, opened.alice, opened.aliceBinding, await signalOf(opened.aliceIdentity.session, aliceUri(opened), SESSION, 'sinal-chave-trocada'));
 await expect.poll(() => swapped.refused().length, {timeout: 5000}).toBe(1);
 expect(swapped.refused()[0]).toMatchObject({code: 'SIGNATURE'});
 expect(swapped.refused()[0]!.message).toContain('chave de sessão');
 expect(theirs).toEqual([]);
});

test('a proof that names the bound key but is not its signature is refused', async () => {
 const opened = await lab();
 const accepted: SignedSignal[] = [];
 const receiver = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {bindings: {[aliceUri(opened)]: opened.aliceIdentity.session.publicKey}});
 closers.push(receiver.subscribe((_peer, signal) => {accepted.push(signal);}));
 // The proof has to name the bound key to reach the signature at all, so the forgery names it while really signing
 // with another key — which is the one thing the detached proof exists to catch.
 const outside = await signalOf(await generateSessionKeyPair(), aliceUri(opened), SESSION, 'sinal-assinado-fora');
 await publish(opened, opened.alice, opened.aliceBinding, {...outside, proof: {...outside.proof, sessionKey: opened.aliceIdentity.session.publicKey}});
 await expect.poll(() => receiver.refused().length, {timeout: 5000}).toBe(1);
 expect(receiver.refused()[0]).toMatchObject({code: 'SIGNATURE'});
 expect(receiver.refused()[0]!.message).toContain('assinatura');
 expect(accepted).toEqual([]);
	// The same adapter takes the signal the room binding really delegated.
 await publish(opened, opened.alice, opened.aliceBinding, await signalOf(opened.aliceIdentity.session, aliceUri(opened), SESSION, 'sinal-legitimo'));
 await expect.poll(() => accepted.length, {timeout: 5000}).toBe(1);
 expect(accepted.map(signal => signal.id)).toEqual(['sinal-legitimo']);
});

test('a signal whose body names another actor than the room attests is refused', async () => {
 const opened = await lab();
 const bob = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {bindings: {[bobUri(opened)]: opened.bobIdentity.session.publicKey}});
 const theirs: SignedSignal[] = [];
 closers.push(bob.subscribe((_peer, signal) => {theirs.push(signal);}));
 // The room attests alice as the sender, but the document inside claims Bob's actor and really is signed by Bob's key.
 publishInjectedBody(opened, opened.alice, opened.aliceBinding, await signalOf(opened.bobIdentity.session, bobUri(opened), SESSION, 'sinal-outro-ator'));
 await expect.poll(() => bob.refused().length, {timeout: 5000}).toBe(1);
 expect(bob.refused()[0]).toMatchObject({code: 'PERMISSION'});
 expect(bob.refused()[0]!.message).toContain('ator');
 expect(theirs).toEqual([]);
});

test('an encrypted event this client cannot open is refused, and an unseal port opens a signal', async () => {
 const opened = await lab();
 const sealed = (signal: SignedSignal): JsonValue => {
  const envelope = signalEnvelope(signal);
  if (!envelope.ok) throw new Error(envelope.error.message);
  return {algorithm: 'm.megolm.v1.aes-sha2', ciphertext: JSON.stringify(envelope.value)};
 };
 const blind = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {bindings: {[aliceUri(opened)]: opened.aliceIdentity.session.publicKey}});
 const theirs: SignedSignal[] = [];
 closers.push(blind.subscribe((_peer, signal) => {theirs.push(signal);}));
 opened.server.inject(opened.roomId, {type: ENCRYPTED_EVENT_TYPE, sender: opened.alice.userId, content: sealed(await signalOf(opened.aliceIdentity.session, aliceUri(opened), SESSION, 'sinal-cifrado'))});
 await expect.poll(() => blind.refused().length, {timeout: 5000}).toBe(1);
 expect(blind.refused()[0]).toMatchObject({code: 'NOT_FOUND'});
 expect(blind.refused()[0]!.message).toContain('cifrado');
 // A client that holds the cipher opens the same event: the port is the decryption, not a bypass of the checks.
 const openedWithKey = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {
  bindings: {[aliceUri(opened)]: opened.aliceIdentity.session.publicKey},
  unseal: async event => {
   const content = event.content as Record<string, JsonValue>;
   return {ok: true, value: JSON.parse(String(content['ciphertext'])) as JsonValue};
  },
 });
 closers.push(openedWithKey.subscribe((_peer, signal) => {theirs.push(signal);}));
 await expect.poll(() => theirs.length, {timeout: 5000}).toBe(1);
 expect(theirs[0]!.id).toBe('sinal-cifrado');
});

test('the same signal read twice is applied once, and an id already used is not a new offer', async () => {
 const opened = await lab();
 const bob = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {bindings: {[aliceUri(opened)]: opened.aliceIdentity.session.publicKey}});
 const theirs: SignedSignal[] = [];
 closers.push(bob.subscribe((_peer, signal) => {theirs.push(signal);}));
 const offer = await signalOf(opened.aliceIdentity.session, aliceUri(opened), SESSION, 'sinal-repetido');
 await publish(opened, opened.alice, opened.aliceBinding, offer);
 await expect.poll(() => theirs.length, {timeout: 5000}).toBe(1);
 // The room delivers the same event again (an overlapping sync, a duplicated page): it is not a second offer. The
 // refusal of the repeat is the signal that the second read happened at all.
 injectSignal(opened, offer);
 await expect.poll(() => bob.refused().length, {timeout: 5000}).toBe(1);
 expect(theirs).toHaveLength(1);
 expect(bob.refused().map(error => error.code)).toEqual(['CONFLICT']);
 expect(bob.refused()[0]!.message).toContain('já foi usado');
});

test('only this project signal event type is a signal: a foreign namespace is refused for reading and for writing', async () => {
 const opened = await lab();
 const bob = signalingFor(opened, opened.bob, opened.bobIdentity, opened.bobBinding, {bindings: {[aliceUri(opened)]: opened.aliceIdentity.session.publicKey}});
 const theirs: SignedSignal[] = [];
 closers.push(bob.subscribe((_peer, signal) => {theirs.push(signal);}));
 // Another application's room event, and this project's own type carrying a document that is not a signal.
 opened.server.inject(opened.roomId, {type: 'com.example.chat.v0', sender: opened.alice.userId, content: {text: 'oi'}});
 opened.server.inject(opened.roomId, {type: SIGNAL_EVENT_TYPE, sender: opened.alice.userId, content: {osim: '0.1', type: 'event', id: 'osim:event:nao-e-sinal', actor: aliceUri(opened), body: {type: 'event'}}});
 opened.server.inject(opened.roomId, {type: SIGNAL_EVENT_TYPE, sender: opened.alice.userId, content: {osim: '0.1', type: 'session', id: 'osim:session:x', actor: aliceUri(opened), body: {kind: 'signal', campo: 'desconhecido'}}});
 await publish(opened, opened.alice, opened.aliceBinding, await signalOf(opened.aliceIdentity.session, aliceUri(opened), SESSION, 'sinal-valido'));
 await expect.poll(() => theirs.length, {timeout: 5000}).toBe(1);
 expect(theirs.map(signal => signal.id)).toEqual(['sinal-valido']);
 expect(bob.refused().map(error => error.code)).toEqual(['MALFORMED', 'MALFORMED']);
 // Writing is fenced the same way: a configured type outside the controlled namespace is refused before a request.
 const outside = signalingFor(opened, opened.alice, opened.aliceIdentity, opened.aliceBinding, {eventType: 'com.example.opensim.signal'});
 await expect(outside.send(bobUri(opened), await signalOf(opened.aliceIdentity.session, aliceUri(opened)))).rejects.toThrow(/namespace/);
 expect(opened.server.events(opened.roomId).some(event => event.type === 'com.example.opensim.signal')).toBe(false);
});

function publishInjectedBody(opened: Lab, account: MatrixAccount, _binding: RoomBinding, signal: SignedSignal): void {
 const envelope = signalEnvelope(signal);
 if (!envelope.ok) throw new Error(envelope.error.message);
 // The wrapper is the one the room will accept (its actor is the sender); only the body names another account.
 const wrapper = {...envelope.value, actor: account.userId === opened.alice.userId ? aliceUri(opened) : bobUri(opened)};
 opened.server.inject(opened.roomId, {type: SIGNAL_EVENT_TYPE, sender: account.userId, content: wrapper as unknown as JsonValue});
}

// --- the real lab: two accounts on two homeservers, joined by federation -----------------------------------------
// Nothing above leaves the process. This one only runs when the operator names two real homeservers, and it proves the
// one thing a fake cannot: the signaling of a session crosses a federation boundary between two accounts that no
// single server authenticated. The registration secret is read from a file and never printed, and the environment is
// discarded afterwards (`OSIM_MATRIX_HOMESERVER`, `OSIM_MATRIX_HOMESERVER_B`, `OSIM_MATRIX_SECRET_FILE`).
const HOMESERVER = process.env.OSIM_MATRIX_HOMESERVER;
const HOMESERVER_B = process.env.OSIM_MATRIX_HOMESERVER_B;
const SECRET_FILE = process.env.OSIM_MATRIX_SECRET_FILE ?? '/tmp/opensim-matrix-lab/registration-secret.txt';
const instant = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

// The two ports of one link, built exactly like the WebRTC adapter builds them: the signaling is injected, so the same
// session code runs over a hand-carried text, a relay or a room.
function sessionPeer(options: {actor: string; keys: KeyPair; signaling: Signaling; network: {factory: RtcFactory}}): {peers: WebRtcPeers; transport: SessionTransport; refused: WorldError[]} {
 const refused: WorldError[] = [];
 const config = {
  codec, hasher, actor: options.actor, session: SESSION,
  signer: {key: options.keys.publicKey, sign: (bytes: Uint8Array) => signEd25519(options.keys, bytes)} as SessionSigner,
  signaling: options.signaling, connection: options.network.factory,
  onRefused: (_peer: string, error: WorldError) => {refused.push(error);},
 };
 const peers = createWebRtcPeers(config);
 return {peers, transport: createWebRtcTransport(config, {peers}), refused};
}

test.skipIf(!HOMESERVER || !HOMESERVER_B)('homeservers real: two accounts on two homeservers signal the same session, which outlives its signaling', async () => {
 const secret = readFileSync(SECRET_FILE, 'utf8').trim();
 const stamp = Date.now().toString(36);
 const alice = await registerAccount({homeserver: HOMESERVER!, secret, username: `alice-${stamp}`, password: `segredo-${stamp}`});
 const bob = await registerAccount({homeserver: HOMESERVER_B!, secret, username: `bob-${stamp}`, password: `segredo-${stamp}`});
 if (!alice.ok) throw new Error(alice.error.message);
 if (!bob.ok) throw new Error(bob.error.message);
 // Two server names, two registrations, and one of them only becomes a member of this room by federation.
 const serverOf = (userId: string) => userId.slice(userId.indexOf(':') + 1);
 expect(serverOf(alice.value.userId)).not.toBe(serverOf(bob.value.userId));
 expect(serverOf(alice.value.userId).length).toBeGreaterThan(0);
 const created = await createRoom(alice.value, {name: `Mundo Victoria ${stamp}`, invite: [bob.value.userId]});
 if (!created.ok) throw new Error(created.error.message);
 const joined = await joinRoom(bob.value, created.value);
 if (!joined.ok) throw new Error(`Ingresso federado recusado: ${joined.error.message}`);
 const identityOf = async (account: MatrixAccount): Promise<MatrixIdentity> => {
  const built = await createMatrixIdentity({account, device: await generateSessionKeyPair(), session: await generateSessionKeyPair(), codec, now: () => instant(0), roomId: created.value});
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
 };
 const aliceIdentity = await identityOf(alice.value), bobIdentity = await identityOf(bob.value);
 const bindingOf = async (account: MatrixAccount, identity: MatrixIdentity): Promise<RoomBinding> => {
  const standing = await roomStanding(account, created.value);
  if (!standing.ok) throw new Error(standing.error.message);
  const proof = await identity.provider(codec).bindSession({principal: identity.principal, scope: {...SESSION, notBefore: instant(-60_000), notAfter: instant(3_600_000)}});
  if (!proof.ok) throw new Error(proof.error.message);
  const binding = roomBinding({account, roomId: created.value, standing: standing.value, session: SESSION, sessionKey: identity.session.publicKey, identity: proof.value, approval: {policy: 'open', invite: 'osim:capability:invite-1'}});
  if (!binding.ok) throw new Error(binding.error.message);
  return binding.value;
 };
 const aliceActor = matrixUriOf(alice.value.userId), bobActor = matrixUriOf(bob.value.userId);
 const aliceSignaling = createMatrixSignaling({account: alice.value, binding: await bindingOf(alice.value, aliceIdentity), codec, verifier: aliceIdentity.verifier(), session: SESSION, bindings: {[bobActor]: bobIdentity.session.publicKey}, pollMs: 250});
 const bobSignaling = createMatrixSignaling({account: bob.value, binding: await bindingOf(bob.value, bobIdentity), codec, verifier: bobIdentity.verifier(), session: SESSION, bindings: {[aliceActor]: aliceIdentity.session.publicKey}, pollMs: 250});
 closers.push(() => aliceSignaling.close(), () => bobSignaling.close());
 expect(aliceSignaling.roomId()).toBe(created.value);
 // The offer leaves one homeserver, the answer leaves the other, and both gates accept what arrived: the link only
 // opens if the signature, the session, the epoch and the key binding of the invite all held.
 const network = wiredPair();
 const alicePeer = sessionPeer({actor: aliceActor, keys: aliceIdentity.session, signaling: aliceSignaling, network});
 const bobPeer = sessionPeer({actor: bobActor, keys: bobIdentity.session, signaling: bobSignaling, network});
 await alicePeer.peers.invite(bobActor);
 await alicePeer.peers.opened(bobActor);
 expect(alicePeer.peers.connected()).toEqual([bobActor]);
 expect(bobPeer.peers.connected()).toEqual([aliceActor]);
 expect([...aliceSignaling.refused(), ...bobSignaling.refused(), ...alicePeer.refused, ...bobPeer.refused]).toEqual([]);
 // Signaling off, session on: with both adapters closed the link keeps carrying the session.
 const heard: string[] = [];
 const stop = bobPeer.transport.subscribe((from, message) => {heard.push(`${from}:${String((message.body as {kind?: string}).kind)}`);});
 aliceSignaling.close();
 bobSignaling.close();
 const delivered = await alicePeer.transport.send(bobActor, {envelope: {worldProtocol: WORLD_PROTOCOL, wireVersion: WIRE_VERSION, kind: 'message', class: 'control', worldId: SESSION.worldId, branchId: SESSION.branchId, sessionId: SESSION.sessionId, epoch: SESSION.epoch, id: 'controle-1'}, body: {kind: 'probe'}});
 expect(delivered).toBeUndefined();
 expect(heard).toEqual([`${aliceActor}:probe`]);
 stop();
 alicePeer.peers.close();
 bobPeer.peers.close();
}, 180_000);
