import type {GeographicFeature} from './geographic-map';
import type {Point} from './camera';
import {variant} from '../core/coordinates';
export type StreetJunction={point:Point;directions:Point[];major:boolean};
export type StreetAgent={point:Point;direction:Point;kind:'car'|'pedestrian';seed:number};
const excluded=(f:GeographicFeature)=>f.bridge||/^(motorway|trunk|motorway_link|trunk_link|steps)/.test(f.kind);
const foot=(f:GeographicFeature)=>/^(footway|path|cycleway|pedestrian)/.test(f.kind);
export function streetJunctions(features:readonly GeographicFeature[],limit=500):StreetJunction[]{
 const nodes=new Map<string,StreetJunction&{blocked:boolean}>();
 for(const f of features)if(f.layer==='streets')for(const ring of f.geometry)for(let i=0;i<ring.length;i++){
  const p=ring[i],key=`${Math.round(p.x*16)}:${Math.round(p.y*16)}`;
  let node=nodes.get(key);if(!node){node={point:p,directions:[],major:false,blocked:false};nodes.set(key,node);}
  if(excluded(f))node.blocked=true;if(foot(f))continue;
  node.major ||= /^(primary|secondary|tertiary)/.test(f.kind);
  for(const q of [ring[i-1],ring[i+1]])if(q){const length=Math.hypot(q.x-p.x,q.y-p.y);if(length<.01)continue;
   const direction={x:(q.x-p.x)/length,y:(q.y-p.y)/length};
   if(!node.directions.some(d=>d.x*direction.x+d.y*direction.y>.94))node.directions.push(direction);
  }
 }
 return[...nodes.values()].filter(n=>!n.blocked&&n.directions.length>=3).slice(0,limit).map(({point,directions,major})=>({point,directions,major}));
}
const agentPaths=new WeakMap<GeographicFeature,Array<{a:Point;b:Point;length:number;seed:number}>>();
export function streetAgents(features:readonly GeographicFeature[],motion:number,limit=180,accept:(point:Point)=>boolean=()=>true):StreetAgent[]{
 const agents:StreetAgent[]=[];
 for(const f of features){
  if(f.layer!=='streets'||f.bridge||/^steps/.test(f.kind))continue;
  let segments=agentPaths.get(f);
  if(!segments){segments=[];for(const ring of f.geometry)for(let i=1;i<ring.length;i++){
   const a=ring[i-1],b=ring[i],length=Math.hypot(b.x-a.x,b.y-a.y);if(length<2)continue;
   const seed=(Math.imul(Math.round(a.x*16),73856093)^Math.imul(Math.round(a.y*16),19349663))>>>0;
   segments.push({a,b,length,seed});
  }agentPaths.set(f,segments);}
  for(const {a,b,length,seed} of segments){
   const direction={x:(b.x-a.x)/length,y:(b.y-a.y)/length},walk=foot(f);
   for(const kind of (walk?['pedestrian']:seed%3===0?['car','pedestrian']:['car']) as Array<'car'|'pedestrian'>){
    const t=(((seed%997)/997)+(motion*(kind==='car'?.9:.12)/length))%1;
    const offset=kind==='car'?.15:walk?.12:/^(primary|secondary)/.test(f.kind)?.82:.59;
    const point={x:a.x+(b.x-a.x)*t-direction.y*offset,y:a.y+(b.y-a.y)*t+direction.x*offset};if(!accept(point))continue;
    if(agents.length>=limit)return agents;agents.push({point,direction,kind,seed});
   }
  }
 }
 return agents;
}

// Where the city is planted. A tree is a station of a lattice over the ground, not a rhythm over the tile's segments:
// the same street arrives here cut into five pieces at one zoom and two at the next, and the address of a tree has to be
// the place it stands on, or the whole avenue walks when the player zooms. The lattice is read at a spacing that doubles
// as the camera pulls back — a station of the coarse lattice is a station of the fine one, so widening the view only
// ever thins the trees, never rearranges them, and the cost of planting is bounded by the screen instead of by the city.
export type Segment={a:Point;b:Point};
export type Planting={x:number;y:number;seed:number};
export type PlantingBox={minX:number;minY:number;maxX:number;maxY:number};
// How far from the centre line a tree stands, and how far the lattice looks for a kerb to stand beside.
export const PLANT_VERGE=1.15,PLANT_REACH=2.1;
const PLANT_STEP=3,PLANT_TARGET=45,PLANT_BIN=4;
export function plantingStep(scale:number):number{
 const k=Math.max(0,Math.min(4,Math.round(Math.log2(PLANT_TARGET/Math.max(1,PLANT_STEP*scale)))));
 return PLANT_STEP*2**k;
}
// Every station of the lattice inside the box, leaning inside its own cell by the address of the ground under it. The
// lean is what keeps a planted street from looking like a grid, and it is measured in the ground's own step rather than
// in the spacing it was read at: a tree that leaned by the spacing would stand somewhere else the moment the camera
// pulled back far enough to double it, which is exactly the walk this planting is here to prevent.
export function plantingStations(box:PlantingBox,step:number,seed:number,density:number):Planting[]{
 const out:Planting[]=[];
 const firstX=Math.floor(box.minX/step),lastX=Math.ceil(box.maxX/step),firstY=Math.floor(box.minY/step),lastY=Math.ceil(box.maxY/step);
 for(let iy=firstY;iy<=lastY;iy++)for(let ix=firstX;ix<=lastX;ix++){
  const x=ix*step,y=iy*step,address=variant(Math.round(x*2),Math.round(y*2),seed);
  if(address%1000>=density*10)continue;
  out.push({x:x+((address>>>8&0xff)/255-.5)*PLANT_STEP*.7,y:y+((address>>>16&0xff)/255-.5)*PLANT_STEP*.7,seed:address});
 }
 return out;
}
// The trees of the streets: stations with a kerb within reach, set back onto the verge on the side they were found, so
// nothing is planted on the asphalt. A station answers to the nearest kerb alone, so a corner plants one tree and not
// one per street that meets there.
export function roadsideTrees(segments:readonly Segment[],box:PlantingBox,step:number,seed:number,density:number):Planting[]{
 const bin=(v:number)=>Math.floor(v/PLANT_BIN),key=(x:number,y:number)=>x*4194304+y;
 const bins=new Map<number,Segment[]>();
 for(const s of segments){
  for(let bx=bin(Math.min(s.a.x,s.b.x));bx<=bin(Math.max(s.a.x,s.b.x));bx++)
   for(let by=bin(Math.min(s.a.y,s.b.y));by<=bin(Math.max(s.a.y,s.b.y));by++){
    const at=key(bx,by),list=bins.get(at);
    if(list)list.push(s);else bins.set(at,[s]);
   }
 }
 const out:Planting[]=[];
 for(const tree of plantingStations(box,step,seed,density)){
  let best=PLANT_REACH,foot:Point|null=null,ray:Point|null=null;
  for(let bx=bin(tree.x-PLANT_REACH);bx<=bin(tree.x+PLANT_REACH);bx++)
   for(let by=bin(tree.y-PLANT_REACH);by<=bin(tree.y+PLANT_REACH);by++)
    for(const s of bins.get(key(bx,by))??[]){
     const dx=s.b.x-s.a.x,dy=s.b.y-s.a.y,length=dx*dx+dy*dy;
     const t=length?Math.max(0,Math.min(1,((tree.x-s.a.x)*dx+(tree.y-s.a.y)*dy)/length)):0;
     const fx=s.a.x+dx*t,fy=s.a.y+dy*t,distance=Math.hypot(tree.x-fx,tree.y-fy);
     if(distance<best){best=distance;foot={x:fx,y:fy};const size=Math.sqrt(length)||1;ray={x:-dy/size,y:dx/size};}
    }
  if(!foot||!ray)continue;
  // Set back along the normal of the kerb, on the side the station was found: a tree stands on the verge, at the same
  // distance from the centre line whichever way the street runs.
  const side=(tree.x-foot.x)*ray.x+(tree.y-foot.y)*ray.y>=0?1:-1;
  out.push({x:foot.x+ray.x*PLANT_VERGE*side,y:foot.y+ray.y*PLANT_VERGE*side,seed:tree.seed});
 }
 return out;
}
