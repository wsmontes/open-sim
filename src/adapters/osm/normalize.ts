import type {BaseChunk,Building,Cell,CellCoord} from '../../core/model';
import {CHUNK,chunkOrigin,variant} from '../../core/coordinates';
export type MapFeature={layer:string;kind:string;bridge:boolean;type:number;geometry:CellCoord[][]};
// A ring is tested against one cell at a time; parity over every ring of a feature is even-odd, exactly like the
// classic point-in-polygon test, so holes and separate parts keep working when rings are visited one by one.
function ringHits(p:CellCoord,ring:CellCoord[]):boolean {
 let hit=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i]!,b=ring[j]!;
  if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;
 }
 return hit;
}
function ringNear(p:CellCoord,ring:CellCoord[],width:number):boolean {
 for(let i=1;i<ring.length;i++){
  const a=ring[i-1]!,b=ring[i]!,dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
  if((p.x-a.x-t*dx)**2+(p.y-a.y-t*dy)**2<=width*width)return true;
 }
 return false;
}
// Explicit kind tables from the Shortbread schema. Substring matching is wrong here: /park/ also matches the
// `parking` sites and /wood/ matches `wood_polygons`-style kinds, which turned parking lots and odd areas into green.
const GREEN:Record<string,true>={park:true,garden:true,grass:true,forest:true,wood:true,meadow:true,scrub:true,heath:true,farmland:true,orchard:true,vineyard:true,allotments:true,village_green:true,recreation_ground:true,nature_reserve:true,golf_course:true,cemetery:true};
const LAND_USE:Record<string,true>={residential:true,commercial:true,industrial:true};
// Only ways a car can use may become road cells. Measured on real tiles (2026-09-29): counting footways, steps, paths,
// cycleways and plazas as roads covered 55-59% of a downtown chunk and overwrote the imported buildings with asphalt.
const DRIVEABLE=/^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/;
// The map already knows which roads are which, and throwing that away was leaving variety on the table: a real
// avenue is imported as an avenue, so a city built on real ground gets the road hierarchy it actually has.
const MOTORWAY=/^(motorway|trunk)(_link)?$/;
const ARTERIAL=/^(primary|secondary)(_link)?$/;
const roadClass=(kind:string)=>MOTORWAY.test(kind)?'highway':ARTERIAL.test(kind)?'avenue':'street';
const PAVED=/^(pedestrian|service)$/;
const layerOrder=(f:MapFeature)=>f.layer==='land'||f.layer==='sites'?0:f.layer==='ocean'||f.layer.startsWith('water')?1:f.layer==='buildings'?2:3;
// One tile carries one `buildings` feature with thousands of rings (São Paulo: 10.137 rings, 108k points). Testing
// every cell of a region against every ring cost 51 s per tile; sorting once per tile and clipping each ring to its
// own bounding box brings the same result down to milliseconds.
const sortedOnce=new WeakMap<readonly MapFeature[],MapFeature[]>();
function sortedByLayer(features:readonly MapFeature[]):MapFeature[] {
 const cached=sortedOnce.get(features);
 if(cached)return cached;
 const sorted=[...features].sort((a,b)=>layerOrder(a)-layerOrder(b));
 sortedOnce.set(features,sorted);
 return sorted;
}
export function normalizeChunk(id:string,features:readonly MapFeature[],source='OpenStreetMap · Shortbread v1'):BaseChunk {
 const origin=chunkOrigin(id),cells=Array.from({length:CHUNK*CHUNK},()=>({terrain:'land'} as Cell));
 const landUse=new Map<number,Building>();
 // Scratch buffers reused for every feature: a parity bit per cell and the list of cells a feature touched.
 const parity=new Uint8Array(CHUNK*CHUNK),touched:number[]=[];
 for(const f of sortedByLayer(features)){
  if(!f.geometry.length)continue;
  const width=f.layer==='streets'?(/motorway|trunk|primary/.test(f.kind)?1.1:.67):.65;
  const polygon=f.type===3;
  touched.length=0;
  for(const ring of f.geometry){
   if(ring.length<2)continue;
   let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
   for(const p of ring){if(p.x<minX)minX=p.x;if(p.x>maxX)maxX=p.x;if(p.y<minY)minY=p.y;if(p.y>maxY)maxY=p.y;}
   const x0=Math.max(0,Math.floor(minX-origin.x-width)),x1=Math.min(CHUNK-1,Math.ceil(maxX-origin.x+width));
   const y0=Math.max(0,Math.floor(minY-origin.y-width)),y1=Math.min(CHUNK-1,Math.ceil(maxY-origin.y+width));
   for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
    const p={x:origin.x+x+.5,y:origin.y+y+.5};
    if(polygon?ringHits(p,ring):ringNear(p,ring,width)){
     const i=y*CHUNK+x;
     if(polygon){if(parity[i]===0)touched.push(i);parity[i]^=1;}
     else paint(cells,landUse,f,i,origin,x,y);
    }
   }
  }
  if(!polygon)continue;
  for(const i of touched){if(parity[i]===1)paint(cells,landUse,f,i,origin,i%CHUNK,Math.floor(i/CHUNK));parity[i]=0;}
 }
 return{id,source,normalizerVersion:1,cells};
}
function paint(cells:Cell[],landUse:Map<number,Building>,f:MapFeature,i:number,origin:CellCoord,x:number,y:number):void {
 const c=cells[i]!;
 if(f.layer==='land'||f.layer==='sites'){
  if(GREEN[f.kind]===true)c.terrain='green';
  if(LAND_USE[f.kind]===true)landUse.set(i,f.kind as Building);
 }else if(f.layer==='ocean'||f.layer.startsWith('water'))cells[i]={terrain:'water'};
 else if(f.layer==='buildings'&&c.terrain!=='water'){
  const hash=variant(origin.x+x,origin.y+y)%10;
  cells[i]={terrain:c.terrain,building:landUse.get(i)??(hash<7?'residential':hash<9?'commercial':'industrial'),stage:1,origin:'imported'};
 }else if(((f.layer==='streets'&&DRIVEABLE.test(f.kind))||(f.layer==='street_polygons'&&PAVED.test(f.kind)))&&(c.terrain!=='water'||f.bridge))cells[i]={terrain:c.terrain,road:true,...(roadClass(f.kind)==='street'?{}:{roadClass:roadClass(f.kind)}),origin:'imported'};
}
