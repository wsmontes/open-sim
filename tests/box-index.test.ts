// The index replaces full scans with a superset scan followed by the same predicate. These tests are the
// proof of that claim: for random scenes, the indexed path must answer EXACTLY what the code it serves
// answers — for every tree, for every footprint, for every edit.
import {expect,test} from 'vitest';
import {assembledFootprints, pointInside, remainingFootprints} from '../src/presentation/city-art';
import type {Footprint} from '../src/presentation/city-art';
import {buildBoxIndex, editIndex, editsTouching, footprintIndex, pointCandidates} from '../src/presentation/spatial-index';
import type {CellCoord} from '../src/core/model';
import type {Point} from '../src/presentation/camera';

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

/** Footprints with a jittered bbox, plus one that overlaps its neighbour so candidate sets are non-trivial. */
function scene(seed: number, count: number, extent: number): Footprint[] {
  const rng = prng(seed);
  const out: Footprint[] = [];
  for (let i = 0; i < count; i++) {
    const x = rng() * extent;
    const y = rng() * extent;
    const w = 0.4 + rng() * 3;
    const h = 0.4 + rng() * 3;
    out.push({rings: [ring(x, y, w, h)], minX: x, maxX: x + w, minY: y, maxY: y + h, area: w * h, kind: 'residential', seed: i});
  }
  if (count > 1) {
    const first = out[0]!;
    out.push({...first, minX: first.minX + 0.3, maxX: first.maxX + 0.3});
  }
  return out;
}

test('a candidate query never misses a box that contains the point', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const footprints = scene(seed, 400, 40);
    const index = buildBoxIndex(footprints);
    const rng = prng(seed * 31);
    const out = new Int32Array(4096);
    let missed = 0;
    let containing = 0;
    for (let i = 0; i < 300; i++) {
      const x = rng() * 60 - 10;
      const y = rng() * 60 - 10;
      const n = pointCandidates(index, x, y, out);
      for (let at = 0; at < footprints.length; at++) {
        const f = footprints[at]!;
        if (x < f.minX || x > f.maxX || y < f.minY || y > f.maxY) continue;
        containing++;
        let found = false;
        for (let k = 0; k < n; k++) {
          if (out[k] === at) {
            found = true;
            break;
          }
        }
        if (!found) missed++;
      }
    }
    expect(missed, `seed ${seed}: every containing box must be among the candidates`).toBe(0);
    expect(containing, `seed ${seed}: the corpus must actually exercise containment`).toBeGreaterThan(0);
  }
});

test('the planting veto answers the same for every tree', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const footprints = scene(seed, 300, 40);
    const index = footprintIndex(footprints);
    const rng = prng(seed * 7);
    const out = new Int32Array(1024);
    let mismatches = 0;
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const tree: Point = {x: rng() * 50 - 5, y: rng() * 50 - 5};
      const baseline = footprints.some(f => tree.x >= f.minX && tree.x <= f.maxX && tree.y >= f.minY && tree.y <= f.maxY && pointInside(tree, f.rings));
      let indexed = false;
      const n = pointCandidates(index, tree.x, tree.y, out);
      for (let k = 0; k < n && !indexed; k++) {
        const f = footprints[out[k]!]!;
        indexed = tree.x >= f.minX && tree.x <= f.maxX && tree.y >= f.minY && tree.y <= f.maxY && pointInside(tree, f.rings);
      }
      if (indexed !== baseline) mismatches++;
      if (baseline) hits++;
    }
    expect(mismatches, `seed ${seed}`).toBe(0);
    expect(hits, `seed ${seed}: the corpus must actually reject some trees`).toBeGreaterThan(0);
  }
});

test('the index returns exactly the edits the full filter would keep', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const footprints = scene(seed, 120, 40);
    const rng = prng(seed * 13);
    const edits: CellCoord[] = [];
    for (let i = 0; i < 400; i++) edits.push({x: Math.floor(rng() * 44 - 2), y: Math.floor(rng() * 44 - 2)});
    const index = editIndex(edits);
    const out = new Int32Array(4096);
    for (const footprint of footprints) {
      const baseline = edits.filter(c => c.x + 1 > footprint.minX && c.x < footprint.maxX && c.y + 1 > footprint.minY && c.y < footprint.maxY);
      const n = editsTouching(index, edits, footprint, out);
      const indexed = [];
      for (let i = 0; i < n; i++) indexed.push(edits[out[i]!]!);
      expect(indexed.length, `seed ${seed} count`).toBe(baseline.length);
      for (const edit of indexed) expect(baseline.includes(edit), `seed ${seed} edit ${edit.x},${edit.y}`).toBe(true);
    }
  }
});

test('remainingFootprints over the pre-filtered list is the same polygon as over the whole list', () => {
  const footprints = scene(9, 200, 24);
  const rng = prng(99);
  const edits: CellCoord[] = [];
  // Edits clustered on purpose, so the boolean path really runs for some footprints.
  for (let i = 0; i < 120; i++) edits.push({x: Math.floor(footprints[i % footprints.length]!.minX + rng() * 3), y: Math.floor(footprints[i % footprints.length]!.minY + rng() * 3)});
  const index = editIndex(edits);
  const out = new Int32Array(2048);
  let exercised = 0;
  for (const footprint of footprints) {
    const n = editsTouching(index, edits, footprint, out);
    const picked: CellCoord[] = [];
    for (let i = 0; i < n; i++) picked.push(edits[out[i]!]!);
    const indexed = n > 0 ? remainingFootprints(footprint, picked) : [footprint];
    const baseline = remainingFootprints(footprint, edits);
    expect(indexed.length, 'same number of pieces').toBe(baseline.length);
    expect(indexed).toEqual(baseline);
    if (indexed.length !== 1 || indexed[0] !== footprint) exercised++;
  }
  expect(exercised, 'the boolean path must actually run in this test').toBeGreaterThan(0);
});

test('the index is cached per array identity and never crosses scenes', () => {
  const a = scene(1, 50, 20);
  const b = scene(2, 50, 20);
  expect(footprintIndex(a)).toBe(footprintIndex(a));
  expect(footprintIndex(a)).not.toBe(footprintIndex(b));
  const editsA: CellCoord[] = [{x: 1, y: 1}];
  const editsB: CellCoord[] = [{x: 5, y: 5}];
  expect(editIndex(editsA)).toBe(editIndex(editsA));
  expect(editIndex(editsA)).not.toBe(editIndex(editsB));
});

test('edges: no boxes, one box, a point outside the extent, a query on the boundary', () => {
  const empty = buildBoxIndex([]);
  expect(pointCandidates(empty, 0, 0, new Int32Array(4))).toBe(0);

  const boxes = [{minX: 2, minY: 2, maxX: 4, maxY: 4}];
  const one = buildBoxIndex(boxes, 1);
  const out = new Int32Array(4);
  // The candidate list is a SUPERSET, so the contract is: candidates + the caller's predicate = the
  // predicate's own answer. Asserting the raw count would be asserting an implementation detail.
  const hits = (x: number, y: number) => {
    const n = pointCandidates(one, x, y, out);
    let found = 0;
    for (let i = 0; i < n; i++) {
      const b = boxes[out[i]!]!;
      if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) found++;
    }
    return found;
  };
  expect(pointCandidates(one, -1000, -1000, out), 'a point outside the extent yields no candidate').toBe(0);
  expect(hits(3, 3)).toBe(1);
  expect(hits(2, 2), 'the boundary belongs to the box').toBe(1);
  expect(hits(4, 4)).toBe(1);
  expect(hits(4.0001, 4)).toBe(0);
  expect(hits(1.9999, 2)).toBe(0);
});

test('a huge box among small ones still yields an exact index', () => {
  const boxes = [{minX: 0, minY: 0, maxX: 1000, maxY: 1000}, ...scene(4, 300, 20)];
  const index = buildBoxIndex(boxes);
  const out = new Int32Array(4096);
  const rng = prng(5);
  for (let i = 0; i < 200; i++) {
    const x = rng() * 1000;
    const y = rng() * 1000;
    const n = pointCandidates(index, x, y, out);
    let hit = false;
    for (let k = 0; k < n; k++) if (out[k] === 0) hit = true;
    expect(hit, 'the big box must be found everywhere inside it').toBe(true);
  }
});

test('assembledFootprints output feeds the index without a copy', () => {
  const footprints = assembledFootprints([]);
  expect(footprints).toEqual([]);
  const index = footprintIndex(footprints);
  expect(pointCandidates(index, 0, 0, new Int32Array(2))).toBe(0);
});

test('bounds index storage for far apart point boxes without losing either candidate',()=>{const index=buildBoxIndex([{minX:0,minY:0,maxX:0,maxY:0},{minX:1e9,minY:1e9,maxX:1e9,maxY:1e9}],1);expect(index.bins.length).toBeLessThanOrEqual(262145);const out=new Int32Array(8);const count=pointCandidates(index,1e9,1e9,out);expect(Array.from(out.subarray(0,count))).toContain(1);});
