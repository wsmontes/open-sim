import {readFileSync} from 'node:fs';
import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {generateSessionKeyPair,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {NETWORK_LIMITS} from '../src/world/wire';
import {authorize,grantBytes,identityBytes,proposalBytes} from '../src/world/permissions';
import type {ActionCapability,Grant,IdentityProof,Proposal} from '../src/world/permissions';
import {createKernel} from '../src/world/kernel';
import {envelopeOf} from '../src/world/osim';
import {durableJson} from '../src/core/protocol';
import {createGame} from '../src/core/commands';
import type {GameState} from '../src/core/model';
import type {Head,JsonValue} from '../src/world/model';
import {blank} from './fixtures/world';
import {fakeHomeserver} from './fixtures/matrix-homeserver';
import type {FakeHomeserver} from './fixtures/matrix-homeserver';
import {IDENTITY_EVENT_TYPE,bindingBody,confirmBinding,createMatrixIdentity,loginAccount,matrixPrincipalOf,matrixUriOf,registerAccount,verifyAccount,verifyMatrixBinding} from '../src/adapters/matrix/identity';
import type {MatrixAccount,MatrixBinding,MatrixFetch,MatrixIdentity} from '../src/adapters/matrix/identity';
import {CAPABILITY_EVENT_TYPE,ENCRYPTED_EVENT_TYPE,WORLD_EVENT_TYPE,bindingAllowsRoom,createMatrixInviteService,createMatrixRooms,createRoom,inviteFromEvent,joinRoom,roomBinding,roomStanding,verifyMatrixJoinRequest} from '../src/adapters/matrix/rooms';
import type {MatrixInviteInput,MatrixRooms,RoomBinding,RoomStanding} from '../src/adapters/matrix/rooms';

const codec = createJcsCodec(), hasher = bytesHasher();
const NOW = '2026-09-29T12:00:00Z';
const SECRET = 'lab-registration-secret-value';
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const head: Head = {worldId: 'victoria', branchId: 'main', commit: {hash: 'aa'.repeat(32), bytes: 64}, generation: 7};
const session = {worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', epoch: 1};
const text = (value: JsonValue): string => new TextDecoder().decode(codec.encode(value));
const world = (): GameState => createGame('victoria', 7, blank('9:9'));

// --- the lab: two accounts in one private room, each with an identity the room attests --------------------------
type Lab = {
 server: FakeHomeserver;
 alice: MatrixAccount;
 bob: MatrixAccount;
 roomId: string;
 standing: RoomStanding;
 aliceIdentity: MatrixIdentity;
 bobIdentity: MatrixIdentity;
 aliceBinding: MatrixBinding;
 bobBinding: MatrixBinding;
};
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
 const aliceIdentity = await identityFor(alice.value, created.value, server.fetch);
 const bobIdentity = await identityFor(bob.value, created.value, server.fetch);
 const standing = await roomStanding(alice.value, created.value, {fetch: server.fetch});
 if (!standing.ok) throw new Error(standing.error.message);
 return {server, alice: alice.value, bob: bob.value, roomId: created.value, standing: standing.value, aliceIdentity, bobIdentity, aliceBinding: aliceIdentity.binding, bobBinding: bobIdentity.binding};
}
async function identityFor(account: MatrixAccount, roomId: string, fetch?: MatrixFetch): Promise<MatrixIdentity> {
 const device = await generateSessionKeyPair(), sessionKey = await generateSessionKeyPair();
 const built = await createMatrixIdentity({account, device, session: sessionKey, codec, now: () => NOW, roomId, fetch});
 if (!built.ok) throw new Error(built.error.message);
 return built.value;
}
async function proofOf(identity: MatrixIdentity, scope = session): Promise<IdentityProof> {
 const proof = await identity.provider(codec).bindSession({principal: identity.principal, scope: {...scope, notBefore: at(-60), notAfter: at(3600)}});
 if (!proof.ok) throw new Error(proof.error.message);
 return proof.value;
}
async function bindingOf(created: Lab, account: MatrixAccount, identity: MatrixIdentity, approval: RoomBinding['approval'] = {policy: 'open', invite: 'osim:capability:invite-1'}): Promise<RoomBinding> {
 const binding = roomBinding({account, roomId: created.roomId, standing: created.standing, session, sessionKey: identity.session.publicKey, identity: await proofOf(identity), approval});
 if (!binding.ok) throw new Error(binding.error.message);
 return binding.value;
}
function inviteInput(overrides: Partial<MatrixInviteInput> = {}): MatrixInviteInput {
 return {
  worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', epoch: 1, head, startedAt: NOW,
  endpoints: [{transport: 'matrix', uri: 'https://matrix.test/#victoria'}, {transport: 'webrtc', uri: 'osim:session:sessao-1'}],
  policy: {kind: 'open'}, actions: ['build'], notBefore: at(-60), notAfter: at(3600), ...overrides,
 };
}
async function grantWith(principal: MatrixAccount, signer: KeyPair, actions: readonly ActionCapability[]): Promise<Grant> {
 const draft: Grant = {
  kind: 'grant', id: 'concessao-1', principal: {scheme: 'matrix', id: matrixUriOf(principal.userId)}, worldId: 'victoria', branchId: 'main',
  actions, namespaces: ['cidade.transito'], spendLimit: 100, epoch: 1,
  proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: signer.publicKey, signature: ''},
 };
 return {...draft, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: draft.proof.sessionKey, signature: await signEd25519(signer, grantBytes(draft, codec))}};
}
async function proposalFrom(identity: MatrixIdentity, action: 'build' | 'component'): Promise<Proposal> {
 const draft: Proposal = {
  worldProtocol: 2, wireVersion: 1, kind: 'proposal', worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', epoch: 1,
  id: 'proposta-1', principal: identity.principal, sessionKey: identity.session.publicKey, observedHead: head.commit,
  intent: action === 'build' ? {type: 'build', tool: 'park', cells: [{x: 289, y: 289}]} : {type: 'component', key: 'cidade.transito', entity: 'casa-1', value: {level: 1}},
  preconditions: {revision: 0}, costLimit: 50, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: identity.session.publicKey, signature: ''},
 };
 return {...draft, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: draft.proof.sessionKey, signature: await signEd25519(identity.session, proposalBytes(draft, codec))}};
}
// The durable world a client ends up with after applying what the room delivered, in the order it delivered it.
async function worldFrom(transport: MatrixRooms): Promise<{hash: string; ids: string[]}> {
 const kernel = createKernel();
 const found = await transport.query({});
 if (!found.ok) throw new Error(found.error.message);
 for (const object of found.value) {
  const applied = await kernel.publish(object);
  if (!applied.ok) throw new Error(applied.error.message);
 }
 const state = {...world(), components: kernel.state().components};
 return {hash: (await hasher.ref(new TextEncoder().encode(durableJson(state)))).hash, ids: found.value.map(object => object.id)};
}

// --- the account -----------------------------------------------------------------------------------------------
test('an account registers with the shared secret and its token is checked against the homeserver', async () => {
 const server = fakeHomeserver({secret: SECRET}), homeserver = `http://${server.serverName}`;
 expect(await registerAccount({homeserver, secret: 'outro-segredo-qualquer', username: 'carol', password: 'segredo-de-carol', fetch: server.fetch})).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 const registered = await registerAccount({homeserver, secret: SECRET, username: 'carol', password: 'segredo-de-carol', fetch: server.fetch});
 expect(registered).toMatchObject({ok: true, value: {userId: '@carol:matrix.test'}});
 if (!registered.ok) return;
 expect(await verifyAccount(registered.value, {fetch: server.fetch})).toMatchObject({ok: true, value: {userId: '@carol:matrix.test', deviceId: 'DEVICE1'}});
 // A token the homeserver does not know is not an account, whatever the caller believes.
 expect(await verifyAccount({...registered.value, accessToken: 'token-inexistente'}, {fetch: server.fetch})).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 expect(await loginAccount({homeserver, user: 'carol', password: 'segredo-de-carol', fetch: server.fetch})).toMatchObject({ok: true, value: {userId: '@carol:matrix.test'}});
 expect(await loginAccount({homeserver, user: 'carol', password: 'errada', fetch: server.fetch})).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
});

test('the device binding is a room event the homeserver attributes to the account', async () => {
 const opened = await lab();
 const written = opened.server.events(opened.roomId).filter(event => event.type === IDENTITY_EVENT_TYPE && event.sender === opened.alice.userId);
 expect(written).toHaveLength(1);
 expect(written[0]!.content).toEqual(bindingBody(opened.aliceBinding));
 expect(opened.aliceBinding.attestation).toEqual({roomId: opened.roomId, eventId: written[0]!.event_id});
 expect(opened.aliceBinding).toMatchObject({kind: 'matrix-binding', version: 1, userId: '@alice:matrix.test', homeserver: 'http://matrix.test'});
 expect(verifyMatrixBinding(opened.aliceBinding)).toMatchObject({ok: true});
 // The actor of the protocol is the account's URI; no Matrix field is needed to write it down.
 expect(matrixUriOf('@alice:matrix.test')).toBe('matrix:@alice:matrix.test');
 expect(matrixPrincipalOf('@alice:matrix.test')).toEqual({ok: true, value: {scheme: 'matrix', id: 'matrix:@alice:matrix.test'}});
 expect(matrixPrincipalOf('alice')).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
});

test('a binding whose account and homeserver disagree, or whose attestation is not a room event, is refused', async () => {
 const opened = await lab();
 expect(verifyMatrixBinding({...opened.aliceBinding, userId: '@alice:outro.test'})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
 expect(verifyMatrixBinding({...opened.aliceBinding, deviceKey: 'não-é-chave'})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
 expect(verifyMatrixBinding({...opened.aliceBinding, issuedAt: 'ontem'})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
 expect(verifyMatrixBinding({...opened.aliceBinding, attestation: {roomId: 'victoria', eventId: 'x'}})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
});

test('a session key another identity signed, or a proof altered afterwards, is refused', async () => {
 const opened = await lab();
 const aliceProof = await proofOf(opened.aliceIdentity);
 expect(await opened.aliceIdentity.verifier().verify(aliceProof, identityBytes(aliceProof, codec))).toBe(true);
 // The same delegation checked against Bob's binding is not Alice's: the account decides, not the signature alone.
 expect(await opened.bobIdentity.verifier().verify(aliceProof, identityBytes(aliceProof, codec))).toBe(false);
 // Exchanging the session key after the delegation was signed breaks the bytes the delegation covers.
 const swapped = {...aliceProof, sessionKey: opened.bobIdentity.session.publicKey};
 expect(await opened.aliceIdentity.verifier().verify(swapped, identityBytes(swapped, codec))).toBe(false);
 // And a binding that delegates another account's key than the one it names is refused before any signature.
 expect(await opened.aliceIdentity.verifier().verify({...aliceProof, delegation: {...aliceProof.delegation, key: opened.bobIdentity.device.publicKey}}, identityBytes(aliceProof, codec))).toBe(false);
 // A request for another account is a forgery attempt, not a binding error.
 expect(await opened.aliceIdentity.provider(codec).bindSession({principal: opened.bobIdentity.principal, scope: {...session, notBefore: at(-60), notAfter: at(3600)}})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
});

test('the binding is anchored in the room: the homeserver says which account wrote it', async () => {
 const opened = await lab();
 expect(await confirmBinding(opened.bob, opened.aliceBinding, {fetch: opened.server.fetch})).toMatchObject({ok: true});
 // A binding nobody wrote into a room has no account behind it, even when the document itself is well formed.
 expect(await confirmBinding(opened.bob, {...opened.aliceBinding, deviceKey: 'ab'.repeat(32)}, {fetch: opened.server.fetch})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
 expect(await confirmBinding(opened.bob, {...opened.aliceBinding, attestation: {roomId: opened.roomId, eventId: '$ausente:matrix.test'}}, {fetch: opened.server.fetch})).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
});

// --- the room --------------------------------------------------------------------------------------------------
test('a private room has a standing this client can read, and a public one is not a room for a private world', async () => {
 const opened = await lab();
 expect(opened.standing).toMatchObject({joinRule: 'invite', encrypted: false, powerLevel: 100});
 expect(opened.standing.users['@alice:matrix.test']).toBe(100);
 expect(opened.standing.users['@bob:matrix.test']).toBeUndefined();
 const identity = await proofOf(opened.aliceIdentity);
 const base = {account: opened.alice, roomId: opened.roomId, session, sessionKey: opened.aliceIdentity.session.publicKey, identity, approval: {policy: 'open' as const, invite: 'osim:capability:invite-1'}};
 expect(roomBinding({...base, standing: {...opened.standing, joinRule: 'public'}})).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 expect(roomBinding({...base, standing: {...opened.standing, historyVisibility: 'world_readable'}})).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
});

test('the room binding ties the account, the room, the session key and the invite approval', async () => {
 const opened = await lab();
 const bound = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 expect(bound).toMatchObject({kind: 'room-binding', version: 1, account: {userId: '@alice:matrix.test', homeserver: 'http://matrix.test'}, room: {roomId: opened.roomId, joinRule: 'invite'}, session, sessionKey: opened.aliceIdentity.session.publicKey});
 const identity = await proofOf(opened.aliceIdentity);
 const base = {account: opened.alice, roomId: opened.roomId, standing: opened.standing, session, sessionKey: opened.aliceIdentity.session.publicKey, identity, approval: {policy: 'open' as const, invite: 'osim:capability:invite-1'}};
 // A session key that is not the one the identity delegated is not this account's.
 expect(roomBinding({...base, sessionKey: opened.bobIdentity.session.publicKey})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
 // The identity proof has to be for this account and this session.
 expect(roomBinding({...base, identity: {...identity, principal: {scheme: 'matrix', id: 'matrix:@bob:matrix.test'}}})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
 expect(roomBinding({...base, identity: {...identity, scope: {...identity.scope, sessionId: 'outra-sessao'}}})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
 // An approval policy without the host's grant carries no proof of approval.
 expect(roomBinding({...base, approval: {policy: 'approval', invite: 'osim:capability:invite-1'}})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
 const grant = await grantWith(opened.alice, opened.aliceIdentity.session, ['build']);
 expect(roomBinding({...base, approval: {policy: 'approval', invite: 'osim:capability:invite-1', grant}})).toMatchObject({ok: true, value: {approval: {policy: 'approval', invite: 'osim:capability:invite-1'}}});
 expect(roomBinding({...base, approval: {policy: 'approval', invite: 'osim:capability:invite-1', grant: {...grant, branchId: 'outra'}}})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
 expect(roomBinding({...base, approval: {policy: 'recipient', invite: 'osim:capability:invite-1', grant: {...grant, principal: {scheme: 'matrix', id: 'matrix:@bob:matrix.test'}}}})).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 expect(roomBinding({...base, roomId: 'victoria'})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
});

test('an event from another room never reaches the kernel, and the refusal names it', async () => {
 const opened = await lab();
 const binding = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 const transport = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch});
 const object = envelopeOf('entity', 'osim:entity:house-42', opened.aliceIdentity.principal.id, {components: {'cidade.transito': {level: 2}}});
 expect(await transport.publish(object)).toEqual({ok: true, value: undefined});
 expect(bindingAllowsRoom(binding, opened.server.events(opened.roomId)[0]!)).toBe(true);
 // A server that answers a read with an event of another room is not a read of this room.
 opened.server.inject(opened.roomId, {type: WORLD_EVENT_TYPE, room_id: '!outra:matrix.test', content: object as unknown as JsonValue});
 expect(bindingAllowsRoom(binding, opened.server.events(opened.roomId).at(-1)!)).toBe(false);
 expect(await transport.query({})).toEqual({ok: true, value: [object]});
 const refused = transport.refusals();
 expect(refused).toHaveLength(1);
 expect(refused[0]).toMatchObject({code: 'PERMISSION'});
 expect(refused[0]!.message).toContain('!outra:matrix.test');
 transport.close();
});

test('an object its sender cannot vouch for is dropped, and a Nostr actor is not bridged here', async () => {
 const opened = await lab();
 const binding = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 const transport = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch});
 const honest = envelopeOf('entity', 'osim:entity:house-43', opened.aliceIdentity.principal.id, {components: {'cidade.transito': {level: 1}}});
 expect((await transport.publish(honest)).ok).toBe(true);
 // A member may post anything into the room; the room only vouches for what the account itself wrote.
 opened.server.inject(opened.roomId, {type: WORLD_EVENT_TYPE, sender: opened.alice.userId, content: envelopeOf('entity', 'osim:entity:forged', opened.bobIdentity.principal.id, {components: {}}) as unknown as JsonValue});
 opened.server.inject(opened.roomId, {type: WORLD_EVENT_TYPE, sender: opened.alice.userId, content: envelopeOf('entity', 'osim:entity:bridged', 'nostr:npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', {components: {}}) as unknown as JsonValue});
 opened.server.inject(opened.roomId, {type: 'm.room.message', sender: opened.alice.userId, content: {msgtype: 'm.text', body: text(honest)}});
 expect(await transport.query({})).toEqual({ok: true, value: [honest]});
 expect(transport.refusals().map(entry => entry.code)).toEqual(['PERMISSION', 'PERMISSION']);
 transport.close();
});

test('an encrypted event this client cannot open is refused and reported, and a cipher port opens it', async () => {
 const opened = await lab();
 const binding = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 const object = envelopeOf('entity', 'osim:entity:sealed', opened.aliceIdentity.principal.id, {components: {'cidade.transito': {level: 3}}});
 opened.server.inject(opened.roomId, {type: ENCRYPTED_EVENT_TYPE, sender: opened.alice.userId, content: {algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'AAAA', session_id: 'sessao'}});
 const blind = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch});
 expect(await blind.query({})).toEqual({ok: true, value: []});
 expect(blind.refusals()[0]).toMatchObject({code: 'NOT_FOUND'});
 blind.close();
 // With a port that can open the sealed content, the same event is an object like any other.
 const sealing = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch, unseal: async () => ({ok: true, value: object})});
 expect(await sealing.query({})).toEqual({ok: true, value: [object]});
 sealing.close();
 // A port that fails reports its own reason instead of being answered with silence.
 const broken = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch, unseal: async () => ({ok: false, error: {code: 'SIGNATURE', message: 'sessão olm desconhecida'}})});
 expect(await broken.query({})).toEqual({ok: true, value: []});
 expect(broken.refusals()[0]).toMatchObject({code: 'SIGNATURE', message: 'sessão olm desconhecida'});
 broken.close();
});

test('a room that declares itself encrypted refuses plaintext and needs both cipher ports', async () => {
 const opened = await lab();
 opened.server.inject(opened.roomId, {type: 'm.room.encryption', state_key: '', content: {algorithm: 'm.megolm.v1.aes-sha2'}});
 const standing = await roomStanding(opened.alice, opened.roomId, {fetch: opened.server.fetch});
 if (!standing.ok) throw new Error(standing.error.message);
 expect(standing.value.encrypted).toBe(true);
 const identity = await proofOf(opened.aliceIdentity);
 const base = {account: opened.alice, roomId: opened.roomId, standing: standing.value, session, sessionKey: opened.aliceIdentity.session.publicKey, identity, approval: {policy: 'open' as const, invite: 'osim:capability:invite-1'}};
 expect(roomBinding(base)).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 const encrypted = await roomBinding({...base, acceptEncrypted: true});
 if (!encrypted.ok) throw new Error(encrypted.error.message);
 const before = opened.server.requests();
 const plain = createMatrixRooms({account: opened.alice, binding: encrypted.value, codec, fetch: opened.server.fetch});
 expect(await plain.publish(envelopeOf('entity', 'osim:entity:claro', opened.aliceIdentity.principal.id, {components: {}}))).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 expect(opened.server.requests()).toBe(before);
 plain.close();
 const sealed = createMatrixRooms({
  account: opened.alice, binding: encrypted.value, codec, fetch: opened.server.fetch,
  seal: async envelope => ({ok: true, value: {algorithm: 'm.megolm.v1.aes-sha2', ciphertext: text(envelope)}}),
  unseal: async event => ({ok: true, value: JSON.parse(String((event.content as Record<string, unknown>)['ciphertext'])) as JsonValue}),
 });
 expect(await sealed.publish(envelopeOf('entity', 'osim:entity:selado', opened.aliceIdentity.principal.id, {components: {'cidade.transito': {level: 4}}}))).toEqual({ok: true, value: undefined});
 expect(await sealed.resolve('osim:entity:selado')).toMatchObject({ok: true, value: {id: 'osim:entity:selado'}});
 sealed.close();
});

test('the negotiated ceiling bounds what leaves, what enters and what a caller may raise', async () => {
 const opened = await lab();
 const binding = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 const transport = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch, limits: {...NETWORK_LIMITS, maxDurableBytes: 512, maxObjectBytes: NETWORK_LIMITS.maxObjectBytes * 4}});
 expect(transport.limits().maxDurableBytes).toBe(512);
 expect(transport.limits().maxObjectBytes).toBe(NETWORK_LIMITS.maxObjectBytes);
 const before = opened.server.requests();
 expect(await transport.publish(envelopeOf('entity', 'osim:entity:grande', opened.aliceIdentity.principal.id, {components: {'cidade.transito': 'x'.repeat(1024)}}))).toMatchObject({ok: false, error: {code: 'LIMIT'}});
 expect(opened.server.requests()).toBe(before);
 // What arrives is bounded too: a content over the ceiling is never parsed.
 opened.server.inject(opened.roomId, {type: WORLD_EVENT_TYPE, sender: opened.alice.userId, content: {osim: '0.1', type: 'entity', id: 'osim:entity:enorme', actor: opened.aliceIdentity.principal.id, body: {components: {'cidade.transito': 'y'.repeat(2048)}}}});
 expect(await transport.query({entity: 'osim:entity:enorme'})).toEqual({ok: true, value: []});
 expect(transport.refusals()[0]).toMatchObject({code: 'LIMIT'});
 transport.close();
});

test('reads walk the room page by page, and a room the account is not in is a refusal', async () => {
 const opened = await lab();
 const binding = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 const writer = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch});
 const objects = Array.from({length: 5}, (_, index) => envelopeOf('entity', `osim:entity:casa-${index}`, opened.aliceIdentity.principal.id, {components: {'cidade.transito': {level: index}}}));
 for (const object of objects) expect((await writer.publish(object)).ok).toBe(true);
 const reader = createMatrixRooms({account: opened.bob, binding: await bindingOf(opened, opened.bob, opened.bobIdentity), codec, fetch: opened.server.fetch, pageSize: 2});
 const before = opened.server.requests();
 expect(await reader.query({components: ['cidade.transito']})).toEqual({ok: true, value: objects});
 expect(opened.server.requests() - before).toBeGreaterThanOrEqual(3);
 const carol = await registerAccount({homeserver: `http://${opened.server.serverName}`, secret: SECRET, username: 'carol', password: 'segredo-de-carol', fetch: opened.server.fetch});
 if (!carol.ok) throw new Error(carol.error.message);
 // A stranger's claim on the room: the document is well formed, and the homeserver is what refuses the read.
 const outsiderBinding: RoomBinding = {...binding, account: {userId: carol.value.userId, homeserver: carol.value.homeserver}};
 const outsider = createMatrixRooms({account: carol.value, binding: outsiderBinding, codec, fetch: opened.server.fetch});
 expect(await outsider.query({})).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 reader.close();
 writer.close();
 outsider.close();
});

test('only this project event type is carried, and a foreign namespace is refused before any request', async () => {
 const opened = await lab();
 const binding = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 const foreign = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch, eventType: 'm.room.message'});
 const before = opened.server.requests();
 expect(await foreign.publish(envelopeOf('entity', 'osim:entity:chat', opened.aliceIdentity.principal.id, {components: {}}))).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 expect(opened.server.requests()).toBe(before);
 foreign.close();
 expect(WORLD_EVENT_TYPE.startsWith('org.opensim.')).toBe(true);
 expect(CAPABILITY_EVENT_TYPE.startsWith('org.opensim.')).toBe(true);
});

test('a homeserver that refuses is reported with its own answer, never with invented success', async () => {
 const opened = await lab();
 const binding = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 const transport = createMatrixRooms({account: opened.alice, binding, codec, fetch: opened.server.fetch});
 const object = envelopeOf('entity', 'osim:entity:recusada', opened.aliceIdentity.principal.id, {components: {}});
 opened.server.fail((path, method) => path.includes('/send/') && method === 'PUT', 403, 'M_FORBIDDEN', 'guest writers are not permitted');
 const refused = await transport.publish(object);
 expect(refused).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 if (!refused.ok) expect(refused.error.message).toContain('guest writers are not permitted');
 opened.server.clearFailures();
 opened.server.fail(path => path.includes('/messages'), 429, 'M_LIMIT_EXCEEDED', 'Too Many Requests');
 expect(await transport.query({})).toMatchObject({ok: false, error: {code: 'LIMIT'}});
 opened.server.clearFailures();
 opened.server.fail(path => path.includes('/messages'), 500, 'M_UNKNOWN', 'internal error');
 expect(await transport.query({})).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
 opened.server.clearFailures();
 expect(await transport.publish(object)).toEqual({ok: true, value: undefined});
 expect(await transport.query({})).toEqual({ok: true, value: [object]});
 transport.close();
});

test('the kernel publishes, resolves and joins through the room, and no Matrix field enters the durable world', async () => {
 const opened = await lab();
 const writer = createKernel({transports: [createMatrixRooms({account: opened.alice, binding: await bindingOf(opened, opened.alice, opened.aliceIdentity), codec, fetch: opened.server.fetch})]});
 const descriptor = envelopeOf('session', 'osim:session:sessao-1', opened.aliceIdentity.principal.id, {type: 'session', id: 'osim:session:sessao-1', mode: 'realtime'});
 expect(await writer.publish(descriptor)).toMatchObject({ok: true, status: 'applied', replication: []});
 const reader = createKernel({transports: [createMatrixRooms({account: opened.bob, binding: await bindingOf(opened, opened.bob, opened.bobIdentity), codec, fetch: opened.server.fetch})]});
 expect(await reader.join('osim:session:sessao-1')).toMatchObject({ok: true, value: {id: 'osim:session:sessao-1'}});
 // The room ties two accounts to one world; nothing about the room is part of the world itself.
 const identity = durableJson(world());
 expect(identity).not.toContain(opened.roomId);
 expect(identity).not.toContain('matrix');
 expect(Object.keys(world()).sort()).toEqual(['actors', 'chunks', 'components', 'formatVersion', 'money', 'revision', 'rulesVersion', 'seed', 'tick', 'worldId']);
});

// --- the invitation ---------------------------------------------------------------------------------------------
test('the invitation is written into the room and opening it produces an ask, never authority', async () => {
 const opened = await lab();
 const hostBinding = await bindingOf(opened, opened.alice, opened.aliceIdentity);
 const service = createMatrixInviteService({codec, now: () => NOW, identity: opened.aliceIdentity, binding: hostBinding, fetch: opened.server.fetch});
 const created = await service.create(inviteInput());
 if (!created.ok) throw new Error(created.error.message);
 expect(created.value.id.startsWith('osim:capability:invite-')).toBe(true);
 const written = opened.server.events(opened.roomId).find(event => event.event_id === created.value.eventId);
 expect(written).toMatchObject({type: CAPABILITY_EVENT_TYPE, sender: opened.alice.userId, room_id: opened.roomId});
 expect(written?.content).toMatchObject({type: 'capability', version: 1, id: created.value.id, issuer: 'matrix:@alice:matrix.test', entity: 'osim:session:sessao-1', policy: {kind: 'open'}});
 // The joiner reads the event out of the room and checks the id against the content that arrived.
 const arrived = await inviteFromEvent(written!, {roomId: opened.roomId, codec});
 expect(arrived).toMatchObject({ok: true, value: {id: created.value.id, roomId: opened.roomId, sender: '@alice:matrix.test'}});
 if (!arrived.ok) return;
 const joiner = createMatrixInviteService({codec, now: () => NOW, identity: opened.bobIdentity, binding: await bindingOf(opened, opened.bob, opened.bobIdentity), fetch: opened.server.fetch});
 const requested = await joiner.open(arrived.value);
 expect(requested).toMatchObject({ok: true, value: {kind: 'join-request', approval: 'none', principal: opened.bobIdentity.principal}});
 if (!requested.ok) return;
 expect(await verifyMatrixJoinRequest(requested.value, {codec, verifier: opened.bobIdentity.verifier(), hasher})).toMatchObject({ok: true});
 // The link is spent here: the same invitation is not a second join.
 expect(await joiner.open(arrived.value)).toMatchObject({ok: false, error: {code: 'CONFLICT'}});
 expect(joiner.spent()).toEqual([created.value.id]);
 // A document altered after the fact is not the invitation it claims to be.
 expect(await inviteFromEvent({...written!, content: {...(written!.content as Record<string, JsonValue>), actions: ['admin']}}, {roomId: opened.roomId, codec})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
 expect(await inviteFromEvent({...written!, room_id: '!outra:matrix.test'}, {roomId: opened.roomId, codec})).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 // Expiry and addressee are decided by the clock and the principal, never by holding the link.
 const expired = await service.create(inviteInput({sessionId: 'sessao-expirada', notBefore: at(-3600), notAfter: at(-60)}));
 if (!expired.ok) throw new Error(expired.error.message);
 expect(await joiner.open(expired.value)).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 const addressed = await service.create(inviteInput({sessionId: 'sessao-2', policy: {kind: 'recipient', subject: {scheme: 'matrix', id: 'matrix:@alice:matrix.test'}}}));
 if (!addressed.ok) throw new Error(addressed.error.message);
 expect(await joiner.open(addressed.value)).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
});

test('a member without a grant is refused, whatever the room says his power level is', async () => {
 const opened = await lab();
 // The room makes Bob an administrator of the room itself; a room role is not an action in the world.
 opened.server.inject(opened.roomId, {type: 'm.room.power_levels', state_key: '', content: {users: {'@alice:matrix.test': 100, '@bob:matrix.test': 100}, users_default: 0}});
 const standing = await roomStanding(opened.alice, opened.roomId, {fetch: opened.server.fetch});
 if (!standing.ok) throw new Error(standing.error.message);
 expect(standing.value.users['@bob:matrix.test']).toBe(100);
 const binding = await bindingOf(opened, opened.bob, opened.bobIdentity);
 expect(binding.account).toEqual({userId: '@bob:matrix.test', homeserver: 'http://matrix.test'});
 const identity = await proofOf(opened.bobIdentity);
 const build = await proposalFrom(opened.bobIdentity, 'build');
 const context = {head, revision: 0, epoch: 1, now: NOW, identity, codec, hasher, verifier: opened.bobIdentity.verifier(), marks: [], revokedGrants: [], chain: []};
 // Power level 100 and a room of his own: the world still says no, because the capability is the grant.
 expect(await authorize(await grantWith(opened.bob, opened.aliceIdentity.session, ['component']), build, context)).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 const allowed = await authorize(await grantWith(opened.bob, opened.aliceIdentity.session, ['build']), build, context);
 expect(allowed.ok).toBe(true);
 if (allowed.ok) expect(allowed.value.actorId.startsWith('p_')).toBe(true);
});

// --- the real homeserver: only when one is named, and reported as such ----------------------------------------
const HOMESERVER = process.env.OSIM_MATRIX_HOMESERVER;
const SECRET_FILE = process.env.OSIM_MATRIX_SECRET_FILE ?? '/tmp/opensim-matrix-lab/registration-secret.txt';

// A real homeserver is a real network hop: this one keeps the default timeout of the whole suite away from it.
test.skipIf(!HOMESERVER)('homeserver real: two accounts read the same world out of one private room', async () => {
 const secret = readFileSync(SECRET_FILE, 'utf8').trim(), stamp = Date.now().toString(36);
 const host = await registerAccount({homeserver: HOMESERVER!, secret, username: `osim-host-${stamp}`, password: `host-${stamp}-segredo`});
 const guest = await registerAccount({homeserver: HOMESERVER!, secret, username: `osim-guest-${stamp}`, password: `guest-${stamp}-segredo`});
 if (!host.ok) throw new Error(host.error.message);
 if (!guest.ok) throw new Error(guest.error.message);
 expect(await verifyAccount(host.value)).toMatchObject({ok: true, value: {userId: host.value.userId}});
 const created = await createRoom(host.value, {name: `Mundo Victoria ${stamp}`, invite: [guest.value.userId]});
 if (!created.ok) throw new Error(created.error.message);
 const roomId = created.value;
 expect(await joinRoom(guest.value, roomId)).toMatchObject({ok: true, value: roomId});
 const standing = await roomStanding(host.value, roomId);
 if (!standing.ok) throw new Error(standing.error.message);
 // The room the plan asks for is a private one: joined by invitation, and not readable by the world.
 expect(standing.value.joinRule).toBe('invite');
 expect(standing.value.historyVisibility).not.toBe('world_readable');
 expect(standing.value.encrypted).toBe(false);
 const hostIdentity = await identityFor(host.value, roomId);
 const guestIdentity = await identityFor(guest.value, roomId);
 // Each side anchors its own device in the room before it writes or reads: the account is the room's word, not ours.
 expect(await confirmBinding(guest.value, hostIdentity.binding)).toMatchObject({ok: true});
 const room = {worldId: 'victoria', branchId: 'main', sessionId: `sessao-${stamp}`, epoch: 1};
 const approve = {policy: 'open' as const, invite: 'osim:capability:invite-lab'};
 const asBound = async (account: MatrixAccount, identity: MatrixIdentity) => {
  const binding = roomBinding({account, roomId, standing: standing.value, session: room, sessionKey: identity.session.publicKey, identity: await proofOf(identity, room), approval: approve});
  if (!binding.ok) throw new Error(binding.error.message);
  return binding.value;
 };
 const hostRoom = createMatrixRooms({account: host.value, binding: await asBound(host.value, hostIdentity), codec, timeoutMs: 15000});
 const guestRoom = createMatrixRooms({account: guest.value, binding: await asBound(guest.value, guestIdentity), codec, timeoutMs: 15000});
 const objects = [
  envelopeOf('entity', `osim:entity:casa-${stamp}`, hostIdentity.principal.id, {components: {'cidade.transito': {level: 2}}}),
  envelopeOf('capability', `osim:capability:invite-${stamp}`, hostIdentity.principal.id, {type: 'capability', version: 1, issuer: hostIdentity.principal.id, entity: `osim:session:${room.sessionId}`}),
 ];
 for (const object of objects) expect(await hostRoom.publish(object)).toEqual({ok: true, value: undefined});
 // A large object still fits the ceiling the adapter chose for a real homeserver: 51 KiB of content leaves and comes
 // back, and an object over the ceiling is refused here with a reason instead of as a 413 from the homeserver.
 const bulky = envelopeOf('entity', `osim:entity:volume-${stamp}`, hostIdentity.principal.id, {components: {'cidade.transito': {pad: 'z'.repeat(50 * 1024)}}});
 expect(await hostRoom.publish(bulky)).toEqual({ok: true, value: undefined});
 expect(await guestRoom.resolve(bulky.id)).toMatchObject({ok: true, value: {id: bulky.id}});
 const overCeiling = envelopeOf('entity', `osim:entity:enorme-${stamp}`, hostIdentity.principal.id, {components: {'cidade.transito': {pad: 'z'.repeat(64 * 1024)}}});
 expect(await hostRoom.publish(overCeiling)).toMatchObject({ok: false, error: {code: 'LIMIT'}});
 // Read back through /messages, and again through /sync: the same object arrives by both paths.
 expect(await guestRoom.resolve(objects[0]!.id)).toMatchObject({ok: true, value: {id: objects[0]!.id}});
 const queried = await guestRoom.query({components: ['cidade.transito']});
 expect(queried).toMatchObject({ok: true});
 if (queried.ok) expect(queried.value).toContainEqual(objects[0]);
 const seen: string[] = [];
 const stop = guestRoom.subscribe({}, object => { seen.push(object.id); });
 // The roster arrives on /sync, which is polled: wait for the object, not for a guessed duration.
 await expect.poll(() => seen.includes(objects[0]!.id), {timeout: 30_000}).toBe(true);
 stop();
 expect(seen).toContain(objects[0]!.id);
 // Both sides derive the same durable world from what the room carried: the semantic hash is the world's.
 const hostWorld = await worldFrom(hostRoom), guestWorld = await worldFrom(guestRoom);
 expect(guestWorld.ids).toEqual(hostWorld.ids);
 expect(guestWorld.hash).toBe(hostWorld.hash);
 expect(hostWorld.ids).toEqual([...objects.map(object => object.id), bulky.id]);
 hostRoom.close();
 guestRoom.close();
}, 60_000);
