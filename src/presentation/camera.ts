import type {CellCoord} from '../core/model';
import {CHUNK,WORLD,chunkId,chunkOrigin} from '../core/coordinates';
export type Point = {x:number;y:number};
export type Camera = {x:number;y:number;zoom:number};
export type Viewport = {width:number;height:number};
export const TILE_W=32,TILE_H=16,MIN_ZOOM=.05,MAX_ZOOM=3;
// Below this step (buffer pixels per cell) one diamond per cell stops being legible or cheap, and the renderer
// switches to a mosaic of blocks per region. 0.05 still lets the whole city and its surroundings fit on screen.
export const COARSE_STEP=6;
export const clampZoom=(z:number)=>Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,z));
export const cellStep=(camera:Camera)=>TILE_W*camera.zoom;
export const isCoarse=(camera:Camera)=>cellStep(camera)<COARSE_STEP;
export const project=(cell:CellCoord,camera:Camera):Point=>({x:camera.x+(cell.x-cell.y)*TILE_W*camera.zoom,y:camera.y+(cell.x+cell.y)*TILE_H*camera.zoom});
// Continuous grid space: the diamond of a cell is the square max(|cx-x|,|cy-y|) <= .5, so its screen half-axes are TILE_W*zoom by TILE_H*zoom.
export function cellSpace(point:Point,camera:Camera):Point {
 const tw=TILE_W*camera.zoom,th=TILE_H*camera.zoom,dx=point.x-camera.x,dy=point.y-camera.y;
 return {x:(dx/tw+dy/th)/2,y:(dy/th-dx/tw)/2};
}
export const pick=(point:Point,camera:Camera):CellCoord=>{const c=cellSpace(point,camera);return {x:Math.round(c.x)||0,y:Math.round(c.y)||0};};
export const centerOn=(cell:CellCoord,camera:Camera,viewport:Viewport):Camera=>({x:viewport.width/2-(cell.x-cell.y)*TILE_W*camera.zoom,y:viewport.height/2-(cell.x+cell.y)*TILE_H*camera.zoom,zoom:camera.zoom});
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
  for(const [dx,dy] of [[0,0],[CHUNK-1,0],[0,CHUNK-1],[CHUNK-1,CHUNK-1]]){
   const p=project({x:x+dx,y:y+dy},camera);
   left=Math.min(left,p.x);right=Math.max(right,p.x);top=Math.min(top,p.y);bottom=Math.max(bottom,p.y);
  }
  if(right<0||left>viewport.width||bottom<0||top>viewport.height)continue;
  ids.add(chunkId({x,y}));
 }
 return [...ids].sort();
}
// The same world point stays under the viewport centre while the zoom changes.
export function zoomTo(camera:Camera,viewport:Viewport,zoom:number):Camera {
 const wanted=clampZoom(zoom),centre=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);
 return {x:viewport.width/2-(centre.x-centre.y)*TILE_W*wanted,y:viewport.height/2-(centre.x+centre.y)*TILE_H*wanted,zoom:wanted};
}
// Loading is rationed from the viewport centre outwards: a wide view can hold hundreds of regions and only this
// budget is fetched per pass, so panning at 0.05x never becomes a mass download of the tile service.
export function closestChunks(ids:readonly string[],camera:Camera,viewport:Viewport,limit:number):string[] {
 const centre=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);
 const distance=(id:string)=>{const origin=chunkOrigin(id);return Math.max(Math.abs(origin.x+CHUNK/2-centre.x),Math.abs(origin.y+CHUNK/2-centre.y));};
 return [...ids].sort((a,b)=>distance(a)-distance(b)||a.localeCompare(b)).slice(0,Math.max(0,limit));
}
