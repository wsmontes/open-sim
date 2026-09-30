// Nostr signaling (task 10 of docs/superpowers/plans/2026-09-29-federated-world.md; docs/OpenSim-Protocol-0.1.txt §23,
// §24 and §30). The signals are the exact documents the manual path of task 8 carries, framed as protocol objects and
// published through the relay adapter's private channel. Nothing here touches the network: an in-process NIP-01 relay
// stores what a writer sends and answers REQ by kind, `#p`, `#t` and `#d`, which is the one filter shape the relay
// adapter uses. The relay-real test at the end runs only when a relay is named.
import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {ed25519Verifier,generateSessionKeyPair,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {createManualSignaling,signSignal} from '../src/adapters/network/manual-signaling';
import type {SessionScope,SessionSigner,SignalKind,SignedSignal} from '../src/adapters/network/manual-signaling';
import {localNostrSigner,npubOf} from '../src/adapters/nostr/identity';
import type {NostrEvent,NostrSigner} from '../src/adapters/nostr/identity';
import {DIRECT_MESSAGE_KIND} from '../src/adapters/nostr/relay';
import type {RelaySocketFactory} from '../src/adapters/nostr/relay';
import {createNostrSignaling} from '../src/adapters/nostr/signaling';
import type {NostrSignaling,NostrSignalingRelay} from '../src/adapters/nostr/signaling';
import type {JsonValue} from '../src/world/model';

const codec = createJcsCodec(), verifier = ed25519Verifier();
const SESSION: SessionScope = {worldId: 'victoria', branchId: 'main', sessionId: 'sessao-1', epoch: 1};
const RELAY_URL = 'ws://relay.example';

// --- one in-process NIP-01 relay --------------------------------------------------------------------------------
// It respects the filters the relay adapter sends: kind, and the tags `#p`, `#t` and `#d`. A private read is
// `#p: own`, so a direct message addressed to one key never comes back to its sender — the behaviour a real relay has
// and the reason the two carriers do not echo into each other.
type FakeRelayOptions = {refusal?: (event: NostrEvent) => string | null; silent?: boolean};
type FakeRelay = {factory: RelaySocketFactory; stored: NostrEvent[]};
type TagFilter = {kinds?: number[]; '#p'?: string[]; '#t'?: string[]; '#d'?: string[]};
function tagValues(event: NostrEvent, name: string): string[] {
 return event.tags.filter(entry => entry[0] === name).map(entry => entry[1]);
}
// A real relay only forwards an event to a subscription whose filter it satisfies; forwarding to every open
// subscription would deliver the public branch of a read to a private reader and double every signal.
function filterMatches(filter: TagFilter, event: NostrEvent): boolean {
 if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
 for (const key of ['#p', '#t', '#d'] as const) {
  const wanted = filter[key];
  if (wanted && !wanted.some(value => tagValues(event, key.slice(1)).includes(value))) return false;
 }
 return true;
}
function fakeRelay(options: FakeRelayOptions = {}): FakeRelay {
 const stored: NostrEvent[] = [], open: {subscription: string; filter: TagFilter; send: (frame: unknown) => void}[] = [];
 const factory: RelaySocketFactory = () => {
  const messages: ((frame: string) => void)[] = [], closes: ((reason: string) => void)[] = [];
  const emit = (frame: unknown) => queueMicrotask(() => { for (const listener of [...messages]) listener(JSON.stringify(frame)); });
  return {
   send(raw) {
    if (options.silent) return;
    const frame = JSON.parse(raw) as unknown[];
    if (frame[0] === 'EVENT') {
     const event = frame[1] as NostrEvent;
     const refusal = options.refusal?.(event) ?? null;
     if (refusal === null) {
      stored.push(event);
      for (const subscription of [...open]) if (filterMatches(subscription.filter, event)) subscription.send(['EVENT', subscription.subscription, event]);
     }
     emit(['OK', event.id, refusal === null, refusal ?? '']);
     return;
    }
    if (frame[0] === 'REQ') {
     const subscription = String(frame[1]);
     const filter = frame[2] as TagFilter;
     for (const event of stored) if (filterMatches(filter, event)) emit(['EVENT', subscription, event]);
     emit(['EOSE', subscription]);
     open.push({subscription, filter, send: frame => emit(frame)});
     return;
    }
    if (frame[0] === 'CLOSE') {
     const index = open.findIndex(entry => entry.subscription === frame[1]);
     if (index >= 0) open.splice(index, 1);
    }
   },
   close() { for (const listener of [...closes]) listener('closed'); },
   onOpen(listener) { queueMicrotask(listener); },
   onMessage(listener) { messages.push(listener); },
   onClose(listener) { closes.push(listener); },
  };
 };
 return {factory, stored};
}

// --- one player: the npub that signs events, and the session key that signs signals -----------------------------
type Person = {actor: string; nostr: NostrSigner; keys: KeyPair};
async function person(fill: number): Promise<Person> {
 const nostr = localNostrSigner(new Uint8Array(32).fill(fill));
 const keys = await generateSessionKeyPair();
 return {actor: `nostr:${npubOf(await nostr.getPublicKey())}`, nostr, keys};
}
const sessionKeyOf = (keys: KeyPair): SessionSigner => ({key: keys.publicKey, sign: bytes => signEd25519(keys, bytes)});
function bindingsOf(...people: Person[]): Record<string, string> {
 const bindings: Record<string, string> = {};
 for (const one of people) bindings[one.actor] = one.keys.publicKey;
 return bindings;
}
function signalingOf(self: Person, bindings: Record<string, string>, relay: Partial<NostrSignalingRelay> & {socket: RelaySocketFactory}): NostrSignaling {
 return createNostrSignaling({codec, verifier, session: SESSION, bindings, actor: self.actor, signer: self.nostr, relay: {url: RELAY_URL, timeoutMs: 200, ...relay}});
}
async function signalOf(who: Person, kind: SignalKind, id: string, sequence: number, over: Partial<SessionScope> = {}, payload?: JsonValue): Promise<SignedSignal> {
 let body: JsonValue;
 if (payload !== undefined) body = payload;
 else if (kind === 'ice') body = {candidate: {candidate: 'candidate:1 1 udp 1 127.0.0.1 4000 typ host'}};
 else body = {description: {type: kind, sdp: 'v=0'}};
 return signSignal({codec, signer: sessionKeyOf(who.keys), actor: who.actor, session: {...SESSION, ...over}, signal: kind, id, sequence, payload: body});
}
const payloadText = (signal: SignedSignal): string => JSON.stringify(signal.payload);

test('a signal of another session never reaches a listener', async () => {
 const relay = fakeRelay(), ana = await person(7), bob = await person(8), bindings = bindingsOf(ana, bob);
 const sender = signalingOf(ana, bindings, {socket: relay.factory});
 const receiver = signalingOf(bob, bindings, {socket: relay.factory});
 const arrived: SignedSignal[] = [];
 receiver.subscribe((_peer, signal) => arrived.push(signal));
 await sender.send(bob.actor, await signalOf(ana, 'offer', 'sinal-outra', 1, {sessionId: 'outra-sessao'}));
 await expect.poll(() => receiver.refused().some(error => error.message.includes('outra sessão'))).toBe(true);
 expect(arrived).toHaveLength(0);
 sender.close();
 receiver.close();
});

test('a signal of an older epoch is refused before it is used', async () => {
 const relay = fakeRelay(), ana = await person(9), bob = await person(10), bindings = bindingsOf(ana, bob);
 const sender = signalingOf(ana, bindings, {socket: relay.factory});
 const receiver = signalingOf(bob, bindings, {socket: relay.factory});
 const arrived: SignedSignal[] = [];
 receiver.subscribe((_peer, signal) => arrived.push(signal));
 await sender.send(bob.actor, await signalOf(ana, 'offer', 'sinal-antiga', 1, {epoch: SESSION.epoch - 1}));
 await expect.poll(() => receiver.refused().some(error => error.message.includes('época anterior'))).toBe(true);
 expect(arrived).toHaveLength(0);
 sender.close();
 receiver.close();
});

test('a signal with a tampered probe or from an unbound key is refused', async () => {
 const relay = fakeRelay(), ana = await person(11), bob = await person(12), stranger = await person(13), bindings = bindingsOf(ana, bob);
 const sender = signalingOf(ana, bindings, {socket: relay.factory});
 const impostor = signalingOf(stranger, bindings, {socket: relay.factory});
 const receiver = signalingOf(bob, bindings, {socket: relay.factory});
 const arrived: SignedSignal[] = [];
 receiver.subscribe((_peer, signal) => arrived.push(signal));
 const valid = await signalOf(ana, 'offer', 'sinal-1', 1);
 // The payload no longer matches the bytes the session key signed.
 await sender.send(bob.actor, {...valid, payload: {description: {type: 'offer', sdp: 'v=0 ATACADO'}}});
 await expect.poll(() => receiver.refused().some(error => error.code === 'SIGNATURE')).toBe(true);
 // A valid signature by a key no invite bound to the actor is not the actor's word either; the impostor publishes under
 // its own actor, so it is the receiver's binding check — not this device's own-actor guard — that refuses it.
 await impostor.send(bob.actor, await signalOf(stranger, 'answer', 'sinal-2', 1));
 await expect.poll(() => receiver.refused().filter(error => error.code === 'SIGNATURE').length).toBe(2);
 expect(arrived).toHaveLength(0);
 sender.close();
 impostor.close();
 receiver.close();
});

test('an offer and an answer the relay carries reach the other side verified, once', async () => {
 const relay = fakeRelay(), ana = await person(14), bob = await person(15), bindings = bindingsOf(ana, bob);
 const sender = signalingOf(ana, bindings, {socket: relay.factory});
 const receiver = signalingOf(bob, bindings, {socket: relay.factory});
 const atBob: SignedSignal[] = [], atAna: SignedSignal[] = [];
 receiver.subscribe((_peer, signal) => atBob.push(signal));
 sender.subscribe((_peer, signal) => atAna.push(signal));
 const offer = await signalOf(ana, 'offer', 'sinal-oferta', 3);
 // Out of order on purpose: the counter does not order the kinds, so a later-numbered offer followed by an earlier
 // candidate is normal traffic, not a replay.
 const candidate = await signalOf(ana, 'ice', 'sinal-candidato', 1);
 await sender.send(bob.actor, offer);
 await sender.send(bob.actor, candidate);
 await expect.poll(() => atBob.map(signal => signal.id)).toEqual(['sinal-oferta', 'sinal-candidato']);
 expect(payloadText(atBob[0]!)).toContain('"offer"');
 // The same document carried again is not a new offer: it arrives exactly once and the replay is a refusal.
 await sender.send(bob.actor, offer);
 await expect.poll(() => receiver.refused().some(error => error.code === 'CONFLICT')).toBe(true);
 expect(atBob.filter(signal => signal.id === 'sinal-oferta')).toHaveLength(1);
 await receiver.send(ana.actor, await signalOf(bob, 'answer', 'sinal-resposta', 1));
 await expect.poll(() => atAna.map(signal => signal.id)).toEqual(['sinal-resposta']);
 expect(payloadText(atAna[0]!)).toContain('"answer"');
 expect(relay.stored.every(event => event.kind === DIRECT_MESSAGE_KIND)).toBe(true);
 sender.close();
 receiver.close();
});

test('an unavailable relay does not take the manual path down: the offer stays in the outbox', async () => {
 const ana = await person(16), bob = await person(17), bindings = bindingsOf(ana, bob);
 const dead: RelaySocketFactory = () => { throw new Error('relay indisponível'); };
 const signaling = signalingOf(ana, bindings, {socket: dead, timeoutMs: 40});
 // Opening the read side of a relay that cannot be dialed is not a failure: there is simply nothing to read yet.
 const stop = signaling.subscribe(() => {});
 expect(typeof stop).toBe('function');
 const offer = await signalOf(ana, 'offer', 'sinal-1', 1);
 await expect(signaling.send(bob.actor, offer)).rejects.toThrow(/NOT_FOUND/);
 expect(signaling.refused().some(error => error.code === 'NOT_FOUND')).toBe(true);
 // The fallback is the copy/paste path of task 8, still standing: the same person carries the text by hand.
 expect(signaling.pending()).toHaveLength(1);
 const text = signaling.copy(bob.actor);
 expect(text).not.toBeNull();
 const receiver = createManualSignaling({codec, verifier, session: SESSION, bindings});
 expect(await receiver.paste(text!)).toMatchObject({ok: true, value: {id: 'sinal-1', actor: ana.actor}});
 stop();
 signaling.close();
});

test('a relay that refuses the private kind is reported and the offer falls back to the outbox', async () => {
 // The reference relay allows public writes in a fixed list of kinds and refuses the rest; when it refuses kind 4 the
 // adapter reports the relay's own answer instead of pretending the signal was delivered.
 const relay = fakeRelay({refusal: event => (event.kind === DIRECT_MESSAGE_KIND ? 'blocked: kind not permitted for public writers' : null)});
 const ana = await person(18), bob = await person(19), bindings = bindingsOf(ana, bob);
 const signaling = signalingOf(ana, bindings, {socket: relay.factory});
 const stop = signaling.subscribe(() => {});
 await expect(signaling.send(bob.actor, await signalOf(ana, 'offer', 'sinal-1', 1))).rejects.toThrow(/PERMISSION/);
 const refused = signaling.refused();
 expect(refused).toHaveLength(1);
 expect(refused[0]!.message).toContain('blocked');
 expect(signaling.pending()).toHaveLength(1);
 expect(relay.stored).toHaveLength(0);
 stop();
 signaling.close();
});

// --- the real relay: exercised only when a relay is named, and reported as such ----------------------------------
const RELAY = process.env.OSIM_NOSTR_RELAY;

test.skipIf(!RELAY)('relay real: two peers exchange a signed offer and an answer over the relay', async () => {
 // Random keys and a session id of this run: the relay is durable, and material of a previous run is not this one's.
 const secret = () => crypto.getRandomValues(new Uint8Array(32));
 const make = async (): Promise<Person> => {
  const nostr = localNostrSigner(secret());
  const keys = await generateSessionKeyPair();
  return {actor: `nostr:${npubOf(await nostr.getPublicKey())}`, nostr, keys};
 };
 const ana = await make(), bob = await make(), bindings = bindingsOf(ana, bob);
 const scope: SessionScope = {...SESSION, sessionId: `sessao-real-${Date.now().toString(36)}`};
 const withScope = async (who: Person, kind: SignalKind, id: string): Promise<SignedSignal> =>
  signSignal({codec, signer: sessionKeyOf(who.keys), actor: who.actor, session: scope, signal: kind, id, sequence: 1, payload: kind === 'ice' ? {candidate: {candidate: 'candidate:1 1 udp 1 127.0.0.1 4000 typ host'}} : {description: {type: kind, sdp: `v=0\r\no=${kind} 1 1 IN IP4 127.0.0.1\r\n`}}});
 const relay: NostrSignalingRelay = {url: RELAY!, timeoutMs: 15000};
 const sender = createNostrSignaling({codec, verifier, session: scope, bindings, actor: ana.actor, signer: ana.nostr, relay});
 const receiver = createNostrSignaling({codec, verifier, session: scope, bindings, actor: bob.actor, signer: bob.nostr, relay});
 const atBob: SignedSignal[] = [], atAna: SignedSignal[] = [];
 receiver.subscribe((_peer, signal) => atBob.push(signal));
 sender.subscribe((_peer, signal) => atAna.push(signal));
 const offer = await withScope(ana, 'offer', `sinal-oferta-${scope.sessionId}`);
 // A relay's writer policy is input, not a promise: the reference relay's NIP-11 says public writes are limited to
 // kinds 0, 1, 3, 5, 6, 7 and 10002 and "all other kinds require the operator allowlist", so kind 4 is refused for a
 // writer that is not allowlisted — the refusal is reported, never hidden. This test proves the private round trip
 // when the relay permits it, and the reported refusal plus the verified manual carrier when it does not.
 let permit: boolean;
 try {
  await sender.send(bob.actor, offer);
  permit = true;
 } catch (error) {
  expect(String(error)).toMatch(/PERMISSION/);
  permit = false;
 }
 if (permit) {
  await expect.poll(() => atBob.length, {timeout: 30000}).toBe(1);
  expect(atBob[0]!.id).toBe(offer.id);
  expect(payloadText(atBob[0]!)).toBe(payloadText(offer));
  const answer = await withScope(bob, 'answer', `sinal-resposta-${scope.sessionId}`);
  await receiver.send(ana.actor, answer);
  await expect.poll(() => atAna.length, {timeout: 30000}).toBe(1);
  expect(atAna[0]!.id).toBe(answer.id);
  expect(payloadText(atAna[0]!)).toBe(payloadText(answer));
  expect(sender.pending()).toHaveLength(0);
  expect(receiver.pending()).toHaveLength(0);
  console.log(`[relay real] ${RELAY}: oferta e resposta assinadas trocadas em kind ${DIRECT_MESSAGE_KIND} e verificadas nos dois sentidos`);
 } else {
  expect(sender.refused().some(error => error.code === 'PERMISSION')).toBe(true);
  const carried = sender.copy(bob.actor);
  expect(carried).not.toBeNull();
  expect(await receiver.paste(carried!)).toMatchObject({ok: true, value: {id: offer.id, actor: ana.actor}});
  const answer = await withScope(bob, 'answer', `sinal-resposta-${scope.sessionId}`);
  await expect(receiver.send(ana.actor, answer)).rejects.toThrow(/PERMISSION/);
  const back = receiver.copy(ana.actor);
  expect(back).not.toBeNull();
  expect(await sender.paste(back!)).toMatchObject({ok: true, value: {id: answer.id, actor: bob.actor}});
  expect(atBob.map(signal => signal.id)).toEqual([offer.id]);
  expect(atAna.map(signal => signal.id)).toEqual([answer.id]);
  console.log(`[relay real] ${RELAY}: kind ${DIRECT_MESSAGE_KIND} recusado pela política de escrita do relay; a oferta e a resposta seguiram pelo transporte manual e foram verificadas nos dois sentidos`);
 }
 sender.close();
 receiver.close();
}, 60000);
