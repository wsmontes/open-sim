import type {CellCoord} from '../core/model';
import {WORLD,chunkId} from '../core/coordinates';
export type Point = {x:number;y:number};
export type Camera = {x:number;y:number;zoom:number};
export type Viewport = {width:number;height:number};
export const TILE_W=32,TILE_H=16,MIN_ZOOM=.5,MAX_ZOOM=3;
export const clampZoom=(z:number)=>Math.max(MIN_ZOOM,Math.min(MAX_ZOOM,z));
export const project=(cell:CellCoord,camera:Camera):Point=>({x:camera.x+(cell.x-cell.y)*TILE_W*camera.zoom,y:camera.y+(cell.x+cell.y)*TILE_H*camera.zoom});
// Continuous grid space: the diamond of a cell is the square max(|cx-x|,|cy-y|) <= .5, so its screen half-axes are TILE_W*zoom by TILE_H*zoom.
export function cellSpace(point:Point,camera:Camera):Point {
 const tw=TILE_W*camera.zoom,th=TILE_H*camera.zoom,dx=point.x-camera.x,dy=point.y-camera.y;
 return {x:(dx/tw+dy/th)/2,y:(dy/th-dx/tw)/2};
}
export const pick=(point:Point,camera:Camera):CellCoord=>{const c=cellSpace(point,camera);return {x:Math.round(c.x)||0,y:Math.round(c.y)||0};};
export const centerOn=(cell:CellCoord,camera:Camera,viewport:Viewport):Camera=>({x:viewport.width/2-(cell.x-cell.y)*TILE_W*camera.zoom,y:viewport.height/2-(cell.x+cell.y)*TILE_H*camera.zoom,zoom:camera.zoom});
export function visibleChunks(camera:Camera,viewport:Viewport):string[] {
 const tw=TILE_W*camera.zoom,th=TILE_H*camera.zoom,corners=[[0,0],[viewport.width,0],[0,viewport.height],[viewport.width,viewport.height]];
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
 for(const [px,py] of corners){const c=cellSpace({x:px,y:py},camera);minX=Math.min(minX,c.x);maxX=Math.max(maxX,c.x);minY=Math.min(minY,c.y);maxY=Math.max(maxY,c.y);}
 const ids=new Set<string>();
 for(let y=Math.floor(minY)-2;y<=Math.ceil(maxY)+2;y++){
  if(y<0||y>=WORLD)continue;
  for(let x=Math.floor(minX)-2;x<=Math.ceil(maxX)+2;x++){
   const p=project({x,y},camera);
   if(p.x+tw<0||p.x-tw>viewport.width||p.y+th<0||p.y-th>viewport.height)continue;
   ids.add(chunkId({x,y}));
  }
 }
 return [...ids].sort();
}
