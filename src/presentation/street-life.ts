import {variant} from '../core/coordinates';
import type {RoadClass} from '../core/model';

// Street life is painted, never simulated. Nothing here reads the world, writes a component or travels between
// clients: every car and pedestrian is a pure function of a few small numbers — the cell's address, how busy it is,
// and the animation clock. That is what lets the streets move at sixty frames a second without putting a transient
// position into the ledger the world is addressed by, and it is why two clients showing the same town show the same
// traffic: the map decides, not the player.
export type StreetLife = {
 kind: 'car' | 'walker' | 'cyclist';
 // A lorry is drawn longer and taller than a car: the same road, seen at the weight of what is on it.
 heavy: boolean;
 // Where along the road the thing is, 0..1 from one end of the cell to the other.
 along: number;
 // Which side of the road it keeps, so two cars meeting do not drive through each other.
 lane: 1 | -1;
 // Whether it travels along the cell's north-east diagonal or its south-east one — the two road axes of the art.
 cross: boolean;
 colour: string;
};

// How busy a road cell is: the tallest building facing it, and whether people have somewhere to be next to it (a shop
// or a park). Both come from the four neighbours the renderer already resolves for its own drawing.
export type CellLife = {x: number; y: number; stage: number; social: boolean; road: RoadClass};

const CAR_COLOURS = ['#d4553f', '#4a77be', '#e0c14a', '#6fbf8b', '#c9c9d1', '#8b5e3c'];
const SHIRT_COLOURS = ['#f0e6d2', '#e0705c', '#5f9fd4', '#f2c46b'];
const CYCLIST_COLOURS = ['#d9738c', '#6fb0c9', '#e3a54a'];

// What the road can carry decides how much of it there is — an avenue lives several times busier than a street, and a
// highway busier still and faster — while what is built along it decides how much of that traffic the city has to
// show. Nobody walks along a highway, which is what its zero is saying.
const ROAD_TRAFFIC: Record<RoadClass, {cars: number; walkers: number; speed: number}> = {
 street: {cars: 13, walkers: 9, speed: 1},
 avenue: {cars: 30, walkers: 15, speed: 1.35},
 highway: {cars: 55, walkers: 0, speed: 1.9},
};
// What one built floor along the road puts on it. An empty street is an empty street — traffic comes from the city,
// and the road class is only how much of it the road can show at once.
const STAGE_CARS: Record<RoadClass, number> = {street: 13, avenue: 22, highway: 16};
// A highway is the one road with traffic that is just passing through: it exists to carry what a street cannot, so a
// new highway through empty land is not a dead end.
const THROUGH_TRAFFIC: Record<RoadClass, number> = {street: 0, avenue: 0, highway: 22};
// How much of the animation clock one car takes to cross its cell. The phase offset each car gets below keeps a row
// of cells from moving in step, which is what would make the traffic look like a marching band.
// Nothing in this city is in a hurry: a car takes about three and a half seconds to cross a cell, and the streets are
// meant to look calm rather than busy. Every individual carries its own phase, so no two move together.
export const CAR_PERIOD = 3.4;

export function lifeAt(cell: CellLife, motion: number): StreetLife | null {
 const traffic = ROAD_TRAFFIC[cell.road];
 const hash = variant(cell.x, cell.y, 0x5f3a1d);
 // The clock only has to be monotonic; taking the positive remainder keeps the arithmetic sane even if it is not.
 const phase = ((motion * traffic.speed / CAR_PERIOD) % 1 + 1) % 1;
 const roll = hash % 100;
 const lane: 1 | -1 = hash & 0x10000 ? 1 : -1;
 const cross = (hash & 0x20000) !== 0;
 const cars = THROUGH_TRAFFIC[cell.road] + Math.min(cell.stage, 3) * STAGE_CARS[cell.road];
 if (roll < cars) {
  // Each car keeps its own offset inside the cell, so a queue never collapses into one block, and the phase carries
  // it in at one end and out at the other. A highway is where the lorries are.
  const offset = ((hash >>> 8) % 100) / 100;
  const heavy = traffic.walkers === 0 && (hash & 0x40000) !== 0;
  return {kind: 'car', heavy, along: (offset + phase) % 1, lane, cross, colour: CAR_COLOURS[(hash >>> 16) % CAR_COLOURS.length]!};
 }
 // A cyclist belongs to the avenue: it is the road a bike takes when there is one, and it puts a third silhouette on
 // the street instead of a second colour of the same one.
 if (cell.road === 'avenue' && roll >= cars + traffic.walkers && roll < cars + traffic.walkers + 7) {
  const offset = ((hash >>> 19) % 100) / 100;
  return {kind: 'cyclist', heavy: false, along: (offset + phase * 1.6) % 1, lane, cross, colour: CYCLIST_COLOURS[(hash >>> 22) % CYCLIST_COLOURS.length]!};
 }
 if (cell.social && roll < cars + traffic.walkers) {
  // People walk, so the same clock carries them less than half as far, and the lane offset puts them at the kerb.
  const offset = ((hash >>> 12) % 100) / 100;
  return {kind: 'walker', heavy: false, along: (offset + phase * 0.45) % 1, lane, cross, colour: SHIRT_COLOURS[(hash >>> 20) % SHIRT_COLOURS.length]!};
 }
 return null;
}

// The road's two axes are the cell's own diagonals, so a vehicle travels along one of them and keeps to its lane
// along the other: `axis` is the direction of travel, `side` the direction of the kerb. Both are halves of the cell,
// which keeps the art tied to the zoom instead of to constants of its own.
const frame = (tw: number, th: number, cross: boolean) => ({
 axis: {x: tw * 0.5, y: cross ? -th * 0.5 : th * 0.5},
 side: {x: tw * 0.5, y: cross ? th * 0.5 : -th * 0.5},
});

export function drawLife(ctx: CanvasRenderingContext2D, x: number, y: number, tw: number, th: number, life: StreetLife): void {
 const {axis, side} = frame(tw, th, life.cross);
 const travel = life.along * 2 - 1;
 if (life.kind === 'car') {
  const cx = x + axis.x * travel + side.x * life.lane * 0.24;
  const cy = y + axis.y * travel + side.y * life.lane * 0.24;
  const scale = life.heavy ? 0.42 : 0.26;
  const length = {x: axis.x * scale, y: axis.y * scale}, width = {x: side.x * (life.heavy ? 0.17 : 0.15), y: side.y * (life.heavy ? 0.17 : 0.15)};
  // A lorry is a box with a cab: the roof highlight sits at the front instead of the middle.
  const cab = life.heavy ? 0.72 : 0.5;
  ctx.fillStyle = life.colour;
  ctx.beginPath();
  ctx.moveTo(cx - length.x - width.x, cy - length.y - width.y);
  ctx.lineTo(cx + length.x - width.x, cy + length.y - width.y);
  ctx.lineTo(cx + length.x + width.x, cy + length.y + width.y);
  ctx.lineTo(cx - length.x + width.x, cy - length.y + width.y);
  ctx.closePath();
  ctx.fill();
  // The roof catches the light, so a car reads as a car and not as a chip of the road surface.
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.beginPath();
  const front = length.x * (cab * 2 - 1), frontY = length.y * (cab * 2 - 1);
  ctx.moveTo(cx + front - width.x * 0.5, cy + frontY - width.y * 0.5);
  ctx.lineTo(cx + front + width.x * 0.5, cy + frontY + width.y * 0.5);
  ctx.lineTo(cx - length.x * 0.5 + width.x * 0.5, cy - length.y * 0.5 + width.y * 0.5);
  ctx.lineTo(cx - length.x * 0.5 - width.x * 0.5, cy - length.y * 0.5 - width.y * 0.5);
  ctx.closePath();
  ctx.fill();
  return;
 }
 if (life.kind === 'cyclist') {
  // A bike is a person with a wheel under them: two small discs and a body leaning forward.
  const cx = x + axis.x * travel + side.x * life.lane * 0.16;
  const cy = y + axis.y * travel + side.y * life.lane * 0.16;
  ctx.strokeStyle = life.colour;
  ctx.lineWidth = Math.max(1, tw * 0.04);
  ctx.beginPath();
  ctx.moveTo(cx - axis.x * 0.1, cy - axis.y * 0.1 - th * 0.1);
  ctx.lineTo(cx + axis.x * 0.1, cy + axis.y * 0.1 - th * 0.1);
  ctx.stroke();
  ctx.fillStyle = 'rgba(40,48,58,.65)';
  ctx.beginPath();ctx.arc(cx - axis.x * 0.1, cy - axis.y * 0.1, Math.max(1, tw * 0.035), 0, Math.PI * 2);ctx.fill();
  ctx.beginPath();ctx.arc(cx + axis.x * 0.1, cy + axis.y * 0.1, Math.max(1, tw * 0.035), 0, Math.PI * 2);ctx.fill();
  ctx.fillStyle = life.colour;
  ctx.beginPath();ctx.arc(cx, cy - axis.y * 0.05 - th * 0.22, Math.max(1, tw * 0.042), 0, Math.PI * 2);ctx.fill();
  return;
 }
 // A pedestrian is a head over a body at the edge of the road: the smallest thing that still reads as a person at
 // the zooms where the streets are drawn at all.
 const px = x + axis.x * travel + side.x * life.lane * 0.1;
 const py = y + axis.y * travel + side.y * life.lane * 0.1 - th * 0.18;
 const height = Math.max(2, th * 0.42);
 ctx.strokeStyle = life.colour;
 ctx.lineWidth = Math.max(1, tw * 0.05);
 ctx.beginPath();
 ctx.moveTo(px, py);
 ctx.lineTo(px, py - height);
 ctx.stroke();
 ctx.fillStyle = life.colour;
 ctx.beginPath();
 ctx.arc(px, py - height, Math.max(1, tw * 0.045), 0, Math.PI * 2);
 ctx.fill();
}
