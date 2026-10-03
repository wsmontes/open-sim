import {GLOBE_ZOOM,dragGlobe,globeCoord,geographicFocus,planetRadius} from '../../presentation/geographic-map';
import {toCell} from '../../core/coordinates';
import type {CellCoord} from '../../core/model';
import type {Camera,Point} from '../../presentation/camera';
import {clampZoom,nextZoomStep,normalizeAngle,pick,rotateTo,zoomTo,ROTATE_STEP} from '../../presentation/camera';
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
 geographic?:boolean;
 camera:()=>Camera;
 tool:()=>SelectedTool;
 // How a drag turns into cells. A street, a plant and a demolition are lines; a zone is a rectangle, which is what the
 // genre taught every player to expect. Drawing a box freehand cell by cell is the kind of chore that reads as work.
 strokeShape?:()=>StrokeShape;
 // Device pixels per CSS pixel of the drawing buffer: the zoom ladder is measured in it, so a notch lands on a crisp step.
 zoomScale?:()=>number;
};
// A touchpad pinch reports small deltas; this turns them into the same zoom the fingers made. A mouse notch is at
// least this many pixels in one axis, which a two-finger swipe almost never is in a single event.
const PINCH_RATE=.01,NOTCH_MIN=50,NOTCH_SIZE=100,MAX_NOTCHES=200;
// Keyboard panning moves the camera in screen pixels: it is a camera, so "up" is up on screen however the view is
// turned. Shift walks four times as far, which is what makes a long trip bearable at a close zoom.
const PAN_STEP=48,PAN_FAST=4;
// The tool each number key selects, matching the order of the tools panel.
const TOOL_KEYS:Record<string,SelectedTool>={'1':'explore','2':'road','3':'avenue','4':'highway','5':'residential','6':'commercial','7':'industrial','8':'park','9':'power','0':'demolish'};
const PAN_KEYS:Record<string,{x:number;y:number}>={ArrowLeft:{x:-1,y:0},ArrowRight:{x:1,y:0},ArrowUp:{x:0,y:-1},ArrowDown:{x:0,y:1},
 a:{x:-1,y:0},d:{x:1,y:0},w:{x:0,y:-1},s:{x:0,y:1},A:{x:-1,y:0},D:{x:1,y:0},W:{x:0,y:-1},S:{x:0,y:1}};
// A drag of one pixel sideways turns the view half a degree; Q/E and the ⟲ ⟳ buttons step a whole 15 degrees, which is
// ROTATE_STEP in the presentation layer, where the camera's vocabulary lives.
const ROTATE_RATE=Math.PI/360;
// Two fingers that turn together turn the city — the gesture every map has, and the only way to turn the view without a
// keyboard. Two conditions keep a pinch or a drag from being read as a turn: the hand never holds its angle exactly, so
// a turn only counts past a dead zone, and a twist keeps the fingers at the same distance from the point between them
// while a finger that slides changes it. Both are needed: dragging with two fingers moves one finger at a time, and the
// line between them swings wildly without the hand ever turning. The band is deliberately tight: a hand turning in place
// holds its span to a couple of percent per frame, while one finger of a drag slid past the other changes it by far more.
const TWIST_SLOP=Math.PI/24,TWIST_RADIUS=.1;
export {MAX_STROKE,beginStroke,boxCells,extendStroke,strokeCells} from '../../presentation/strokes';
export type {StrokeShape,StrokeState} from '../../presentation/strokes';
import {beginStroke,extendStroke} from '../../presentation/strokes';
import type {StrokeShape,StrokeState} from '../../presentation/strokes';
// The player is typing in a field: no key may reach the map (holding space in the latitude box used to arm panning).
const isTyping=(target:EventTarget|null):boolean=>target instanceof HTMLElement&&(target.isContentEditable||target.tagName==='INPUT'||target.tagName==='TEXTAREA'||target.tagName==='SELECT');
export function attachInput(canvas:HTMLCanvasElement,context:InputContext,callbacks:InputCallbacks):()=>void {
 const viewport=()=>({width:canvas.width,height:canvas.height});
 const planetary=(camera:Camera)=>context.geographic&&camera.zoom<GLOBE_ZOOM;
 const pickPoint=(point:Point,camera:Camera)=>{
  if(!planetary(camera))return pick(point,camera);
  const v=viewport(),geo=globeCoord({x:point.x-v.width/2,y:point.y-v.height/2},geographicFocus(camera,v),planetRadius(camera.zoom,v));
  return geo?toCell(geo.lat,geo.lon):null;
 };
 let stroke:StrokeState|null=null,pan:{point:Point;camera:Camera}|null=null,rotate:{point:Point;camera:Camera}|null=null,space=false;
 // Where the finger went down and whether it has wandered since. A finger that lands and lifts without moving is a
 // selection; one that travels is a drag, a stroke or a gesture, and none of those is a selection.
 let touch:{id:number;point:Point;moved:boolean}|null=null;
 // Every finger that is down, in the order it arrived: two of them are a pinch, and the first one to arrive may be a
 // drag the player is still making when the second lands.
 const fingers=new Map<number,Point>();
 let pinch:{distance:number;mid:Point;angle:number;radius:number;camera:Camera}|null=null;
 let buffer={width:canvas.width,height:canvas.height};
 const shape=()=>context.strokeShape?.()??'line';
 const midpoint=()=>{
  const points=[...fingers.values()];
  return {x:(points[0]!.x+points[1]!.x)/2,y:(points[0]!.y+points[1]!.y)/2};
 };
 const spread=()=>{
  const points=[...fingers.values()];
  return Math.hypot(points[0]!.x-points[1]!.x,points[0]!.y-points[1]!.y);
 };
 // Which way the two fingers point at each other: the pinch's own bearing, and what a twist turns.
 const bearing=()=>{
  const points=[...fingers.values()];
  return Math.atan2(points[1]!.y-points[0]!.y,points[1]!.x-points[0]!.x);
 };
 // Everything a two-finger gesture is measured by, read together so the references always agree with each other.
 const pose=()=>({distance:spread(),mid:midpoint(),angle:bearing(),radius:spread()/2});
 // Zoom about the midpoint and carry the map with it: the world point between the fingers stays between them.
 const pinchTo=(camera:Camera,mid:Point,distance:number,origin:Point,from:number)=>{
  const zoom=clampZoom(camera.zoom*(distance/Math.max(1,from))),ratio=zoom/camera.zoom;
  if(planetary(camera))return zoomTo(dragGlobe(camera,viewport(),origin,mid),viewport(),zoom);
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
  if(fingers.size>=2){
   if(touch)touch.moved=true;
   // A second finger turns whatever was happening into a pinch; the drag or stroke in course is abandoned, not left
   // half-finished behind the gesture.
   stroke=null;pan=null;rotate=null;callbacks.onPreview([]);
   pinch={...pose(),camera};
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
  if(buffer.width!==canvas.width||buffer.height!==canvas.height){
   const sx=canvas.width/Math.max(1,buffer.width),sy=canvas.height/Math.max(1,buffer.height),camera=context.camera();
   for(const [id,p] of fingers)fingers.set(id,{x:p.x*sx,y:p.y*sy});
   if(pinch)pinch={...pose(),camera};
   if(pan)pan={point:fingers.values().next().value??{x:pan.point.x*sx,y:pan.point.y*sy},camera};
   if(rotate)rotate={point:fingers.values().next().value??{x:rotate.point.x*sx,y:rotate.point.y*sy},camera};
   if(touch)touch.point={x:touch.point.x*sx,y:touch.point.y*sy};
   buffer={width:canvas.width,height:canvas.height};
  }
  const point=pointInBuffer(event);
  if(touch&&touch.id===event.pointerId&&!touch.moved&&Math.hypot(point.x-touch.point.x,point.y-touch.point.y)>TAP_SLOP)touch.moved=true;
  if(fingers.has(event.pointerId))fingers.set(event.pointerId,point);
  if(pinch&&fingers.size>=2){
   const distance=spread(),mid=midpoint(),angle=bearing(),radius=distance/2;
   // The applied camera becomes the reference for the next frame: a pinch is a sequence of small ratios, and keeping
   // the original one would throw away every step but the last.
   const turn=normalizeAngle(angle-pinch.angle);
   const twisted=Math.abs(turn)>TWIST_SLOP&&Math.abs(radius-pinch.radius)<=pinch.radius*TWIST_RADIUS;
   const spun=twisted?rotateTo(pinch.camera,{width:canvas.width,height:canvas.height},pinch.camera.rotation+turn):pinch.camera;
   const next=pinchTo(spun,mid,distance,pinch.mid,pinch.distance);
   callbacks.onCamera(next);
   pinch={distance,mid,angle:twisted?angle:pinch.angle,radius:twisted?radius:pinch.radius,camera:next};
   return;
  }
  if(rotate)return callbacks.onCamera(rotateTo(rotate.camera,{width:canvas.width,height:canvas.height},rotate.camera.rotation+(point.x-rotate.point.x)*ROTATE_RATE));
  if(pan)return callbacks.onCamera(planetary(pan.camera)?dragGlobe(pan.camera,viewport(),pan.point,point):{x:pan.camera.x+point.x-pan.point.x,y:pan.camera.y+point.y-pan.point.y,zoom:clampZoom(pan.camera.zoom),rotation:normalizeAngle(pan.camera.rotation)});
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
  if(fingers.size>=2){pinch={...pose(),camera:context.camera()};release(event);return;}
  if(fingers.size>0){
   const point=fingers.values().next().value!;
   pan={point,camera:context.camera()};rotate=null;stroke=null;
   if(touch)touch.moved=true;
   release(event);return;
  }
  pan=null;rotate=null;release(event);
  // The stroke is applied first when there is one: a tap that lays a street is a selection *and* a build, and the card
  // the player gets has to describe the cell as it ended up rather than as it was.
  if(stroke){
   const cells=stroke.cells;
   stroke=null;
   callbacks.onCommit(cells);
  }
  if(tapped&&at){const picked=pickPoint(at,context.camera());if(picked)callbacks.onTap(picked);}
 };
 const onPointerCancel=(event:PointerEvent)=>{
  fingers.clear();touch=null;pinch=null;pan=null;rotate=null;stroke=null;
  release(event);callbacks.onPreview([]);callbacks.onCancel();
 };
 const onPointerLeave=()=>callbacks.onHover(null);
 const onContextMenu=(event:Event)=>event.preventDefault();
 const onWheel=(event:WheelEvent)=>{
  event.preventDefault();
  const camera=context.camera(),point=pointInBuffer(event),rect=canvas.getBoundingClientRect();
  const scaleX=rect.width?canvas.width/rect.width:1,scaleY=rect.height?canvas.height/rect.height:1;
  // A wheel event is three different gestures. A touchpad pinch arrives with ctrlKey set (the browser's convention)
  // and is continuous; a mouse notch is a large, line-sized step; a two-finger touchpad swipe is a stream of small
  // deltas in both axes and means "move the map", exactly like dragging it.
  const unit=event.deltaMode===1?16:event.deltaMode===2?canvas.height:1,dx=event.deltaX*unit,dy=event.deltaY*unit;
  const anchored=(zoom:number)=>{if(planetary(camera))return zoomTo(camera,viewport(),zoom);const ratio=zoom/camera.zoom;return {x:point.x-(point.x-camera.x)*ratio,y:point.y-(point.y-camera.y)*ratio,zoom,rotation:normalizeAngle(camera.rotation)};};
  if(event.ctrlKey){
   callbacks.onCamera(anchored(clampZoom(camera.zoom*Math.exp(-dy*PINCH_RATE))),{snap:false});
   return;
  }
  const notch=event.deltaMode!==0||(dx===0&&Math.abs(dy)>=NOTCH_MIN&&Number.isInteger(dy));
  if(notch){
   if(dy===0)return;
   // One notch is one crisp step, whatever the step size is at this zoom: far out the ladder's steps are wider than
   // any fixed factor, and rounding a fixed factor to the nearest step would leave the camera where it was. A fast spin
   // reports several notches in one event, and each of them is a step.
   const notches=Math.min(MAX_NOTCHES,Math.max(1,Math.round(Math.abs(dy)/NOTCH_SIZE))),direction=dy<0?1:-1;
   let zoom=camera.zoom;
   for(let i=0;i<notches;i++)zoom=nextZoomStep(zoom,context.zoomScale?.()??1,direction);
   callbacks.onCamera(anchored(zoom),{snap:true});
   return;
  }
  callbacks.onCamera(planetary(camera)?dragGlobe(camera,viewport(),point,{x:point.x-dx*scaleX,y:point.y-dy*scaleY}):{x:camera.x-dx*scaleX,y:camera.y-dy*scaleY,zoom:camera.zoom,rotation:normalizeAngle(camera.rotation)});
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
   return callbacks.onCamera(planetary(camera)?dragGlobe(camera,viewport(),{x:0,y:0},{x:panDirection.x*step,y:panDirection.y*step}):{x:camera.x+panDirection.x*step,y:camera.y+panDirection.y*step,zoom:camera.zoom,rotation:normalizeAngle(camera.rotation)});
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
 window.addEventListener('pointercancel',onPointerCancel);
 window.addEventListener('keydown',onKeyDown);
 window.addEventListener('keyup',onKeyUp);
 return ()=>{
  canvas.removeEventListener('pointerdown',onPointerDown);
  canvas.removeEventListener('pointermove',onPointerMove);
  canvas.removeEventListener('pointerleave',onPointerLeave);
  canvas.removeEventListener('contextmenu',onContextMenu);
  canvas.removeEventListener('wheel',onWheel);
  window.removeEventListener('pointerup',onPointerUp);
  window.removeEventListener('pointercancel',onPointerCancel);
  window.removeEventListener('keydown',onKeyDown);
  window.removeEventListener('keyup',onKeyUp);
 };
}
