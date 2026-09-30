// Manual signaling: an offer and an answer are two texts the players carry from one device to the other
// (docs/superpowers/specs/2026-09-29-federated-world-design.md §8.4; plan Tarefa 8). Nothing here trusts the text — a
// signal is signed by the session key of a participant, that key has to be the one this session bound to the actor,
// and the signal has to belong to this session and this epoch. A pasted text that fails any of those is refused before
// a platform peer ever sees an offer, which is what makes "authenticated first" a property of the adapter instead of a
// promise in a comment. A Nostr or Matrix adapter implements the same `Signaling` port later; the transport above it
// never knows which one carried the text.
import {MAX_DEPTH,failed,ok} from '../../world/model';
import type {JsonValue,WorldError,WorldResult} from '../../world/model';
import {decodeUtf8,parseStrictJson} from '../../world/codec';
import type {WorldCodec} from '../../world/ports';
import {NETWORK_LIMITS} from '../../world/wire';
import type {MessageProof,SignatureVerifier} from '../../world/permissions';

export type SessionScope = {worldId: string; branchId: string; sessionId: string; epoch: number};
export type SignalKind = 'offer' | 'answer' | 'ice';
// The signed signal of §29: the payload is opaque here (SDP or an ICE candidate), the envelope is closed, and the
// signature is detached so the bytes of the signal never depend on their own proof.
export type SignedSignal = {
 worldProtocol: 2;
 wireVersion: 1;
 kind: 'signal';
 signal: SignalKind;
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 id: string;
 sequence: number;
 actor: string;
 payload: JsonValue;
 proof: MessageProof;
};
export type SessionSigner = {key: string; sign(bytes: Uint8Array): Promise<string>};
export type SignalText = {peer: string; text: string};
// `subscribe` only ever hands over a signal whose signature, session, epoch and key binding were verified by this
// adapter, so the transport above it can treat a signal as an authenticated message from `peer`.
export interface Signaling {
 send(peer: string, signal: SignedSignal): Promise<void>;
 subscribe(listener: (peer: string, signal: SignedSignal) => void): () => void;
}
export type ManualSignaling = Signaling & {
 pending(): readonly SignalText[];
 copy(peer: string): string | null;
 paste(text: string): Promise<WorldResult<SignedSignal>>;
 refused(): readonly WorldError[];
};

const SIGNAL_KINDS: readonly SignalKind[] = ['offer', 'answer', 'ice'];
// How many signals of this session the adapter still recognises as already used: enough for the exchanges of a live
// session, bounded so a long session does not grow a set per signal forever.
const REPLAY_WINDOW = 1024;
const SIGNAL_FIELDS = ['worldProtocol', 'wireVersion', 'kind', 'signal', 'worldId', 'branchId', 'sessionId', 'epoch', 'id', 'sequence', 'actor', 'payload', 'proof'];
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];
const SCHEME = /^[a-z][a-z0-9+.-]*:/i, IDENTIFIER = /^[^\s\u0000-\u001f]{1,200}$/, HEX = /^[0-9a-f]+$/;

// What a signature covers: every field of the signal except the proof itself.
export const signalBody = (signal: SignedSignal): JsonValue => ({
 worldProtocol: signal.worldProtocol, wireVersion: signal.wireVersion, kind: signal.kind, signal: signal.signal,
 worldId: signal.worldId, branchId: signal.branchId, sessionId: signal.sessionId, epoch: signal.epoch,
 id: signal.id, sequence: signal.sequence, actor: signal.actor, payload: signal.payload,
});
export const signalBytes = (signal: SignedSignal, codec: WorldCodec): Uint8Array => codec.encode(signalBody(signal));
// The form a player copies: the same document plus the detached proof, canonical JSON and no newline. The proof stays
// outside `signalBytes` so the bytes a signature covers never depend on the signature itself.
export const signalDocument = (signal: SignedSignal): JsonValue => ({
 ...signalBody(signal) as {[key: string]: JsonValue},
 proof: {kind:'message', algorithm:'Ed25519', sessionKey:signal.proof.sessionKey, signature:signal.proof.signature},
});
export const signalText = (signal: SignedSignal, codec: WorldCodec): string => new TextDecoder().decode(codec.encode(signalDocument(signal)));

export async function signSignal(request: {codec: WorldCodec; signer: SessionSigner; actor: string; session: SessionScope; signal: SignalKind; id: string; sequence: number; payload: JsonValue}): Promise<SignedSignal> {
 const base: SignedSignal = {
  worldProtocol: 2, wireVersion: 1, kind: 'signal', signal: request.signal, ...request.session,
  id: request.id, sequence: request.sequence, actor: request.actor, payload: request.payload,
  proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: request.signer.key, signature: ''},
 };
 return {...base, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: request.signer.key, signature: await request.signer.sign(signalBytes(base, request.codec))}};
}

// The copy/paste inbox of one player. `send` only puts a text in the outbox — there is no network here at all — and
// `paste` is the moment the text a person carried comes back in, so it is also the only gate it has to pass.
export function createManualSignaling(options: {codec: WorldCodec; verifier: SignatureVerifier; session: SessionScope; bindings: Readonly<Record<string, string>>; limit?: number}): ManualSignaling {
 const outbox: SignalText[] = [];
 const listeners = new Set<(peer: string, signal: SignedSignal) => void>();
 const refusals: WorldError[] = [];
 const lastSequence = new Map<string, number>();
 const delivered = new Set<string>();
 const deny = (error: WorldError): WorldResult<SignedSignal> => {refusals.push(error); return failed(error.code, error.message);};
 return {
  async send(peer, signal) { outbox.push({peer, text: signalText(signal, options.codec)}); },
  subscribe(listener) { listeners.add(listener); return () => {listeners.delete(listener);}; },
  pending: () => outbox.map(entry => ({...entry})),
  copy(peer) {
   const index = outbox.findIndex(entry => entry.peer === peer);
   if (index < 0) return null;
   return outbox.splice(index, 1)[0]!.text;
  },
  async paste(text) {
   const limit = options.limit ?? NETWORK_LIMITS.maxControlBytes;
   const bytes = new TextEncoder().encode(text.trim());
   if (!bytes.byteLength || bytes.byteLength > limit) return deny({code:'LIMIT', message:`Sinal de ${bytes.byteLength} bytes não cabe no limite de ${limit}`});
   const decoded = decodeUtf8(bytes);
   if (!decoded.ok) return deny(decoded.error);
   const parsed = parseStrictJson(decoded.value, MAX_DEPTH);
   if (!parsed.ok) return deny(parsed.error);
   const read = readSignal(parsed.value);
   if (!read.ok) return deny(read.error);
   const signal = read.value;
   if (signal.worldId !== options.session.worldId || signal.branchId !== options.session.branchId || signal.sessionId !== options.session.sessionId) return deny({code:'CONFLICT', message:'Sinal de outra sessão'});
   if (signal.epoch < options.session.epoch) return deny({code:'CONFLICT', message:`Sinal da época anterior ${signal.epoch}; esta sessão já está na época ${options.session.epoch}`});
   if (signal.epoch > options.session.epoch) return deny({code:'CONFLICT', message:`Sinal da época ${signal.epoch}, mais nova que a época ${options.session.epoch} desta sessão`});
   const bound = options.bindings[signal.actor];
   if (!bound) return deny({code:'SIGNATURE', message:`Ator ${signal.actor} não está vinculado a esta sessão`});
   if (bound !== signal.proof.sessionKey) return deny({code:'SIGNATURE', message:`A chave de sessão de ${signal.actor} não é a vinculada ao convite`});
   if (!await options.verifier.verify(signal.proof, signalBytes(signal, options.codec))) return deny({code:'SIGNATURE', message:`A assinatura de ${signal.actor} não cobre este sinal`});
   // Control traffic resists a replay by id: the same copy pasted twice is not a new offer. The sequence stays in the
   // document as the sender's counter, but it does not order the kinds — a candidate for the answer may legitimately
   // arrive before the answer it belongs to, and refusing it would cost connectivity instead of protecting anything.
   if (delivered.has(signal.id)) return deny({code:'CONFLICT', message:`Sinal ${signal.id} de ${signal.actor} já foi usado nesta sessão`});
   // The window is bounded: what a session can still recognise is the recent past of its own signals, and a signal older
   // than that is a case for reconciliation instead of an ever-growing set.
   delivered.add(signal.id);
   if (delivered.size > REPLAY_WINDOW) { const oldest = delivered.keys().next().value; if (oldest !== undefined) delivered.delete(oldest); }
   if (signal.sequence > (lastSequence.get(signal.actor) ?? 0)) lastSequence.set(signal.actor, signal.sequence);
   for (const listener of [...listeners]) await Promise.resolve(listener(signal.actor, signal));
   return ok(signal);
  },
  refused: () => [...refusals],
 };
}

// The text is a closed document: an unknown field means a newer contract, and this client refuses it instead of
// ignoring a field it cannot judge.
function readSignal(value: JsonValue): WorldResult<SignedSignal> {
 if (!plain(value)) return failed('MALFORMED', 'Sinal não é um objeto');
 for (const key of Object.keys(value)) {
  if (RESERVED_KEYS.includes(key)) return failed('MALFORMED', `Sinal com chave reservada: ${key}`);
  if (!SIGNAL_FIELDS.includes(key)) return failed('MALFORMED', `Sinal com campo desconhecido: ${key}`);
 }
 if (value['worldProtocol'] !== 2 || value['wireVersion'] !== 1) return failed('WIRE_VERSION_UNSUPPORTED', `Sinal de outra versão de protocolo: ${String(value['worldProtocol'])}/${String(value['wireVersion'])}`);
 if (value['kind'] !== 'signal') return failed('MALFORMED', 'O texto colado não é um sinal');
 const kind = value['signal'];
 if (typeof kind !== 'string' || !SIGNAL_KINDS.includes(kind as SignalKind)) return failed('MALFORMED', `Tipo de sinal desconhecido: ${String(kind)}`);
 const actor = value['actor'];
 if (typeof actor !== 'string' || !IDENTIFIER.test(actor) || !SCHEME.test(actor)) return failed('MALFORMED', 'O ator do sinal precisa de um esquema declarado');
 const proof = value['proof'];
 if (!plain(proof) || proof['kind'] !== 'message' || proof['algorithm'] !== 'Ed25519') return failed('MALFORMED', 'Sinal sem prova destacada');
 const sessionKey = proof['sessionKey'], signature = proof['signature'];
 if (typeof sessionKey !== 'string' || !HEX.test(sessionKey) || sessionKey.length !== 64) return failed('SIGNATURE', 'Chave de sessão do sinal inválida');
 if (typeof signature !== 'string' || !HEX.test(signature) || signature.length !== 128) return failed('SIGNATURE', 'Assinatura do sinal inválida');
 for (const field of ['worldId', 'branchId', 'sessionId', 'id'] as const) {
  const text = value[field];
  if (typeof text !== 'string' || !IDENTIFIER.test(text)) return failed('MALFORMED', `Sinal sem ${field}`);
 }
 const epoch = value['epoch'], sequence = value['sequence'];
 if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) return failed('MALFORMED', 'Sinal com época inválida');
 if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) return failed('MALFORMED', 'Sinal com sequência inválida');
 const payload = value['payload'];
 if (payload === undefined) return failed('MALFORMED', 'Sinal sem carga utilizável');
 return ok({
  worldProtocol: 2, wireVersion: 1, kind: 'signal', signal: kind as SignalKind,
  worldId: value['worldId'] as string, branchId: value['branchId'] as string, sessionId: value['sessionId'] as string,
  epoch: epoch as number, id: value['id'] as string, sequence: sequence as number, actor,
  payload, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey, signature},
 });
}
function plain(value: unknown): value is Record<string, JsonValue> {
 return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
