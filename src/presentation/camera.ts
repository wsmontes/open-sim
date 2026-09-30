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
