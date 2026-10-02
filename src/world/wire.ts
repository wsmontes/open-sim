import type {JsonValue, WorldResult} from './model';
import {MAX_DEPTH, WIRE_VERSION, WORLD_PROTOCOL, failed, ok} from './model';
import type {WorldCodec} from './ports';
import {decodeUtf8, parseStrictJson} from './codec';
import {assertClosed,isPlainObject,} from '../core/guards';

// The framing of a live session (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.3). Pure: the contract
// owns the envelope, the traffic classes and the byte ceilings; the runtime supplies the codec and the transport.
//
// The envelope is closed and it is the *only* thing this layer interprets: it declares which class of traffic the
// message belongs to, who it is for (world, branch, session, epoch) and an id that makes a repeated delivery
// recognisable. The body stays opaque apart from declaring its own `kind`, so the next layer can pick the closed
// schema that fits it — adding a body kind does not change the framing, adding an envelope field is a new wireVersion.
export type TrafficClass = 'control' | 'durable' | 'ephemeral' | 'object';
export type WireEnvelope = {
 worldProtocol: 2;
 wireVersion: 1;
 kind: 'message';
 class: TrafficClass;
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 id: string;
};
export type WireMessage = {envelope: WireEnvelope; body: JsonValue};

// Limits from the plan's global constraints (spec §9.3), applied before parsing or allocating beyond a ceiling. The
// numbers are the MVP targets: a session may negotiate them lower, never higher.
export type Limits = {
 participants: number;
 maxControlBytes: number;
 maxDurableBytes: number;
 maxSegmentBytes: number;
 maxObjectBytes: number;
 maxInflightObjectBytes: number;
 maxProposalQueue: number;
 proposalsPerSecond: number;
 presencePerSecond: number;
};
export const NETWORK_LIMITS: Limits = {
 participants: 8,
 maxControlBytes: 64 * 1024,
 maxDurableBytes: 64 * 1024,
 maxSegmentBytes: 16 * 1024,
 maxObjectBytes: 32 * 1024 * 1024,
 maxInflightObjectBytes: 64 * 1024 * 1024,
 maxProposalQueue: 128,
 proposalsPerSecond: 20,
 presencePerSecond: 10,
};
// Every ceiling is negotiated towards the smaller number: a peer never raises what this client will allocate.
export function narrowerLimits(left: Limits, right: Limits): Limits {
 return {
  participants: Math.min(left.participants, right.participants),
  maxControlBytes: Math.min(left.maxControlBytes, right.maxControlBytes),
  maxDurableBytes: Math.min(left.maxDurableBytes, right.maxDurableBytes),
  maxSegmentBytes: Math.min(left.maxSegmentBytes, right.maxSegmentBytes),
  maxObjectBytes: Math.min(left.maxObjectBytes, right.maxObjectBytes),
  maxInflightObjectBytes: Math.min(left.maxInflightObjectBytes, right.maxInflightObjectBytes),
  maxProposalQueue: Math.min(left.maxProposalQueue, right.maxProposalQueue),
  proposalsPerSecond: Math.min(left.proposalsPerSecond, right.proposalsPerSecond),
  presencePerSecond: Math.min(left.presencePerSecond, right.presencePerSecond),
 };
}
// A static table: the class decides which ceiling applies. Presence is bounded by rate in the spec, not by size, so it
// shares the control ceiling instead of inventing a number.
const CLASS_CEILING: Record<TrafficClass, 'maxControlBytes' | 'maxDurableBytes' | 'maxSegmentBytes'> = {
 control: 'maxControlBytes',
 durable: 'maxDurableBytes',
 ephemeral: 'maxControlBytes',
 object: 'maxSegmentBytes',
};

export function encodeMessage(message: WireMessage, codec: WorldCodec): Uint8Array {
 return codec.encode(message as unknown as JsonValue);
}
export function decodeMessage(bytes: Uint8Array, limits: Limits = NETWORK_LIMITS): WorldResult<WireMessage> {
 // The class is inside the bytes, so the first guard uses the largest ceiling of the framed classes; the exact
 // ceiling is enforced once the envelope says which class this is.
 const ceiling = Math.max(limits.maxControlBytes, limits.maxDurableBytes);
 if (bytes.byteLength > ceiling) return failed('LIMIT', `Mensagem de ${bytes.byteLength} bytes excede o limite de ${ceiling}`);
 const decoded = decodeUtf8(bytes);
 if (!decoded.ok) return decoded;
 const parsed = parseStrictJson(decoded.value, MAX_DEPTH);
 if (!parsed.ok) return parsed;
 try {
  return messageFrom(parsed.value, bytes.byteLength, limits);
 } catch (error) {
  return failed('MALFORMED', error instanceof Error ? error.message : 'Mensagem inválida');
 }
}
// Whether an id was already delivered, and whether it was delivered in a context this session can still accept. A
// repeat of the same message is answered from the receipt it produced; the same id in another epoch, branch, session
// or world is fenced by the previous epoch and must not be applied again (spec §7.5).
export type Replay = 'new' | 'duplicate' | 'replay';
export function replayOf(seen: readonly WireEnvelope[], envelope: WireEnvelope): Replay {
 let known = false;
 for (const entry of seen) {
  if (entry.id !== envelope.id) continue;
  known = true;
  if (entry.class === envelope.class && entry.worldId === envelope.worldId && entry.branchId === envelope.branchId && entry.sessionId === envelope.sessionId && entry.epoch === envelope.epoch) return 'duplicate';
 }
 return known ? 'replay' : 'new';
}

// --- shape validation ------------------------------------------------------------------------------------------
function addressPart(value: unknown, label: string): WorldResult<string> {
 if (typeof value !== 'string' || !value.length || value.length > 80) return failed('MALFORMED', `${label} inválido`);
 return ok(value);
}
function messageFrom(value: JsonValue, byteLength: number, limits: Limits): WorldResult<WireMessage> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Mensagem não é um objeto');
 const envelope = value['envelope'];
 if (!isPlainObject(envelope)) return failed('MALFORMED', 'Mensagem sem envelope');
 assertClosed(envelope, ['worldProtocol', 'wireVersion', 'kind', 'class', 'worldId', 'branchId', 'sessionId', 'epoch', 'id'], 'Envelope');
 if (envelope['worldProtocol'] !== WORLD_PROTOCOL) return failed('WORLD_PROTOCOL_UNSUPPORTED', `Protocolo de mundo ${String(envelope['worldProtocol'])} não é suportado (esperado ${WORLD_PROTOCOL})`);
 if (envelope['wireVersion'] !== WIRE_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `Versão de transporte ${String(envelope['wireVersion'])} não é suportada (esperada ${WIRE_VERSION})`);
 const traffic = envelope['class'];
 if (traffic !== 'control' && traffic !== 'durable' && traffic !== 'ephemeral' && traffic !== 'object') return failed('MALFORMED', `Classe de tráfego desconhecida: ${String(traffic)}`);
 const ceiling = limits[CLASS_CEILING[traffic]];
 if (byteLength > ceiling) return failed('LIMIT', `Mensagem de ${byteLength} bytes excede o limite de ${ceiling} da classe ${traffic}`);
 if (envelope['kind'] !== 'message') return failed('MALFORMED', `Envelope de tipo desconhecido: ${String(envelope['kind'])}`);
 const epoch = envelope['epoch'];
 if (!Number.isSafeInteger(epoch) || typeof epoch !== 'number' || epoch < 0) return failed('MALFORMED', 'Época inválida');
 const body = value['body'];
 if (!isPlainObject(body)) return failed('MALFORMED', 'Mensagem sem corpo');
 const kind = body['kind'];
 if (typeof kind !== 'string' || !kind.length || kind.length > 40) return failed('MALFORMED', 'Corpo sem tipo declarado');
 const worldId = addressPart(envelope['worldId'], 'Mundo');
 if (!worldId.ok) return worldId;
 const branchId = addressPart(envelope['branchId'], 'Ramificação');
 if (!branchId.ok) return branchId;
 const sessionId = addressPart(envelope['sessionId'], 'Sessão');
 if (!sessionId.ok) return sessionId;
 const id = addressPart(envelope['id'], 'Identificador');
 if (!id.ok) return id;
 return ok({
  envelope: {worldProtocol: 2, wireVersion: 1, kind: 'message', class: traffic, worldId: worldId.value, branchId: branchId.value, sessionId: sessionId.value, epoch, id: id.value},
  body,
 });
}
