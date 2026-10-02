// @vitest-environment jsdom
import {expect,test} from 'vitest';
import {render as optimized} from '../src/surfaces/canvas/canvas-renderer';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
import {render as reference} from './fixtures/renderer-reference';
import {createGame} from '../src/core/commands';
import {CHUNK,WORLD,chunkId} from '../src/core/coordinates';
import type {BaseChunk,Cell,CellCoord} from '../src/core/model';
import type {ChunkStatus} from '../src/session/ports';

// A frame is a pure sequence of canvas calls. Recording the method name and every argument of each call, and asserting
// the optimized renderer produces the same sequence as a verbatim copy of the upstream renderer, is the proof that the
// allocation-light rewrite changed how the work is done and not what is drawn. Numbers are compared with a tiny
// epsilon because the scalar projection reorders the same arithmetic (a*cx+b*cy instead of grouping through objects),
// so bit-for-bit equality is not guaranteed, only equality to floating-point rounding.
type Call = {op: string; args: unknown[]};
type Recording = {ctx: CanvasRenderingContext2D; calls: Call[]};
const METHODS = ['beginPath','moveTo','lineTo','closePath','fill','stroke','arc','ellipse','fillRect','strokeRect','save','restore','translate','rotate','clip','setLineDash','clearRect','drawImage'];
const recorder = (): Recording => {
 const calls: Call[] = [];
 const target: Record<string, unknown> = {};
 for (const name of METHODS) target[name] = (...args: unknown[]) => { calls.push({op: name, args}); };
 target['measureText'] = () => ({width: 0});
 // Property writes (fillStyle, strokeStyle, lineWidth, imageSmoothingEnabled, ...) are recorded too: a changed colour
 // or line width is a changed picture, so the proof has to cover them, not only the geometry methods.
 const written: Record<string, unknown> = {};
 const ctx = new Proxy(target, {
  get: (object, key) => (key in object ? object[key as string] : written[key as string]),
  set: (_object, key, value) => { written[key as string] = value; calls.push({op: `=${String(key)}`, args: [value]}); return true; },
 }) as unknown as CanvasRenderingContext2D;
 return {ctx, calls};
};

const EPS = 1e-9;
const same = (a: unknown, b: unknown): boolean => {
 if (typeof a === 'number' && typeof b === 'number') {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) <= EPS + EPS * Math.max(Math.abs(a), Math.abs(b));
 }
 if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
 return a === b;
};
const assertEqual = (label: string, got: Call[], want: Call[]): void => {
 expect(got.length, `${label}: call count`).toBe(want.length);
 for (let i = 0; i < want.length; i++) {
  const g = got[i]!, w = want[i]!;
  const ok = g.op === w.op && g.args.length === w.args.length && g.args.every((arg, j) => same(arg, w.args[j]));
  if (!ok) {
   throw new Error(`${label}: call ${i} differs\n  reference: ${w.op}(${JSON.stringify(w.args)})\n  optimized: ${g.op}(${JSON.stringify(g.args)})`);
  }
 }
};

// The same town the cost test uses, at every level the renderer has: woods, water, three road classes, buildings of
// three heights plus a stage-0 site and parks.
const townCells: Cell[] = Array.from({length: 1024}, (_unused, index) => {
 const y = Math.floor(index / CHUNK), x = index % CHUNK;
 if (y % 7 === 0) return {terrain: 'land', road: true};
 if (y % 7 === 3) return {terrain: 'land', road: true, roadClass: 'avenue'};
 if (y % 7 === 5) return {terrain: 'land', road: true, roadClass: 'highway'};
 if (x > 26) return {terrain: 'water'};
 if ((x + y) % 11 === 0) return {terrain: 'green'};
 if (y % 7 === 1) return {terrain: 'land', building: 'residential', stage: x % 4 === 0 ? 0 : 1 + (x % 3), origin: 'player'};
 if (y % 7 === 2) return {terrain: 'land', building: 'commercial', stage: 1 + (x % 3), origin: 'player'};
 if (y % 7 === 4) return {terrain: 'land', building: 'industrial', stage: 1 + (x % 3), origin: 'player'};
 if (y % 7 === 6) return {terrain: 'land', building: x % 4 === 0 ? 'park' : 'residential', stage: 1 + (x % 3), origin: 'player'};
 return {terrain: 'land'};
});
const base: BaseChunk = {id: '0:0', source: 'equiv', normalizerVersion: 1, cells: townCells};
const state = createGame('equiv', 7, base);
// A ready region beside the town, and an errored one, so the mosaic/unknown/error ground paths are all exercised.
const errorId = chunkId({x: CHUNK, y: 0});
const errorStatus: ChunkStatus = {status: 'error', message: 'nope'};
const chunks = new Map<string, ChunkStatus>([[errorId, errorStatus]]);
const viewport = {width: 688, height: 475};
const centre: CellCoord = {x: 15, y: 15};
const anchor = {x: viewport.width / 2, y: viewport.height / 2};

const view = (zoom: number, rotation: number, extra: Partial<WorldView> = {}): WorldView => ({
 camera: {x: anchor.x, y: anchor.y, zoom, rotation},
 viewport, state, chunks, tool: 'explore', hover: null, preview: [], previewAffordable: true, seed: 7, motion: 0,
 ...extra,
});

const previewCells: CellCoord[] = [{x: 14, y: 14}, {x: 15, y: 14}, {x: 16, y: 14}];
const scenarios: Array<[string, WorldView]> = [];
for (const [zname, zoom] of [['near', 1.6] as const, ['mid', 0.6] as const, ['far', 0.22] as const]) {
 for (const [rname, rotation] of [['r0', 0] as const, ['r0.7', 0.7] as const, ['r-2.1', -2.1] as const]) {
  scenarios.push([`${zname}/${rname} explore`, view(zoom, rotation)]);
  scenarios.push([`${zname}/${rname} hover`, view(zoom, rotation, {hover: centre})]);
  scenarios.push([`${zname}/${rname} preview-ok`, view(zoom, rotation, {tool: 'residential', preview: previewCells, previewAffordable: true})]);
  scenarios.push([`${zname}/${rname} preview-bad`, view(zoom, rotation, {tool: 'residential', preview: previewCells, previewAffordable: false})]);
 }
}
// Motion changes what moves on the streets without changing the frame cost — include it so street-life draws too.
scenarios.push(['near/r0.7 motion', view(1.6, 0.7, {motion: 4.2})]);

test.each(scenarios)('optimized renderer draws exactly what the reference draws: %s', (_label, worldView) => {
 const ref = recorder();
 reference(ref.ctx, worldView);
 const opt = recorder();
 optimized(opt.ctx, worldView);
 assertEqual(_label, opt.calls, ref.calls);
 expect(ref.calls.length).toBeGreaterThan(0);
});

test('the proof covers a view large enough to force the mosaic pass as well as the fine pass',()=>{
 // isCoarse or the 5000-cell budget switches to blocks; a very wide view takes that branch.
 const wide = view(0.08, 0.7);
 const ref = recorder();
 reference(ref.ctx, wide);
 const opt = recorder();
 optimized(opt.ctx, wide);
 assertEqual('wide mosaic', opt.calls, ref.calls);
 expect(ref.calls.length).toBeGreaterThan(0);
});

test('a south-edge region near the world floor still matches (latitude does not wrap)',()=>{
 const southId = chunkId({x: 0, y: WORLD - 1});
 const southState = createGame('south', 7, {id: southId, source: 'south', normalizerVersion: 1, cells: townCells});
 const southView = view(1.2, 0.7, {state: southState, camera: {x: anchor.x, y: anchor.y, zoom: 1.2, rotation: 0.7}});
 // Centre the camera on the southern region.
 const centred: WorldView = {...southView, camera: {x: anchor.x, y: anchor.y, zoom: 1.2, rotation: 0.7}, state: southState};
 const ref = recorder();
 reference(ref.ctx, centred);
 const opt = recorder();
 optimized(opt.ctx, centred);
 assertEqual('south edge', opt.calls, ref.calls);
});
