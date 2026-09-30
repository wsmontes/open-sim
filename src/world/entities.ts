// Generic durable entities (spec §3.4; docs/world-protocol.md §2). A portable fact about a place needs an identity that
// survives the source redrawing the feature, an address in named coordinates, and provenance back to the revision it
// came from — while the lattice cell stays an *engine* address: this module uses it to index a geometry, and never
// publishes it as the meaning of an entity (§5 of the world protocol).
//
// Reconciliation is the decision here, and its rule is that this client does not guess. A feature the provider
// identified keeps its local identity when the source redraws it; a feature a revision no longer mentions is not a
// demolition; a split or a merge whose correspondence the source did not state is reported for review instead of
// resolved by the client. What changes is published as protocol objects, and every event is checked against the
// boundary (`applyEvent`) before it leaves this module.
import type {Components} from '../core/model';
import {chunkId,toCell} from '../core/coordinates';
import {canonicalJson,isEntityId} from '../core/protocol';
import type {JsonValue,WorldError,WorldResult} from './model';
import {failed,ok} from './model';
import type {EventOp,OsimEnvelope,OsimTimeRef} from './osim';
import {applyEvent,checkCoreComponent,entityUri,envelopeOf,osimTimeFrom} from './osim';
import {sameJson} from './changes';
import type {CaptureTimes,SourceMethod} from './reality';

// --- the portable geometry (spec §3.4) -------------------------------------------------------------------------
// Longitude and latitude in degrees, named as such: altitude needs a vertical reference no capture here declares, and
// the lattice of the engine is not a coordinate system of the contract.
export type GeoPosition = {lon: number; lat: number};
export type GeoGeometry = {type: 'point' | 'line' | 'polygon'; positions: readonly GeoPosition[]};
// A geometry is data from outside, so it is bounded before it can be indexed: a hostile ring must not become an
// arbitrarily large index (spec R13).
export const MAX_GEOMETRY_POSITIONS = 4096;
// The durable table of the profile that creates entities, and the full geometry it read: a namespace of entities is
// state like any other, and the two names live here because both this module and its callers name them.
export const ENTITY_INDEX_KEY = 'entity.index';
export const ENTITY_GEOMETRY_KEY = 'entity.geometry';

// One normalized feature of a source revision, before this client decides whether it already knows the entity.
export type SourceEntity = {
 kind: string;
 geometry: GeoGeometry;
 source: string;
 // The address of the capture record this feature was read from (spec §3.3).
 revision: string;
 // When we knew it, in the four times of §3.5 — never the download date standing in for the date of a fact.
 times: CaptureTimes;
 // Present only when the provider itself named the feature (spec §3.3); a coordinate is never presented as one.
 sourceId?: string;
 name?: string;
 attributes?: Record<string, JsonValue>;
 // Component namespaces the source states about the feature. They are written on the entity and they follow their
 // author: a namespace this source wrote goes away when it stops declaring it, and one another profile wrote is not
 // its to take away.
 extensions?: Record<string, JsonValue>;
 // Provider identifiers of the features this one replaces, when the source states the correspondence.
 replaces?: readonly string[];
 method?: SourceMethod;
};

// What the table keeps about one entity: the kind of thing it is, the components it carries, which of those namespaces
// the source authored, and the claims that tie it to revisions.
export type EntityClaim = {
 source: string;
 revision: string;
 sourceId?: string;
 method: SourceMethod;
 time: OsimTimeRef;
 attributes?: Record<string, JsonValue>;
};
export type EntityEntry = {
 kind: string;
 components: Record<string, unknown>;
 sourceKeys: readonly string[];
 claims: readonly EntityClaim[];
 // Region references of the engine, once each, sorted: an entity that crosses regions or the antimeridian has one
 // identity with several references and one accounting.
 chunks: readonly string[];
};
export type EntityIndex = {
 actor: string;
 timeline: string;
 entities: Record<string, EntityEntry>;
};
// A correspondence this client refuses to make on its own (spec §3.4: ambiguous association becomes a reviewable
// conflict). Nothing is applied to the entities named here.
export type EntityAmbiguity = {
 kind: 'split' | 'merge';
 identity: string;
 existing: readonly string[];
 incoming: readonly number[];
 message: string;
};
export type EntityProblem = {code: WorldError['code']; message: string; incoming: readonly number[]};
export type EntityReconciliation = {
 index: EntityIndex;
 added: readonly string[];
 updated: readonly string[];
 unchanged: readonly string[];
 ambiguous: readonly EntityAmbiguity[];
 refused: readonly EntityProblem[];
 // What the kernel should publish: a declaration for an entity this table learned, an event for a change of one it
 // already knew.
 published: readonly OsimEnvelope[];
};

const KINDS: readonly GeoGeometry['type'][] = ['point','line','polygon'];
const MINIMUM: Record<GeoGeometry['type'],number> = {point:1,line:2,polygon:4};
const METHODS: readonly SourceMethod[] = ['reported','derived','simulated','player'];
const EARTH_SPACE = 'osim:space:earth';
// The instant form the boundary validates (§13, `src/world/osim.ts`): a time nobody can re-read is not a time.
const INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const URI = /^[a-z][a-z0-9+.-]*:/i, URI_CHARS = /^[^\s\u0000-\u001f]{1,200}$/;

function record(value: unknown): value is Record<string, unknown> {
 return !!value && typeof value === 'object' && !Array.isArray(value);
}
const malformed = (message: string): WorldError => ({code:'MALFORMED',message});
const isPosition = (value: unknown): value is GeoPosition => record(value)
 && typeof value['lon'] === 'number' && Number.isFinite(value['lon']) && value['lon'] >= -180 && value['lon'] <= 180
 && typeof value['lat'] === 'number' && Number.isFinite(value['lat']) && value['lat'] >= -90 && value['lat'] <= 90;
const isInstant = (value: unknown): boolean => typeof value === 'string' && INSTANT.test(value) && !Number.isNaN(Date.parse(value));
const isIdentifier = (value: unknown): boolean => typeof value === 'string' && URI.test(value) && URI_CHARS.test(value);
// Region references are ordered by column and row, so two clients list the same geometry identically.
function byRegion(a: string, b: string): number {
 const [ax,ay] = a.split(':').map(Number), [bx,by] = b.split(':').map(Number);
 return (ax!-bx!) || (ay!-by!);
}
// A deterministic local spelling, not a cryptographic address: the provider's identifier travels in the claim, and
// this name only has to be the same word in every client that reads the same revision (protocol §4, spec §3.4). Every
// table of this layer names its rows here, so two profiles spell the same slot identically.
export function derivedName(prefix: string,identity: string): string {
 if (identity.length <= 64) {
  const readable = identity.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'-');
  if (readable.length > 0 && readable.length <= 72) return `${prefix}-${readable}`;
 }
 return `${prefix}-${mix(identity)}`;
}
const trim = (value: number): number => Math.round(value * 1e6) / 1e6;
// The mixing name of a long identity: a deterministic word, never an address (the claims carry the real provenance).
function mix(text: string): string {
 let a = 0x811c9dc5, b = 0x9e3779b9;
 for (let index = 0; index < text.length; index += 1) {
  const code = text.charCodeAt(index);
  a = Math.imul(a ^ code,0x01000193) >>> 0;
  b = Math.imul(b ^ code,0x85ebca6b) >>> 0;
 }
 return `${a.toString(36)}${b.toString(36)}`;
}

// --- reading what a source states -------------------------------------------------------------------------------
function geometryProblem(geometry: unknown): WorldError | null {
 if (!record(geometry)) return malformed('A feição não declara geometria');
 const type = geometry['type'], positions = geometry['positions'];
 if (typeof type !== 'string' || !KINDS.includes(type as GeoGeometry['type'])) return malformed(`Geometria de tipo desconhecido: ${String(type)}`);
 if (!Array.isArray(positions)) return malformed('Geometria sem posições');
 if (positions.length > MAX_GEOMETRY_POSITIONS) return {code:'LIMIT',message:`Uma feição de ${positions.length} posições excede o limite de ${MAX_GEOMETRY_POSITIONS}`};
 if (positions.length < MINIMUM[type as GeoGeometry['type']]) return malformed(`Uma geometria do tipo ${type} precisa de ${MINIMUM[type as GeoGeometry['type']]} posições`);
 for (const [index,position] of positions.entries()) {
  if (!isPosition(position)) return malformed(`Posição inválida (${index}): latitude e longitude em graus, dentro dos limites`);
 }
 return null;
}
function timesProblem(times: unknown): WorldError | null {
 if (!record(times)) return malformed('A feição não declara quando foi conhecida');
 if (!isInstant(times['retrievedAt'])) return malformed('O momento de retirada não é um instante ISO-8601');
 for (const field of ['observedAt','publishedAt']) if (times[field] !== undefined && !isInstant(times[field])) return malformed(`O momento ${field} não é um instante ISO-8601`);
 const interval = times['interval'];
 if (interval === undefined) return null;
 if (!record(interval) || !isInstant(interval['from']) || !isInstant(interval['to'])) return malformed('O período representado não é um par de instantes');
 if (Date.parse(interval['from'] as string) > Date.parse(interval['to'] as string)) return malformed('O período representado termina antes de começar');
 return null;
}
// A source that stated a period keeps a period: §13 is not a formatting rule, and a claim about a year is not a claim
// about the instant the file was downloaded.
function fingerprintOf(geometry: GeoGeometry): string {
 return `${geometry.type}:${geometry.positions.map(position => `${trim(position.lon)},${trim(position.lat)}`).join(';')}`;
}
function identityOf(source: string, sourceId: string | undefined, kind: string, geometry: GeoGeometry): string {
 return sourceId !== undefined ? `${source}|${sourceId}` : `${source}|~${kind}|${fingerprintOf(geometry)}`;
}
function identitiesOf(entry: EntityEntry): string[] {
 const found = new Set<string>();
 const geometry = geometryIn(entry.components);
 for (const claim of entry.claims) {
  if (claim.sourceId !== undefined) {found.add(`${claim.source}|${claim.sourceId}`);continue;}
  if (geometry) found.add(identityOf(claim.source,undefined,entry.kind,geometry));
 }
 return [...found];
}
function geometryIn(components: Record<string, unknown>): GeoGeometry | null {
 const raw = components[ENTITY_GEOMETRY_KEY];
 if (!record(raw)) return null;
 const type = raw['type'], positions = raw['positions'];
 if (typeof type !== 'string' || !KINDS.includes(type as GeoGeometry['type'])) return null;
 if (!Array.isArray(positions) || !positions.every(isPosition)) return null;
 return {type: type as GeoGeometry['type'], positions: positions as readonly GeoPosition[]};
}
// The references this geometry has in the engine: one per region it touches, never one per position, so a feature
// crossing the antimeridian is indexed twice and counted once. The cell is an address of the engine, nothing else.
function chunkReferences(components: Record<string, unknown>): string[] {
 const found = new Set<string>();
 const geometry = geometryIn(components);
 for (const position of geometry?.positions ?? []) found.add(chunkId(toCell(position.lat,position.lon)));
 if (!found.size) {
  // A declaration that carried only the named position still has a place in the engine's index.
  const transform = components['osim.transform'];
  const position = record(transform) ? transform['position'] : undefined;
  if (isPosition(position)) found.add(chunkId(toCell(position.lat,position.lon)));
 }
 return [...found].sort(byRegion);
}

// --- what reconcileEntities works on ---------------------------------------------------------------------------
type Observation = {
 identity: string;
 kind: string;
 source: string;
 revision: string;
 sourceId?: string;
 name?: string;
 geometry: GeoGeometry;
 times: CaptureTimes;
 attributes?: Record<string, JsonValue>;
 extensions: Record<string, JsonValue>;
 method: SourceMethod;
 replaces: readonly string[];
 indexes: readonly number[];
};
function observationOf(entity: SourceEntity,index: number): WorldResult<Observation> {
 if (!record(entity)) return failed('MALFORMED','Feição inválida');
 const kind = entity.kind, source = entity.source;
 if (typeof kind !== 'string' || !kind.length || kind.length > 80) return failed('MALFORMED','A feição não declara o seu tipo');
 if (typeof source !== 'string' || !source.length || source.length > 200) return failed('MALFORMED','A feição não declara a sua fonte');
 if (!isIdentifier(entity.revision)) return failed('MALFORMED','A feição não aponta para a revisão de onde veio');
 const geometry = geometryProblem(entity.geometry);
 if (geometry) return failed(geometry.code,geometry.message);
 const times = timesProblem(entity.times);
 if (times) return failed(times.code,times.message);
 for (const [value,label] of [[entity.sourceId,'O identificador de origem'],[entity.name,'O nome']] as const) {
  if (value !== undefined && (typeof value !== 'string' || !value.length || value.length > 200)) return failed('MALFORMED',`${label} é inválido`);
 }
 const method = entity.method ?? 'reported';
 if (!METHODS.includes(method)) return failed('MALFORMED',`Método desconhecido na feição: ${String(entity.method)}`);
 const attributes = entity.attributes ?? {};
 const extensions = entity.extensions ?? {};
 for (const [values,label] of [[attributes,'Os atributos'],[extensions,'As extensões']] as const) {
  if (!record(values)) return failed('MALFORMED',`${label} da feição precisam ser um objeto`);
 }
 const replaces = entity.replaces ?? [];
 if (!replaces.every(entry => typeof entry === 'string' && entry.length > 0)) return failed('MALFORMED','A lista de identificadores substituídos é inválida');
 const observation: Observation = {
  identity: identityOf(source,entity.sourceId,kind,entity.geometry),
  kind,
  source,
  revision: entity.revision,
  geometry: {type: entity.geometry.type,positions: entity.geometry.positions.map(position => ({lon:position.lon,lat:position.lat}))},
  times: {...entity.times,...(entity.times.interval ? {interval:{...entity.times.interval}} : {})},
  extensions: {...extensions},
  method,
  replaces: [...replaces],
  indexes: [index],
 };
 if (entity.sourceId !== undefined) observation.sourceId = entity.sourceId;
 if (entity.name !== undefined) observation.name = entity.name;
 if (Object.keys(attributes).length) observation.attributes = {...attributes};
 return ok(observation);
}
// The same identity delivered in pieces — a way the provider clipped in two regions — is one observation with the
// pieces together and every region named once.
function joined(first: Observation,next: Observation): Observation {
 const positions = [...first.geometry.positions];
 for (const position of next.geometry.positions) if (!positions.some(known => known.lon === position.lon && known.lat === position.lat)) positions.push(position);
 return {
  ...first,
  geometry: {type:first.geometry.type,positions},
  indexes: [...first.indexes,...next.indexes],
  extensions: {...first.extensions,...next.extensions},
  ...(next.name !== undefined ? {name:next.name} : {}),
  ...(next.attributes !== undefined ? {attributes:{...first.attributes,...next.attributes}} : {}),
 };
}
const claimKey = (claim: EntityClaim): string => `${claim.source}|${claim.revision}|${claim.sourceId ?? ''}|${claim.time.time}`;
function claimOf(observation: Observation,timeline: string): EntityClaim {
 const claim: EntityClaim = {source:observation.source,revision:observation.revision,method:observation.method,time:osimTimeFrom(timeline,observation.times)};
 if (observation.sourceId !== undefined) claim.sourceId = observation.sourceId;
 if (observation.attributes !== undefined) claim.attributes = observation.attributes;
 return claim;
}
// The components of a source fact: the geometry, the named position, the resolution a source establishes, the name it
// gave, and every namespace it stated. Each one is checked against the core vocabulary before it can be stored, which
// is also what refuses a namespace this client cannot carry.
function componentsOf(observation: Observation): WorldResult<Record<string, unknown>> {
 const first = observation.geometry.positions[0]!;
 const components: Record<string, unknown> = {
  [ENTITY_GEOMETRY_KEY]: {type:observation.geometry.type,positions:observation.geometry.positions},
  'osim.transform': {space:EARTH_SPACE,position:{lon:first.lon,lat:first.lat}},
  // A source reported the feature: `observed` is what it is, and no inference of this client is presented as fact.
  'osim.existence': {level:'observed'},
 };
 if (observation.name !== undefined) components['osim.name'] = {default:observation.name};
 for (const [key,value] of Object.entries(observation.extensions)) components[key] = value;
 for (const key of Object.keys(components)) {
  const checked = checkCoreComponent(key,components[key]);
  if (!checked.ok) return failed(checked.error.code,checked.error.message);
 }
 return ok(components);
}
function nextEntry(previous: EntityEntry | undefined,observation: Observation,components: Record<string, unknown>,claim: EntityClaim): EntityResult {
 const merged: Record<string, unknown> = {...(previous?.components ?? {})};
 // The namespaces the source authored follow the source; a value another profile wrote is not the source's to remove.
 for (const key of previous?.sourceKeys ?? []) delete merged[key];
 for (const [key,value] of Object.entries(components)) merged[key] = value;
 const claims = [...(previous?.claims ?? [])];
 if (!claims.some(existing => claimKey(existing) === claimKey(claim))) claims.push(claim);
 const entry: EntityEntry = {
  kind: observation.kind,
  components: merged,
  sourceKeys: Object.keys(observation.extensions).sort(),
  claims,
  chunks: chunkReferences(merged),
 };
 return {entry,changed: !previous || canonicalJson(entry as unknown as JsonValue) !== canonicalJson(previous as unknown as JsonValue)};
}
type EntityResult = {entry: EntityEntry; changed: boolean};

// Publishing a change: an entity this table learned is a declaration, and a change of one it knew is an event. The
// event is a protocol object, so it is built and then handed to the boundary's own `applyEvent` — a client that
// publishes something its own kernel would refuse is publishing a lie.
function declarationOf(id: string,entry: EntityEntry,actor: string): OsimEnvelope {
 return envelopeOf('entity',entityUri(id),actor,{components:entry.components} as unknown as JsonValue);
}
function eventsOf(id: string,previous: EntityEntry,next: EntityEntry,index: EntityIndex,claim: EntityClaim): WorldResult<readonly OsimEnvelope[]> {
 const published: OsimEnvelope[] = [];
 const keys = [...new Set([...Object.keys(previous.components),...Object.keys(next.components)])].sort();
 const scratch: Components = {};
 for (const name of Object.keys(previous.components)) scratch[name] = {[id]:previous.components[name]};
 for (const key of keys) {
  const was = previous.components[key], now = next.components[key];
  if (was !== undefined && now !== undefined && sameJson(was as JsonValue,now as JsonValue)) continue;
  if (was === undefined && now === undefined) continue;
  // `merge` writes inside a structured component this client's core knows, so a field a newer client added survives;
  // a namespace the source stopped declaring is removed, and everything else is a value replaced as a whole.
  const op: EventOp = now === undefined ? 'remove' : key === 'osim.transform' || key === 'osim.name' ? 'merge' : 'set';
  const body: Record<string, JsonValue> = {entity:entityUri(id),component:key,op,timeline:index.timeline,time:claim.time.time};
  if (now !== undefined) body['value'] = now as JsonValue;
  const eventId = `osim:event:${derivedName('u',`${id}|${key}|${claim.revision}|${claim.time.time}`)}`;
  const applied = applyEvent(scratch,{type:'event',id:eventId,actor:index.actor,...body});
  if (!applied.ok) return failed(applied.error.code,`A mudança de ${id} não é um evento válido: ${applied.error.message}`);
  published.push(envelopeOf('event',eventId,index.actor,body as unknown as JsonValue));
 }
 return ok(published);
}

// --- the table --------------------------------------------------------------------------------------------------
export function emptyEntityIndex(actor: string,timeline: string): EntityIndex {
 if (!isIdentifier(actor)) throw new Error(`O ator do índice de entidades precisa de um esquema: ${String(actor)}`);
 if (!isIdentifier(timeline)) throw new Error(`A linha do tempo do índice precisa de um esquema: ${String(timeline)}`);
 return {actor,timeline,entities:{}};
}
// The durable value of the `entity.index` namespace: one entry per entity, which is what a second profile reads to
// find an entity without understanding the profile that created it.
export function entityIndexValue(index: EntityIndex): Record<string, JsonValue> {
 const table: Record<string, JsonValue> = {};
 for (const id of Object.keys(index.entities).sort()) {
  const entry = index.entities[id]!;
  table[id] = {kind:entry.kind,components:entry.components,sourceKeys:[...entry.sourceKeys],claims:entry.claims} as unknown as JsonValue;
 }
 return table;
}
export function entityIndexFrom(value: unknown,actor: string,timeline: string): WorldResult<EntityIndex> {
 if (!record(value)) return failed('MALFORMED','Índice de entidades inválido');
 const entities: Record<string, EntityEntry> = {};
 for (const id of Object.keys(value)) {
  if (!isEntityId(id)) return failed('MALFORMED',`Identificador inválido no índice de entidades: ${id}`);
  const entry = record(value[id]) ? value[id] as Record<string, unknown> : null;
  const components = entry && record(entry['components']) ? entry['components'] as Record<string, unknown> : null;
  if (!entry || typeof entry['kind'] !== 'string' || !components) return failed('MALFORMED',`Entrada inválida no índice de entidades: ${id}`);
  const claims: EntityClaim[] = [];
  for (const claim of Array.isArray(entry['claims']) ? entry['claims'] : []) {
   if (!record(claim) || typeof claim['source'] !== 'string' || typeof claim['revision'] !== 'string' || !METHODS.includes(claim['method'] as SourceMethod)) return failed('MALFORMED',`Procedência inválida na entrada ${id}`);
   const time = record(claim['time']) ? claim['time'] as Record<string, unknown> : null;
   if (!time || !isIdentifier(time['timeline']) || !isInstant(time['time'])) return failed('MALFORMED',`Procedência sem instante na entrada ${id}`);
   const rebuilt: EntityClaim = {source:claim['source'],revision:claim['revision'],method:claim['method'] as SourceMethod,time:time as unknown as EntityClaim['time']};
   if (claim['sourceId'] !== undefined) {
    if (typeof claim['sourceId'] !== 'string') return failed('MALFORMED',`Procedência inválida na entrada ${id}`);
    rebuilt.sourceId = claim['sourceId'];
   }
   if (claim['attributes'] !== undefined) {
    if (!record(claim['attributes'])) return failed('MALFORMED',`Atributos inválidos na entrada ${id}`);
    rebuilt.attributes = claim['attributes'] as Record<string, JsonValue>;
   }
   claims.push(rebuilt);
  }
  const sourceKeys = Array.isArray(entry['sourceKeys']) && entry['sourceKeys'].every(key => typeof key === 'string') ? [...entry['sourceKeys']] as string[] : [];
  if (!claims.length) return failed('MALFORMED',`A entrada ${id} não declara de onde veio`);
  entities[id] = {kind:entry['kind'],components:{...components},sourceKeys,claims,chunks:chunkReferences(components)};
 }
 return ok({actor,timeline,entities});
}

// --- reconciliation ---------------------------------------------------------------------------------------------
export function reconcileEntities(before: EntityIndex,incoming: readonly SourceEntity[]): EntityReconciliation {
 const refused: EntityProblem[] = [], ambiguous: EntityAmbiguity[] = [];
 const observations: Observation[] = [], pieces = new Map<string,Observation>(), dropped = new Set<string>();
 incoming.forEach((feature,index) => {
  const read = observationOf(feature,index);
  if (!read.ok) {refused.push({code:read.error.code,message:read.error.message,incoming:[index]});return;}
  const observation = read.value, found = pieces.get(observation.identity);
  if (!found) {pieces.set(observation.identity,observation);observations.push(observation);return;}
  if (found.kind !== observation.kind) {
   refused.push({code:'CONFLICT',message:`A feição ${observation.identity} veio com dois tipos: ${found.kind} e ${observation.kind}`,incoming:[...found.indexes,...observation.indexes]});
   dropped.add(observation.identity);
   return;
  }
  const merged = joined(found,observation);
  pieces.set(observation.identity,merged);
  observations[observations.indexOf(found)] = merged;
 });
 const owners = new Map<string,string[]>();
 for (const id of Object.keys(before.entities).sort()) {
  for (const identity of identitiesOf(before.entities[id]!)) owners.set(identity,[...(owners.get(identity) ?? []),id]);
 }
 type Intended = {observation:Observation;target:string | null;id:string};
 const intended: Intended[] = [];
 for (const observation of observations.filter(entry => !dropped.has(entry.identity))) {
  const replaced = new Set<string>();
  for (const sourceId of observation.replaces) for (const id of owners.get(`${observation.source}|${sourceId}`) ?? []) replaced.add(id);
  const claimed = owners.get(observation.identity) ?? [];
  if (replaced.size > 1 || (replaced.size === 0 && claimed.length > 1)) {
   const count = Math.max(replaced.size,claimed.length);
   ambiguous.push({kind:'merge',identity:observation.identity,existing:[...(replaced.size > 1 ? replaced : new Set(claimed))].sort(),incoming:[...observation.indexes],message:`A feição ${observation.identity} corresponde a ${count} entidades conhecidas: a associação é ambígua e precisa de revisão`});
   continue;
  }
  const target = replaced.size === 1 ? [...replaced][0]! : claimed.length === 1 ? claimed[0]! : null;
  intended.push({observation,target,id:target ?? derivedName('e',observation.identity)});
 }
 // Two features of one revision inheriting the same entity: which one becomes it is the source's statement to make,
 // not this client's to derive.
 const claimedBy = new Map<string,number>();
 for (const entry of intended) if (entry.target) claimedBy.set(entry.target,(claimedBy.get(entry.target) ?? 0) + 1);
 const reported = new Set<string>();
 for (const entry of intended) {
  if (!entry.target || (claimedBy.get(entry.target) ?? 0) < 2 || reported.has(entry.target)) continue;
  reported.add(entry.target);
  ambiguous.push({kind:'split',identity:entry.observation.identity,existing:[entry.target],incoming:intended.filter(other => other.target === entry.target).flatMap(other => [...other.observation.indexes]),message:`${claimedBy.get(entry.target)} feições desta revisão reivindicam a entidade ${entry.target}: a associação é ambígua e precisa de revisão`});
 }
 const entities = {...before.entities}, added: string[] = [], updated: string[] = [], unchanged: string[] = [], published: OsimEnvelope[] = [];
 for (const entry of intended.filter(other => !other.target || (claimedBy.get(other.target) ?? 0) < 2).sort((a,b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
  const observation = entry.observation, built = componentsOf(observation);
  if (!built.ok) {refused.push({code:built.error.code,message:built.error.message,incoming:[...observation.indexes]});continue;}
  const previous = entities[entry.id];
  if (!entry.target && previous) {refused.push({code:'CONFLICT',message:`O identificador derivado ${entry.id} já pertence a outra feição`,incoming:[...observation.indexes]});continue;}
  const claim = claimOf(observation,before.timeline);
  const outcome = nextEntry(previous,observation,built.value,claim);
  if (!outcome.changed) {unchanged.push(entry.id);continue;}
  if (!previous) {added.push(entry.id);entities[entry.id] = outcome.entry;published.push(declarationOf(entry.id,outcome.entry,before.actor));continue;}
  const events = eventsOf(entry.id,previous,outcome.entry,before,claim);
  if (!events.ok) {refused.push({code:events.error.code,message:events.error.message,incoming:[...observation.indexes]});continue;}
  updated.push(entry.id);
  entities[entry.id] = outcome.entry;
  published.push(...events.value);
 }
 return {index:{actor:before.actor,timeline:before.timeline,entities},added,updated,unchanged,ambiguous,refused,published};
}
