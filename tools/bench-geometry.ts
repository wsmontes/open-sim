// Measures the geometry hot path of the geographic renderer, in Node, with the game's own code.
// No DOM, no canvas, no browser: this is the gate that decides whether the frame-path geometry is
// worth porting, caching or indexing at all. It reproduces the three loops that run per frame in
// `surfaces/canvas/geographic-renderer.ts` and `street-renderer.ts`, baseline versus indexed:
//
//   A. assembledFootprints(tiles)          — runs whenever the visible tile set changes (i.e. while panning)
//   B. remainingFootprints(p, edits)       — runs per visible footprint, per frame
//   C. the planting veto                   — point-in-footprint per tree, per frame
//   D. the per-frame Object.entries scan of the world's edited chunks
//
//   npx tsx tools/bench-geometry.ts [buildingsPerTile] [edits] [trees]
import {assembledFootprints, pointInside, remainingFootprints} from '../src/presentation/city-art';
import type {Footprint} from '../src/presentation/city-art';
import {editIndex, editsTouching, footprintIndex, pointCandidates} from '../src/presentation/spatial-index';
import {plantingStep, roadsideTrees} from '../src/presentation/street-detail';
import type {GeographicFeature, GeographicTile} from '../src/presentation/geographic-map';
import type {Point} from '../src/presentation/camera';
import {WORLD} from '../src/core/coordinates';
import type {CellCoord} from '../src/core/model';

const buildingsPerTile = Math.max(4, Number(process.argv[2]) || 60);
const editCount = Math.max(0, Number(process.argv[3]) || 200);
const treeCount = Math.max(0, Number(process.argv[4]) || 3000);
const TILES = 3;
const Z = 8;
const side = WORLD / 2 ** Z;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ring = (x: number, y: number, w: number, h: number): Point[] => [
  {x, y},
  {x: x + w, y},
  {x: x + w, y: y + h},
  {x, y: y + h},
];

/** A city tile: small buildings on a jittered lattice, plus blocks that straddle the edges. */
function buildTiles(seed: number): GeographicTile[] {
  const rng = prng(seed);
  const tiles: GeographicTile[] = [];
  const perRow = Math.ceil(Math.sqrt(buildingsPerTile));
  for (let ty = 0; ty < TILES; ty++) {
    for (let tx = 0; tx < TILES; tx++) {
      const x0 = tx * side;
      const y0 = ty * side;
      const geometry: Point[][] = [];
      const step = side / perRow;
      for (let gy = 0; gy < perRow; gy++) {
        for (let gx = 0; gx < perRow; gx++) {
          if (rng() < 0.2) continue;
          const x = x0 + gx * step + rng() * step * 0.25;
          const y = y0 + gy * step + rng() * step * 0.25;
          geometry.push(ring(x, y, step * (0.35 + rng() * 0.5), step * (0.35 + rng() * 0.5)));
        }
      }
      geometry.push(ring(x0 - side * 0.01, y0 - side * 0.01, side * 0.06, side * 0.06));
      geometry.push(ring(x0 + side * 0.97, y0 + side * 0.97, side * 0.06, side * 0.06));
      const buildings: GeographicFeature = {layer: 'buildings', kind: 'residential', bridge: false, type: 3, geometry};
      const streets: GeographicFeature = {
        layer: 'streets',
        kind: (tx + ty) % 3 === 0 ? 'primary' : 'residential',
        bridge: false,
        type: 2,
        geometry: [ring(x0 + side * 0.1, y0 + side * 0.5, side * 0.8, 0.4)],
      };
      tiles.push({z: Z, x: tx, y: ty, features: [buildings, streets]});
    }
  }
  return tiles;
}

function bestOf(runs: number, fn: () => void): number {
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    if (ms < best) best = ms;
  }
  return best;
}

// ------------------------------------------------------------------ corpus

const tiles = buildTiles(20261004);
const rng = prng(7);
const playerEdits: CellCoord[] = [];
for (let i = 0; i < editCount; i++) playerEdits.push({x: Math.floor(rng() * side * TILES), y: Math.floor(rng() * side * TILES)});
const footprintCount = tiles.reduce((n, t) => n + t.features.filter(f => f.layer === 'buildings').length, 0);

const segments: {a: Point; b: Point}[] = [];
for (const tile of tiles) {
  for (const feature of tile.features) {
    if (feature.layer !== 'streets') continue;
    for (const r of feature.geometry) for (let i = 1; i < r.length; i++) segments.push({a: r[i - 1]!, b: r[i]!});
  }
}
const box = {minX: 0, minY: 0, maxX: side * TILES, maxY: side * TILES};
const trees = roadsideTrees(segments, box, plantingStep(1), 0x51ed, treeCount).slice(0, treeCount);

const chunks: Record<string, {edits: Record<number, unknown>}> = {};
for (let i = 0; i < 300; i++) {
  const record: Record<number, unknown> = {};
  for (let j = 0; j < 6; j++) record[j * 37] = {terrain: 'land'};
  chunks[`${i}:0`] = {edits: record};
}

// ------------------------------------------------------------------ baseline

const footprints: readonly Footprint[] = assembledFootprints(tiles);

const joinedMs = bestOf(3, () => {
  assembledFootprints(buildTiles(20261004)); // a fresh array every time, so the WeakMap cannot serve it
});

const baselineEditsMs = bestOf(5, () => {
  for (const footprint of footprints) remainingFootprints(footprint, playerEdits);
});

const baselineVetoMs = bestOf(5, () => {
  for (const tree of trees) {
    footprints.some(f => tree.x >= f.minX && tree.x <= f.maxX && tree.y >= f.minY && tree.y <= f.maxY && pointInside(tree, f.rings));
  }
});

const entriesMs = bestOf(5, () => {
  for (const [id, chunk] of Object.entries(chunks)) for (const [index, cell] of Object.entries(chunk.edits)) void (id.length + index.length + (cell ? 1 : 0));
});

// ------------------------------------------------------------------ indexed

const buildings = footprintIndex(footprints);
const edits = editIndex(playerEdits);
const candidateBuffer = new Int32Array(4096);
const editBuffer = new Int32Array(4096);
const picked: CellCoord[] = [];

const indexedEditsMs = bestOf(5, () => {
  for (const footprint of footprints) {
    const n = editsTouching(edits, playerEdits, footprint, editBuffer);
    if (n === 0) continue; // the whole point: nothing to do, nothing allocated
    picked.length = 0;
    for (let i = 0; i < n; i++) picked.push(playerEdits[editBuffer[i]!]!);
    remainingFootprints(footprint, picked);
  }
});

const indexedVetoMs = bestOf(5, () => {
  for (const tree of trees) {
    const n = pointCandidates(buildings, tree.x, tree.y, candidateBuffer);
    for (let i = 0; i < n; i++) {
      const f = footprints[candidateBuffer[i]!]!;
      if (tree.x >= f.minX && tree.x <= f.maxX && tree.y >= f.minY && tree.y <= f.maxY && pointInside(tree, f.rings)) break;
    }
  }
});

const indexedFrame = indexedEditsMs + indexedVetoMs + entriesMs;
const baselineFrame = baselineEditsMs + baselineVetoMs + entriesMs;
const row = (label: string, value: string, note = '') => `${label.padEnd(30)}${value.padStart(11)}  ${note}`;

console.log(`scene: ${TILES}x${TILES} tiles, ${footprintCount} building features, ${footprints.length} footprints, ${playerEdits.length} edits, ${trees.length} trees`);
console.log('');
console.log(row('loop', 'baseline', 'indexed'));
console.log(row('A. assembledFootprints', joinedMs.toFixed(2) + ' ms', 'unchanged (next target)'));
console.log(row('B. remainingFootprints', baselineEditsMs.toFixed(3) + ' ms', indexedEditsMs.toFixed(3) + ' ms  ' + (baselineEditsMs / Math.max(indexedEditsMs, 1e-6)).toFixed(1) + 'x'));
console.log(row('C. planting veto', baselineVetoMs.toFixed(3) + ' ms', indexedVetoMs.toFixed(3) + ' ms  ' + (baselineVetoMs / Math.max(indexedVetoMs, 1e-6)).toFixed(1) + 'x'));
console.log(row('D. Object.entries scan', entriesMs.toFixed(3) + ' ms', 'unchanged'));
console.log(row('B+C+D per frame', baselineFrame.toFixed(3) + ' ms', indexedFrame.toFixed(3) + ' ms'));
console.log(row('share of 16.7 ms frame', ((baselineFrame / 16.7) * 100).toFixed(1) + '%', ((indexedFrame / 16.7) * 100).toFixed(1) + '%'));
