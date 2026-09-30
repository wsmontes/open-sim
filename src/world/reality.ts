// Provenance for real-world data (docs/superpowers/specs/2026-09-29-federated-world-design.md §3.3). Pure: the caller
// supplies the clock and the transformation, so a revision is reproducible, and nothing here reads the environment.
import type {BaseChunk} from '../core/model';
import {CHUNK,WORLD,chunkOrigin,toGeo} from '../core/coordinates';
import type {DatasetTerm,JsonValue,ObjectRef,WorldObject,WorldResult} from './model';
import type {ContentHasher,WorldCodec} from './ports';

// --- what one capture records (spec §3.3) ----------------------------------------------------------------------
// Named coordinates and an explicit unit, plus the lattice the rectangle was taken from: the lattice is an address
// inside this client, never the definition of the planet, so a coverage declares both (§3.4).
export type Coverage = {
 crs: 'EPSG:4326';
 unit: 'degree';
 bounds: {west: number; south: number; east: number; north: number};
 lattice: {name: 'city-grid-v1'; cellsPerSide: number; cellLonDegrees: number; maxLatitude: number};
};
// Who published the data and which collection it is. `providerRevision` is present only when the supplier states one:
// tiles are served live and do not, and a revision nobody published is not invented for them.
export type SourceIdentity = {id: string; dataset: string; url: string; providerRevision?: string};
// Every field is optional: a term nobody declared is absent, which is how a source that forbids redistribution or
// declares no licence says so instead of borrowing one (spec §3.6).
export type SourceTerms = {attribution?: string; license?: string; url?: string};
export type TransformationRef = {name: string; version: number};
// Four separate times (spec §3.5). `observedAt` and `interval` are what the data is about; `retrievedAt` is this
// client's download and is never used to stand in for what the source did not date.
export type CaptureTimes = {retrievedAt: string; observedAt?: string; publishedAt?: string; interval?: {from: string; to: string}};
export type CaptureLevel = 'detail' | 'overview';
export type SourceMethod = 'reported' | 'derived' | 'simulated' | 'player';

export type DatasetRevision = {
 source: SourceIdentity;
 times: CaptureTimes;
 coverage: Coverage;
 terms: SourceTerms;
 transformation: TransformationRef;
 // Per normalized chunk, with the parameters that produced it. Tiles obtained at different moments are not one global
 // snapshot of the provider (§3.5), and `featureIds` says whether anything could be tied to a provider identifier.
 capture: {scope: 'chunk'; chunk: string; level: CaptureLevel; zoom: number; featureIds: 'known' | 'unknown'};
 // The bytes this revision describes, addressed by content.
 entity: ObjectRef;
 previous: ObjectRef[];
 extensions: Record<string, JsonValue>;
};
// One feature or attribute of a captured chunk, tied to the capture it came from (the claim lives in the capture
// record). `sourceId` is present only when the provider itself gave one: an id derived from a coordinate is never
// presented as a provider id, and a missing id is a fact about the source, not a gap to fill (spec §3.3).
export type SourceClaim = {
 subject: {kind: 'cell'; index: number} | {kind: 'capture'};
 values: Record<string, JsonValue>;
 sourceId?: string;
 method: SourceMethod;
 quality?: string;
 extensions: Record<string, JsonValue>;
};

// The base as captured, the revision that explains it, the claims for its cells, and the objects a bundle has to carry
// for it: `objects[0]` is the captured chunk and `objects[1]` is the capture record that cites it.
export type CapturedBase = {base: BaseChunk; revision: DatasetRevision; claims: SourceClaim[]; objects: WorldObject[]};

export type CaptureContext = CaptureTimes & {
 codec: WorldCodec;
 source: SourceIdentity;
 terms: SourceTerms;
 transformation: TransformationRef;
 capture: {level: CaptureLevel; zoom: number};
 previous?: readonly ObjectRef[];
 extensions?: Record<string, JsonValue>;
};

// --- the port -------------------------------------------------------------------------------------------------
// A region is addressed on the client's grid, and every revision records the lon/lat rectangle its chunk covers.
export type GeoRegion = {chunks: readonly string[]};
export type CaptureRequest = {
 level: CaptureLevel;
 times: CaptureTimes;
 terms?: SourceTerms;
 previous?: readonly ObjectRef[];
 extensions?: Record<string, JsonValue>;
};
export interface RealitySource {
 capture(region: GeoRegion, request: CaptureRequest): Promise<WorldResult<CapturedBase[]>>;
}

// --- times ----------------------------------------------------------------------------------------------------
// The world contract checks the shape itself: a runtime's own date parser accepts formats that mean different days in
// different clients, and an instant that cannot be re-read is not a time anybody recorded.
const INSTANT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
function instant(value: string, label: string): number {
 if (!INSTANT.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`${label} não é um instante ISO-8601: ${value}`);
 return Date.parse(value);
}
// A represented period and a single observation are two answers to the same question, so a context that states both is
// refused rather than resolved silently. Unknown times stay absent: the download instant is not when a fact was true.
function timesOf(source: CaptureTimes): CaptureTimes {
 instant(source.retrievedAt, 'Momento de retirada');
 const times: CaptureTimes = {retrievedAt: source.retrievedAt};
 if (source.observedAt !== undefined) {
  instant(source.observedAt, 'Momento de observação');
  times.observedAt = source.observedAt;
 }
 if (source.publishedAt !== undefined) {
  instant(source.publishedAt, 'Momento de publicação');
  times.publishedAt = source.publishedAt;
 }
 if (source.interval) {
  if (source.observedAt !== undefined) throw new Error('Um período representado não é afirmado junto de um instante observado');
  const from = instant(source.interval.from, 'Início do período representado'), to = instant(source.interval.to, 'Fim do período representado');
  if (from > to) throw new Error('O período representado termina antes de começar');
  times.interval = {from: source.interval.from, to: source.interval.to};
 }
 return times;
}

// --- coverage -------------------------------------------------------------------------------------------------
// Longitude is a uniform step of the lattice; latitude follows the projection it was built on. The edges come from the
// cell indices themselves, so a region at the latitude limit or across the antimeridian declares what it addresses.
const LATTICE: Coverage['lattice'] = {name: 'city-grid-v1', cellsPerSide: WORLD, cellLonDegrees: 360 / WORLD, maxLatitude: 85.05112878};

// --- claims ---------------------------------------------------------------------------------------------------
// Only the cells a source actually decided are claimed. `origin: 'imported'` marks a cell a provider geometry painted,
// and green or water terrain is only ever written from provider data, while the default of a cell is land and nobody
// claims it. The method is `derived` because Shortbread carries geometry, not facts about cells: turning a ring into a
// cell is this client's normalization, which the revision names.
function claimsOf(base: BaseChunk): SourceClaim[] {
 const claims: SourceClaim[] = [];
 for (let index = 0; index < base.cells.length; index += 1) {
  const cell = base.cells[index]!;
  if (cell.origin !== 'imported' && cell.terrain === 'land') continue;
  const values: Record<string, JsonValue> = {terrain: cell.terrain};
  if (cell.road !== undefined) values.road = cell.road;
  if (cell.building !== undefined) values.building = cell.building;
  if (cell.stage !== undefined) values.stage = cell.stage;
  claims.push({subject: {kind: 'cell', index}, values, method: 'derived', extensions: {}});
 }
 return claims;
}

// What a bundle carries for this capture: the term inventory travels next to the bytes it describes, and a source that
// declared no redistribution licence says so by leaving the licence out (spec §3.6).
export function termsOf(captured: CapturedBase): DatasetTerm {
 const term: DatasetTerm = {source: captured.revision.source.dataset};
 const {attribution, license} = captured.revision.terms;
 if (attribution !== undefined) term.attribution = attribution;
 if (license !== undefined) term.license = license;
 return term;
}

// One normalized chunk becomes a revision plus the claim sheet for its cells. The base is returned untouched: a capture
// records what a source said, it never rewrites the terrain to fit the revision.
export async function captureBase(base: BaseChunk, context: CaptureContext, hash: ContentHasher): Promise<CapturedBase> {
 const origin = chunkOrigin(base.id);
 if (base.cells.length !== CHUNK * CHUNK) throw new Error(`Trecho ${base.id} não é uma região completa do perfil cidade`);
 const baseValue = {kind: 'base-chunk', base: base as unknown as JsonValue} as JsonValue;
 const baseRef = await hash.ref(context.codec.encode(baseValue));
 const claims = claimsOf(base);
 const revision: DatasetRevision = {
  source: {...context.source},
  times: timesOf(context),
  coverage: {
   crs: 'EPSG:4326',
   unit: 'degree',
   bounds: {
    west: origin.x * LATTICE.cellLonDegrees - 180,
    east: (origin.x + CHUNK) * LATTICE.cellLonDegrees - 180,
    south: toGeo({x: origin.x, y: origin.y + CHUNK}).lat,
    north: toGeo({x: origin.x, y: origin.y}).lat,
   },
   lattice: {...LATTICE},
  },
  terms: {...context.terms},
  transformation: {...context.transformation},
  capture: {scope: 'chunk', chunk: base.id, level: context.capture.level, zoom: context.capture.zoom, featureIds: claims.some(claim => claim.sourceId !== undefined) ? 'known' : 'unknown'},
  entity: baseRef,
  previous: [...(context.previous ?? [])],
  extensions: {...(context.extensions ?? {})},
 };
 const revisionValue = revision as unknown as JsonValue, claimsValue = claims as unknown as JsonValue;
 const recordValue = {kind: 'capture', revision: revisionValue, claims: claimsValue} as JsonValue;
 const recordRef = await hash.ref(context.codec.encode(recordValue));
 return {base, revision, claims, objects: [{ref: baseRef, value: baseValue}, {ref: recordRef, value: recordValue}]};
}
