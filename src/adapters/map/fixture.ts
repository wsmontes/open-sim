import type {BaseChunk,Cell} from '../../core/model';
import {CHUNK,chunkOrigin,variant} from '../../core/coordinates';
import type {MapLevel,MapSource} from '../../session/ports';

// A map with no network behind it, for playing and testing anywhere (spec 2026-10-01 P7). Every region is the same
// small town, so a playthrough can be written against known cells: a river down column 28, an imported street on row
// 0 with a few imported houses on row 1, a wood in the top-right corner, and free land everywhere else.
//
// Like the real provider, it answers per region and per level, and an overview is the same ground without buildings.
export const FIXTURE_SOURCE = 'fixture-town-v1';

function townCell(x: number, y: number, level: MapLevel): Cell {
 if (x >= 28 && x <= 29) return {terrain: 'water'};
 if (y === 0) return {terrain: 'land', road: true, origin: 'imported'};
 if (level === 'detail' && y === 1 && x >= 2 && x <= 6) return {terrain: 'land', building: 'residential', stage: 1, origin: 'imported'};
 if (x >= 22 && y >= 2 && y <= 6) return {terrain: 'green'};
 return {terrain: 'land'};
}

export function fixtureTown(id: string, level: MapLevel = 'detail'): BaseChunk {
 chunkOrigin(id);
 const cells: Cell[] = [];
 for (let y = 0; y < CHUNK; y += 1) for (let x = 0; x < CHUNK; x += 1) cells.push(townCell(x, y, level));
 return {id, source: level === 'overview' ? `${FIXTURE_SOURCE} (aproximação)` : FIXTURE_SOURCE, normalizerVersion: 1, cells};
}

export type FixtureMapOptions = {
 // Regions that fail to load, to rehearse the "Tentar novamente" path.
 failing?: ReadonlySet<string>;
 // When set, a region in `failing` fails only this many times and then loads: the retry that follows a failure
 // succeeds, which is the happy end of the "tentar de novo" path.
 failTimes?: number;
 // A deterministic per-region delay, in calls of the event loop, so loading order is exercised without a clock.
 jitter?: boolean;
};

export function createFixtureMap(options: FixtureMapOptions = {}): MapSource & {requests: () => readonly string[]} {
 const requests: string[] = [];
 const failures = new Map<string, number>();
 return {
  attribution: {text: 'Mapa sintético de teste', url: 'about:blank'},
  requests: () => requests,
  async loadChunk(id, level: MapLevel = 'detail') {
   requests.push(`${level}:${id}`);
   if (options.jitter) {
    const origin = chunkOrigin(id);
    for (let wait = variant(origin.x, origin.y) % 4; wait > 0; wait -= 1) await Promise.resolve();
   }
   if (options.failing?.has(id)) {
    const soFar = failures.get(id) ?? 0;
    // No limit means the region always fails; a limit lets the first attempts fail and a later retry succeed.
    if (options.failTimes === undefined || soFar < options.failTimes) {
     failures.set(id, soFar + 1);
     throw new Error(`Mapa indisponível (${id}). Tente novamente.`);
    }
   }
   return fixtureTown(id, level);
  },
 };
}
