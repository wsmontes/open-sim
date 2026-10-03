import {WORLD} from '../core/coordinates';
import type {TerrainTile} from './terrain-model';
export type TerrainReading={elevationM:number;kind:'dtm'|'dsm';sourceId:string;verticalDatum:string};
export const metresPerCellAt=(latitude:number):number=>40075016.686*Math.cos(latitude*Math.PI/180)/WORLD;
const lon360=(lon:number)=>((lon%360)+360)%360;
export function createTerrainSurface(tiles:readonly TerrainTile[]){
 if(new Set(tiles.map(t=>t.verticalDatum)).size>1)throw new Error('Incompatible terrain datums');
 const ordered=[...tiles].sort((a,b)=>(a.kind==='dtm'?0:1)-(b.kind==='dtm'?0:1)||(a.sourceResolutionM??a.spacingM)-(b.sourceResolutionM??b.spacingM)||a.id.localeCompare(b.id));
 return {sample(geo:{lat:number;lon:number}):TerrainReading|null{
  if(!Number.isFinite(geo.lat)||!Number.isFinite(geo.lon))return null;
  for(const t of ordered){
   const {west,east,south,north}=t.bounds;const span=lon360(east-west),delta=lon360(geo.lon-west);
   if(geo.lat<south||geo.lat>north||delta>span||!span||north<=south||t.size<2)continue;
   const x=delta/span*(t.size-1),y=(north-geo.lat)/(north-south)*(t.size-1);const ix=Math.min(t.size-2,Math.floor(x)),iy=Math.min(t.size-2,Math.floor(y));const fx=x-ix,fy=y-iy;
   const indices=[iy*t.size+ix,iy*t.size+ix+1,(iy+1)*t.size+ix,(iy+1)*t.size+ix+1];
   if(indices.some(i=>!t.valid[i]||!Number.isFinite(t.heightsM[i])))continue;
   const [nw,ne,sw,se]=indices.map(i=>t.heightsM[i]);
   const elevationM=fx+fy<=1?nw*(1-fx-fy)+ne*fx+sw*fy:se*(fx+fy-1)+ne*(1-fy)+sw*(1-fx);
   return {elevationM,kind:t.kind,sourceId:t.sourceId,verticalDatum:t.verticalDatum};
  }
  return null;
 }};
}
// Continuous Mercator point, retaining eastward dateline wrapping for a tile's local mesh.
export function terrainPoint(lon:number,lat:number):{x:number;y:number}{
 const phi=Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180;
 return {x:(lon+180)/360*WORLD,y:(1-Math.asinh(Math.tan(phi))/Math.PI)/2*WORLD};
}
