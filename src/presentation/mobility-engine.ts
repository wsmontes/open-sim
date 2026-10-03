import type {Point} from './camera';
import type {MobilityAgent,MobilityDemand,MobilityEdge,MobilityFrameAgent,MobilityNetwork,MobilitySignal} from './mobility-model';
import {findMobilityRoute} from './mobility-network';
export const MOBILITY_LENGTH={car:4.5,bus:12,truck:10,pedestrian:.5,police:4.5,'school-bus':10} as const;
const STEP=1/30,CAP=480;
const axis=(edge:MobilityEdge)=>{const a=edge.path.at(-2)!,b=edge.path.at(-1)!;return Math.abs(b.x-a.x)>=Math.abs(b.y-a.y)?'east-west':'north-south';};
const lane=(agent:MobilityAgent)=>agent.kind==='pedestrian'?'sidewalk':'vehicle';
export function createMobilityEngine(initial:MobilityNetwork,seed:number){
 let network=initial,clock=0,accumulator=0,sequence=0,randomState=seed>>>0||0x51ed;
 let demand:MobilityDemand={vehicles:0,pedestrians:0,truckShare:0,hour:12};
 const agents=new Map<string,MobilityAgent>(),retired=new Set<string>();let external=new Set<string>();
 const edgePools=new Map<MobilityAgent['kind'],readonly MobilityEdge[]>();
 const geometry=new WeakMap<MobilityEdge,{length:number;parts:readonly number[]}>();
 let surface:(point:Point,edge:MobilityEdge)=>number|null=()=>null;
 const reservations=new Map<string,{id:string;until:number}>();
 let intersections=new Set<string>();
 const readIntersections=()=>{
  const neighbours=new Map<string,Set<string>>();for(const edge of network.edges.values()){const a=neighbours.get(edge.from)??new Set();a.add(edge.to);neighbours.set(edge.from,a);const b=neighbours.get(edge.to)??new Set();b.add(edge.from);neighbours.set(edge.to,b);}
  intersections=new Set([...neighbours].filter(([,set])=>set.size>=3).map(([id])=>id));
 };readIntersections();
 const random=()=>{randomState^=randomState<<13;randomState^=randomState>>>17;randomState^=randomState<<5;return (randomState>>>0)/4294967296;};
 const valid=(agent:MobilityAgent)=>agent.route.length>0&&agent.route.every((id,i)=>{const edge=network.edges.get(id);return edge?.allowed.includes(agent.kind)&&(i===0||network.edges.get(agent.route[i-1])?.to===edge.from);});
 const phase=():MobilitySignal['phase']=>{const time=clock%50;return time<20?'east-west-green':time<23?'east-west-yellow':time<25?'clearance':time<45?'north-south-green':time<48?'north-south-yellow':'clearance';};
 const admit=(agent:MobilityAgent,edge:MobilityEdge)=>{
  if(!intersections.has(edge.to))return true;
  const occupied=reservations.get(edge.to);
  if(occupied&&occupied.until>clock){if(occupied.id===agent.id)return true;return false;}
  return phase()===`${axis(edge)}-green`;
 };
 const gapToLeader=(agent:MobilityAgent,index:Map<string,MobilityAgent[]>):number=>{
  let nearest=Infinity;
  let ahead=-agent.distanceM;
  for(let i=agent.edgeIndex;i<Math.min(agent.route.length,agent.edgeIndex+3);i++){
   for(const other of index.get(`${agent.route[i]}:${lane(agent)}`)??[]){if(other.id===agent.id)continue;const distance=ahead+other.distanceM;if(distance>0)nearest=Math.min(nearest,distance-(MOBILITY_LENGTH[agent.kind]+MOBILITY_LENGTH[other.kind])/2-2);}
   ahead+=network.edges.get(agent.route[i])!.lengthM;
   if(ahead>100)break;
   }
  return Math.max(0,nearest);
 };
 const finish=(id:string)=>{agents.delete(id);if(external.has(id))retired.add(id);};
 const step=()=>{
  clock+=STEP;
  const ordered=[...agents.values()].sort((a,b)=>b.distanceM-a.distanceM||a.id.localeCompare(b.id));
  const index=new Map<string,MobilityAgent[]>();
  for(const agent of ordered){const key=`${agent.route[agent.edgeIndex]}:${lane(agent)}`,list=index.get(key)??[];list.push(agent);index.set(key,list);}
  for(const agent of ordered){
   if(!agents.has(agent.id))continue;
   let edge=network.edges.get(agent.route[agent.edgeIndex]);if(!edge){finish(agent.id);continue;}
   const previousKey=`${edge.id}:${lane(agent)}`;
   let travel=Math.min(Math.max(0,agent.speedMps)*STEP,gapToLeader(agent,index));
   if(!admit(agent,edge))travel=Math.min(travel,Math.max(0,edge.lengthM-agent.distanceM-MOBILITY_LENGTH[agent.kind]/2-1));
   let next=agent.distanceM+travel;
   if(intersections.has(edge.to)&&travel>0&&next>=edge.lengthM-MOBILITY_LENGTH[agent.kind]/2-1&&admit(agent,edge))reservations.set(edge.to,{id:agent.id,until:clock+(MOBILITY_LENGTH[agent.kind]*1.5+3)/Math.max(1,agent.speedMps)});
   while(next>=edge.lengthM){
    if(!admit(agent,edge)){next=Math.min(next,Math.max(agent.distanceM,edge.lengthM-MOBILITY_LENGTH[agent.kind]/2-1));break;}
    if(intersections.has(edge.to))reservations.set(edge.to,{id:agent.id,until:clock+(MOBILITY_LENGTH[agent.kind]+2)/Math.max(1,agent.speedMps)});
    next-=edge.lengthM;agent.edgeIndex++;
    if(agent.edgeIndex>=agent.route.length){finish(agent.id);break;}
    edge=network.edges.get(agent.route[agent.edgeIndex])!;
   }
   if(agents.has(agent.id))agent.distanceM=next;
   const nextKey=agents.has(agent.id)?`${agent.route[agent.edgeIndex]}:${lane(agent)}`:null;
   if(nextKey!==previousKey){const list=index.get(previousKey)!;list.splice(list.indexOf(agent),1);if(nextKey){const next=index.get(nextKey)??[];next.push(agent);index.set(nextKey,next);}}
  }
 };
 const generate=()=>{
  const vehicleTarget=Math.max(0,Math.min(CAP,Math.floor(demand.vehicles))),walkerTarget=Math.max(0,Math.min(CAP-vehicleTarget,Math.floor(demand.pedestrians)));
  for(const [walking,target] of [[false,vehicleTarget],[true,walkerTarget]] as const){
   let count=[...agents.values()].filter(a=>(a.kind==='pedestrian')===walking).length;
   for(let attempt=0;count<target&&agents.size<CAP&&attempt<8;attempt++){
    const kind=walking?'pedestrian':random()<demand.truckShare?'truck':'car';
    let edges=edgePools.get(kind);if(!edges){edges=[...network.edges.values()].filter(edge=>edge.allowed.includes(kind));edgePools.set(kind,edges);}if(!edges.length)break;
    const from=edges[Math.floor(random()*edges.length)].from,to=edges[Math.floor(random()*edges.length)].to,route=findMobilityRoute(network,from,to,kind);if(!route?.length)continue;
    const id=`demand:${seed}:${++sequence}`,first=network.edges.get(route[0])!;
    if([...agents.values()].some(a=>a.route[a.edgeIndex]===first.id&&lane(a)===(walking?'sidewalk':'vehicle')&&a.distanceM<(MOBILITY_LENGTH[kind]+MOBILITY_LENGTH[a.kind])/2+2))continue;
    const rush=demand.hour>=7&&demand.hour<10||demand.hour>=16&&demand.hour<19;
    agents.set(id,{id,kind,route,edgeIndex:0,distanceM:0,speedMps:walking?1.2+random()*.4:/motorway|trunk|highway/.test(first.roadClass)?22:kind==='truck'?8:rush?8:11,seed:randomState>>>0});count++;
   }
  }
 };
 return {
  setNetwork(next:MobilityNetwork){
   if(next.revision===network.revision)return;network=next;reservations.clear();edgePools.clear();readIntersections();
   for(const agent of agents.values())if(!valid(agent))finish(agent.id);
  },
  setDemand(next:MobilityDemand){demand={vehicles:Number.isFinite(next.vehicles)?Math.max(0,next.vehicles):0,pedestrians:Number.isFinite(next.pedestrians)?Math.max(0,next.pedestrians):0,truckShare:Number.isFinite(next.truckShare)?Math.max(0,Math.min(1,next.truckShare)):0,hour:Number.isFinite(next.hour)?next.hour:12};},
  setAgents(next:readonly MobilityAgent[]){
   const wanted=new Set(next.map(a=>a.id));for(const id of external)if(!wanted.has(id)){agents.delete(id);retired.delete(id);}external=wanted;
   for(const requested of next){
    if(retired.has(requested.id)||!valid(requested)||!Number.isFinite(requested.distanceM)||!Number.isFinite(requested.speedMps)||!Number.isInteger(requested.edgeIndex)||requested.edgeIndex<0||requested.edgeIndex>=requested.route.length)continue;
    const existing=agents.get(requested.id);
    if(existing&&existing.kind===requested.kind&&existing.route.join('|')===requested.route.join('|')){existing.speedMps=Math.max(0,requested.speedMps);continue;}
    if(!existing&&agents.size>=CAP)break;
    const length=network.edges.get(requested.route[requested.edgeIndex])!.lengthM;
    if(!existing&&[...agents.values()].some(other=>other.route[other.edgeIndex]===requested.route[requested.edgeIndex]&&lane(other)===lane(requested)&&Math.abs(other.distanceM-requested.distanceM)<(MOBILITY_LENGTH[other.kind]+MOBILITY_LENGTH[requested.kind])/2+2))continue;
    agents.set(requested.id,{...requested,route:[...requested.route],distanceM:Math.max(0,Math.min(length,requested.distanceM)),speedMps:Math.max(0,requested.speedMps)});
   }
  },
  setSurface(resolve:(point:Point,edge:MobilityEdge)=>number|null){surface=resolve;},
  advance(seconds:number){
   if(!Number.isFinite(seconds)||seconds<=0)return;
   accumulator+=Math.min(.25,seconds);generate();while(accumulator+1e-10>=STEP){step();accumulator-=STEP;}
  },
  agents():readonly MobilityAgent[]{return [...agents.values()].map(a=>({...a,route:[...a.route]}));},
  signals():readonly MobilitySignal[]{return [...intersections].map(nodeId=>({nodeId,point:network.nodes.get(nodeId)!.point,phase:phase(),method:'simulated'}));},
  frame():readonly MobilityFrameAgent[]{
   return [...agents.values()].flatMap(agent=>{
    const edge=network.edges.get(agent.route[agent.edgeIndex]);if(!edge)return [];
    let shape=geometry.get(edge);if(!shape){const parts:number[]=[];let length=0;for(let i=1;i<edge.path.length;i++){const a=edge.path[i-1],b=edge.path[i],part=Math.hypot(b.x-a.x,b.y-a.y);parts.push(part);length+=part;}shape={length,parts};geometry.set(edge,shape);}
    let distance=Math.min(1,agent.distanceM/edge.lengthM)*shape.length,index=0;
    while(index<shape.parts.length-1&&distance>shape.parts[index]){distance-=shape.parts[index];index++;}
    const a=edge.path[index],b=edge.path[index+1],length=shape.parts[index]||1,t=Math.min(1,distance/length),dx=b.x-a.x,dy=b.y-a.y,point={x:a.x+dx*t,y:a.y+dy*t};
    return [{id:agent.id,kind:agent.kind,point,heading:{x:dx/length,y:dy/length},elevationM:surface(point,edge),seed:agent.seed,method:'simulated' as const,tripId:agent.tripId}];
   });
  },
 };
}
