import type {TransitContent} from '../core/transit-data';
import type {MobilityNetwork,MobilityEdge,MobilityNode} from './mobility-model';
import type {Point} from './camera';
import {WORLD} from '../core/coordinates';
import {metresPerCellAt} from './terrain-surface';
import {findMobilityRoute} from './mobility-network';
export type TransitRoutePattern={id:string;routeId:string;shapeId?:string;directionId?:string;edges:readonly string[];stopDistancesM:readonly number[];method:'reported'|'derived';networkRevision:string};
export type TransitPatternFailure={id:string;reason:'missing-stop'|'missing-shape'|'outside-network'|'disconnected';stopIndex?:number;fromNode?:string;toNode?:string};
const point=(geo:{lat:number;lon:number}):Point=>({x:(geo.lon+180)/360*WORLD,y:(1-Math.log(Math.tan(Math.PI/4+geo.lat*Math.PI/360))/Math.PI)/2*WORLD});
const distanceToSegment=(p:Point,a:Point,b:Point)=>{const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p.x-a.x-dx*t,p.y-a.y-dy*t);};
export function buildTransitPatterns(dataset:TransitContent,network:MobilityNetwork,report:(failure:TransitPatternFailure)=>void=()=>{}):readonly TransitRoutePattern[]{
 const stops=new Map(dataset.stops.map(s=>[s.providerId,s])),shapes=new Map(dataset.shapes.map(s=>[s.id,s])),seen=new Set<string>(),patterns:TransitRoutePattern[]=[];
 const buckets=new Map<string,MobilityNode[]>(),bucket=32;
 for(const node of network.nodes.values()){const key=`${Math.floor(node.point.x/bucket)}:${Math.floor(node.point.y/bucket)}`,list=buckets.get(key)??[];list.push(node);buckets.set(key,list);}
 for(const route of dataset.routes){if(route.type!==3)continue;
  for(const trip of route.trips){
   const id=JSON.stringify([route.providerId,trip.shapeId??null,trip.directionId??null,trip.stops.map(s=>s.stopId)]);if(seen.has(id))continue;seen.add(id);
   const fail=(reason:TransitPatternFailure['reason'],details:Partial<TransitPatternFailure>={})=>report({id,reason,...details});
   const declared=trip.stops.map(s=>stops.get(s.stopId));if(declared.some(s=>!s)){fail('missing-stop');continue;}
   const coordinates=declared.map(s=>point(s!)),m=metresPerCellAt(declared[0]?.lat??0),radius=75/m;
   const shape=trip.shapeId?shapes.get(trip.shapeId):undefined;if(trip.shapeId&&!shape){fail('missing-shape');continue;}
   const geometry=shape?[...shape.points].sort((a,b)=>a.sequence-b.sequence).map(point):undefined;
   // A narrow corridor prevents the shortest path from replacing an operator's route with a shortcut across town.
   const corridor=new Map<string,Point[]>();
   if(geometry)for(let i=1;i<geometry.length;i++){
    const a=geometry[i-1],b=geometry[i];for(let x=Math.floor((Math.min(a.x,b.x)-radius)/bucket);x<=Math.floor((Math.max(a.x,b.x)+radius)/bucket);x++)for(let y=Math.floor((Math.min(a.y,b.y)-radius)/bucket);y<=Math.floor((Math.max(a.y,b.y)+radius)/bucket);y++){
     const key=`${x}:${y}`,list=corridor.get(key)??[];list.push(a,b);corridor.set(key,list);
    }
   }
   const inCorridor=(p:Point)=>{if(!geometry)return true;const parts=corridor.get(`${Math.floor(p.x/bucket)}:${Math.floor(p.y/bucket)}`)??[];for(let i=0;i<parts.length;i+=2)if(distanceToSegment(p,parts[i],parts[i+1])<=radius)return true;return false;};
   const candidates=new Set<string>();
   if(geometry)for(const [key,parts] of corridor){for(const node of buckets.get(key)??[]){if(parts.length&&inCorridor(node.point))candidates.add(node.id);}}
   const edges=new Map<string,MobilityEdge>(),outgoing=new Map<string,string[]>();
   for(const node of geometry?[...candidates].map(id=>network.nodes.get(id)!):network.nodes.values())for(const edgeId of network.outgoing.get(node.id)??[]){
    const edge=network.edges.get(edgeId)!;if(!edge.allowed.includes('bus')||geometry&&(!candidates.has(edge.to)||!edge.path.every(inCorridor)))continue;
    edges.set(edgeId,edge);const list=outgoing.get(edge.from)??[];list.push(edgeId);outgoing.set(edge.from,list);
   }
   const validNodes=new Set([...edges.values()].flatMap(e=>[e.from,e.to]));
   const restricted:MobilityNetwork={...network,edges,outgoing};
   const nearest=(p:Point)=>{
    const found:{node:MobilityNode;offsetM:number}[]=[];
    for(let x=Math.floor((p.x-radius)/bucket);x<=Math.floor((p.x+radius)/bucket);x++)for(let y=Math.floor((p.y-radius)/bucket);y<=Math.floor((p.y+radius)/bucket);y++)for(const node of buckets.get(`${x}:${y}`)??[]){
     if(!validNodes.has(node.id))continue;
     const d=Math.hypot(node.point.x-p.x,node.point.y-p.y);if(d<=radius)found.push({node,offsetM:d*m});
    }
    return found.sort((a,b)=>a.offsetM-b.offsetM||a.node.id.localeCompare(b.node.id)).slice(0,8);
   };
   const anchors=coordinates.map(nearest);if(anchors.some(list=>!list.length)){fail('outside-network');continue;}
   type Match={node:string;cost:number;length:number;path:string[];distances:number[]};
   let states:Match[]=(anchors[0]??[]).map(a=>({node:a.node.id,cost:a.offsetM*4,length:0,path:[],distances:[0]}));
   for(let i=1;i<anchors.length;i++){
    const next:Match[]=[];
    for(const anchor of anchors[i]){
     let best:Match|undefined;
     for(const previous of states){
      const part=previous.node===anchor.node.id?[]:findMobilityRoute(restricted,previous.node,anchor.node.id,'bus');if(!part)continue;
      const distance=part.reduce((sum,id)=>sum+edges.get(id)!.lengthM,0),cost=previous.cost+distance+anchor.offsetM*4,length=previous.length+distance;
      if(!best||cost<best.cost)best={node:anchor.node.id,cost,length,path:[...previous.path,...part],distances:[...previous.distances,length]};
     }
     if(best)next.push(best);
    }
    states=next;if(!states.length){fail('disconnected',{stopIndex:i});break;}
   }
   const best=states.sort((a,b)=>a.cost-b.cost)[0];if(!best)continue;
   const path=best.path,distances=best.distances;if(!path.length){fail('disconnected');continue;}
   patterns.push({id,routeId:route.providerId,...(trip.shapeId?{shapeId:trip.shapeId}:{}),...(trip.directionId?{directionId:trip.directionId}:{}),edges:path,stopDistancesM:distances,method:'derived',networkRevision:network.revision});
  }
 }
 return patterns;
}
