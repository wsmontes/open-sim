// The OpenSim 0.1 boundary (docs/OpenSim-Protocol-0.1.txt). This module is the only place that knows the protocol's
// envelope, its identifiers and its four state operations, so the rest of the world layer keeps speaking the local
// contract (docs/world-protocol.md) and the transports only carry what this boundary produced.
//
// Two rules decide the shape of everything here, and they pull in opposite directions on purpose (protocol §2.3 and
// §48): the envelope and the operation are closed, because a newer client must not smuggle meaning into the framing;
// a component is open, because a client that does not implement a namespace must still be able to carry it unchanged.
import type {Components} from '../core/model';
import {assertJsonSafe,isComponentKey,isEntityId} from '../core/protocol';
import type {JsonValue,WorldResult} from './model';
import {failed,ok} from './model';
import type {CaptureTimes} from './reality';

export const OSIM_VERSION = '0.1';
// The kinds of the core (§3). `component` is listed because a component may be published on its own, not only inside
// an entity body.
export type OsimKind = 'entity' | 'component' | 'event' | 'timeline' | 'snapshot' | 'session' | 'capability';
const KINDS: readonly OsimKind[] = ['entity','component','event','timeline','snapshot','session','capability'];
// The envelope of §48: `{osim, type, id, actor, body}` and nothing else. `body` is open by design — it is where a
// component, an event or a session descriptor travels.
export type OsimEnvelope = {osim: typeof OSIM_VERSION; type: OsimKind; id: string; actor: string; body: JsonValue};
// The four state operations of §15, and nothing else: a protocol that grows an operation per genre stops being a
// protocol.
export type EventOp = 'set' | 'merge' | 'remove' | 'delete';
const OPS: readonly EventOp[] = ['set','merge','remove','delete'];
// An event targets one component of one entity on one timeline (§14).
export type OsimEvent = {
 type: 'event';
 id: string;
 entity: string;
 component: string;
 op: EventOp;
 value?: JsonValue;
 actor: string;
 timeline: string;
 time: string;
 sequence?: number;
 previous?: string;
};
// A time coordinate (§13). `time` is when this record was made; `validTime` is when the fact was true — the two are
// never the same question, and a source that stated a period gets a period instead of an invented instant.
export type OsimTimeRef = {timeline: string; time: string; validTime?: string; interval?: {from: string; to: string}; observedTime?: string};
export type EventOutcome = {components: Components; tombstone?: {entity: string; timeline: string; time: string}};
export const EXISTENCE_LEVELS: readonly string[] = ['abstract','simulated','materialized','observed'];

const INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
// A URI carries a scheme (§4). `osim:entity:house-42` is ours; `did:key:…`, `https://…`, `sha256:…` belong to another
// ecosystem and are carried as they are, never rewritten into ours.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i, URI_CHARS = /^[^\s\u0000-\u001f]{1,200}$/;
const PLAIN = Object.prototype; // used through isPlain below; kept named so the intent is not a bare comparison

function isPlain(value: unknown): value is Record<string, unknown> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const proto: unknown = Object.getPrototypeOf(value);
 return proto === PLAIN || proto === null;
}
function json(value: unknown, label: string): WorldResult<JsonValue> {
 try {
  assertJsonSafe(value, label);
 } catch (error) {
  return failed('MALFORMED', error instanceof Error ? error.message : `${label} inválido`);
 }
 if (value === undefined) return failed('MALFORMED', `${label} ausente`);
 return ok(value as JsonValue);
}
function instant(value: unknown, label: string): WorldResult<string> {
 if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value))) return failed('MALFORMED', `${label} não é um instante ISO-8601`);
 return ok(value);
}
// An actor, a timeline and an event id are all identifiers with a scheme (§4): `did:key:…`, `osim:timeline:…`,
// `osim:event:…`. A bare word is not one, and a client that accepted one would be inventing an identifier space.
function identifier(value: unknown, name: string): WorldResult<string> {
 if (typeof value !== 'string' || !URI_CHARS.test(value) || !SCHEME.test(value)) return failed('MALFORMED', `${name} precisa ser um identificador com esquema`);
 return ok(value);
}

// --- identifiers (§4) -------------------------------------------------------------------------------------------
export type ParsedUri = {scheme: 'osim'; kind: OsimKind; id: string} | {scheme: 'foreign'; uri: string};
export function parseOsimUri(text: string): ParsedUri {
 if (typeof text !== 'string' || !URI_CHARS.test(text) || !SCHEME.test(text)) throw new Error(`Identificador inválido: ${String(text)}`);
 const parts = text.split(':');
 if (parts[0] === 'osim' && parts.length === 3 && KINDS.includes(parts[1] as OsimKind) && URI_CHARS.test(parts[2]!)) {
  return {scheme:'osim', kind: parts[1] as OsimKind, id: parts[2]!};
 }
 return {scheme:'foreign', uri: text};
}
// A local identifier has to be storable before it can be named: the entity index of the durable state keys on it, and
// that index refuses reserved words and anything a save could not hold (src/core/protocol.ts).
export function entityUri(id: string): string {
 if (typeof id !== 'string' || !isEntityId(id)) throw new Error(`Identificador de entidade inválido: ${String(id)}`);
 return `osim:entity:${id}`;
}
export function timelineUri(id: string): string {
 if (typeof id !== 'string' || !URI_CHARS.test(id)) throw new Error(`Identificador de linha do tempo inválido: ${String(id)}`);
 return `osim:timeline:${id}`;
}
// The local id behind an `osim:entity:` URI, or `null` when this is not one of ours.
// A URI this client cannot even read is not one of ours, and asking is not an error: `parseOsimUri` refuses a
// malformed identifier for callers who already hold one, while this lookup answers `null` so an event that names
// something unrecognisable is rejected as a value instead of aborting the caller.
export function entityIdOf(uri: string): string | null {
 try {
  const parsed = parseOsimUri(uri);
  return parsed.scheme === 'osim' && parsed.kind === 'entity' ? parsed.id : null;
 } catch {
  return null;
 }
}

// --- navigable view URIs (§40) ---------------------------------------------------------------------------------
// A view URI identifies a requested world view, never a particular server: `osim://earth/ca/bc/victoria?timeline=…&time=…`.
// Only the two coordinates the protocol defines are accepted as query; anything else belongs in the view's own filter,
// not in the identifier, and an unknown key is refused instead of ignored.
export type ViewUri = {path: string[]; timeline?: string; time?: string};
const SEGMENT = /^[A-Za-z0-9._~-]{1,80}$/;
export function parseViewUri(text: string): WorldResult<ViewUri> {
 if (typeof text !== 'string' || !text.startsWith('osim://')) return failed('MALFORMED', 'URI de vista precisa começar com osim://');
 const rest = text.slice('osim://'.length);
 const cut = rest.indexOf('?');
 const route = cut >= 0 ? rest.slice(0, cut) : rest;
 const query = cut >= 0 ? rest.slice(cut + 1) : '';
 const segments = route.split('/').filter(segment => segment.length > 0);
 if (!segments.length) return failed('MALFORMED', 'URI de vista sem caminho');
 for (const segment of segments) if (!SEGMENT.test(segment)) return failed('MALFORMED', `Segmento inválido: ${segment}`);
 const view: ViewUri = {path: segments};
 if (query.length) {
  for (const pair of query.split('&')) {
   const [key, value = ''] = pair.split('=');
   if (key === 'timeline') {
    const timeline = instant(value, 'Linha do tempo') && identifier(value, 'Linha do tempo');
    if (!timeline.ok) return timeline;
    view.timeline = value;
   } else if (key === 'time') {
    const time = instant(value, 'Instante');
    if (!time.ok) return time;
    view.time = value;
   } else return failed('MALFORMED', `Chave desconhecida na vista: ${String(key)}`);
  }
 }
 return ok(view);
}
export function viewUri(path: readonly string[], options: {timeline?: string; time?: string} = {}): string {
 if (!path.length) throw new Error('URI de vista sem caminho');
 for (const segment of path) if (!SEGMENT.test(segment)) throw new Error(`Segmento inválido: ${segment}`);
 const query: string[] = [];
 if (options.timeline !== undefined) query.push(`timeline=${options.timeline}`);
 if (options.time !== undefined) query.push(`time=${options.time}`);
 return `osim://${path.join('/')}${query.length ? `?${query.join('&')}` : ''}`;
}

// --- envelope (§48) ---------------------------------------------------------------------------------------------
export function envelopeOf(kind: OsimKind, id: string, actor: string, body: JsonValue): OsimEnvelope {
 const built: OsimEnvelope = {osim: OSIM_VERSION, type: kind, id, actor, body};
 const checked = checkEnvelope(built);
 if (!checked.ok) throw new Error(checked.error.message);
 return checked.value;
}
export function checkEnvelope(value: unknown): WorldResult<OsimEnvelope> {
 if (!isPlain(value)) return failed('MALFORMED', 'Envelope inválido');
 const known = ['osim','type','id','actor','body'];
 const unknown = Object.keys(value).filter(key => !known.includes(key));
 if (unknown.length) return failed('MALFORMED', `Envelope com campo desconhecido: ${unknown[0]}`);
 if (value['osim'] !== OSIM_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `Versão de protocolo desconhecida: ${String(value['osim'])}`);
 if (typeof value['type'] !== 'string' || !KINDS.includes(value['type'] as OsimKind)) return failed('MALFORMED', `Tipo desconhecido: ${String(value['type'])}`);
 if (typeof value['id'] !== 'string' || !URI_CHARS.test(value['id'])) return failed('MALFORMED', 'Identificador inválido');
 if (typeof value['actor'] !== 'string' || !URI_CHARS.test(value['actor']) || !SCHEME.test(value['actor'])) return failed('MALFORMED', 'Ator precisa ser um identificador com esquema');
 // The envelope declares a kind; the id agrees with it, so a relay cannot relabel an event as a session.
 const parsed = parseOsimUri(value['id']);
 if (parsed.scheme === 'osim' && parsed.kind !== value['type']) return failed('MALFORMED', `Identificador ${value['id']} não é um ${value['type']}`);
 const body = json(value['body'], 'Corpo do envelope');
 if (!body.ok) return body;
 return ok({osim: OSIM_VERSION, type: value['type'] as OsimKind, id: value['id'], actor: value['actor'], body: body.value});
}

// --- events (§14, §15, §16) -------------------------------------------------------------------------------------
// Applying an event is pure: the caller keeps the components it had, and a rejected event changes nothing.
export function applyEvent(components: Components, event: unknown): WorldResult<EventOutcome> {
 if (!isPlain(event)) return failed('MALFORMED', 'Evento inválido');
 if (event['type'] !== 'event') return failed('MALFORMED', 'Objeto não é um evento');
 const eventId = identifier(event['id'], 'Identificador de evento');
 if (!eventId.ok) return eventId;
 const actor = identifier(event['actor'], 'Ator');
 if (!actor.ok) return actor;
 const timeline = identifier(event['timeline'], 'Linha do tempo');
 if (!timeline.ok) return timeline;
 const time = instant(event['time'], 'Instante do evento');
 if (!time.ok) return time;
 if (typeof event['component'] !== 'string' || !isComponentKey(event['component'])) return failed('MALFORMED', `Namespace inválido: ${String(event['component'])}`);
 if (typeof event['op'] !== 'string' || !OPS.includes(event['op'] as EventOp)) return failed('MALFORMED', `Operação desconhecida: ${String(event['op'])}`);
 const entity = typeof event['entity'] === 'string' ? entityIdOf(event['entity']) : null;
 if (!entity) return failed('MALFORMED', `Entidade inválida: ${String(event['entity'])}`);
 const op = event['op'] as EventOp;
 const key = event['component'];
 const next: Components = {...components};
 const namespace: Record<string, unknown> = {...(next[key] ?? {})};
 if (op === 'delete') {
  // A tombstone, not a rewrite (§15): every component of the entity goes, and the caller records that it is gone.
  for (const name of Object.keys(next)) {
   const entries = {...next[name]!};
   if (!(entity in entries)) continue;
   delete entries[entity];
   // An empty namespace is not state: leaving `{}` behind would change the durable identity of a world that no
   // longer has that component (§15 remove).
   if (Object.keys(entries).length) next[name] = entries;
   else delete next[name];
  }
  return ok({components: next, tombstone: {entity: event['entity'] as string, timeline: timeline.value, time: time.value}});
 }
 if (op === 'remove') {
  delete namespace[entity];
  if (Object.keys(namespace).length) next[key] = namespace;
  else delete next[key];
  return ok({components: next});
 }
 const value = json(event['value'], 'Valor do componente');
 if (!value.ok) return value;
 if (op === 'set') {
  namespace[entity] = value.value;
  next[key] = namespace;
  return ok({components: next});
 }
 // `merge` writes fields into a structured component. It is the operation that makes partial understanding worth
 // something: fields this client never wrote stay exactly where they were (§15).
 const target = json(namespace[entity] ?? {}, `Componente ${key}/${entity}`);
 if (!target.ok) return target;
 if (!isPlain(value.value)) return failed('MALFORMED', 'Merge precisa de um componente estruturado');
 if (!isPlain(target.value)) return failed('MALFORMED', `Componente ${key}/${entity} não é estruturado`);
 namespace[entity] = {...target.value, ...value.value};
 next[key] = namespace;
 return ok({components: next});
}

// --- the core component vocabulary (§9) -------------------------------------------------------------------------
// Validation of a core component never rejects a field a newer client added: the protocol grows by compatibility, and
// something like `accuracy` inside osim.transform must survive this client untouched.
export function checkCoreComponent(key: string, value: unknown): WorldResult<Record<string, unknown>> {
 if (typeof key !== 'string' || !isComponentKey(key)) return failed('MALFORMED', `Namespace inválido: ${String(key)}`);
 const safe = json(value, `Componente ${key}`);
 if (!safe.ok) return safe;
 if (!isPlain(value)) return failed('MALFORMED', `Componente ${key} precisa ser um objeto`);
 if (!key.startsWith('osim.')) return ok({...value});
 switch (key) {
  case 'osim.transform': {
   const space = value['space'], position = value['position'];
   if (typeof space !== 'string' || !URI_CHARS.test(space) || !SCHEME.test(space)) return failed('MALFORMED', 'osim.transform precisa de um espaço nomeado');
   if (!isPlain(position)) return failed('MALFORMED', 'osim.transform precisa de uma posição');
   const lat = position['lat'], lon = position['lon'], alt = position['alt'];
   if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return failed('MALFORMED', 'Latitude inválida');
   if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) return failed('MALFORMED', 'Longitude inválida');
   if (alt !== undefined && (typeof alt !== 'number' || !Number.isFinite(alt))) return failed('MALFORMED', 'Altitude inválida');
   return ok({...value});
  }
  case 'osim.existence': {
   if (typeof value['level'] !== 'string' || !EXISTENCE_LEVELS.includes(value['level'])) return failed('MALFORMED', `Nível de existência desconhecido: ${String(value['level'])}`);
   return ok({...value});
  }
  case 'osim.name': {
   if (typeof value['default'] !== 'string' || !value['default'].length) return failed('MALFORMED', 'osim.name precisa de um rótulo padrão');
   const translations = value['translations'];
   if (translations !== undefined) {
    if (!isPlain(translations)) return failed('MALFORMED', 'Traduções inválidas');
    for (const language of Object.keys(translations)) if (typeof translations[language] !== 'string') return failed('MALFORMED', `Tradução inválida: ${language}`);
   }
   return ok({...value});
  }
  case 'osim.bounds': {
   const shape = value['shape'];
   if (shape === 'sphere') {
    const radius = value['radius'];
    if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0) return failed('MALFORMED', 'Raio inválido');
    return ok({...value});
   }
   if (shape === 'bbox') {
    for (const edge of ['min','max'] as const) {
     const corner = value[edge];
     if (!Array.isArray(corner) || corner.length !== 3 || corner.some(part => typeof part !== 'number' || !Number.isFinite(part))) return failed('MALFORMED', `Caixa inválida: ${edge}`);
    }
    return ok({...value});
   }
   return failed('MALFORMED', `Forma desconhecida: ${String(shape)}`);
  }
  case 'osim.relations': {
   for (const name of Object.keys(value)) if (typeof value[name] !== 'string' || !SCHEME.test(value[name] as string)) return failed('MALFORMED', `Relação inválida: ${name}`);
   return ok({...value});
  }
  case 'osim.geometry': {
   // §9.2: geometry is referenced, not embedded — and the reference is content-addressed like everything durable
   // (§21), so another provider can serve the same bytes.
   const asset = value['asset'], mediaType = value['mediaType'];
   if (typeof asset !== 'string' || !SCHEME.test(asset) || !URI_CHARS.test(asset)) return failed('MALFORMED', 'osim.geometry precisa de um asset endereçado');
   if (typeof mediaType !== 'string' || !mediaType.length) return failed('MALFORMED', 'osim.geometry precisa de um tipo de mídia');
   return ok({...value});
  }
  case 'osim.behavior': {
   // §36: a client is never required to execute behavior to understand the entity, so only the reference and the
   // interface it claims to implement are validated here.
   const module_ = value['module'], mediaType = value['mediaType'], face = value['interface'];
   if (typeof module_ !== 'string' || !SCHEME.test(module_) || !URI_CHARS.test(module_)) return failed('MALFORMED', 'osim.behavior precisa de um módulo endereçado');
   if (typeof mediaType !== 'string' || !mediaType.length) return failed('MALFORMED', 'osim.behavior precisa de um tipo de mídia');
   if (typeof face !== 'string' || !SCHEME.test(face)) return failed('MALFORMED', 'osim.behavior precisa de uma interface nomeada');
   return ok({...value});
  }
  case 'osim.space': {
   // §10: a space is an entity, and its reference system is what its coordinates mean. A room does not need a
   // latitude; only the chain to Earth does.
   const system = value['referenceSystem'];
   if (typeof system !== 'string' || !system.length) return failed('MALFORMED', 'osim.space precisa de um sistema de referência');
   return ok({...value});
  }
  case 'osim.layer': {
   if (typeof value['source'] !== 'string' || !value['source'].length) return failed('MALFORMED', 'Camada precisa de uma fonte');
   const priority = value['priority'];
   if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) return failed('MALFORMED', 'Prioridade inválida');
   return ok({...value});
  }
  // A core namespace this client does not implement is carried, not judged: that is §2.3 applied to our own core.
  default: return ok({...value});
 }
}

// --- time (§13) -------------------------------------------------------------------------------------------------
// A capture states four different things and this mapping keeps them apart: `time` is when this client wrote the
// record, `observedTime` is when the network learned the fact, and `validTime` is claimed only when the source named
// an instant. A source that named a period keeps a period.
export function osimTimeFrom(timeline: string, times: CaptureTimes): OsimTimeRef {
 const ref: OsimTimeRef = {timeline, time: times.retrievedAt, observedTime: times.retrievedAt};
 if (times.interval) ref.interval = {from: times.interval.from, to: times.interval.to};
 else if (times.observedAt !== undefined) ref.validTime = times.observedAt;
 return ref;
}
