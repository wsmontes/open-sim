import type {GeographicFeature} from './geographic-map';
import type {Point} from './camera';
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
