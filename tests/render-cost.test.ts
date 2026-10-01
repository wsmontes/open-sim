// @vitest-environment jsdom
import {expect,test} from 'vitest';
import {render} from '../src/presentation/canvas-renderer';
import type {WorldView} from '../src/presentation/canvas-renderer';
import {createGame} from '../src/core/commands';
import {TILE_H,TILE_W} from '../src/presentation/camera';
import {WORLD,chunkId} from '../src/core/coordinates';
import type {BaseChunk,Cell} from '../src/core/model';
import type {ChunkStatus} from '../src/session/ports';

// What this file defends is not a wall-clock number — that depends on the machine, the browser and whether the tab is
// in front of the player — but the amount of drawing the renderer asks for. Operations are deterministic, so a
// regression is a failing test instead of a stutter somebody notices later.
type Recorder = {ctx: CanvasRenderingContext2D; ops: () => number};
const recorder = (): Recorder => {
 let count = 0;
 const bump = () => { count += 1; };
 const target: Record<string, unknown> = {};
 // Every drawing call the renderer makes, counted; property writes are ignored on purpose (they cost nothing).
 for (const name of ['beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'arc', 'ellipse', 'fillRect', 'strokeRect', 'save', 'restore', 'translate', 'rotate', 'clip', 'setLineDash', 'clearRect', 'drawImage']) {
  target[name] = bump;
 }
 target['measureText'] = () => ({width: 0});
 return {ctx: new Proxy(target, {get: (object, key) => (key in object ? object[key as string] : undefined), set: () => true}) as unknown as CanvasRenderingContext2D, ops: () => count};
};

// The same town at every level the renderer has: woods, water, three road classes, buildings of three heights.
const cells: Cell[] = Array.from({length: 1024}, (_unused, index) => {
 const y = Math.floor(index / 32), x = index % 32;
 if (y % 7 === 0) return {terrain: 'land', road: true};
 if (y % 7 === 3) return {terrain: 'land', road: true, roadClass: 'avenue'};
 if (y % 7 === 5) return {terrain: 'land', road: true, roadClass: 'highway'};
 if (x > 26) return {terrain: 'water'};
 if ((x + y) % 11 === 0) return {terrain: 'green'};
 if (y % 7 === 1) return {terrain: 'land', building: 'residential', stage: 1 + (x % 3), origin: 'player'};
 if (y % 7 === 2) return {terrain: 'land', building: 'commercial', stage: 1 + (x % 3), origin: 'player'};
 if (y % 7 === 4) return {terrain: 'land', building: 'industrial', stage: 1 + (x % 3), origin: 'player'};
 if (y % 7 === 6) return {terrain: 'land', building: x % 4 === 0 ? 'park' : 'residential', stage: 1 + (x % 3), origin: 'player'};
 return {terrain: 'land'};
});
const state = createGame('cost', 7, {id: '0:0', source: 'cost', normalizerVersion: 1, cells} as BaseChunk);
const viewport = {width: 688, height: 475};
const view = (zoom: number): WorldView => ({
 camera: {x: viewport.width / 2, y: viewport.height / 2, zoom, rotation: 0},
 viewport, state, chunks: new Map<string, ChunkStatus>(), tool: 'explore', hover: null, preview: [], previewAffordable: true, seed: 7, motion: 0,
});
// How much of the map a frame can possibly be covering at that zoom, so the cost can be read per cell instead of per
// frame: a wide view legitimately draws more cells than a near one.
const visibleCells = (zoom: number) => (viewport.width / (TILE_W * zoom) + 2) * (viewport.height / (TILE_H * zoom) + 2);
const cost = (zoom: number) => {
 const r = recorder();
 render(r.ctx, view(zoom));
 return {ops: r.ops(), perCell: r.ops() / visibleCells(zoom)};
};

test('detail is spent where it can be seen, and zooming out costs less rather than more',()=>{
 // Not constants to keep in step, but the shape of the curve: a cell drawn near costs more than the same cell drawn
 // from far away, and past the budget the frame stops drawing cells at all and draws blocks — which is why the cost
 // of a frame falls as the player pulls back instead of climbing with the number of cells in the air.
 const near = cost(1.6), mid = cost(0.6), far = cost(0.25);
 expect(near.perCell).toBeGreaterThan(mid.perCell);
 expect(mid.perCell).toBeGreaterThan(1);
 expect(far.ops).toBeLessThan(mid.ops);
 // And even the furthest view still paints something: a blank screen is not an optimisation.
 expect(far.ops).toBeGreaterThan(0);
});

test('the cost of a frame is bounded by what is on screen, not by the map behind it',()=>{
 // The culling is what lets a player pan a city of millions of cells: a frame at a fixed zoom cannot get more
 // expensive because the world outside the viewport grew.
 const small = cost(1);
 const huge: WorldView = {...view(1), state: {...state, chunks: {...state.chunks, '9:9': state.chunks['0:0']!}}};
 const r = recorder();
 render(r.ctx, huge);
 expect(r.ops()).toBe(small.ops);
});

test('the same city costs the same frame twice, and the streets are what moves in it',()=>{
 // Painting is a pure function of the view: the same view drawn twice is the same work, and a moving clock changes
 // what is on the streets without changing what the frame costs.
 const first = recorder();
 render(first.ctx, view(1.2));
 const second = recorder();
 render(second.ctx, view(1.2));
 expect(second.ops()).toBe(first.ops());
 const moving = recorder();
 render(moving.ctx, {...view(1.2), motion: 4.2});
 expect(Math.abs(moving.ops() - first.ops())).toBeLessThanOrEqual(first.ops() * 0.25);
});

test('the north coast never samples land from the south edge of the world',()=>{
 const northCells:Cell[]=Array.from({length:1024},()=>({terrain:'water'}));
 const north=createGame('coast',7,{id:'0:0',source:'north',normalizerVersion:1,cells:northCells} as BaseChunk);
 const southId=chunkId({x:0,y:WORLD-1});
 const south=(terrain:'land'|'water')=>createGame('south',7,{id:southId,source:'south',normalizerVersion:1,cells:Array.from({length:1024},()=>({terrain}))} as BaseChunk).chunks[southId]!;
 const draw=(terrain:'land'|'water')=>{
  const r=recorder();
  render(r.ctx,{...view(1),state:{...north,chunks:{...north.chunks,[southId]:south(terrain)}}});
  return r.ops();
 };
 // Longitude wraps; latitude does not. If y=-1 were wrapped with wrapX, southern land would add foam to the north.
 expect(draw('land')).toBe(draw('water'));
});
