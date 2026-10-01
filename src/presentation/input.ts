import type {CellCoord} from '../core/model';
import type {Camera,Point} from './camera';
import {clampZoom,normalizeAngle,pick,rotateTo} from './camera';
import type {SelectedTool} from './hud';
export type InputCallbacks = {
 onHover(cell:CellCoord|null):void;
 onPreview(cells:readonly CellCoord[]):void;
 onCommit(cells:readonly CellCoord[]):void;
 // `snap` is for input that arrives in steps — a wheel notch, a button — where landing on a crisp zoom costs nothing.
 // A gesture keeps whatever zoom the fingers asked for: quantising mid-pinch makes the position arithmetic describe a
 // scale that was never applied, and the scene slides away from under the fingers.
 onCamera(camera:Camera,options?:{snap?:boolean}):void;
 onCancel():void;
 // A short touch on the city, told apart from a drag: what the player selected, not where they built.
 onTap(cell:CellCoord):void;
 // The number keys pick a tool, so the player can build a whole street without leaving the keyboard.
 onTool(tool:SelectedTool):void;
};
export type InputContext = {
 camera:()=>Camera;
 tool:()=>SelectedTool;
 // How a drag turns into cells. A street, a plant and a demolition are lines; a zone is a rectangle, which is what the
 // genre taught every player to expect. Drawing a box freehand cell by cell is the kind of chore that reads as work.
 strokeShape?:()=>StrokeShape;
};
export type StrokeShape='line'|'box';
export type StrokeState = {anchor:CellCoord;cells:CellCoord[];last:CellCoord};
// One command carries at most this many cells (src/core/quote.ts refuses more), so a gesture can never build a
// selection the world will not accept.
export const MAX_STROKE=1024;
const ZOOM_RATE=.002;
// Keyboard panning moves the camera in screen pixels: it is a camera, so "up" is up on screen however the view is
// turned. Shift walks four times as far, which is what makes a long trip bearable at a close zoom.
const PAN_STEP=48,PAN_FAST=4;
// The tool each number key selects, matching the order of the tools panel.
const TOOL_KEYS:Record<string,SelectedTool>={'1':'explore','2':'road','3':'avenue','4':'highway','5':'residential','6':'commercial','7':'industrial','8':'park','9':'power','0':'demolish'};
const PAN_KEYS:Record<string,{x:number;y:number}>={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1},
 a:{x:-1,y:0},d:{x:1,y:0},w:{x:0,y:-1},s:{x:0,y:1},A:{x:-1,y:0},D:{x:1,y:0},W:{x:0,y:-1},S:{x:0,y:1}};
// A drag of one pixel sideways turns the view half a degree; Q/E step a whole 15 degrees per press.
const ROTATE_RATE=Math.PI/360,ROTATE_STEP=Math.PI/12;
export function strokeCells(from:CellCoord,to:CellCoord):CellCoord[] {
 let x=from.x,y=from.y;
 const dx=Math.abs(to.x-x),dy=-Math.abs(to.y-y),sx=x<to.x?1:-1,sy=y<to.y?1:-1;
 let err=dx+dy;
 const cells=[{x,y}];
 while((x!==to.x||y!==to.y)&&cells.length<MAX_STROKE){
  const e2=2*err;
  if(e2>=dy){err+=dy;x+=sx;}
  if(e2<=dx){err+=dx;y+=sy;}
  cells.push({x,y});
 }
 return cells;
}
// The rectangle between the anchor and the far corner, clamped to what one command can carry. The clamp pulls the far
// corner in instead of cutting cells off the edge: what the player sees is still a rectangle, just a smaller one.
export function boxCells(anchor:CellCoord,corner:CellCoord,limit=MAX_STROKE):CellCoord[] {
 let width=Math.abs(corner.x-anchor.x)+1,height=Math.abs(corner.y-anchor.y)+1;
 if(width*height>limit){
  const room=Math.max(1,Math.floor(limit/Math.max(1,Math.min(width,height))));
  if(width>=height)width=Math.min(width,Math.max(1,room));else height=Math.min(height,Math.max(1,room));
  // A square limit can still round up by one cell; trim the larger side until it fits.
  while(width*height>limit){if(width>=height)width-=1;else height-=1;}
 }
 const stepX=corner.x>=anchor.x?1:-1,stepY=corner.y>=anchor.y?1:-1,cells:CellCoord[]=[];
 for(let row=0;row<height;row++)for(let column=0;column<width;column++)cells.push({x:anchor.x+column*stepX,y:anchor.y+row*stepY});
 return cells;
}
export const beginStroke=(cell:CellCoord,shape:StrokeShape='line'):StrokeState=>({anchor:{x:cell.x,y:cell.y},cells:[{x:cell.x,y:cell.y}],last:{x:cell.x,y:cell.y}});
// Appends the freshly crossed cells of the segment, never revisiting a cell already in the stroke. A box is redrawn
// from its anchor every time instead: a drag that comes back leaves one cell, not a trail of everything it touched.
export function extendStroke(stroke:StrokeState,cell:CellCoord,shape:StrokeShape='line'):StrokeState {
 if(shape==='box'){
  if(cell.x===stroke.last.x&&cell.y===stroke.last.y)return stroke;
  return {...stroke,cells:boxCells(stroke.anchor,cell),last:{x:cell.x,y:cell.y}};
 }
 if(cell.x===stroke.last.x&&cell.y===stroke.last.y)return stroke;
 const cells=stroke.cells.slice();
 for(const p of strokeCells(stroke.last,cell)){
  if(cells.length>=MAX_STROKE)break;
  if(!cells.some(c=>c.x===p.x&&c.y===p.y))cells.push(p);
 }
 return {cells,last:{x:cell.x,y:cell.y},anchor:stroke.anchor};
}
// The player is typing in a field: no key may reach the map (holding space in the latitude box used to arm panning).
const isTyping=(target:EventTarget|null):boolean=>target instanceof HTMLElement&&(target.isContentEditable||target.tagName==='INPUT'||target.tagName==='TEXTAREA'||target.tagName==='SELECT');
export function attachInput(canvas:HTMLCanvasElement,context:InputContext,callbacks:InputCallbacks):()=>void {
 let stroke:StrokeState|null=null,pan:{point:Point;camera:Camera}|null=null,rotate:{point:Point;camera:Camera}|null=null,space=false;
 // Where the finger went down and whether it has wandered since. A finger that lands and lifts without moving is a
 // selection; one that travels is a drag, a stroke or a gesture, and none of those is a selection.
 let touch:{id:number;point:Point;moved:boolean}|null=null;
 // Every finger that is down, in the order it arrived: two of them are a pinch, and the first one to arrive may be a
 // drag the player is still making when the second lands.
 const fingers=new Map<number,Point>();
 let pinch:{distance:number;mid:Point;camera:Camera}|null=null;
 const shape=()=>context.strokeShape?.()??'line';
 const midpoint=()=>{
  const points=[...fingers.values()];
  return {x:(points[0]!.x+points[1]!.x)/2,y:(points[0]!.y+points[1]!.y)/2};
 };
 const spread=()=>{
  const points=[...fingers.values()];
  return Math.hypot(points[0]!.x-points[1]!.x,points[0]!.y-points[1]!.y);
 };
 // Zoom about the midpoint and carry the map with it: the world point between the fingers stays between them.
 const pinchTo=(camera:Camera,mid:Point,distance:number,origin:Point,from:number)=>{
  const zoom=clampZoom(camera.zoom*(distance/Math.max(1,from))),ratio=zoom/camera.zoom;
  return {x:mid.x-(origin.x-camera.x)*ratio,y:mid.y-(origin.y-camera.y)*ratio,zoom,rotation:normalizeAngle(camera.rotation)};
 };
 const pointInBuffer=(event:{clientX:number;clientY:number}):Point=>{
  const rect=canvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)*(rect.width?canvas.width/rect.width:1),y:(event.clientY-rect.top)*(rect.height?canvas.height/rect.height:1)};
 };
 const capture=(event:PointerEvent)=>{
  if(typeof canvas.setPointerCapture!=='function')return;
  try{canvas.setPointerCapture(event.pointerId);}catch{/* A stale pointer id cannot be captured; the window listener still closes the batch. */}
 };
 const release=(event:PointerEvent)=>{
  if(typeof canvas.releasePointerCapture!=='function')return;
  try{canvas.releasePointerCapture(event.pointerId);}catch{/* Releasing a pointer the canvas never captured is a no-op the spec allows to throw. */}
 };
 const TAP_SLOP=6;
 const onPointerDown=(event:PointerEvent)=>{
  const camera=context.camera(),point=pointInBuffer(event);
  fingers.set(event.pointerId,point);
  if(fingers.size===1)touch={id:event.pointerId,point,moved:false};
  if(fingers.size===2){
   // A second finger turns whatever was happening into a pinch; the drag or stroke in course is abandoned, not left
   // half-finished behind the gesture.
   stroke=null;pan=null;rotate=null;callbacks.onPreview([]);
   pinch={distance:spread(),mid:midpoint(),camera};
   capture(event);
   return;
  }
  if(event.button===1||event.button===2){event.preventDefault();capture(event);pan={point,camera};return;}
  if(event.button!==0)return;
  if(event.ctrlKey||event.metaKey){capture(event);rotate={point,camera};return;}
  if(space||context.tool()==='explore'){capture(event);pan={point,camera};return;}
  capture(event);
  stroke=beginStroke(pick(point,camera),shape());
  callbacks.onPreview(stroke.cells);
 };
 const onPointerMove=(event:PointerEvent)=>{
  const point=pointInBuffer(event);
  if(touch&&touch.id===event.pointerId&&!touch.moved&&Math.hypot(point.x-touch.point.x,point.y-touch.point.y)>TAP_SLOP)touch.moved=true;
  if(fingers.has(event.pointerId))fingers.set(event.pointerId,point);
  if(pinch&&fingers.size>=2){
   const distance=spread(),mid=midpoint();
   // The applied camera becomes the reference for the next frame: a pinch is a sequence of small ratios, and keeping
   // the original one would throw away every step but the last.
   const next=pinchTo(pinch.camera,mid,distance,pinch.mid,pinch.distance);
   callbacks.onCamera(next);
   pinch={distance,mid,camera:next};
   return;
  }
  if(rotate)return callbacks.onCamera(rotateTo(rotate.camera,{width:canvas.width,height:canvas.height},rotate.camera.rotation+(point.x-rotate.point.x)*ROTATE_RATE));
  if(pan)return callbacks.onCamera({x:pan.camera.x+point.x-pan.point.x,y:pan.camera.y+point.y-pan.point.y,zoom:clampZoom(pan.camera.zoom),rotation:normalizeAngle(pan.camera.rotation)});
  const cell=pick(point,context.camera());
  callbacks.onHover(cell);
  if(!stroke)return;
  stroke=extendStroke(stroke,cell,shape());
  callbacks.onPreview(stroke.cells);
 };
 const onPointerUp=(event:PointerEvent)=>{
  const tapped=touch&&touch.id===event.pointerId&&!touch.moved;
  const at=tapped?pointInBuffer(event):null;
  fingers.delete(event.pointerId);
  if(touch&&touch.id===event.pointerId)touch=null;
  if(fingers.size<2)pinch=null;
  if(fingers.size>0){release(event);return;}
  pan=null;rotate=null;release(event);
  // The stroke is applied first when there is one: a tap that lays a street is a selection *and* a build, and the card
  // the player gets has to describe the cell as it ended up rather than as it was.
  if(stroke){
   const cells=stroke.cells;
   stroke=null;
   callbacks.onCommit(cells);
  }
  if(tapped&&at)callbacks.onTap(pick(at,context.camera()));
 };
 const onPointerLeave=()=>callbacks.onHover(null);
 const onContextMenu=(event:Event)=>event.preventDefault();
 const onWheel=(event:WheelEvent)=>{
  event.preventDefault();
  const camera=context.camera(),point=pointInBuffer(event);
  const zoom=clampZoom(camera.zoom*Math.exp(-event.deltaY*ZOOM_RATE)),ratio=zoom/camera.zoom;
  callbacks.onCamera({x:point.x-(point.x-camera.x)*ratio,y:point.y-(point.y-camera.y)*ratio,zoom,rotation:normalizeAngle(camera.rotation)},{snap:true});
 };
 const onKeyDown=(event:KeyboardEvent)=>{
  if(isTyping(event.target))return;
  if(event.key===' '){space=true;return;}
  if(event.key==='q'||event.key==='Q'||event.key==='e'||event.key==='E'){
   const camera=context.camera(),step=event.key==='q'||event.key==='Q'?-ROTATE_STEP:ROTATE_STEP;
   return callbacks.onCamera(rotateTo(camera,{width:canvas.width,height:canvas.height},camera.rotation+step));
  }
  // One key per tool, in the order the panel shows them: the fastest way through a build session is never moving the
  // hand off the keyboard, and it is the shortcut players of this genre reach for first.
  const chosen=TOOL_KEYS[event.key];
  if(chosen){
   event.preventDefault();
   return callbacks.onTool(chosen);
  }
  const panDirection=PAN_KEYS[event.key];
  if(panDirection){
   const camera=context.camera(),step=PAN_STEP*(event.shiftKey?PAN_FAST:1);
   event.preventDefault();
   return callbacks.onCamera({x:camera.x+panDirection.x*step,y:camera.y+panDirection.y*step,zoom:camera.zoom,rotation:normalizeAngle(camera.rotation)});
  }
  if(event.key!=='Escape')return;
  if(stroke){stroke=null;callbacks.onPreview([]);}
  callbacks.onCancel();
 };
 const onKeyUp=(event:KeyboardEvent)=>{if(event.key===' ')space=false;};
 canvas.addEventListener('pointerdown',onPointerDown);
 canvas.addEventListener('pointermove',onPointerMove);
 canvas.addEventListener('pointerleave',onPointerLeave);
 canvas.addEventListener('contextmenu',onContextMenu);
 canvas.addEventListener('wheel',onWheel,{passive:false});
 window.addEventListener('pointerup',onPointerUp);
 window.addEventListener('pointercancel',onPointerUp);
 window.addEventListener('keydown',onKeyDown);
 window.addEventListener('keyup',onKeyUp);
 return ()=>{
  canvas.removeEventListener('pointerdown',onPointerDown);
  canvas.removeEventListener('pointermove',onPointerMove);
  canvas.removeEventListener('pointerleave',onPointerLeave);
  canvas.removeEventListener('contextmenu',onContextMenu);
  canvas.removeEventListener('wheel',onWheel);
  window.removeEventListener('pointerup',onPointerUp);
  window.removeEventListener('pointercancel',onPointerUp);
  window.removeEventListener('keydown',onKeyDown);
  window.removeEventListener('keyup',onKeyUp);
 };
}
