// The shared population (spec §3.4; §3 of docs/world-protocol.md; protocol §34). One profile shows a number, another
// materializes the people behind it, and `64 = 60 + 4` has to stay true — so materialization is a *reservation*, not a
// copy: people leave the aggregate, a second delivery of the same reservation answers the same people, and two clients
// reserving the same slot derive the same four persons instead of inventing eight.
//
// The durable record is the `population.materialized` namespace: one entry per reservation, with the engine address the
// people came from, the slots they occupy there and the identifiers both profiles agree on. Their portable facts are
// the core components — `osim.transform`, `osim.existence`, `osim.name` — so a client that implements no population at
// all still reads where each character is (§9). The cell is an approximation this contract declares: it is the address
// of the engine, and nobody gets to call it the building (world-protocol §5).
import {coordAt,toGeo} from '../core/coordinates';
import type {Components,GameState} from '../core/model';
import {summarize} from '../core/simulation';
import type {GeoPosition} from './entities';
import {derivedName} from './entities';
import type {WorldResult} from './model';
import {failed,ok} from './model';
import {checkCoreComponent} from './osim';

export const POPULATION_NAMESPACE = 'population.materialized';
// A cell with more derived slots than this is a runaway derivation, not a city (spec R13).
const MAX_SLOT = 4096;
const CELL = /^\d+:\d+#\d+$/;
const EARTH_SPACE = 'osim:space:earth';
const trim = (value: number): number => Math.round(value * 1e4) / 1e4;

export type PopulationReservation = {
 id: string;
 owner: string;
 cell: string;
 place: GeoPosition;
 // The slots of the cell these people occupy, one person per slot: the same slot always derives the same person.
 slots: readonly number[];
 ids: readonly string[];
};
export type SharedPopulation = {
 worldId: string;
 seed: number;
 // The number the aggregate profile shows, already net of what is materialized: the total is this plus the people.
 aggregate: number;
 reservations: readonly PopulationReservation[];
};
export type MaterializeRequest = {
 // The reservation: delivering the same one twice is the same operation with the same answer (spec §7.4).
 id: string;
 owner: string;
 cell: string;
 count: number;
 // A better geodesic address than the one the cell approximates, when the caller has one.
 place?: GeoPosition;
};
export type MaterializedCharacter = {
 id: string;
 uri: string;
 reservation: string;
 owner: string;
 cell: string;
 place: GeoPosition;
 slot: number;
};

function record(value: unknown): value is Record<string, unknown> {
 return !!value && typeof value === 'object' && !Array.isArray(value);
}
// The geodesic address a cell approximates. This is the declared approximation, and it is the only place the lattice
// is translated into the portable contract.
function placementOf(cell: string): GeoPosition | null {
 const [chunk,index] = cell.split('#');
 if (!chunk || index === undefined || !CELL.test(cell)) return null;
 try {
  const point = toGeo(coordAt(chunk,Number(index)));
  return {lon:point.lon,lat:point.lat};
 } catch {
  return null;
 }
}
// The person of a slot. Deterministic from (worldId, cell, slot, seed), so two clients cannot invent different people
// for the same place; the engine address names the *slot*, never the person's meaning.
function characterId(state: SharedPopulation,cell: string,slot: number): string {
 return derivedName('p',`${state.worldId}|${cell}|${slot}|${state.seed}`);
}
// A value this contract cannot read is not counted as materialized people: the count here moves the city's own number.
function reservationsIn(state: GameState): PopulationReservation[] {
 const namespace = state.components[POPULATION_NAMESPACE];
 const found: PopulationReservation[] = [];
 if (!record(namespace)) return found;
 for (const id of Object.keys(namespace).sort()) {
  const entry = record(namespace[id]) ? namespace[id] as Record<string, unknown> : null;
  if (!entry) continue;
  const cell = entry['cell'], owner = entry['owner'], ids = entry['ids'], slots = entry['slots'];
  if (typeof cell !== 'string' || typeof owner !== 'string' || !CELL.test(cell)) continue;
  if (!Array.isArray(ids) || !ids.every(entry => typeof entry === 'string') || !ids.length) continue;
  if (!Array.isArray(slots) || slots.length !== ids.length || !slots.every(slot => Number.isSafeInteger(slot) && (slot as number) >= 0)) continue;
  if (entry['count'] !== ids.length) continue;
  const stored = record(entry['place']) ? entry['place'] as Record<string, unknown> : null;
  const place = stored && typeof stored['lon'] === 'number' && typeof stored['lat'] === 'number'
   ? {lon:stored['lon'],lat:stored['lat']}
   : placementOf(cell);
  if (!place) continue;
  found.push({id,owner,cell,place,slots:[...slots] as number[],ids:[...ids] as string[]});
 }
 return found;
}
// The people of the whole population, once each: a reservation that repeats a person another one already holds does not
// move the aggregate twice, which is what makes two clients deriving the same slot harmless.
const idsOf = (state: SharedPopulation): string[] => [...new Set(state.reservations.flatMap(entry => [...entry.ids]))];
function charactersOfReservation(reservation: PopulationReservation): MaterializedCharacter[] {
 return reservation.ids.map((id,index) => ({
  id,
  uri:`osim:entity:${id}`,
  reservation:reservation.id,
  owner:reservation.owner,
  cell:reservation.cell,
  place:{...reservation.place},
  slot:reservation.slots[index]!,
 }));
}

export function emptyPopulation(worldId: string,seed: number,aggregate: number): SharedPopulation {
 if (typeof worldId !== 'string' || !worldId.length || worldId.length > 80) throw new Error(`Mundo inválido na população: ${String(worldId)}`);
 if (!Number.isSafeInteger(seed)) throw new Error(`Semente inválida na população: ${String(seed)}`);
 if (!Number.isSafeInteger(aggregate) || aggregate < 0) throw new Error(`Agregado inválido na população: ${String(aggregate)}`);
 return {worldId,seed,aggregate,reservations:[]};
}
export function populationOf(state: GameState): SharedPopulation {
 // The aggregate is what the resident profile shows after subtracting what was materialized: the four walkers of a
 // home of four read 60 here and 4 there, and the total never moves.
 return {worldId:state.worldId,seed:state.seed,aggregate:Math.max(0,summarize(state).population),reservations:reservationsIn(state)};
}
export const materializedCount = (state: SharedPopulation): number => idsOf(state).length;
export const totalOf = (state: SharedPopulation): number => state.aggregate + materializedCount(state);

export function charactersOf(state: SharedPopulation): MaterializedCharacter[] {
 return [...state.reservations]
  .sort((a,b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  .flatMap(charactersOfReservation);
}
// The reservation as it is stored: the engine address it came from, the geodesic address it approximates, the slots and
// the people. `count` travels besides `ids` so a client that does not read identifiers still knows how many people left.
function unitOf(reservation: PopulationReservation): Record<string, unknown> {
 return {
  cell:reservation.cell,
  place:{...reservation.place},
  owner:reservation.owner,
  count:reservation.ids.length,
  slots:[...reservation.slots],
  ids:[...reservation.ids],
 };
}
// Every component a materialized person exists by, in the shape the durable state carries. Each one goes through the
// core vocabulary, so this contract cannot write a component its own boundary would refuse.
export function populationComponents(state: SharedPopulation): Components {
 const units: Record<string, unknown> = {};
 const components: Components = {[POPULATION_NAMESPACE]:units};
 for (const reservation of state.reservations) {
  units[reservation.id] = unitOf(reservation);
  for (const character of charactersOfReservation(reservation)) {
   const label = `Morador ${character.slot + 1} · ${trim(character.place.lon)}, ${trim(character.place.lat)}`;
   const written: Record<string, Record<string, unknown>> = {
    'osim.transform': {space:EARTH_SPACE,position:{lon:character.place.lon,lat:character.place.lat}},
    'osim.existence': {level:'materialized'},
    'osim.name': {default:label},
   };
   for (const [key,value] of Object.entries(written)) {
    const checked = checkCoreComponent(key,value);
    if (!checked.ok) throw new Error(`O componente ${key} de ${character.id} é inválido: ${checked.error.message}`);
    components[key] = {...(components[key] ?? {}),[character.id]:value};
   }
  }
 }
 return components;
}
// What moves a world from one population to another: every entry the new one has, and a removal — `null`, which the
// component command understands — for every person and reservation the old one had and the new one does not. A
// dematerialized person is thus *returned*, not merely forgotten, and nothing outside these reservations is touched:
// another profile's entities in `osim.transform` are none of this contract's business.
export function populationChanges(before: SharedPopulation,after: SharedPopulation): Components {
 const changes = populationComponents(after);
 const units: Record<string, unknown> = {...(changes[POPULATION_NAMESPACE] ?? {})};
 for (const reservation of before.reservations) if (!after.reservations.some(entry => entry.id === reservation.id)) units[reservation.id] = null;
 changes[POPULATION_NAMESPACE] = units;
 const remaining = new Set(idsOf(after));
 for (const id of idsOf(before)) {
  if (remaining.has(id)) continue;
  for (const key of ['osim.transform','osim.existence','osim.name']) changes[key] = {...(changes[key] ?? {}),[id]:null};
 }
 return changes;
}
export function materialize(state: SharedPopulation,request: MaterializeRequest): WorldResult<SharedPopulation> {
 if (typeof request.id !== 'string' || !request.id.length || request.id.length > 80) return failed('MALFORMED','A reserva precisa de um identificador');
 if (typeof request.owner !== 'string' || !request.owner.length) return failed('MALFORMED','A reserva precisa de um dono');
 if (typeof request.cell !== 'string' || !CELL.test(request.cell)) return failed('MALFORMED',`A reserva ${request.id} não aponta para uma célula do motor`);
 if (!Number.isSafeInteger(request.count) || request.count < 1) return failed('MALFORMED',`A reserva ${String(request.count)} pede uma quantidade inválida de moradores`);
 const existing = state.reservations.find(entry => entry.id === request.id);
 if (existing) {
  const same = existing.owner === request.owner && existing.cell === request.cell && existing.ids.length === request.count;
  return same ? ok(state) : failed('CONFLICT',`A reserva ${request.id} já existe com outro conteúdo`);
 }
 if (request.count > state.aggregate) return failed('CONFLICT',`A reserva ${request.id} pede ${request.count} moradores e o agregado tem ${state.aggregate}`);
 const place = request.place ?? placementOf(request.cell);
 if (!place) return failed('MALFORMED',`A célula ${request.cell} não tem endereço geodésico`);
 const taken = new Set(idsOf(state));
 const slots: number[] = [], ids: string[] = [];
 for (let slot = 0; ids.length < request.count; slot += 1) {
  if (slot > MAX_SLOT) return failed('LIMIT',`A célula ${request.cell} excedeu ${MAX_SLOT} moradores materializados`);
  const id = characterId(state,request.cell,slot);
  if (taken.has(id)) continue;
  slots.push(slot);
  ids.push(id);
 }
 return ok({
  ...state,
  aggregate:state.aggregate - request.count,
  reservations:[...state.reservations,{id:request.id,owner:request.owner,cell:request.cell,place,slots,ids}],
 });
}
// Dematerializing returns the people to the aggregate: the reservation that held them goes or shrinks, and the number
// the profile shows grows by exactly the people who came back — never by removing a component somebody happens to read.
export function dematerialize(state: SharedPopulation,entityIds: readonly string[]): WorldResult<SharedPopulation> {
 if (!Array.isArray(entityIds) || !entityIds.length) return failed('MALFORMED','Nenhum morador selecionado para devolver');
 const known = new Set(idsOf(state));
 const unknown = [...new Set(entityIds)].filter(id => !known.has(id));
 if (unknown.length) return failed('NOT_FOUND',`Não há moradores materializados com os identificadores ${unknown.slice(0,4).join(', ')}`);
 const released = new Set(entityIds);
 const reservations: PopulationReservation[] = [];
 for (const reservation of state.reservations) {
  const kept = reservation.ids.map((id,index) => ({id,slot:reservation.slots[index]!})).filter(entry => !released.has(entry.id));
  if (kept.length) reservations.push({...reservation,slots:kept.map(entry => entry.slot),ids:kept.map(entry => entry.id)});
 }
 return ok({...state,aggregate:state.aggregate + released.size,reservations});
}
