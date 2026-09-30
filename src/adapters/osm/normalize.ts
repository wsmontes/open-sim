import type {BaseChunk,Building,CellCoord} from '../../core/model';
import {CHUNK,chunkOrigin,variant} from '../../core/coordinates';
export type MapFeature={layer:string;kind:string;bridge:boolean;type:number;geometry:CellCoord[][]};
function inside(p:CellCoord,rings:CellCoord[][]){let hit=false;for(const ring of rings)for(let i=0,j=ring.length-1;i<ring.length;j=i++){
 const a=ring[i],b=ring[j];if(((a.y>p.y)!==(b.y>p.y))&&(p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x))hit=!hit;
}return hit;}
function nearLine(p:CellCoord,rings:CellCoord[][],width:number){for(const ring of rings)for(let i=1;i<ring.length;i++){
 const a=ring[i-1],b=ring[i],dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
 if((p.x-a.x-t*dx)**2+(p.y-a.y-t*dy)**2<=width*width)return true;
}return false;}
// Explicit kind tables from the Shortbread schema. Substring matching is wrong here: /park/ also matches the
// `parking` sites and /wood/ matches `wood_polygons`-style kinds, which turned parking lots and odd areas into green.
const GREEN:Record<string,true>={park:true,garden:true,grass:true,forest:true,wood:true,meadow:true,scrub:true,heath:true,farmland:true,orchard:true,vineyard:true,allotments:true,village_green:true,recreation_ground:true,nature_reserve:true,golf_course:true,cemetery:true};
const LAND_USE:Record<string,true>={residential:true,commercial:true,industrial:true};
// Only ways a car can use may become road cells. Measured on real tiles (2026-09-29): counting footways, steps, paths,
// cycleways and plazas as roads covered 55-59% of a downtown chunk and overwrote the imported buildings with asphalt.
const DRIVEABLE=/^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/;
const PAVED=/^(pedestrian|service)$/;
export function normalizeChunk(id:string,features:readonly MapFeature[],source='OpenStreetMap · Shortbread v1'):BaseChunk {
 const origin=chunkOrigin(id);const cells=Array.from({length:CHUNK*CHUNK},()=>({terrain:'land'} as BaseChunk['cells'][number]));
 const landUse=new Map<number,Building>();
 const order=(f:MapFeature)=>f.layer==='land'||f.layer==='sites'?0:f.layer==='ocean'||f.layer.startsWith('water')?1:f.layer==='buildings'?2:3;
 const sorted=[...features].sort((a,b)=>order(a)-order(b));
 for(const f of sorted){
  const points=f.geometry.flat();if(!points.length)continue;
  const width=f.layer==='streets'?(/motorway|trunk|primary/.test(f.kind)?1.1:.67):.65;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const p of points){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
  const x0=Math.max(0,Math.floor(minX-origin.x-width)),x1=Math.min(31,Math.ceil(maxX-origin.x+width));
  const y0=Math.max(0,Math.floor(minY-origin.y-width)),y1=Math.min(31,Math.ceil(maxY-origin.y+width));
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   const p={x:origin.x+x+.5,y:origin.y+y+.5};if(!(f.type===3?inside(p,f.geometry):nearLine(p,f.geometry,width)))continue;
   const i=y*32+x,c=cells[i];
   if(f.layer==='land'||f.layer==='sites'){
    if(GREEN[f.kind]===true)c.terrain='green';
    if(LAND_USE[f.kind]===true)landUse.set(i,f.kind as Building);
   }else if(f.layer==='ocean'||f.layer.startsWith('water'))cells[i]={terrain:'water'};
   else if(f.layer==='buildings'&&c.terrain!=='water'){
    const hash=variant(origin.x+x,origin.y+y)%10;
    cells[i]={terrain:c.terrain,building:landUse.get(i)??(hash<7?'residential':hash<9?'commercial':'industrial'),stage:1,origin:'imported'};
   }else if(((f.layer==='streets'&&DRIVEABLE.test(f.kind))||(f.layer==='street_polygons'&&PAVED.test(f.kind)))&&(c.terrain!=='water'||f.bridge))cells[i]={terrain:c.terrain,road:true,origin:'imported'};
  }
 }
 return{id,source,normalizerVersion:1,cells};
}
