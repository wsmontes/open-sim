// The object port of a live session (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.3, §9.3; OpenSim
// Protocol §21–22). An object is addressed by the hash of its bytes, so this port never invents a format: the sender
// streams segments of the exact bytes, the receiver asks from the cursor it already holds, and the whole object is
// checked against its address before it is handed over or written anywhere. Three properties follow from that and from
// nothing else: a truncated or adulterated stream can never become an object, a dropped connection costs the tail
// instead of the whole transfer, and the platform buffer — not a timeout — decides how fast a stream may go.
//
// The channel is a port, so the same logic runs over a data channel, a test wire or another runtime's transport, and
// the negotiation is a number: `limits` and `backpressure` arrive already agreed and are narrowed here, never raised.
import {failed,ok,sameRef} from '../../world/model';
import type {ObjectRef,WorldError,WorldResult} from '../../world/model';
import type {ContentHasher} from '../../world/ports';
import {NETWORK_LIMITS,narrowerLimits} from '../../world/wire';
import type {Limits} from '../../world/wire';
import type {ObjectStore} from '../blobs/direct';

// The plan's constraint for a live session: suspend sending at 1 MiB of platform buffer and only resume below 256 KiB.
export type Backpressure = {highWaterBytes: number; lowWaterBytes: number};
export const BUFFER_AGREEMENT: Backpressure = {highWaterBytes: 1024 * 1024, lowWaterBytes: 256 * 1024};
export function narrowerBackpressure(left: Backpressure, right: Backpressure): Backpressure {
 const highWaterBytes = Math.min(left.highWaterBytes, right.highWaterBytes);
 return {highWaterBytes, lowWaterBytes: Math.max(0, Math.min(left.lowWaterBytes, right.lowWaterBytes, highWaterBytes - 1))};
}

// --- the wire format of the segment channel (binary, addressed, no base64) ---------------------------------------
export type FrameTag = 'request' | 'segment' | 'complete' | 'missing';
export type ObjectFrame = {tag: FrameTag; ref: ObjectRef; offset: number; payload?: Uint8Array};
const TAG: Record<FrameTag, number> = {request:1, segment:2, complete:3, missing:4};
const TAG_OF: Record<number, FrameTag> = {1:'request', 2:'segment', 3:'complete', 4:'missing'};
const HASH_BYTES = 32, HEADER_BYTES = 1 + HASH_BYTES + 4 + 4;
const HEX = /^[0-9a-f]{64}$/;

export function writeFrame(frame: ObjectFrame): Uint8Array {
 if (!HEX.test(frame.ref.hash)) throw new Error(`Endereço de objeto inválido: ${frame.ref.hash}`);
 if (!Number.isSafeInteger(frame.ref.bytes) || frame.ref.bytes < 0 || frame.ref.bytes > 0xffffffff) throw new Error(`Tamanho de objeto fora do alcance do quadro: ${frame.ref.bytes}`);
 if (!Number.isSafeInteger(frame.offset) || frame.offset < 0 || frame.offset > 0xffffffff) throw new Error(`Deslocamento fora do alcance do quadro: ${frame.offset}`);
 const payload = frame.payload ?? new Uint8Array(0);
 const bytes = new Uint8Array(HEADER_BYTES + payload.byteLength);
 bytes[0] = TAG[frame.tag];
 bytes.set(hexBytes(frame.ref.hash), 1);
 const view = new DataView(bytes.buffer);
 view.setUint32(1 + HASH_BYTES, frame.offset, false);
 view.setUint32(1 + HASH_BYTES + 4, frame.ref.bytes, false);
 bytes.set(payload, HEADER_BYTES);
 return bytes;
}
export function readFrame(bytes: Uint8Array): WorldResult<ObjectFrame> {
 if (bytes.byteLength < HEADER_BYTES) return failed('MALFORMED', `Quadro de ${bytes.byteLength} bytes não tem cabeçalho`);
 const tag = TAG_OF[bytes[0]!];
 if (!tag) return failed('MALFORMED', `Quadro de tipo desconhecido: ${bytes[0]}`);
 const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
 const hash = hexText(bytes.subarray(1, 1 + HASH_BYTES));
 const offset = view.getUint32(1 + HASH_BYTES, false), total = view.getUint32(1 + HASH_BYTES + 4, false);
 const payload = bytes.byteLength > HEADER_BYTES ? bytes.subarray(HEADER_BYTES) : undefined;
 return ok({tag, ref:{hash, bytes:total}, offset, ...(payload ? {payload} : {})});
}
const DIGITS = '0123456789abcdef';
function hexBytes(hex: string): Uint8Array {
 const bytes = new Uint8Array(HASH_BYTES);
 for (let index = 0; index < HASH_BYTES; index += 1) bytes[index] = (DIGITS.indexOf(hex[index * 2]!) << 4) | DIGITS.indexOf(hex[index * 2 + 1]!);
 return bytes;
}
function hexText(bytes: Uint8Array): string {
 let text = '';
 for (const byte of bytes) text += `${DIGITS[byte >> 4]}${DIGITS[byte & 15]}`;
 return text;
}

// --- the channel and the state a transfer needs across calls -----------------------------------------------------
// What a transfer asks of a channel: hand a frame over, say how much the platform still buffers, wait until the
// buffer is below a floor, be told a frame arrived, and be told the channel is gone.
export type ObjectLink = {
 peer: string;
 send(frame: Uint8Array): void;
 bufferedAmount(): number;
 drain(below: number): Promise<void>;
 receive(listener: (frame: Uint8Array) => void): () => void;
 closed(listener: () => void): () => void;
};
// The bytes of an interrupted transfer, kept so the next attempt asks for the tail instead of starting over. A shelf
// belongs to the device, not to the connection, which is what makes a resume survive the connection that dropped.
export type PartialShelf = {get(ref: ObjectRef): Uint8Array | undefined; set(ref: ObjectRef, bytes: Uint8Array): void; clear(ref: ObjectRef): void};
export function createPartialShelf(): PartialShelf {
 const held = new Map<string, Uint8Array>();
 const key = (ref: ObjectRef) => `${ref.hash}@${ref.bytes}`;
 return {
  get(ref) { return held.get(key(ref))?.slice(); },
  set(ref, bytes) { held.set(key(ref), bytes.slice()); },
  clear(ref) { held.delete(key(ref)); },
 };
}
// The 64 MiB of concurrent transfer per session (spec §9.3). A transfer reserves the whole object before a byte is
// allocated, so a peer cannot make this device allocate past the ceiling by announcing a large object.
export type ObjectBudget = {reserve(bytes: number): boolean; release(bytes: number): void; available(): number};
export function createObjectBudget(limit: number = NETWORK_LIMITS.maxInflightObjectBytes): ObjectBudget {
 let used = 0;
 return {
  reserve(bytes) { if (bytes < 0 || used + bytes > limit) return false; used += bytes; return true; },
  release(bytes) { used = Math.max(0, used - bytes); },
  available: () => limit - used,
 };
}
export type TransferPorts = {
 links: {get(peer: string): ObjectLink | null};
 hasher: ContentHasher;
 budget: ObjectBudget;
 store?: ObjectStore;
 limits?: Limits;
 backpressure?: Backpressure;
 resume?: PartialShelf;
 onRefused?: (error: WorldError) => void;
};
export type ServedObject = {stop: () => void; idle: () => Promise<void>};
export type ServeOptions = {link: ObjectLink; store: ObjectStore; limits?: Limits; backpressure?: Backpressure; onRefused?: (error: WorldError) => void};

// --- receiving ---------------------------------------------------------------------------------------------------
export async function transferObject(ref: ObjectRef, peer: string, ports: TransferPorts): Promise<WorldResult<Uint8Array>> {
 const limits = narrowerLimits(NETWORK_LIMITS, ports.limits ?? NETWORK_LIMITS);
 const backpressure = narrowerBackpressure(BUFFER_AGREEMENT, ports.backpressure ?? BUFFER_AGREEMENT);
 // Both refusals happen before a single byte is allocated or asked for.
 if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0) return failed('MALFORMED', `Tamanho de objeto inválido: ${ref.bytes}`);
 if (!HEX.test(ref.hash)) return failed('MALFORMED', `Endereço de objeto inválido: ${ref.hash}`);
 if (ref.bytes > limits.maxObjectBytes) return failed('LIMIT', `Objeto de ${ref.bytes} bytes excede o teto negociado de ${limits.maxObjectBytes}`);
 const link = ports.links.get(peer);
 if (!link) return failed('NOT_FOUND', `Sem canal de objeto com ${peer}`);
 if (!ports.budget.reserve(ref.bytes)) return failed('LIMIT', `Transferência de ${ref.bytes} bytes não cabe nos ${ports.budget.available()} bytes livres da sessão`);
 try {
  const held = ports.resume?.get(ref);
  const bytes = new Uint8Array(ref.bytes);
  let received = 0;
  if (held) {
   received = Math.min(held.byteLength, ref.bytes);
   bytes.set(held.subarray(0, received), 0);
  }
  let settled: WorldResult<Uint8Array> | null = null, finished = false, lost = false, wait: (() => void) | null = null;
  const note = () => { const wake = wait; wait = null; wake?.(); };
  const refuse = (error: WorldError, stop: boolean) => { ports.onRefused?.(error); if (stop) settled = failed(error.code, error.message); };
  const offFrame = link.receive(frame => {
   if (settled) return;
   const read = readFrame(frame);
   if (!read.ok) { refuse(read.error, false); return; }
   const parsed = read.value;
   // A frame that names another object is not this transfer's business: another one may be waiting for it.
   if (parsed.ref.hash !== ref.hash || parsed.ref.bytes !== ref.bytes) { refuse({code:'MALFORMED', message:`Quadro de outro objeto: ${parsed.ref.hash.slice(0, 12)}…`}, false); return; }
   if (parsed.tag === 'missing') { settled = failed('MISSING_OBJECT', `O par não tem o objeto ${ref.hash.slice(0, 12)}…`); note(); return; }
   if (parsed.tag === 'complete') { finished = true; note(); return; }
   if (parsed.tag !== 'segment') { refuse({code:'MALFORMED', message:`Quadro de ${parsed.tag} não pertence a uma transferência`}, false); return; }
   const payload = parsed.payload ?? new Uint8Array(0);
   if (payload.byteLength > limits.maxSegmentBytes) { refuse({code:'LIMIT', message:`Segmento de ${payload.byteLength} bytes excede o teto negociado de ${limits.maxSegmentBytes}`}, true); note(); return; }
   if (parsed.offset + payload.byteLength > ref.bytes) { refuse({code:'MALFORMED', message:`Segmento em ${parsed.offset} ultrapassa os ${ref.bytes} bytes do objeto`}, true); note(); return; }
   if (parsed.offset < received) return;
   if (parsed.offset > received) { refuse({code:'CONFLICT', message:`Segmento em ${parsed.offset} saltou os ${received} bytes já recebidos`}, true); note(); return; }
   bytes.set(payload, parsed.offset);
   received += payload.byteLength;
   note();
  });
  const offClose = link.closed(() => { lost = true; note(); });
  try {
   while (!settled && !finished && !lost && received < ref.bytes) {
    await pace(link, backpressure);
    if (settled || lost) break;
    const pending = new Promise<void>(resolve => { wait = resolve; });
    try { link.send(writeFrame({tag:'request', ref, offset:received})); } catch { lost = true; break; }
    await pending;
   }
   if (settled) return settled;
   if (received < ref.bytes) {
    if (lost) {
     ports.resume?.set(ref, bytes.subarray(0, received));
     return failed('MISSING_OBJECT', `Conexão caiu com ${received} de ${ref.bytes} bytes; a retomada continua daqui`);
    }
    ports.resume?.clear(ref);
    return failed('HASH_MISMATCH', `Objeto incompleto: ${received} de ${ref.bytes} bytes`);
   }
   // Only bytes that match the address go anywhere: not into the store, not out of this function.
   if (!sameRef(await ports.hasher.ref(bytes), ref)) { ports.resume?.clear(ref); return failed('HASH_MISMATCH', `Os bytes recebidos não correspondem ao endereço ${ref.hash.slice(0, 12)}…`); }
   if (ports.store) {
    const written = await ports.store.put(bytes);
    if (!written.ok) return written;
    if (!sameRef(written.value, ref)) return failed('HASH_MISMATCH', 'O armazenamento guardou outro endereço para estes bytes');
   }
   ports.resume?.clear(ref);
   return ok(bytes);
  } finally { offFrame(); offClose(); }
 } finally { ports.budget.release(ref.bytes); }
}
// The platform buffer is the throttle: a saturated channel is not an error, it is the moment to wait for the drain
// that the negotiation says resumes the stream.
async function pace(link: ObjectLink, backpressure: Backpressure): Promise<void> {
 if (link.bufferedAmount() < backpressure.highWaterBytes) return;
 await link.drain(backpressure.lowWaterBytes);
}

// --- serving -----------------------------------------------------------------------------------------------------
// The side that holds the bytes. One pump per object at a time, and a pump that stops when the channel is gone: a
// serving peer never buffers a whole object in the platform either, it waits for the drain exactly like the receiver.
export function serveObjects(options: ServeOptions): ServedObject {
 const limits = narrowerLimits(NETWORK_LIMITS, options.limits ?? NETWORK_LIMITS);
 const backpressure = narrowerBackpressure(BUFFER_AGREEMENT, options.backpressure ?? BUFFER_AGREEMENT);
 const serving = new Map<string, Promise<void>>();
 const idlers = new Set<() => void>();
 let busy = 0, stopped = false;
 const settleIdle = () => { if (busy > 0) return; for (const resolve of [...idlers]) { idlers.delete(resolve); resolve(); } };
 const idle = () => busy === 0 ? Promise.resolve() : new Promise<void>(resolve => {idlers.add(resolve);});
 const pump = async (ref: ObjectRef, from: number): Promise<void> => {
  busy += 1;
  try {
   const held = await options.store.get(ref);
   if (!held.ok) { if (!stopped) options.link.send(writeFrame({tag:'missing', ref, offset:0})); return; }
   const total = held.value.byteLength;
   for (let cursor = from; cursor < total && !stopped;) {
    if (options.link.bufferedAmount() >= backpressure.highWaterBytes) {
     busy -= 1;
     settleIdle();
     try { await options.link.drain(backpressure.lowWaterBytes); } finally { busy += 1; }
    }
    if (stopped) return;
    const end = Math.min(cursor + limits.maxSegmentBytes, total);
    options.link.send(writeFrame({tag:'segment', ref, offset:cursor, payload:held.value.subarray(cursor, end)}));
    cursor = end;
   }
   if (!stopped) options.link.send(writeFrame({tag:'complete', ref, offset:total}));
  } finally {
   busy -= 1;
   settleIdle();
  }
 };
 const run = (ref: ObjectRef, from: number) => {
  const key = `${ref.hash}@${ref.bytes}`;
  if (serving.has(key)) return;
  // A channel that is gone ends this pump; the receiver decides what a lost tail means.
  const task = pump(ref, from).catch(() => {}).finally(() => { serving.delete(key); });
  serving.set(key, task);
  void task;
 };
 const off = options.link.receive(frame => {
  const read = readFrame(frame);
  if (!read.ok) { options.onRefused?.(read.error); return; }
  if (read.value.tag !== 'request') return;
  if (read.value.ref.bytes > limits.maxObjectBytes) { options.onRefused?.({code:'LIMIT', message:`Pedido de ${read.value.ref.bytes} bytes excede o teto negociado de ${limits.maxObjectBytes}`}); return; }
  run(read.value.ref, read.value.offset);
 });
 return {
  stop() { stopped = true; off(); },
  idle,
 };
}
