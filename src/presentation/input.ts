import type {CellCoord} from '../core/model';
import type {Camera,Point} from './camera';
import {clampZoom,pick} from './camera';
export type InputCallbacks = {
 onHover(cell:CellCoord|null):void;
 onPreview(cells:readonly CellCoord[]):void;
 onCommit(cells:readonly CellCoord[]):void;
 onCamera(camera:Camera):void;
 onCancel():void;
};
export type StrokeState = {cells:CellCoord[];last:CellCoord};
export const MAX_STROKE=1024;
const ZOOM_RATE=.002;
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
export const beginStroke=(cell:CellCoord):StrokeState=>({cells:[{x:cell.x,y:cell.y}],last:{x:cell.x,y:cell.y}});
// Appends the freshly crossed cells of the segment, never revisiting a cell already in the stroke.
export function extendStroke(stroke:StrokeState,cell:CellCoord):StrokeState {
 if(cell.x===stroke.last.x&&cell.y===stroke.last.y)return stroke;
 const cells=stroke.cells.slice();
 for(const p of strokeCells(stroke.last,cell)){
  if(cells.length>=MAX_STROKE)break;
  if(!cells.some(c=>c.x===p.x&&c.y===p.y))cells.push(p);
 }
 return {cells,last:{x:cell.x,y:cell.y}};
}
export function attachInput(canvas:HTMLCanvasElement,getCamera:()=>Camera,callbacks:InputCallbacks):()=>void {
 let stroke:StrokeState|null=null,pan:{point:Point;camera:Camera}|null=null,space=false;
 const pointInBuffer=(event:{clientX:number;clientY:number}):Point=>{
  const rect=canvas.getBoundingClientRect();
  return {x:(event.clientX-rect.left)*(rect.width?canvas.width/rect.width:1),y:(event.clientY-rect.top)*(rect.height?canvas.height/rect.height:1)};
 };
 const capture=(event:PointerEvent)=>{
  if(typeof canvas.setPointerCapture!=='function')return;
  try{canvas.setPointerCapture(event.pointerId);}catch{/* A stale pointer id cannot be captured; the window listener still closes the batch. */}
 };
 const onPointerDown=(event:PointerEvent)=>{
  const point=pointInBuffer(event);
  if(event.button===1||space){capture(event);pan={point,camera:getCamera()};return;}
  if(event.button!==0)return;
  capture(event);
  stroke=beginStroke(pick(point,getCamera()));
  callbacks.onPreview(stroke.cells);
 };
 const onPointerMove=(event:PointerEvent)=>{
  const point=pointInBuffer(event);
  if(pan)return callbacks.onCamera({x:pan.camera.x+point.x-pan.point.x,y:pan.camera.y+point.y-pan.point.y,zoom:clampZoom(pan.camera.zoom)});
  const cell=pick(point,getCamera());
  callbacks.onHover(cell);
  if(!stroke)return;
  stroke=extendStroke(stroke,cell);
  callbacks.onPreview(stroke.cells);
 };
 const onPointerUp=()=>{
  pan=null;
  if(!stroke)return;
  const cells=stroke.cells;
  stroke=null;
  callbacks.onCommit(cells);
 };
 const onPointerLeave=()=>callbacks.onHover(null);
 const onWheel=(event:WheelEvent)=>{
  event.preventDefault();
  const camera=getCamera(),point=pointInBuffer(event);
  const zoom=clampZoom(camera.zoom*Math.exp(-event.deltaY*ZOOM_RATE)),ratio=zoom/camera.zoom;
  callbacks.onCamera({x:point.x-(point.x-camera.x)*ratio,y:point.y-(point.y-camera.y)*ratio,zoom});
 };
 const onKeyDown=(event:KeyboardEvent)=>{
  if(event.key===' '){space=true;return;}
  if(event.key!=='Escape')return;
  if(stroke){stroke=null;callbacks.onPreview([]);}
  callbacks.onCancel();
 };
 const onKeyUp=(event:KeyboardEvent)=>{if(event.key===' ')space=false;};
 canvas.addEventListener('pointerdown',onPointerDown);
 canvas.addEventListener('pointermove',onPointerMove);
 canvas.addEventListener('pointerleave',onPointerLeave);
 canvas.addEventListener('wheel',onWheel,{passive:false});
 window.addEventListener('pointerup',onPointerUp);
 window.addEventListener('pointercancel',onPointerUp);
 window.addEventListener('keydown',onKeyDown);
 window.addEventListener('keyup',onKeyUp);
 return ()=>{
  canvas.removeEventListener('pointerdown',onPointerDown);
  canvas.removeEventListener('pointermove',onPointerMove);
  canvas.removeEventListener('pointerleave',onPointerLeave);
  canvas.removeEventListener('wheel',onWheel);
  window.removeEventListener('pointerup',onPointerUp);
  window.removeEventListener('pointercancel',onPointerUp);
  window.removeEventListener('keydown',onKeyDown);
  window.removeEventListener('keyup',onKeyUp);
 };
}
