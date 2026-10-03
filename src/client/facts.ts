import type {CellCoord} from '../core/model';
import {toCell} from '../core/coordinates';

// Real demography the client carries, independent of where it comes from (spec 2026-10-01 §5.1 FactsPort). The browser
// backs it with Wikidata + IBGE; a test backs it with the fixed table below. The shape mirrors the reality adapter's
// `CityFacts` field for field, so the browser adapter hands its result straight across without translation.
import type {CityFacts} from '../core/municipal-facts';
export type {CityFacts,CityFactsSource,MeasureSource,NumericMeasure,MunicipalFinance,CityIdentity,DemographicObservation} from '../core/municipal-facts';

// The door to the real world's demography, in the style of `MapSource` (spec §5.1). `named` answers the place the
// player typed or picked; `near` answers the place the camera is standing in. A source that fails, lies or answers
// garbage leaves the game without a number instead of with an invented one, so every answer may be null.
export type FactsPort = {
 named(name: string): Promise<CityFacts | null>;
 near(lat: number, lon: number): Promise<CityFacts | null>;
};

// The latitude Web Mercator stops at; a typed coordinate beyond it is not a place on this map.
export const MAX_LATITUDE_DEG = 85.05112878;

export type Place = {name: string; lat: number; lon: number; facts: CityFacts};

// The places the client ships with, each carrying the population Wikidata states for it — read on 2026-09-30 from the
// QID beside it, and only the values that were actually read. A curated starting point is not a claim of permanence;
// the live lookup refreshes it. Moved out of src/browser/main.ts in stage B so the terminal and tests share it.
export const PLACES: Record<string, Place> = {
 Vancouver: {name: 'Vancouver', lat: 49.2827, lon: -123.1207, facts: {id: 'Q24639', label: 'Vancouver', population: 662248, populationYear: 2021, source: {dataset: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q24639', license: 'CC0'}}},
 'São Paulo': {name: 'São Paulo', lat: -23.5505, lon: -46.6333, facts: {id: 'Q174', label: 'São Paulo', country: 'Brasil', population: 11904961, populationYear: 2025, source: {dataset: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q174', license: 'CC0'}}},
 Lisboa: {name: 'Lisboa', lat: 38.7223, lon: -9.1393, facts: {id: 'Q597', label: 'Lisboa', population: 545796, populationYear: 2021, source: {dataset: 'Wikidata', url: 'https://www.wikidata.org/wiki/Q597', license: 'CC0'}}},
};

// Accents and case do not decide whether "São Paulo" was understood: a terminal keyboard should not have to type them.
const plain = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// The bundled place a name refers to, matched without accents, or null for a place the client does not ship with.
export function placeByName(name: string): Place | null {
 const wanted = plain(name);
 for (const place of Object.values(PLACES)) if (plain(place.name) === wanted) return place;
 return null;
}

// A fixed-table FactsPort for playing and testing with no network (spec §5.1). It answers only for the bundled places,
// by name or by nearest coordinate within a quarter degree, and null for anywhere else — the honest "no figure".
export function createFixtureFacts(places: readonly Place[] = Object.values(PLACES)): FactsPort {
 return {
  async named(name) { return placeByName(name)?.facts ?? null; },
  async near(lat, lon) {
   let best: Place | null = null, bestDistance = Infinity;
   for (const place of places) {
    const distance = Math.abs(place.lat - lat) + Math.abs(place.lon - lon);
    if (distance < bestDistance) { bestDistance = distance; best = place; }
   }
   return best && bestDistance <= 0.25 ? best.facts : null;
  },
 };
}

export type GoTo = {cell: CellCoord; label: string} | {error: string};

// A typed "ir -23.55,-46.63": a coordinate on the map, with the same bounds the browser's place form enforces, or the
// pt-BR message the player reads when it is off the map. The label is the rounded pair, matching the browser.
export function goToCoord(lat: number, lon: number): GoTo {
 if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > MAX_LATITUDE_DEG || Math.abs(lon) > 180) {
  return {error: 'Informe latitude entre -85,0511 e 85,0511 e longitude entre -180 e 180.'};
 }
 return {cell: toCell(lat, lon), label: `${lat.toFixed(4)}, ${lon.toFixed(4)}`};
}
