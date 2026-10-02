import type {CellCoord} from '../core/model';
import {CHUNK,WORLD,chunkId,chunkOrigin} from '../core/coordinates';
import {VIEW_ZOOM_MAX,VIEW_ZOOM_MIN} from '../core/model';
export type Point = {x:number;y:number};
export type Camera = {x:number;y:number;zoom:number;rotation:number};
export type Viewport = {width:number;height:number};
export const TILE_W=32,TILE_H=16,MIN_ZOOM=VIEW_ZOOM_MIN,MAX_ZOOM=VIEW_ZOOM_MAX;
// Below this step (buffer pixels per cell) one diamond per cell stops being legible or cheap, and the renderer
// switches to a mosaic of blocks per region. 0.05 still lets the whole city and its surroundings fit on screen.
export const COARSE_STEP=6;
export const clampZoom=(z:number)=>Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,z));
// The zoom steps the game actually uses: those where a tile is a whole, even number of device pixels. In between, a
// one pixel line is drawn as runs of one and two pixels, a checkerboard of single pixels turns into one flat tone below
// half a pixel per cell, and a stroke that lands on a half pixel is spread over two rows at half alpha. Measuring the
// ladder rather than the real numbers is what keeps the art crisp at every zoom the player can reach.
export function zoomLadder(scale:number):readonly number[] {
 const perTile=TILE_W*scale;
 // The two ends of the zoom range are steps of the ladder whatever they measure: the whole-city view has to stay
 // reachable, and at a tile of one or two pixels there is no crispness left to protect.
 const steps:number[]=[MIN_ZOOM];
 for(let pixels=Math.max(2,Math.ceil(TILE_W*MIN_ZOOM*scale/2)*2);pixels<=TILE_W*MAX_ZOOM*scale;pixels+=2){
  const step=pixels/perTile;
  if(step>MIN_ZOOM&&step<MAX_ZOOM)steps.push(step);
 }
 steps.push(MAX_ZOOM);
 return steps;
}
// The zoom a camera change lands on. Input that arrives in steps — a wheel notch, a button — is rounded to the ladder,
// because landing on a crisp zoom costs the player nothing. A gesture keeps exactly what the fingers asked for:
// rounding it mid-pinch makes the camera arithmetic describe a scale that was never applied, so the city slides away
// from under the fingers by the difference between the two, every frame, in whichever direction the rounding fell.
export function settleZoom(zoom:number,scale:number,snap:boolean):number {
 return snap?snapZoom(zoom,scale):clampZoom(zoom);
}
// The nearest step to what the player asked for: the wheel, the buttons and every camera move land on the ladder, so
// the city is always drawn crisp — including at the end of a glide.
export function snapZoom(zoom:number,scale:number):number {
 const steps=zoomLadder(scale);
 const wanted=clampZoom(zoom);
 let best=steps[0]!;
 for(const step of steps)if(Math.abs(step-wanted)<Math.abs(best-wanted))best=step;
 return best;
}
export const cellStep=(camera:Camera)=>TILE_W*camera.zoom;
export const isCoarse=(camera:Camera)=>cellStep(camera)<COARSE_STEP;
// The bearing is carried in screen space: the isometric axes turn around the anchor by camera.rotation, 0 keeping
// north up. Projection and its inverse are the only two places allowed to know the sign convention, so they live
// side by side; rotation 0 takes the exact same arithmetic as an unturned camera.
const spin=(camera:Camera,u:number,v:number):Point=>{
 if(camera.rotation===0)return {x:u,y:v};
 const c=Math.cos(camera.rotation),s=Math.sin(camera.rotation);
 return {x:c*u-s*v,y:s*u+c*v};
};
const unspin=(camera:Camera,dx:number,dy:number):Point=>{
 if(camera.rotation===0)return {x:dx,y:dy};
 const c=Math.cos(camera.rotation),s=Math.sin(camera.rotation);
 return {x:c*dx+s*dy,y:c*dy-s*dx};
};
// How fast a camera move closes the distance to where it is going, per second. High enough to feel immediate, low
// enough that the eye can follow the city sliding into place.
export const GLIDE_PER_SECOND = 9;
// One step of a camera move. The approach is exponential, so the move is quick at first and gentle at the end, and it
// never overshoots: `fraction` is how much of the remaining distance to close this frame. Rotation takes the short way
// round, so turning from just east of north to just west of it is a couple of degrees and not most of a circle.
export function approach(from:Camera,to:Camera,fraction:number):Camera {
 const k=Math.max(0,Math.min(1,fraction));
 const turn=normalizeAngle(to.rotation-from.rotation);
 return {
  x:from.x+(to.x-from.x)*k,
  y:from.y+(to.y-from.y)*k,
  zoom:from.zoom+(to.zoom-from.zoom)*k,
  rotation:normalizeAngle(from.rotation+turn*k),
 };
}
// A move is finished when the camera is close enough that another frame would not be seen: the thresholds are in
// screen pixels, a fraction of zoom, and radians.
export function arrived(from:Camera,to:Camera):boolean {
 return Math.abs(to.x-from.x)<.5&&Math.abs(to.y-from.y)<.5
  &&Math.abs(to.zoom-from.zoom)<Math.max(.0005,to.zoom*.002)
  &&Math.abs(normalizeAngle(to.rotation-from.rotation))<.002;
}
// A turned view is the same view, so angles are folded back into (-PI, PI] instead of growing without bound.
export function normalizeAngle(radians:number):number {
 const wrapped=((radians+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
 return wrapped===-Math.PI?Math.PI:wrapped;
}
export const project=(cell:CellCoord,camera:Camera):Point=>{
 const p=spin(camera,(cell.x-cell.y)*TILE_W*camera.zoom,(cell.x+cell.y)*TILE_H*camera.zoom);
 return {x:camera.x+p.x,y:camera.y+p.y};
};
// Continuous grid space: the diamond of a cell is the square max(|cx-x|,|cy-y|) <= .5, so its screen half-axes are TILE_W*zoom by TILE_H*zoom. The bearing is undone first, which is what turns a pointer into a world point.
export function cellSpace(point:Point,camera:Camera):Point {
 const tw=TILE_W*camera.zoom,th=TILE_H*camera.zoom,d=unspin(camera,point.x-camera.x,point.y-camera.y);
 return {x:(d.x/tw+d.y/th)/2,y:(d.y/th-d.x/tw)/2};
}
export const pick=(point:Point,camera:Camera):CellCoord=>{const c=cellSpace(point,camera);return {x:Math.round(c.x)||0,y:Math.round(c.y)||0};};
// Anchor that lands the continuous cell (cx,cy) exactly on the viewport centre, since project() is anchor + R*(u,v).
function anchorAt(camera:Camera,zoom:number,cx:number,cy:number,viewport:Viewport):Point {
 const p=spin(camera,(cx-cy)*TILE_W*zoom,(cx+cy)*TILE_H*zoom);
 return {x:viewport.width/2-p.x,y:viewport.height/2-p.y};
}
export function centerOn(cell:CellCoord,camera:Camera,viewport:Viewport):Camera {
 const p=anchorAt(camera,camera.zoom,cell.x,cell.y,viewport);
 return {x:p.x,y:p.y,zoom:camera.zoom,rotation:camera.rotation};
}
export function visibleChunks(camera:Camera,viewport:Viewport):string[] {
 const corners=[[0,0],[viewport.width,0],[0,viewport.height],[viewport.width,viewport.height]];
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
 for(const [px,py] of corners){const c=cellSpace({x:px,y:py},camera);minX=Math.min(minX,c.x);maxX=Math.max(maxX,c.x);minY=Math.min(minY,c.y);maxY=Math.max(maxY,c.y);}
 // Region-level pass: the whole visible set lives inside this cell-space box, so testing each region's own bounding
 // diamond is enough and stays cheap when a single screen holds hundreds of regions (wide zoom).
 const firstX=Math.floor((minX-1)/CHUNK),lastX=Math.floor((maxX+1)/CHUNK);
 const firstY=Math.max(0,Math.floor((minY-1)/CHUNK)),lastY=Math.min(WORLD/CHUNK-1,Math.floor((maxY+1)/CHUNK));
 const ids=new Set<string>();
 for(let cy=firstY;cy<=lastY;cy++)for(let cx=firstX;cx<=lastX;cx++){
  const x=cx*CHUNK,y=cy*CHUNK;
  let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
  // Half a cell of slack on each side: a region whose centre just left the viewport still paints part of its
  // diamond on screen, and the renderer draws it, so the loader has to request it.
  for(const [dx,dy] of [[-.5,-.5],[CHUNK-.5,-.5],[-.5,CHUNK-.5],[CHUNK-.5,CHUNK-.5]]){
   const p=project({x:x+dx,y:y+dy},camera);
   left=Math.min(left,p.x);right=Math.max(right,p.x);top=Math.min(top,p.y);bottom=Math.max(bottom,p.y);
  }
  if(right<0||left>viewport.width||bottom<0||top>viewport.height)continue;
  ids.add(chunkId({x,y}));
 }
 return [...ids].sort();
}
// The same world point stays under the viewport centre while the zoom changes, and while the bearing turns: widening
// or spinning the view orbits what the player is looking at instead of drifting away from it.
export function zoomTo(camera:Camera,viewport:Viewport,zoom:number):Camera {
 const wanted=clampZoom(zoom),centre=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);
 const p=anchorAt(camera,wanted,centre.x,centre.y,viewport);
 return {x:p.x,y:p.y,zoom:wanted,rotation:camera.rotation};
}
export function rotateTo(camera:Camera,viewport:Viewport,rotation:number):Camera {
 const turned={...camera,rotation:normalizeAngle(rotation)};
 const centre=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);
 const p=anchorAt(turned,camera.zoom,centre.x,centre.y,viewport);
 return {x:p.x,y:p.y,zoom:camera.zoom,rotation:turned.rotation};
}
// Loading is rationed from the viewport centre outwards: a wide view can hold hundreds of regions and only this
// budget is fetched per pass, so panning at 0.05x never becomes a mass download of the tile service.
export function closestChunks(ids:readonly string[],camera:Camera,viewport:Viewport,limit:number):string[] {
 const centre=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);
 const distance=(id:string)=>{const origin=chunkOrigin(id);return Math.max(Math.abs(origin.x+CHUNK/2-centre.x),Math.abs(origin.y+CHUNK/2-centre.y));};
 return [...ids].sort((a,b)=>distance(a)-distance(b)||a.localeCompare(b)).slice(0,Math.max(0,limit));
}
