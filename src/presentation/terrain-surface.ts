import {WORLD,toGeo} from '../core/coordinates';
import type {TerrainTile} from './terrain-model';
export type TerrainReading={elevationM:number;kind:'dtm'|'dsm';sourceId:string;verticalDatum:string};
export const metresPerCellAt=(latitude:number):number=>40075016.686*Math.cos(latitude*Math.PI/180)/WORLD;
export type SupportedSurface={kind:'deck'|'ocean'|'river';elevationM:number;verticalDatum:string;method:'reported'|'derived'};
export function createSurfaceSupport(sample:(geo:{lat:number;lon:number})=>TerrainReading|null){
 const elevation=(point:{x:number;y:number},level?:SupportedSurface):number|null=>{
  const ground=sample(toGeo(point));
  if(level)return ground&&ground.verticalDatum===level.verticalDatum&&Number.isFinite(level.elevationM)?level.elevationM:null;
  return ground?.elevationM??null;
 };
 return {elevation,
  foundation(points:readonly {x:number;y:number}[]):number|null{
   const heights=points.map(p=>elevation(p));
   return heights.length&&heights.every(h=>h!==null)?Math.max(...heights as number[]):null;
  },
  line(points:readonly {x:number;y:number}[],spacingM=20,level?:SupportedSurface):{point:{x:number;y:number};elevationM:number|null}[]{
   if(!Number.isFinite(spacingM)||spacingM<=0)throw new Error('Invalid surface spacing');
   const out:{point:{x:number;y:number};elevationM:number|null}[]=[];
   for(let i=0;i<points.length;i++){
    const a=points[i];if(i===0){out.push({point:a,elevationM:elevation(a,level)});continue;}
    const b=points[i-1],distance=Math.hypot(a.x-b.x,a.y-b.y)*metresPerCellAt(toGeo(a).lat),steps=Math.min(4096,Math.max(1,Math.ceil(distance/spacingM)));
    for(let step=1;step<=steps;step++){const t=step/steps,point={x:b.x+(a.x-b.x)*t,y:b.y+(a.y-b.y)*t};out.push({point,elevationM:elevation(point,level)});}
   }
   return out;
  },
 };
}
const lon360=(lon:number)=>((lon%360)+360)%360;
export function createTerrainSurface(tiles:readonly TerrainTile[]){
 if(new Set(tiles.map(t=>t.verticalDatum)).size>1)throw new Error('Incompatible terrain datums');
 const ordered=[...tiles].sort((a,b)=>(a.kind==='dtm'?0:1)-(b.kind==='dtm'?0:1)||(a.sourceResolutionM??a.spacingM)-(b.sourceResolutionM??b.spacingM)||a.id.localeCompare(b.id));
 const buckets=new Map<string,TerrainTile[]>(),wide:TerrainTile[]=[];
 const key=(x:number,y:number)=>`${((x%(360*64))+(360*64))%(360*64)}:${y}`;
 for(const tile of ordered){
  const west=Math.floor((lon360(tile.bounds.west)-1e-9)*64),east=Math.floor((lon360(tile.bounds.west)+lon360(tile.bounds.east-tile.bounds.west)+1e-9)*64),south=Math.floor((tile.bounds.south-1e-9)*64),north=Math.floor((tile.bounds.north+1e-9)*64);
  if((east-west+1)*(north-south+1)>4096){wide.push(tile);continue;}
  for(let y=south;y<=north;y++)for(let x=west;x<=east;x++){const id=key(x,y),known=buckets.get(id);if(known)known.push(tile);else buckets.set(id,[tile]);}
 }
 return {sample(geo:{lat:number;lon:number}):TerrainReading|null{
  if(!Number.isFinite(geo.lat)||!Number.isFinite(geo.lon))return null;
  const candidates=buckets.get(key(Math.floor(lon360(geo.lon)*64),Math.floor(geo.lat*64)))??[];
  const local=wide.length?ordered.filter(t=>wide.includes(t)||candidates.includes(t)):candidates;
  for(const t of local){
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
