import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {generateSessionKeyPair,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {NETWORK_LIMITS} from '../src/world/wire';
import {authorize,grantBytes,identityBytes,proposalBytes} from '../src/world/permissions';
import type {Grant,Proposal} from '../src/world/permissions';
import {createKernel} from '../src/world/kernel';
import {checkEnvelope,envelopeOf} from '../src/world/osim';
import type {Head,JsonValue} from '../src/world/model';
import {createNostrIdentity,localNostrSigner,nip07Signer,nostrVerifier,npubOf,verifyBinding} from '../src/adapters/nostr/identity';
import type {NostrEvent,NostrIdentity,NostrSigner} from '../src/adapters/nostr/identity';
import {announce,createInviteService,inviteText,parseInvite,verifyInvite,verifyJoinRequest} from '../src/adapters/nostr/invites';
import type {Invite,InviteInput} from '../src/adapters/nostr/invites';
import {APP_DATA_KIND,DIRECT_MESSAGE_KIND,PUBLIC_KINDS,createNostrRelay} from '../src/adapters/nostr/relay';
import type {RelaySocket,RelaySocketFactory} from '../src/adapters/nostr/relay';

const codec = createJcsCodec(), hasher = bytesHasher();
const NOW = '2026-09-29T12:00:00Z';
const at = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const head: Head = {worldId: 'victoria', branchId: 'main', commit: {hash: 'aa'.repeat(32), bytes: 64}, generation: 7};
const text = (value: JsonValue): string => new TextDecoder().decode(codec.encode(value));

// --- helpers ---------------------------------------------------------------------------------------------------
async function identityOf(signer: NostrSigner | undefined, now: string = NOW): Promise<NostrIdentity> {
 const device = await generateSessionKeyPair(), session = await generateSessionKeyPair();
 const built = await createNostrIdentity({signer, device, session, codec, now: () => now});
 if (!built.ok) throw new Error(built.error.message);
 return built.value;
}
function inviteInput(overrides: Partial<InviteInput> = {}): InviteInput {
 return {
  worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', epoch: 1, head, startedAt: NOW,
  endpoints: [{transport: 'nostr', uri: 'wss://relay.example'}],
  policy: {kind: 'open'}, actions: ['build'], notBefore: at(-60), notAfter: at(3600), ...overrides,
 };
}
// A relay that speaks NIP-01 in process: it stores what the writer policy allows and answers REQ by filter. Nothing
// here touches the network, so the adapter tests never depend on a public service.
type FakeRelayOptions = {refusal?: (event: NostrEvent) => string | null; silent?: boolean; dead?: boolean};
function fakeRelay(options: FakeRelayOptions = {}) {
 const stored: NostrEvent[] = [];
 const closedSubscriptions: string[] = [];
 let signalClosed: (frame: string) => void = () => undefined;
 const closed = new Promise<string>(resolve => { signalClosed = resolve; });
 let connections = 0;
 const factory: RelaySocketFactory = () => {
  if (options.dead) throw new Error('relay indisponível');
  connections += 1;
  const messages: ((frame: string) => void)[] = [], opens: (() => void)[] = [], closes: ((reason: string) => void)[] = [];
  let socketClosed = false;
  const emit = (frame: unknown) => { if (!socketClosed) queueMicrotask(() => { for (const listener of [...messages]) listener(JSON.stringify(frame)); }); };
  return {
   send(frame) {
    if (options.silent) return;
    const parsed = JSON.parse(frame) as unknown[];
    if (parsed[0] === 'EVENT') {
     const event = parsed[1] as NostrEvent;
     const refusal = options.refusal?.(event) ?? null;
     if (!refusal) stored.push(event);
     emit(['OK', event.id, refusal === null, refusal ?? '']);
     return;
    }
    if (parsed[0] === 'REQ') {
     const filter = parsed[2] as {kinds?: number[]; '#d'?: string[]; '#t'?: string[]};
     const tag = (event: NostrEvent, name: string) => event.tags.filter(entry => entry[0] === name).map(entry => entry[1]);
     for (const event of stored) {
      if (filter.kinds && !filter.kinds.includes(event.kind)) continue;
      if (filter['#d'] && !filter['#d'].some(value => tag(event, 'd').includes(value))) continue;
      if (filter['#t'] && !filter['#t'].some(value => tag(event, 't').includes(value))) continue;
      emit(['EVENT', parsed[1], event]);
     }
     emit(['EOSE', parsed[1]]);
     return;
    }
    if (parsed[0] === 'CLOSE') { closedSubscriptions.push(String(parsed[1])); signalClosed(String(parsed[1])); }
   },
   close() { socketClosed = true; queueMicrotask(() => { for (const listener of [...closes]) listener('closed'); }); },
   onOpen(listener) { opens.push(listener); queueMicrotask(() => { for (const listener of [...opens]) listener(); }); },
   onMessage(listener) { messages.push(listener); },
   onClose(listener) { closes.push(listener); },
  };
 };
 return {factory, stored, closedSubscriptions, closed, connections: () => connections};
}

// --- identity: NIP-07, the signer's npub and the Ed25519 device it authorizes ---------------------------------
test('the signer defines the principal and a request for another npub is refused', async () => {
 const user = localNostrSigner(new Uint8Array(32).fill(7)), bunker = localNostrSigner(new Uint8Array(32).fill(9));
 const identity = await identityOf(user);
 const npub = npubOf(await user.getPublicKey());
 const scope = {worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', notBefore: at(0), notAfter: at(600)};
 expect(identity.principal).toEqual({scheme: 'nostr', id: `nostr:${npub}`});
 expect(identity.binding.npub).toBe(npub);
 expect(identity.binding.deviceKey).toBe(identity.device.publicKey);
 expect(verifyBinding(identity.binding).ok).toBe(true);
 expect(await identity.provider(codec).bindSession({principal: identity.principal, scope})).toMatchObject({ok: true});
 // A remote signer that holds another key cannot claim the user's identity, exactly like the local key holder that
 // refuses a root key that is not its own.
 const bunkerIdentity = await identityOf(bunker);
 expect(await bunkerIdentity.provider(codec).bindSession({principal: identity.principal, scope})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
 // A principal of another scheme has no Nostr binding at all.
 expect(await identity.provider(codec).bindSession({principal: {scheme: 'matrix', id: '@ana:example'}, scope})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
});

test('the Ed25519 delegation only means something through the device key the npub authorized', async () => {
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(3)));
 const scope = {worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', notBefore: at(0), notAfter: at(600)};
 const bound = await identity.provider(codec).bindSession({principal: identity.principal, scope});
 if (!bound.ok) throw new Error(bound.error.message);
 const proof = bound.value;
 expect(proof.delegation.key).toBe(identity.device.publicKey);
 expect(proof.sessionKey).toBe(identity.session.publicKey);
 expect(await identity.verifier().verify(proof, identityBytes(proof, codec))).toBe(true);
 // The nostr half is what makes the delegation mean something: a proof signed by a device the npub never authorized
 // is refused even though its Ed25519 delegation verifies on its own.
 const other = await identityOf(localNostrSigner(new Uint8Array(32).fill(4)));
 const stranger = await other.provider(codec).bindSession({principal: other.principal, scope});
 if (!stranger.ok) throw new Error(stranger.error.message);
 expect(await identity.verifier().verify(stranger.value, identityBytes(stranger.value, codec))).toBe(false);
 expect(await other.verifier().verify(stranger.value, identityBytes(stranger.value, codec))).toBe(true);
});

test('a missing signer is a refusal and a refusing signer is a signature failure', async () => {
 const device = await generateSessionKeyPair(), session = await generateSessionKeyPair();
 expect(await createNostrIdentity({signer: undefined, device, session, codec, now: () => NOW})).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
 expect(nip07Signer(undefined)).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
 expect(nip07Signer({getPublicKey: () => Promise.resolve('ab'.repeat(32))})).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
 const refusing: NostrSigner = {getPublicKey: () => Promise.resolve('ab'.repeat(32)), signEvent: () => Promise.reject(new Error('o usuário recusou'))};
 expect(await createNostrIdentity({signer: refusing, device, session, codec, now: () => NOW})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
 // A signer that answers with a signature over something else does not get a binding either.
 const honest = localNostrSigner(new Uint8Array(32).fill(5));
 const liar: NostrSigner = {...honest, signEvent: async template => ({...await honest.signEvent(template), sig: '00'.repeat(64)})};
 expect(await createNostrIdentity({signer: liar, device, session, codec, now: () => NOW})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
});

test('NIP-07 shape is adopted from the extension object and a tampered binding is refused', async () => {
 const inner = localNostrSigner(new Uint8Array(32).fill(11));
 const adopted = nip07Signer({getPublicKey: () => inner.getPublicKey(), signEvent: (template: unknown) => inner.signEvent(template as never)});
 if (!adopted.ok) throw new Error(adopted.error.message);
 const identity = await identityOf(adopted.value);
 expect(identity.principal.id).toBe(`nostr:${npubOf(await inner.getPublicKey())}`);
 // The signed event no longer matches its body, so the binding stops verifying.
 expect(verifyBinding({...identity.binding, deviceKey: 'ff'.repeat(32)})).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
});

// --- invites: the link commits to the descriptor without disclosing it ----------------------------------------
async function hostFixture() {
 const host = await identityOf(localNostrSigner(new Uint8Array(32).fill(21)));
 const service = createInviteService({codec, now: () => NOW, identity: host});
 const created = await service.create(inviteInput());
 if (!created.ok) throw new Error(created.error.message);
 return {host, service, invite: created.value};
}
async function joinerFixture(fill: number, identity?: NostrIdentity) {
 const joiner = identity ?? await identityOf(localNostrSigner(new Uint8Array(32).fill(fill)));
 return {joiner, service: createInviteService({codec, now: () => NOW, identity: joiner})};
}

test('creating an invite needs a signer and the issuer comes from the signer, not from the input', async () => {
 const unsigned = createInviteService({codec, now: () => NOW});
 expect(await unsigned.create(inviteInput())).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
 const {host, invite} = await hostFixture();
 expect((await verifyInvite(invite)).ok).toBe(true);
 const body = invite.body;
 expect(body.issuer).toBe(host.principal.id);
 expect(body.session.host).toBe(host.principal.id);
 expect(body.session.timeline).toBe('osim:timeline:main');
 expect(body.session.id).toBe('osim:session:sessao-1');
 expect(body.session.head).toEqual(head);
 expect(body.session.world).toEqual({worldId: 'victoria', branchId: 'main', epoch: 1});
 expect(body.actions).toEqual(['build']);
 expect(invite.id.startsWith('osim:capability:invite-')).toBe(true);
 // Re-pointing the descriptor at another branch changes the signed content, so it is not the same invite.
 const repointed = {id: invite.id, event: {...invite.event, content: invite.event.content.replace('"main"', '"outra"')}};
 expect(await verifyInvite(repointed)).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
 expect(await parseInvite(inviteText(repointed, codec))).toMatchObject({ok: false, error: {code: 'SIGNATURE'}});
});

test('the public announcement commits to the invite without carrying the private half', async () => {
 const {host, invite} = await hostFixture();
 const envelope = announce(invite);
 expect(checkEnvelope(envelope).ok).toBe(true);
 const publicPayload = text(envelope.body);
 expect(publicPayload).toContain(invite.id);
 expect(publicPayload).toContain(invite.event.id);
 expect(publicPayload).toContain(host.principal.id);
 expect(publicPayload).not.toContain(head.commit.hash);
 expect(publicPayload).not.toContain(host.device.secretKey);
 expect(publicPayload).not.toContain(host.session.secretKey);
 expect(publicPayload).not.toContain('"head"');
 // The reference alone is not an invite: it cannot be opened, so holding it grants nothing.
 expect(await parseInvite(publicPayload)).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
});

test('the invitation travels as text that survives a round trip, and a broken one is refused', async () => {
 const {invite} = await hostFixture();
 const parsed = await parseInvite(inviteText(invite, codec));
 if (!parsed.ok) throw new Error(parsed.error.message);
 expect(parsed.value.id).toBe(invite.id);
 expect(parsed.value.event.id).toBe(invite.event.id);
 expect(parsed.value.body).toEqual(invite.body);
 expect(await parseInvite('nao é json')).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
 expect(await parseInvite(JSON.stringify({kind: 'invite'}))).toMatchObject({ok: false, error: {code: 'MALFORMED'}});
});

test('an invite outside its validity window or for another recipient is refused', async () => {
 const {host, invite} = await hostFixture();
 const {joiner, service} = await joinerFixture(31);
 expect(await service.open(invite)).toMatchObject({ok: true});
 const late = createInviteService({codec, now: () => at(7200), identity: joiner});
 expect(await late.open(invite)).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 // A recipient policy names one principal: the named one joins, anyone else is refused.
 const {service: hostService} = await hostFixture();
 const other = await identityOf(localNostrSigner(new Uint8Array(32).fill(34)));
 const named = await hostService.create(inviteInput({policy: {kind: 'recipient', subject: joiner.principal}}));
 if (!named.ok) throw new Error(named.error.message);
 expect(await service.open(named.value)).toMatchObject({ok: true, value: {approval: 'none'}});
 expect(await createInviteService({codec, now: () => NOW, identity: other}).open(named.value)).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 // An approval policy joins without a grant and says so, so the host knows to decide.
 const approval = await hostService.create(inviteInput({sessionId: 'sessao-2', policy: {kind: 'approval'}}));
 if (!approval.ok) throw new Error(approval.error.message);
 expect(await service.open(approval.value)).toMatchObject({ok: true, value: {approval: 'required'}});
});

test('an invite opens once in this client: a replay is a conflict rather than a second join', async () => {
 const {invite} = await hostFixture();
 const {service} = await joinerFixture(41);
 expect((await service.open(invite)).ok).toBe(true);
 // The digest of the link is what was spent, so asking again is a repeat rather than a second join.
 expect(await service.open(invite)).toMatchObject({ok: false, error: {code: 'CONFLICT'}});
 expect(service.spent()).toEqual([invite.id]);
 // The same inputs produce the same link, which is what makes a repeat recognisable by digest; another session is
 // another link, and the fence does not block it.
 const {invite: same} = await hostFixture();
 expect(same.id).toBe(invite.id);
 const {service: hostService} = await hostFixture();
 const fresh = await hostService.create(inviteInput({sessionId: 'sessao-3'}));
 if (!fresh.ok) throw new Error(fresh.error.message);
 expect(fresh.value.id).not.toBe(invite.id);
 expect((await service.open(fresh.value)).ok).toBe(true);
});

test('a verified join request is not a grant: authorization still needs the capability', async () => {
 const {host, invite} = await hostFixture();
 const {joiner, service} = await joinerFixture(51);
 const opened = await service.open(invite);
 if (!opened.ok) throw new Error(opened.error.message);
 const request = opened.value;
 expect(await verifyJoinRequest(request, {codec, verifier: joiner.verifier(), hasher})).toMatchObject({ok: true});
 expect((request as unknown as Record<string, unknown>)['grant']).toBeUndefined();
 expect(request.actions).toEqual(['build']);
 expect(request.approval).toBe('none');
 const scope = {worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', notBefore: at(0), notAfter: at(600)};
 const hostIdentity = await host.provider(codec).bindSession({principal: host.principal, scope});
 const joinerIdentity = await joiner.provider(codec).bindSession({principal: joiner.principal, scope});
 if (!hostIdentity.ok || !joinerIdentity.ok) throw new Error('vínculo de identidade falhou');
 const grantWith = async (actions: Grant['actions']): Promise<Grant> => {
  const base: Grant = {kind: 'grant', id: 'concessao-1', principal: joiner.principal, worldId: 'victoria', branchId: 'main', actions, namespaces: ['cidade.transito'], spendLimit: 100, epoch: 1, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: hostIdentity.value.sessionKey, signature: ''}};
  return {...base, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: base.proof.sessionKey, signature: await signEd25519(host.session, grantBytes(base, codec))}};
 };
 const draft: Proposal = {worldProtocol: 2, wireVersion: 1, kind: 'proposal', worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', epoch: 1, id: 'proposta-1', principal: joiner.principal, sessionKey: joiner.session.publicKey, observedHead: head.commit, intent: {type: 'build', tool: 'park', cells: [{x: 289, y: 289}]}, preconditions: {revision: 0}, costLimit: 50, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: joiner.session.publicKey, signature: ''}};
 const proposal: Proposal = {...draft, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: draft.proof.sessionKey, signature: await signEd25519(joiner.session, proposalBytes(draft, codec))}};
 const context = {head, revision: 0, epoch: 1, now: NOW, identity: joinerIdentity.value, codec, hasher, verifier: joiner.verifier(), marks: [], revokedGrants: [], chain: []};
 // The link, the descriptor and a verified request are not authority: without the action in a grant there is none.
 expect(await authorize(await grantWith(['component']), proposal, context)).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 const accepted = await authorize(await grantWith(['build']), proposal, context);
 expect(accepted.ok).toBe(true);
 if (accepted.ok) expect(accepted.value.actorId.startsWith('p_')).toBe(true);
});

// --- the relay adapter: KernelTransport over NIP-01 ------------------------------------------------------------
test('the relay publishes a signed note and reads it back by REQ', async () => {
 const relay = fakeRelay();
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(71)));
 const transport = createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: relay.factory});
 const object = envelopeOf('entity', 'osim:entity:house-42', identity.principal.id, {components: {'cidade.transito': {level: 2}}});
 expect(await transport.publish(object)).toEqual({ok: true, value: undefined});
 expect(relay.stored).toHaveLength(1);
 const event = relay.stored[0]!;
 expect(PUBLIC_KINDS).toContain(event.kind);
 expect(event.content).toBe(new TextDecoder().decode(codec.encode(object)));
 expect(event.tags).toContainEqual(['d', 'osim:entity:house-42']);
 expect(event.tags).toContainEqual(['t', 'osim-0.1']);
 expect(await transport.resolve('osim:entity:house-42')).toEqual({ok: true, value: object});
 expect(await transport.resolve('osim:entity:unknown')).toEqual({ok: true, value: null});
 transport.close();
});

test('a relay that refuses a message is a permission failure carrying the relay answer', async () => {
 // The reference relay refuses kind 4 for a public writer: the adapter reports that answer instead of pretending.
 const relay = fakeRelay({refusal: event => (event.kind === DIRECT_MESSAGE_KIND ? 'blocked: kind not permitted for public writers' : null)});
 const sender = await identityOf(localNostrSigner(new Uint8Array(32).fill(72)));
 const peer = localNostrSigner(new Uint8Array(32).fill(78));
 const transport = createNostrRelay({url: 'ws://relay.example', codec, signer: sender.signer, recipients: [await peer.getPublicKey()], socket: relay.factory});
 const refused = await transport.publish(envelopeOf('entity', 'osim:entity:house-43', sender.principal.id, {components: {}}));
 expect(refused).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 if (!refused.ok) expect(refused.error.message).toContain('blocked');
 expect(relay.stored).toHaveLength(0);
 transport.close();
});

test('a private object travels as a direct message that only its recipient can read', async () => {
 const relay = fakeRelay();
 const sender = await identityOf(localNostrSigner(new Uint8Array(32).fill(79)));
 const peerSecret = new Uint8Array(32).fill(80), peer = localNostrSigner(peerSecret), peerKey = await peer.getPublicKey();
 const writer = createNostrRelay({url: 'ws://relay.example', codec, signer: sender.signer, recipients: [peerKey], socket: relay.factory});
 const secret = envelopeOf('capability', 'osim:capability:invite-3', sender.principal.id, {type: 'capability', invite: {id: 'y'}});
 expect(await writer.publish(secret)).toEqual({ok: true, value: undefined});
 const event = relay.stored[0]!;
 expect(event.kind).toBe(DIRECT_MESSAGE_KIND);
 expect(event.tags).toContainEqual(['p', peerKey]);
 // The relay never learns which object the ciphertext holds, and only the recipient's key opens it.
 expect(event.content).not.toContain('osim:capability:invite-3');
 expect(JSON.parse(await peer.nip04!.decrypt(event.pubkey, event.content))).toEqual(secret);
 // The recipient's own adapter answers with the object, not with the ciphertext.
 const reader = createNostrRelay({url: 'ws://relay.example', codec, signer: peer, recipients: [await sender.signer.getPublicKey()], socket: relay.factory});
 expect(await reader.resolve(secret.id)).toEqual({ok: true, value: secret});
 reader.close();
 writer.close();
});

test('an object that its publisher cannot vouch for never reaches the kernel', async () => {
 const relay = fakeRelay();
 const owner = await identityOf(localNostrSigner(new Uint8Array(32).fill(81)));
 const impostor = await identityOf(localNostrSigner(new Uint8Array(32).fill(82)));
 const reader = createNostrRelay({url: 'ws://relay.example', codec, socket: relay.factory});
 // A valid signature by another key is not this actor's word.
 const forged = await impostor.signer.signEvent({kind: 1, created_at: Math.floor(Date.parse(NOW) / 1000), tags: [['d', 'osim:entity:forged'], ['t', 'osim-0.1'], ['o', 'entity']], content: text(envelopeOf('entity', 'osim:entity:forged', owner.principal.id, {components: {}}))});
 relay.stored.push(forged);
 expect(await reader.query({entity: 'osim:entity:forged'})).toEqual({ok: true, value: []});
 // A note whose signature does not cover its content is dropped for the same reason.
 const writer = createNostrRelay({url: 'ws://relay.example', codec, signer: owner.signer, socket: relay.factory});
 const honest = envelopeOf('entity', 'osim:entity:honest', owner.principal.id, {components: {'cidade.transito': {level: 1}}});
 expect((await writer.publish(honest)).ok).toBe(true);
 expect(await reader.query({entity: 'osim:entity:honest'})).toEqual({ok: true, value: [honest]});
 relay.stored[1]!.sig = '00'.repeat(64);
 expect(await reader.query({entity: 'osim:entity:honest'})).toEqual({ok: true, value: []});
 reader.close();
 writer.close();
});

test('a silent relay and an unreachable one are distinguished from an object nobody has', async () => {
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(73)));
 const silent = createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: fakeRelay({silent: true}).factory, timeoutMs: 30});
 expect(await silent.publish(envelopeOf('entity', 'osim:entity:house-44', identity.principal.id, {components: {}}))).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
 expect(await silent.resolve('osim:entity:house-44')).toEqual({ok: true, value: null});
 silent.close();
 const dead = createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: fakeRelay({dead: true}).factory, timeoutMs: 30});
 expect(await dead.resolve('osim:entity:house-45')).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
 const stop = dead.subscribe({components: []}, () => undefined);
 expect(typeof stop).toBe('function');
 stop();
 dead.close();
});

test('NIP-78 is never a public discovery channel', async () => {
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(74)));
 expect(PUBLIC_KINDS).not.toContain(APP_DATA_KIND);
 const relay = fakeRelay();
 const transport = createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: relay.factory, kinds: {public: APP_DATA_KIND}});
 const refused = await transport.publish(envelopeOf('capability', 'osim:capability:invite-1', identity.principal.id, {type: 'capability'}));
 expect(refused).toMatchObject({ok: false, error: {code: 'PERMISSION'}});
 if (!refused.ok) expect(refused.error.message).toContain('NIP-78');
 // A kind outside the public writer list is refused before any connection is opened.
 expect(relay.stored).toHaveLength(0);
 expect(relay.connections()).toBe(0);
 transport.close();
});

test('reads are bounded by the narrower limits and oversized objects never reach the socket', async () => {
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(75)));
 const relay = fakeRelay();
 const transport = createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: relay.factory, limits: {...NETWORK_LIMITS, maxDurableBytes: 2048}});
 expect(transport.limits().maxDurableBytes).toBe(2048);
 expect(transport.limits().maxObjectBytes).toBe(NETWORK_LIMITS.maxObjectBytes);
 const big = envelopeOf('entity', 'osim:entity:big', identity.principal.id, {components: {'cidade.transito': 'x'.repeat(4096)}});
 expect(await transport.publish(big)).toMatchObject({ok: false, error: {code: 'LIMIT'}});
 expect(relay.stored).toHaveLength(0);
 expect(relay.connections()).toBe(0);
 // A relay that announces a higher ceiling is not obeyed: the narrower number wins.
 const raised = createNostrRelay({url: 'ws://relay.example', codec, socket: relay.factory, limits: {...NETWORK_LIMITS, maxObjectBytes: NETWORK_LIMITS.maxObjectBytes * 4}});
 expect(raised.limits().maxObjectBytes).toBe(NETWORK_LIMITS.maxObjectBytes);
 raised.close();
 transport.close();
});

test('a read-only adapter serves queries without any signer and refuses to publish', async () => {
 const relay = fakeRelay();
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(76)));
 const writer = createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: relay.factory});
 const object = envelopeOf('entity', 'osim:entity:house-46', identity.principal.id, {components: {'cidade.transito': {level: 1}}});
 expect((await writer.publish(object)).ok).toBe(true);
 const reader = createNostrRelay({url: 'ws://relay.example', codec, socket: relay.factory});
 expect(await reader.query({entity: 'osim:entity:house-46'})).toEqual({ok: true, value: [object]});
 expect(await reader.query({components: ['cidade.transito']})).toEqual({ok: true, value: [object]});
 expect(await reader.query({components: ['cidade.outro']})).toEqual({ok: true, value: []});
 expect(await reader.publish(object)).toMatchObject({ok: false, error: {code: 'NOT_FOUND'}});
 reader.close();
 writer.close();
});

test('a subscription delivers decoded objects until the closer sends CLOSE', async () => {
 const relay = fakeRelay();
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(77)));
 const transport = createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: relay.factory});
 const object = envelopeOf('capability', 'osim:capability:invite-2', identity.principal.id, {type: 'capability', invite: {id: 'x'}});
 expect((await transport.publish(object)).ok).toBe(true);
 const received: unknown[] = [];
 let first: (entries: unknown[]) => void = () => undefined;
 const delivered = new Promise<unknown[]>(resolve => { first = resolve; });
 const stop = transport.subscribe({}, entry => { received.push(entry); first(received); });
 expect(await delivered).toEqual([object]);
 stop();
 expect(await relay.closed).toBeTypeOf('string');
 expect(relay.closedSubscriptions).toHaveLength(1);
 transport.close();
});

// --- the kernel drives this transport through the §30 port ------------------------------------------------------
test('the kernel publishes and joins through the relay transport', async () => {
 const relay = fakeRelay();
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(83)));
 const writer = createKernel({transports: [createNostrRelay({url: 'ws://relay.example', codec, signer: identity.signer, socket: relay.factory})]});
 const session = envelopeOf('session', 'osim:session:sessao-9', identity.principal.id, {type: 'session', id: 'osim:session:sessao-9', mode: 'realtime'});
 expect(await writer.publish(session)).toMatchObject({ok: true, status: 'applied', replication: []});
 expect(relay.stored).toHaveLength(1);
 // A kernel that holds nothing locally joins through the transport: that is what the port is for.
 const reader = createKernel({transports: [createNostrRelay({url: 'ws://relay.example', codec, socket: relay.factory})]});
 expect(await reader.join(session.id)).toMatchObject({ok: true, value: {id: session.id}});
 expect(await reader.join('osim:session:ausente')).toEqual({ok: true, value: null});
});

// --- the real relay: exercised only when a relay is named, and reported as such --------------------------------
const RELAY = process.env.OSIM_NOSTR_RELAY;

test.skipIf(!RELAY)('relay real: a kind 1 note carries the invite reference and REQ returns it', async () => {
 const identity = await identityOf(localNostrSigner(new Uint8Array(32).fill(200)));
 const transport = createNostrRelay({url: RELAY!, codec, signer: identity.signer, timeoutMs: 15000});
 const sessionId = `sessao-probe-${Date.now().toString(36)}`;
 const service = createInviteService({codec, now: () => NOW, identity});
 const created = await service.create(inviteInput({sessionId, policy: {kind: 'open'}, endpoints: [{transport: 'nostr', uri: RELAY!}]}));
 if (!created.ok) throw new Error(created.error.message);
 const envelope = announce(created.value);
 expect(await transport.publish(envelope)).toEqual({ok: true, value: undefined});
 const found = await transport.resolve(envelope.id);
 expect(found).toEqual({ok: true, value: envelope});
 // The whole invitation, as the text a person would send, travels as the content of another note; the joiner reads it
 // back, verifies the signature that arrived through the relay and produces a join request.
 const document = envelopeOf('capability', created.value.id, identity.principal.id, JSON.parse(inviteText(created.value, codec)) as JsonValue);
 expect(await transport.publish(document)).toEqual({ok: true, value: undefined});
 const delivered = await transport.resolve(document.id);
 expect(delivered.ok).toBe(true);
 if (!delivered.ok || delivered.value === null) throw new Error('convite não voltou do relay');
 const arrived = await parseInvite(JSON.stringify(delivered.value.body));
 expect(arrived).toMatchObject({ok: true, value: {id: created.value.id}});
 const joinerIdentity = await identityOf(localNostrSigner(new Uint8Array(32).fill(202)));
 const joiner = createInviteService({codec, now: () => NOW, identity: joinerIdentity});
 const request = arrived.ok ? await joiner.open(arrived.value) : arrived;
 expect(request).toMatchObject({ok: true, value: {invite: {id: created.value.id}}});
 if (request.ok) expect(await verifyJoinRequest(request.value, {codec, verifier: joinerIdentity.verifier(), hasher})).toMatchObject({ok: true});
 console.log(`[relay real] ${RELAY}: convite completo relido do relay e aberto por outra chave, pedido de entrada verificado`);
 const queried = await transport.query({components: []});
 expect(queried.ok).toBe(true);
 if (queried.ok) expect(queried.value.some(entry => entry.id === envelope.id)).toBe(true);
 console.log(`[relay real] ${RELAY}: announce de convite publicado em kind 1 e relido por REQ#d (${envelope.id}), envelope idêntico: ${found.ok && found.value !== null}`);
 // Whatever the relay's writer policy says about a direct message, the adapter repeats it instead of claiming success.
 // Observed on 2026-09-29: kind 4 is refused for a writer that is not in the relay's allowlist.
 const peer = localNostrSigner(new Uint8Array(32).fill(201));
 const direct = createNostrRelay({url: RELAY!, codec, signer: identity.signer, recipients: [await peer.getPublicKey()], timeoutMs: 15000});
 const answer = await direct.publish(envelope);
 if (!answer.ok) {
  expect(answer.error.code).toBe('PERMISSION');
  expect(answer.error.message.length).toBeGreaterThan(0);
  console.log(`[relay real] ${RELAY}: kind ${DIRECT_MESSAGE_KIND} (mensagem direta) recusado pelo relay: ${answer.error.message}`);
 } else {
  console.log(`[relay real] ${RELAY}: kind ${DIRECT_MESSAGE_KIND} aceito por este escritor`);
 }
 direct.close();
 transport.close();
}, 40000);
