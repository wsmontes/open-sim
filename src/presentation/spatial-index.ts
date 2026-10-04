// Spatial index for the frame path. The measured bottleneck of the geographic renderer is not polygon
// maths: it is two nested loops that scan a whole list per item, per frame, allocating as they go
// (`remainingFootprints` scans every edit for every footprint; the planting veto scans every footprint
// for every tree). Both scans are O(items × candidates) where the real answer is O(items + hits).
//
// This module is a uniform bin grid over axis-aligned boxes, in the compact CSR shape that costs two
// typed arrays and no per-query allocation:
//
//   bins[i] .. bins[i+1]   the slice of `items` that belongs to bin i
//
// Exactness contract, and the reason nothing about the picture changes:
//   * A box is registered in EVERY bin it overlaps — not only the bin its corner falls in. Registering
//     by corner loses a box whose overlap with the query lies entirely inside another bin.
//   * The query returns a SUPERSET of the true candidates; the caller still applies the exact predicate
//     (`c.x + 1 > f.minX && …`, `pointInside(…)`). The index only decides what to test.
// Replacing a full scan with a superset scan followed by the same predicate is behaviour-preserving by
// construction; what changes is how many predicate calls happen.

import type {Footprint} from './city-art';
import {pointInside, remainingFootprints} from './city-art';
import type {Point} from './camera';
import type {CellCoord} from '../core/model';

export type BoxIndex = {
  /** CSR offsets, length cols*rows + 1 */ bins: Int32Array;
  /** item indices, grouped by bin */ items: Int32Array;
  /** bin size, in the world units the callers already use */ cell: number;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
};

export type Box = {minX: number; minY: number; maxX: number; maxY: number};

const cache = new WeakMap<object, BoxIndex>();
const EMPTY = new Int32Array(0);

/** The one place a box becomes bins. Every builder goes through here, so they cannot drift apart. */
function buildFromBoxes(boxes: readonly Box[], requestedCell: number): BoxIndex {
  if (boxes.length === 0) return {bins: new Int32Array(2), items: EMPTY, cell: requestedCell > 0 ? requestedCell : 1, minX: 0, minY: 0, cols: 1, rows: 1};
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }
  // The cell is chosen from the data when the caller does not dictate one: the world scale of this game
  // moves with the zoom (WORLD / 2^z), so a fixed cell is a linear scan with extra steps at some zooms.
  let cell = requestedCell;
  if (!(cell > 0)) {
    let span = 0;
    for (const box of boxes) span += Math.max(box.maxX - box.minX, box.maxY - box.minY);
    const extent = Math.max(maxX - minX, maxY - minY);
    cell = Math.max((span / boxes.length) * 2, extent / Math.max(1, Math.sqrt(boxes.length)), 1e-6);
  }
  cell = Math.max(1e-6, cell);
  // A box is registered in every bin it overlaps, which is what makes the query exact. Pathological
  // inputs would blow that up, so the cell grows until the registration count stays bounded. Bounded
  // loop on purpose: malformed input must yield a usable index, never a hang.
  for (let guard = 0; guard < 64; guard++) {
    let registrations = 0;
    for (const box of boxes) {
      const sideX = Math.max(1, Math.ceil((box.maxX - box.minX) / cell));
      const sideY = Math.max(1, Math.ceil((box.maxY - box.minY) / cell));
      registrations += sideX * sideY;
    }
    if (registrations <= boxes.length * 4) break;
    cell *= 2;
  }
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const column = (x: number) => (Number.isFinite(x) ? Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / cell))) : -1);
  const row = (y: number) => (Number.isFinite(y) ? Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / cell))) : -1);
  const bins = new Int32Array(cols * rows + 1);
  for (const box of boxes) {
    const bx1 = column(box.maxX);
    const by1 = row(box.maxY);
    for (let by = row(box.minY); by <= by1; by++) {
      for (let bx = column(box.minX); bx <= bx1; bx++) bins[by * cols + bx + 1]++;
    }
  }
  for (let i = 0; i < cols * rows; i++) bins[i + 1] += bins[i]!;
  const items = new Int32Array(bins[cols * rows]!);
  const cursor = bins.slice(0, cols * rows);
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i]!;
    const bx1 = column(box.maxX);
    const by1 = row(box.maxY);
    for (let by = row(box.minY); by <= by1; by++) {
      for (let bx = column(box.minX); bx <= bx1; bx++) {
        items[cursor[by * cols + bx]!++] = i;
      }
    }
  }
  return {bins, items, cell, minX, minY, cols, rows};
}

export function buildBoxIndex(boxes: readonly Box[], requestedCell = 1): BoxIndex {
  return buildFromBoxes(boxes, requestedCell);
}

/**
 * Same grid, built from cells: each one occupies [x, x+1) × [y, y+1), which is exactly the region the
 * caller's own predicate tests (`c.x + 1 > minX && c.x < maxX`), so the candidate set is the superset of
 * the same predicate.
 */
export function buildCellIndex(cells: readonly CellCoord[], requestedCell = 0): BoxIndex {
  const boxes: Box[] = new Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    boxes[i] = {minX: c.x, minY: c.y, maxX: c.x + 1, maxY: c.y + 1};
  }
  return buildFromBoxes(boxes, requestedCell);
}

/** Indices of every box that MIGHT contain (x,y), written into `out`. Returns how many were written. */
export function pointCandidates(index: BoxIndex, x: number, y: number, out: Int32Array): number {
  const bx = Math.floor((x - index.minX) / index.cell);
  const by = Math.floor((y - index.minY) / index.cell);
  if (!(bx >= 0 && bx < index.cols && by >= 0 && by < index.rows)) return 0;
  return copyBin(index, by * index.cols + bx, out);
}

/** Indices of every box that MIGHT overlap the given box. Still a superset: the caller tests exactly. */
export function boxCandidates(index: BoxIndex, minX: number, minY: number, maxX: number, maxY: number, out: Int32Array): number {
  const cx0 = Math.floor((minX - index.minX) / index.cell);
  const cx1 = Math.floor((maxX - index.minX) / index.cell);
  const cy0 = Math.floor((minY - index.minY) / index.cell);
  const cy1 = Math.floor((maxY - index.minY) / index.cell);
  const x0 = Math.max(0, Math.min(index.cols - 1, cx0));
  const x1 = Math.max(0, Math.min(index.cols - 1, cx1));
  const y0 = Math.max(0, Math.min(index.rows - 1, cy0));
  const y1 = Math.max(0, Math.min(index.rows - 1, cy1));
  if (!(x0 <= x1) || !(y0 <= y1)) return 0;
  let n = 0;
  for (let by = y0; by <= y1; by++) {
    for (let bx = x0; bx <= x1; bx++) {
      const bin = by * index.cols + bx;
      const stop = index.bins[bin + 1]!;
      for (let i = index.bins[bin]!; i < stop; i++) {
        if (n === out.length) return n;
        out[n++] = index.items[i]!;
      }
    }
  }
  return n;
}

function copyBin(index: BoxIndex, bin: number, out: Int32Array): number {
  const start = index.bins[bin]!;
  const stop = index.bins[bin + 1]!;
  const n = Math.min(stop - start, out.length);
  for (let i = 0; i < n; i++) out[i] = index.items[start + i]!;
  return n;
}

/** Index over footprint bounding boxes. Cached by the footprint array's identity, like the code it serves. */
export function footprintIndex(footprints: readonly Footprint[], cell = 0): BoxIndex {
  const cached = cache.get(footprints);
  if (cached) return cached;
  const built = buildFromBoxes(footprints, cell);
  cache.set(footprints, built);
  return built;
}

/** Index over the player's edited cells. Cached by the edits array's identity. */
export function editIndex(edits: readonly CellCoord[], cell = 0): BoxIndex {
  const cached = cache.get(edits);
  if (cached) return cached;
  const built = buildCellIndex(edits, cell);
  cache.set(edits, built);
  return built;
}

/**
 * The same index, cached by whatever object identifies the revision it was built from — the game state,
 * whose identity changes when the world does. The cells are only read when the index is actually built,
 * so a caller can hand over a freshly mapped array every frame and still pay for the index once.
 */
export function editIndexFor(key: object, cells: readonly CellCoord[]): BoxIndex {
  const cached = cache.get(key);
  if (cached) return cached;
  const built = buildCellIndex(cells);
  cache.set(key, built);
  return built;
}

/**
 * The edits that can possibly touch a footprint, as indices into `edits`, written into `out`.
 * This is exactly the set the filter inside `remainingFootprints` would have kept — no more, no less.
 *
 * A box is registered in every bin it overlaps, so a multi-bin query can list the same box twice. The
 * stamp array makes the second sighting free: one integer compare, no allocation, no Set. The scratch
 * is module-level because the renderer is single-threaded per context.
 */
export function editsTouching(index: BoxIndex, edits: readonly CellCoord[], footprint: Box, out: Int32Array): number {
  const candidates = boxCandidates(index, footprint.minX, footprint.minY, footprint.maxX, footprint.maxY, out);
  if (stamps.length < edits.length) stamps = new Int32Array(edits.length);
  const mark = nextStamp();
  let n = 0;
  for (let i = 0; i < candidates; i++) {
    const at = out[i]!;
    if (stamps[at] === mark) continue;
    stamps[at] = mark;
    const edit = edits[at]!;
    if (edit.x + 1 > footprint.minX && edit.x < footprint.maxX && edit.y + 1 > footprint.minY && edit.y < footprint.maxY) out[n++] = at;
  }
  return n;
}

let stamps = new Int32Array(0);
let stamp = 0;

function nextStamp(): number {
  if (stamp === 0x7ffffffe) {
    stamps.fill(0);
    stamp = 0;
  }
  return ++stamp;
}

/**
 * The planting veto's question, asked through the index: is this point inside any of the footprints?
 * Same predicate as the linear scan it replaces — bbox first, then the exact point-in-rings test.
 */
export function pointInsideAny(footprints: readonly Footprint[], index: BoxIndex, point: Point, out: Int32Array): boolean {
  const n = pointCandidates(index, point.x, point.y, out);
  for (let i = 0; i < n; i++) {
    const f = footprints[out[i]!]!;
    if (point.x >= f.minX && point.x <= f.maxX && point.y >= f.minY && point.y <= f.maxY && pointInside(point, f.rings)) return true;
  }
  return false;
}

/**
 * `remainingFootprints`, but handed only the edits the index says can touch this footprint. The boolean
 * itself stays in city-art: this decides what to hand it and nothing else, so there is one implementation
 * of the geometry and two ways of finding the work.
 */
export function remainingIndexed(footprint: Footprint, edits: readonly CellCoord[], index: BoxIndex, picked: CellCoord[], out: Int32Array): Footprint[] {
  const n = editsTouching(index, edits, footprint, out);
  if (n === 0) return [footprint];
  picked.length = 0;
  for (let i = 0; i < n; i++) picked.push(edits[out[i]!]!);
  return remainingFootprints(footprint, picked);
}
