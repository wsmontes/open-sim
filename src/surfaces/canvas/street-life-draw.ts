// Drawing the street life the logic decided (spec 2026-10-01 §6): the canvas half of presentation/street-life.ts. The
// logic (lifeAt and its traffic tables) stays portable there; only the pencil — the cars, cyclists and walkers on a
// 2D context — lives here, because a CanvasRenderingContext2D is a DOM type.
import type {StreetLife} from '../../presentation/street-life';

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
