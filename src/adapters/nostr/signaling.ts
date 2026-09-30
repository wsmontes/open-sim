// Nostr signaling: the same signed offer/answer documents the manual path carries, published as protocol objects in a
// private relay channel (docs/superpowers/specs/2026-09-29-federated-world-design.md §8.1 and §8.4; plan Tarefa 10;
// docs/OpenSim-Protocol-0.1.txt §23, §24 and §30). The adapter implements the `Signaling` port of Tarefa 8, so the
// WebRTC transport above it does not know whether a person carried the text or a relay did.
//
// Three boundaries are deliberate:
//
//   * The relay is a transport, not a gate. A signal is framed as a `session` object of the protocol — session traffic
//     is not history (§24) — and handed to `createNostrRelay`, so the private channel is the one the relay adapter
//     already knows: kind 4, NIP-04, addressed to one recipient. No second framing, no new kind.
//   * Verification is the manual adapter's. `subscribe` decodes the object back to the exact document a person would
//     paste and puts it through `createManualSignaling`, the single place that checks the detached session-key proof,
//     the world/branch/session, the epoch, the key binding and the replay by signal id. A relay therefore cannot
//     deliver an offer the manual path would have refused, and both carriers share one fence.
//   * The manual path survives. A relay that is silent, refuses the kind or is unreachable leaves the offer in the
//     manual outbox instead of losing it: `send` publishes first and falls back to `pending()`/`copy()` on any
//     failure, so a person can still carry the signal by hand. The relay is never a single point of failure for a
//     session that already works by copy/paste.
//
// A private channel of the relay adapter is addressed by its *recipient*, not by its sender, and the REQ is
// `#p: own` — so one channel addressed to this device reads every sender that can talk to it. That is why reading
// needs no list of peers: the read channel is addressed to `actor` itself, which is also the one recipient whose key
// this device is guaranteed to hold. Sending opens a channel per peer on demand, because the recipient is what decides
// the encryption target. A signal of another session, of another epoch, with a tampered proof or already seen is
// refused before a listener ever sees it.
import {envelopeOf} from '../../world/osim';
import type {OsimEnvelope} from '../../world/osim';
import {failed,ok} from '../../world/model';
import type {JsonValue,WorldError,WorldResult} from '../../world/model';
import type {WorldCodec} from '../../world/ports';
import type {SignatureVerifier} from '../../world/permissions';
import type {Limits} from '../../world/wire';
import {createManualSignaling,signalDocument} from '../network/manual-signaling';
import type {ManualSignaling,SessionScope,SignalText,Signaling,SignedSignal} from '../network/manual-signaling';
import {pubkeyOf} from './identity';
import type {NostrSigner} from './identity';
import {createNostrRelay} from './relay';
import type {NostrRelay,RelaySocketFactory} from './relay';

// A signal travels as a `session` object; the signal's own id fences the replay, and the envelope id names the session
// because a signaling message is about the session, not a durable object of the world.
const SIGNAL_OBJECT_TYPE = 'session';
const SESSION_PREFIX = 'osim:session:';

export type NostrSignalingRelay = {
 url: string;
 socket?: RelaySocketFactory;
 timeoutMs?: number;
 limits?: Limits;
 kinds?: {public?: number; direct?: number};
 pageSize?: number;
 now?: () => string;
};
export type NostrSignalingConfig = {
 codec: WorldCodec;
 verifier: SignatureVerifier;
 session: SessionScope;
 // The key binding of the manual path: actor URI -> the session key that actor's signals must be signed with.
 bindings: Readonly<Record<string, string>>;
 // This device's protocol actor, `nostr:npub…`, and the signer whose key is that npub. A signal whose actor is not
 // this one is refused before it is published: the relay could not vouch for it and a reader would drop it.
 actor: string;
 signer: NostrSigner;
 relay: NostrSignalingRelay;
 limit?: number;
};
// The port of Tarefa 8 plus the manual inbox it falls back to: a relay that is down must not take the copy/paste path
// down with it, so the same outbox is reachable from here.
export type NostrSignaling = Signaling & {
 pending(): readonly SignalText[];
 copy(peer: string): string | null;
 paste(text: string): Promise<WorldResult<SignedSignal>>;
 refused(): readonly WorldError[];
 close(): void;
};

function plain(value: unknown): value is Record<string, JsonValue> {
 return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function textOf(error: unknown): string {
 return error instanceof Error ? error.message : String(error);
}
// The object the relay carries: the protocol envelope around the exact document a person would paste, signed by the
// npub the signal claims, because the relay only accepts an object whose `nostr:` actor is the event's own key.
function frame(signal: SignedSignal): OsimEnvelope {
 return envelopeOf(SIGNAL_OBJECT_TYPE, `${SESSION_PREFIX}${signal.sessionId}`, signal.actor, signalDocument(signal));
}

export function createNostrSignaling(config: NostrSignalingConfig): NostrSignaling {
 const codec = config.codec;
 const manual: ManualSignaling = createManualSignaling({codec, verifier: config.verifier, session: config.session, bindings: config.bindings, limit: config.limit});
 const channels = new Map<string, NostrRelay>();
 const transportRefusals: WorldError[] = [];
 let openListeners = 0, readerStop: (() => void) | null = null;
 let localIdentity: Promise<WorldResult<string>> | null = null;

 // The npub this device publishes under is asked of the signer once: an extension prompt is a user gesture, not a step
 // to repeat per signal. A signer that answers another key than `actor` claims is a misconfiguration, and publishing
 // under it would produce events every reader drops, so it is refused here instead. A failure is not remembered: a
 // locked signer may open later, and the manual path is exactly what has to keep working until it does.
 function ownKey(): Promise<WorldResult<string>> {
  if (!localIdentity) {
   localIdentity = (async () => {
    let key: string;
    try {
     key = await config.signer.getPublicKey();
    } catch (error) {
     localIdentity = null;
     return failed('NOT_FOUND', `Assinador Nostr indisponível: ${textOf(error)}`);
    }
    const claimed = pubkeyOf(config.actor);
    if (!claimed.ok) { localIdentity = null; return claimed; }
    if (claimed.value !== key) { localIdentity = null; return failed('SIGNATURE', `O ator ${config.actor} não é a chave deste assinador Nostr`); }
    return ok(key);
   })();
  }
  return localIdentity;
 }

 // One private channel per recipient, created on first use: the recipient decides `own` (this device) and the
 // encryption target, so two peers cannot share a send channel. `createNostrRelay` reads the channel lazily and
 // reports the relay's own refusals, so an unreachable relay is a failure of `publish`, never a throw here.
 function relayFor(peer: string): NostrRelay {
  let relay = channels.get(peer);
  if (!relay) {
   relay = createNostrRelay({
    url: config.relay.url, codec, signer: config.signer, recipients: [peer],
    socket: config.relay.socket, timeoutMs: config.relay.timeoutMs, limits: config.relay.limits,
    kinds: config.relay.kinds, pageSize: config.relay.pageSize, now: config.relay.now,
   });
   channels.set(peer, relay);
  }
  return relay;
 }

 // What the relay delivered is framed again exactly as it was signed, then handed to the manual gate. An object that
 // is not a signal of this session is dropped in silence: a relay's public branch carries other people's world
 // objects, and none of them is a signal this device should report as refused.
 async function ingest(object: OsimEnvelope): Promise<void> {
  if (object.type !== SIGNAL_OBJECT_TYPE) return;
  const body = object.body;
  if (!plain(body) || body['kind'] !== 'signal') return;
  await manual.paste(new TextDecoder().decode(codec.encode(body)));
 }

 // The read channel is addressed to this device itself: a private read is `#p: own`, so one subscription hears every
 // sender, and `actor` is the recipient key this device is sure to have. Nothing is ever published through it.
 function openReader(): () => void {
  return relayFor(config.actor).subscribe({}, object => { void ingest(object); });
 }

 async function publish(peer: string, signal: SignedSignal): Promise<WorldResult<void>> {
  const identity = await ownKey();
  if (!identity.ok) return identity;
  return relayFor(peer).publish(frame(signal));
 }

 return {
  async send(peer, signal) {
   // The actor of a signal is the publisher's protocol identity; a mismatch is a wiring error on this device, not a
   // relay failure, so it is refused instead of being pushed to a peer who would (rightly) drop it.
   if (signal.actor !== config.actor) {
    const error: WorldError = {code: 'SIGNATURE', message: `O sinal diz ser de ${signal.actor}, não de ${config.actor}`};
    transportRefusals.push(error);
    throw new Error(`${error.code}: ${error.message}`);
   }
   const published = await publish(peer, signal);
   if (published.ok) return;
   // The relay is somebody else's infrastructure: a refusal, a missing signer or an unreachable relay must not lose an
   // offer this device already signed, so the same document stays in the manual outbox for a person to carry.
   transportRefusals.push(published.error);
   await manual.send(peer, signal);
   throw new Error(`${published.error.code}: ${published.error.message}`);
  },
  // One relay subscription serves every listener; the manual inbox is what actually holds the delivered signals, so a
  // text that a person pastes reaches the same listeners a relay-delivered signal does.
  subscribe(listener) {
   const stopManual = manual.subscribe(listener);
   if (openListeners === 0) readerStop = openReader();
   openListeners += 1;
   let live = true;
   return () => {
    if (!live) return;
    live = false;
    stopManual();
    openListeners -= 1;
    if (openListeners === 0 && readerStop) { readerStop(); readerStop = null; }
   };
  },
  pending: () => manual.pending(),
  copy: peer => manual.copy(peer),
  paste: text => manual.paste(text),
  refused: () => [...transportRefusals, ...manual.refused()],
  close() {
   readerStop?.();
   readerStop = null;
   openListeners = 0;
   for (const relay of channels.values()) relay.close();
   channels.clear();
  },
 };
}
