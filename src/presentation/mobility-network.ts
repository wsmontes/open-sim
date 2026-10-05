import type {Cell,CellCoord} from '../core/model';
import {roadClassOf} from '../core/model';
import {toGeo,wrapX} from '../core/coordinates';
import type {GeographicFeature} from './geographic-map';
import {nearestWorldX} from './geographic-map';
import type {Point} from './camera';
import {metresPerCellAt} from './terrain-surface';
import type {MobilityKind,MobilityNetwork,MobilityNode,MobilityEdge} from './mobility-model';
const MOTOR:readonly MobilityKind[]=['car','bus','truck','police','school-bus'];
const ALL:readonly MobilityKind[]=[...MOTOR,'pedestrian'];
const snap=(n:number)=>Math.round(n*1000)/1000;
const pointKey=(p:Point)=>`${wrapX(snap(p.x))},${snap(p.y)}`;
const ROADS=new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service','track','road','street','avenue','highway','footway','path','steps','pedestrian','cycleway','bridleway','busway','bus_guideway']);
const allowed=(kind:string):readonly MobilityKind[]=>/^(motorway|trunk|highway)/.test(kind)?MOTOR:/^(footway|path|steps|pedestrian|cycleway|bridleway)$/.test(kind)?['pedestrian']:ALL;
type Segment={a:Point;b:Point;feature:GeographicFeature;level:number;cuts:number[]};
const cross=(a:Point,b:Point)=>a.x*b.y-a.y*b.x;
const sub=(a:Point,b:Point)=>({x:a.x-b.x,y:a.y-b.y});
const along=(s:Segment,t:number):Point=>({x:snap(s.a.x+(s.b.x-s.a.x)*t),y:snap(s.a.y+(s.b.y-s.a.y)*t)});
function connect(a:Segment,b:Segment){
 if(a.level!==b.level)return 0;
 const r=sub(a.b,a.a),s=sub(b.b,b.a),delta=sub(b.a,a.a),den=cross(r,s);
 if(Math.abs(den)>1e-8){const t=cross(delta,s)/den,u=cross(delta,r)/den;if(t>=-1e-8&&t<=1+1e-8&&u>=-1e-8&&u<=1+1e-8){a.cuts.push(Math.max(0,Math.min(1,t)));b.cuts.push(Math.max(0,Math.min(1,u)));return 2;}return 0;}
 if(Math.abs(cross(delta,r))>1e-6)return 0;
 let added=0;
 const project=(p:Point,start:Point,v:Point)=>((p.x-start.x)*v.x+(p.y-start.y)*v.y)/(v.x*v.x+v.y*v.y);
 for(const p of [b.a,b.b]){const t=project(p,a.a,r);if(t>=0&&t<=1){a.cuts.push(t);added++;}}
 for(const p of [a.a,a.b]){const t=project(p,b.a,s);if(t>=0&&t<=1){b.cuts.push(t);added++;}}
 return added;
}
export type NetworkConstructionBudget={maxSegments:number;maxEdges:number;maxComparisons:number;maxBucketEntries?:number};
export class NetworkBudgetExceeded extends Error {constructor(){super('Mobility construction budget exceeded');}}
function* geographicNetworkSteps(features:readonly GeographicFeature[],revision:string,budget?:NetworkConstructionBudget):Generator<void,MobilityNetwork>{
 let operations=0;
 const segments:Segment[]=[],seen=new Set<string>();
 const groundEndpoints=new Set<string>(),portals=new Set<string>();
 let endpoints=0;
 for(const feature of features){if(++operations%128===0)yield;if(feature.layer!=='streets'||feature.type!==2||!ROADS.has(feature.kind))continue;
  for(const path of feature.geometry){if(++operations%128===0)yield;if(!path.length)continue;for(const p of [path[0],path[path.length-1]]){if(budget&&endpoints>=budget.maxSegments*4)throw new NetworkBudgetExceeded();endpoints++;if(feature.bridge||feature.tunnel)portals.add(pointKey(p));else if((feature.level??0)===0)groundEndpoints.add(pointKey(p));}}
 }
 for(const feature of features){if(++operations%128===0)yield;if(feature.layer!=='streets'||feature.type!==2||!ROADS.has(feature.kind))continue;
  const level=feature.level??(feature.bridge?1:feature.tunnel?-1:0);
  for(const path of feature.geometry)for(let i=1;i<path.length;i++){
   if(++operations%128===0)yield;
   const a=path[i-1],raw=path[i],b={x:nearestWorldX(raw.x,a.x),y:raw.y};if(![a.x,a.y,b.x,b.y,level].every(Number.isFinite)||pointKey(a)===pointKey(b))continue;
   const ends=[pointKey(a),pointKey(b)].sort(),sense=feature.oneway?`${pointKey(feature.oneway===-1?b:a)}>`:'both';
   const key=`${level}|${feature.kind}|${ends.join('|')}|${sense}`;if(seen.has(key))continue;if(budget&&segments.length>=budget.maxSegments)throw new NetworkBudgetExceeded();seen.add(key);segments.push({a,b,feature,level,cuts:[0,1]});
  }
 }
 // Segment bounding buckets limit intersection comparisons to nearby geometry.
 const buckets=new Map<string,number[]>();
 let comparisons=0,bucketEntries=0,cuts=segments.length*2;
 const compare=(a:number,b:number)=>{if(a!==b){if(budget&&comparisons>=budget.maxComparisons)throw new NetworkBudgetExceeded();comparisons++;const added=connect(segments[a],segments[b]);if(added){cuts+=added;if(budget&&cuts>budget.maxEdges*4)throw new NetworkBudgetExceeded();}}};
 const wide:number[]=[];
 for(let i=0;i<segments.length;i++){
  const s=segments[i],x0=Math.floor(Math.min(s.a.x,s.b.x)/32),x1=Math.floor(Math.max(s.a.x,s.b.x)/32),y0=Math.floor(Math.min(s.a.y,s.b.y)/32),y1=Math.floor(Math.max(s.a.y,s.b.y)/32),checked=new Set<number>();
  if((x1-x0+1)*(y1-y0+1)>4096){wide.push(i);continue;}
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){if(budget&&bucketEntries>=(budget.maxBucketEntries??budget.maxEdges*8))throw new NetworkBudgetExceeded();bucketEntries++;if(++operations%128===0)yield;const key=`${x}:${y}:${s.level}`,list=buckets.get(key)??[];for(const j of list)if(!checked.has(j)){checked.add(j);compare(i,j);if(++operations%512===0)yield;}list.push(i);buckets.set(key,list);}
 }
 for(const i of wide)for(let j=0;j<segments.length;j++){compare(i,j);if(++operations%512===0)yield;}
 const nodes=new Map<string,MobilityNode>(),edges=new Map<string,MobilityEdge>(),outgoing=new Map<string,string[]>();
 const node=(point:Point,level:number)=>{const id=`${pointKey(point)}@${level}`;if(!nodes.has(id))nodes.set(id,{id,point:{x:wrapX(snap(point.x)),y:snap(point.y)},level});return id;};
 const edge=(s:Segment,a:Point,b:Point)=>{
  const endpointLevel=(p:Point)=>(s.feature.bridge||s.feature.tunnel)&&portals.has(pointKey(p))&&groundEndpoints.has(pointKey(p))?0:s.level;
  const from=node(a,endpointLevel(a)),to=node(b,endpointLevel(b));if(from===to)return;
  const id=`${from}>${to}|${s.feature.kind}`;if(edges.has(id))return;
  const lengthM=Math.hypot(b.x-a.x,b.y-a.y)*metresPerCellAt(toGeo({x:(a.x+b.x)/2,y:(a.y+b.y)/2}).lat);
  if(budget&&edges.size>=budget.maxEdges)throw new NetworkBudgetExceeded();
  edges.set(id,{id,from,to,path:[a,b],lengthM,roadClass:s.feature.kind,allowed:allowed(s.feature.kind),method:s.feature.oneway!==undefined&&s.feature.level!==undefined?'reported':'derived',level:s.level,bridge:s.feature.bridge});
  const list=outgoing.get(from)??[];list.push(id);outgoing.set(from,list);
 };
 for(const segment of segments){if(++operations%128===0)yield;const cuts=[...new Set(segment.cuts.map(t=>Math.round(t*1e9)/1e9))].sort((a,b)=>a-b);for(let i=1;i<cuts.length;i++){if(++operations%128===0)yield;const a=along(segment,cuts[i-1]),b=along(segment,cuts[i]);if(segment.feature.oneway!==-1)edge(segment,a,b);if(segment.feature.oneway!==1)edge(segment,b,a);}}
 for(const list of outgoing.values())list.sort();
 return {revision,nodes,edges,outgoing};
}
export function buildGeographicNetwork(features:readonly GeographicFeature[],revision:string,budget?:NetworkConstructionBudget):MobilityNetwork{
 const steps=geographicNetworkSteps(features,revision,budget);let step=steps.next();while(!step.done)step=steps.next();return step.value;
}
const asyncClock=globalThis as unknown as {setTimeout(callback:()=>void,ms:number):unknown;performance:{now():number}};
export async function buildGeographicNetworkAsync(features:readonly GeographicFeature[],revision:string,cancelled:()=>boolean=()=>false,budget?:NetworkConstructionBudget):Promise<MobilityNetwork>{
 const steps=geographicNetworkSteps(features,revision,budget);let step=steps.next();
 while(!step.done){await new Promise<void>(resolve=>asyncClock.setTimeout(resolve,0));if(cancelled())throw new Error('Mobility preparation cancelled');const until=asyncClock.performance.now()+4;do{step=steps.next();}while(!step.done&&asyncClock.performance.now()<until);}
 return step.value;
}
export function buildCellNetwork(cells:readonly {coord:CellCoord;cell:Cell}[],revision:string):MobilityNetwork{
 const roads=new Map(cells.filter(c=>c.cell.road).map(c=>[pointKey(c.coord),c]));const features:GeographicFeature[]=[];
 for(const {coord,cell} of roads.values())for(const [dx,dy] of [[1,0],[0,1]]){
  const next=roads.get(pointKey({x:coord.x+dx,y:coord.y+dy}));if(!next)continue;
  const kind=roadClassOf(cell)==='highway'||roadClassOf(next.cell)==='highway'?'highway':roadClassOf(cell);
  features.push({layer:'streets',kind,type:2,bridge:false,geometry:[[coord,next.coord]],level:0});
 }
 return buildGeographicNetwork(features,revision);
}
export function findMobilityRoute(network:MobilityNetwork,from:string,to:string,kind:MobilityKind,maxVisited=Infinity):readonly string[]|null{
 if(!network.nodes.has(from)||!network.nodes.has(to))return null;if(from===to)return [];
 const distances=new Map<string,number>([[from,0]]),previous=new Map<string,string>(),visited=new Set<string>(),heap:{id:string;distance:number}[]=[];
 const before=(a:{id:string;distance:number},b:{id:string;distance:number})=>a.distance<b.distance||a.distance===b.distance&&a.id<b.id;
 const push=(id:string,distance:number)=>{const entry={id,distance};heap.push(entry);let i=heap.length-1;while(i>0){const parent=Math.floor((i-1)/2);if(!before(entry,heap[parent]))break;heap[i]=heap[parent];i=parent;}heap[i]=entry;};
 const pop=()=>{const first=heap[0],last=heap.pop()!;if(heap.length){let i=0;while(i*2+1<heap.length){let child=i*2+1;if(child+1<heap.length&&before(heap[child+1],heap[child]))child++;if(!before(heap[child],last))break;heap[i]=heap[child];i=child;}heap[i]=last;}return first;};
 push(from,0);
 while(heap.length){if(visited.size>=maxVisited)return null;const {id:current,distance:best}=pop();if(visited.has(current)||best!==distances.get(current))continue;if(current===to)break;visited.add(current);
  for(const id of network.outgoing.get(current)??[]){const edge=network.edges.get(id)!;if(!edge.allowed.includes(kind)||visited.has(edge.to))continue;const distance=best+edge.lengthM;if(distance<(distances.get(edge.to)??Infinity)){distances.set(edge.to,distance);previous.set(edge.to,id);push(edge.to,distance);}}
 }
 if(!previous.has(to))return null;const route:string[]=[];let current=to;while(current!==from){const id=previous.get(current);if(!id)return null;route.push(id);current=network.edges.get(id)!.from;}return route.reverse();
}
