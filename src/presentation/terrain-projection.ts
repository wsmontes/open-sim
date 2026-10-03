import type {TerrainTile} from './terrain-model';
import {terrainPoint} from './terrain-surface';
import {groundVector,project,TILE_H,TILE_W} from './camera';
import type {Point,Camera} from './camera';
export type TerrainTriangle={points:readonly [Point,Point,Point];heightsM:readonly [number,number,number]};
// Fixed camera inclination sin(theta)=TILE_H/TILE_W=.5. Physical vertical projection uses cos(theta).
export const verticalPixelsPerMetre=(camera:Camera,metresPerCell:number):number=>Math.sqrt(2)*TILE_W*Math.sqrt(1-(TILE_H/TILE_W)**2)*camera.zoom/metresPerCell;
export function projectElevated(point:Point,elevationM:number,camera:Camera,metresPerCell:number):Point{
 const p=project(point,camera);return {x:p.x,y:p.y-elevationM*verticalPixelsPerMetre(camera,metresPerCell)};
}
export function terrainDepth(point:Point,elevationM:number,camera:Camera,metresPerCell:number):number{
 return groundVector(camera,point.x,point.y).y/(TILE_H*camera.zoom)+elevationM/metresPerCell*Math.sqrt(2/3);
}
export function pickTerrain(screen:Point,triangles:readonly TerrainTriangle[],camera:Camera,metresPerCell:number):{point:Point;elevationM:number}|null{
 let result:{point:Point;elevationM:number}|null=null,best=-Infinity;
 if(!Number.isFinite(metresPerCell)||metresPerCell<=0)return null;
 for(const t of triangles){
  const [a,b,c]=t.points.map((p,i)=>projectElevated(p,t.heightsM[i],camera,metresPerCell));
  const det=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(Math.abs(det)<1e-10)continue;
  const u=((b.y-c.y)*(screen.x-c.x)+(c.x-b.x)*(screen.y-c.y))/det;
  const v=((c.y-a.y)*(screen.x-c.x)+(a.x-c.x)*(screen.y-c.y))/det;const w=1-u-v;
  if(Math.min(u,v,w)<-1e-7)continue;
  const point={x:u*t.points[0].x+v*t.points[1].x+w*t.points[2].x,y:u*t.points[0].y+v*t.points[1].y+w*t.points[2].y};
  const elevationM=u*t.heightsM[0]+v*t.heightsM[1]+w*t.heightsM[2],depth=terrainDepth(point,elevationM,camera,metresPerCell);
  if(depth>=best){result={point,elevationM};best=depth;}
 }
 return result;
}

export function trianglesForTile(tile:TerrainTile,stride=1):TerrainTriangle[]{
 const triangles:TerrainTriangle[]=[];const n=tile.size,step=Math.max(1,Math.floor(stride));
 const east=tile.bounds.east<tile.bounds.west?tile.bounds.east+360:tile.bounds.east;
 const point=(x:number,y:number)=>terrainPoint(tile.bounds.west+(east-tile.bounds.west)*x/(n-1),tile.bounds.north-(tile.bounds.north-tile.bounds.south)*y/(n-1));
 for(let y=0;y<n-1;y+=step)for(let x=0;x<n-1;x+=step){
  const ex=Math.min(n-1,x+step),ey=Math.min(n-1,y+step);
  const ids=[y*n+x,y*n+ex,ey*n+x,ey*n+ex];
  // Coarse LOD must preserve holes inside the skipped samples, too.
  let valid=true;for(let sy=y;sy<=ey;sy++)for(let sx=x;sx<=ex;sx++)if(!tile.valid[sy*n+sx]||!Number.isFinite(tile.heightsM[sy*n+sx]))valid=false;
  if(!valid)continue;const points=[point(x,y),point(ex,y),point(x,ey),point(ex,ey)],h=ids.map(i=>tile.heightsM[i]);
  triangles.push({points:[points[0],points[1],points[2]],heightsM:[h[0],h[1],h[2]]},{points:[points[3],points[2],points[1]],heightsM:[h[3],h[2],h[1]]});
 }return triangles;
}
