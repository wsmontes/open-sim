// Signaling over a Matrix room (plan Tarefa 11; the `Signaling` port of Tarefa 8; design §8.2 and §8.4). An offer and
// an answer are room events of this project's own type, and the room is the channel: a private room of the session
// replaces the person carrying a text by hand, without becoming a second protocol. The signal itself is the same
// closed document of §29 — detached proof, session, epoch, key binding of the invite and replay window — and the gate
// that judges it is the Tarefa 8 adapter itself: what arrives from the room is fed to `createManualSignaling.paste`,
// so a carrier never gets its own idea of what a signal is.
//
// Three boundaries are load-bearing:
//   * Namespace. The event type lives under `org.opensim.` and `createMatrixRooms` refuses a configuration outside it
//     before a request is made; on the way back only that type is read, so another application's room event is never
//     a signal.
//   * The room vouches for the account, the signature vouches for the session. The envelope actor has to be the
//     `matrix:` URI the homeserver attributes to the sender, and the document inside has to be signed by the session
//     key the room binding delegated — a room power level is a room role and never a game permission.
//   * Session and epoch. A signal of another session, or of an epoch other than the current one, is not late: it
//     belongs to a conversation this device is no longer having.
//
// Known boundaries: every room member reads every signal, so `send`'s addressee is a routing hint and not a private
// channel; privacy is the room, and a session that needs the relay to not read its traffic has to say so when the
// room is bound (`acceptEncrypted`) and supply the two cipher ports. And a room keeps the exchange, so a client that
// subscribes late reads the session's own signals — the epoch is what fences a previous writer's material, and the
// transport above is the one that decides what a repeated offer means.
import {failed} from '../../world/model';
import type {WorldError,WorldResult} from '../../world/model';
import {OSIM_VERSION,checkEnvelope} from '../../world/osim';
import type {OsimEnvelope} from '../../world/osim';
import type {WorldCodec} from '../../world/ports';
import type {SignatureVerifier} from '../../world/permissions';
import type {Limits} from '../../world/wire';
import {createManualSignaling,signalDocument} from '../network/manual-signaling';
import type {SessionScope,Signaling,SignedSignal} from '../network/manual-signaling';
import {matrixUriOf} from './identity';
import type {MatrixAccount,MatrixFetch} from './identity';
import {createMatrixRooms} from './rooms';
import type {RoomBinding,SealPort,UnsealPort} from './rooms';

// A signal is session traffic (§24), so it travels as a `session` object whose body is the closed signal document.
export const SIGNAL_EVENT_TYPE = 'org.opensim.signal.v0';
// What a caller can read is a bounded window, not a log a hostile room can grow.
const REFUSAL_WINDOW = 64;

// `send` returns only a promise, so a refusal has to travel on the rejection — the same shape the WebRTC port uses.
export class SignalingRefused extends Error {
 readonly error: WorldError;
 constructor(error: WorldError) {
  super(error.message);
  this.name = 'SignalingRefused';
  this.error = error;
 }
}

export type MatrixSignalingConfig = {
 account: MatrixAccount;
 binding: RoomBinding;
 codec: WorldCodec;
 verifier: SignatureVerifier;
 session: SessionScope;
 // The session key each peer's actor is bound to — the `bindings` of the Tarefa 8 gate. This account's own binding
 // comes from the room binding, so a caller does not have to pass its own entry.
 bindings: Readonly<Record<string, string>>;
 fetch?: MatrixFetch;
 timeoutMs?: number;
 limits?: Limits;
 pageSize?: number;
 pages?: number;
 pollMs?: number;
 eventType?: string;
 unseal?: UnsealPort;
 seal?: SealPort;
};
// What this adapter refused to deliver, in the order it judged it, followed by the events the room itself refused to
// hand over (`createMatrixRooms` reports those separately because it never saw a body it could judge).
export type MatrixSignaling = Signaling & {refused(): readonly WorldError[]; roomId(): string; close(): void};

// The protocol object a signal travels as. The id embeds the session and the signal's own id, because the room's
// transaction idempotency is derived from it: two signals of two sessions in the same room must not share one.
export function signalEnvelope(signal: SignedSignal): WorldResult<OsimEnvelope> {
 if (typeof signal.id !== 'string' || !signal.id.length) return failed('MALFORMED', 'Sinal sem identificador');
 return checkEnvelope({osim: OSIM_VERSION, type: 'session', id: `osim:session:${signal.sessionId}.${signal.id}`, actor: signal.actor, body: signalDocument(signal)});
}

export function createMatrixSignaling(config: MatrixSignalingConfig): MatrixSignaling {
 const {account, binding, codec, session} = config;
 const eventType = config.eventType ?? SIGNAL_EVENT_TYPE;
 const selfUri = matrixUriOf(account.userId);
 // The room binding is this account's evidence about the session key it delegated; a caller-supplied entry for the
 // same actor cannot contradict it.
 const gate = createManualSignaling({codec, verifier: config.verifier, session, bindings: {...config.bindings, [selfUri]: binding.sessionKey}});
 const rooms = createMatrixRooms({
  account, binding, codec, eventType,
  fetch: config.fetch, timeoutMs: config.timeoutMs, limits: config.limits,
  pageSize: config.pageSize, pages: config.pages, pollMs: config.pollMs,
  unseal: config.unseal, seal: config.seal,
 });
 const listeners = new Set<(peer: string, signal: SignedSignal) => void>();
 const refusals: WorldError[] = [];
 let stop: (() => void) | null = null;
 function remember(error: WorldError): void {
  if (refusals.length >= REFUSAL_WINDOW) refusals.shift();
  refusals.push(error);
 }
 // What the room delivers is an object of the session event type; whether it is a signal, and whose, is decided by
 // the Tarefa 8 gate and by the one thing the room adds to it: the account the homeserver says wrote the event.
 async function accept(envelope: OsimEnvelope): Promise<void> {
  if (envelope.actor === selfUri) return;
  if (envelope.type !== 'session') return remember({code:'MALFORMED', message:`Objeto ${envelope.type} no evento de sinalização ${eventType}`});
  const accepted = await gate.paste(new TextDecoder().decode(codec.encode(envelope.body)));
  if (!accepted.ok) return remember(accepted.error);
  if (accepted.value.actor !== envelope.actor) return remember({code:'PERMISSION', message:`O ator do corpo do sinal (${accepted.value.actor}) não é o ator atestado pela sala (${envelope.actor})`});
  for (const listener of [...listeners]) listener(accepted.value.actor, accepted.value);
 }
 return {
  async send(peer, signal) {
   if (signal.actor !== selfUri) throw new SignalingRefused({code:'SIGNATURE', message:`O sinal diz ser de ${signal.actor}, mas esta conta é ${selfUri}`});
   if (signal.worldId !== session.worldId || signal.branchId !== session.branchId || signal.sessionId !== session.sessionId || signal.epoch !== session.epoch) {
    throw new SignalingRefused({code:'CONFLICT', message:`Sinal de ${signal.worldId}/${signal.branchId}/${signal.sessionId}@${signal.epoch}, não da sessão ${session.sessionId}@${session.epoch}`});
   }
   if (signal.proof.sessionKey !== binding.sessionKey) throw new SignalingRefused({code:'SIGNATURE', message:'O sinal não foi assinado pela chave de sessão que o vínculo da sala delegou a esta conta'});
   // A room carries the signals of its own accounts; a peer of another community is not addressable from here.
   if (!peer.startsWith('matrix:')) throw new SignalingRefused({code:'MALFORMED', message:`${peer} não é uma conta Matrix: este adaptador entrega por sala`});
   const envelope = signalEnvelope(signal);
   if (!envelope.ok) throw new SignalingRefused(envelope.error);
   const written = await rooms.publish(envelope.value);
   if (!written.ok) throw new SignalingRefused(written.error);
  },
  subscribe(listener) {
   listeners.add(listener);
   // A gate that throws (a platform crypto failure, a document it could not judge) must not become an unhandled
   // rejection inside the poll loop: it is one more refusal of one event.
   if (!stop) stop = rooms.subscribe({}, object => {void accept(object).catch(error => {remember({code:'SIGNATURE', message:`Falha ao verificar o sinal: ${error instanceof Error ? error.message : String(error)}`});});});
   return () => {
    listeners.delete(listener);
    if (!listeners.size && stop) { stop(); stop = null; }
   };
  },
  refused: () => [...refusals, ...rooms.refusals().map(entry => ({code: entry.code, message: entry.message}))].slice(-REFUSAL_WINDOW),
  roomId: () => rooms.roomId(),
  close() {
   if (stop) { stop(); stop = null; }
   listeners.clear();
   rooms.close();
  },
 };
}
