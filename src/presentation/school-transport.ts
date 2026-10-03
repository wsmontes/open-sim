import {WORLD} from '../core/coordinates';
import type {SchoolSite} from '../core/traffic-data';
import type {MobilityAgent,MobilityNetwork} from './mobility-model';
import {findMobilityRoute} from './mobility-network';
import {metresPerCellAt} from './terrain-surface';
// Weekday peak windows are scenario assumptions, not the VSB calendar or routes.
export function schoolBusAgents(schools:readonly SchoolSite[],network:MobilityNetwork,scenarioInstant:string,seed:number):readonly MobilityAgent[]{
 const date=new Date(scenarioInstant);if(!Number.isFinite(date.getTime()))return [];
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Vancouver',weekday:'short',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(date),part=(k:string)=>parts.find(p=>p.type===k)!.value;
 const time=Number(part('hour'))*60+Number(part('minute'));if(['Sat','Sun'].includes(part('weekday'))||!(time>=450&&time<540||time>=870&&time<990))return [];
 const out:MobilityAgent[]=[],seen=new Set<string>(),nodes=[...network.nodes.values()].filter(n=>n.level===0&&network.outgoing.get(n.id)?.some(id=>network.edges.get(id)!.allowed.includes('school-bus')));
 for(const school of schools){if(out.length>=6)break;if(seen.has(school.id)||school.source.method!=='reported')continue;seen.add(school.id);
  const p={x:(school.lon+180)/360*WORLD,y:(1-Math.asinh(Math.tan(school.lat*Math.PI/180))/Math.PI)/2*WORLD},scale=metresPerCellAt(school.lat),distance=(n:typeof nodes[number])=>Math.hypot(n.point.x-p.x,n.point.y-p.y)*scale;
  const target=[...nodes].sort((a,b)=>distance(a)-distance(b)||a.id.localeCompare(b.id))[0];if(!target||distance(target)>100)continue;
  const origins=nodes.filter(n=>distance(n)>=300&&distance(n)<=2000).sort((a,b)=>a.id.localeCompare(b.id));
  for(const origin of origins){const route=findMobilityRoute(network,origin.id,target.id,'school-bus');if(!route?.length)continue;const length=route.reduce((n,id)=>n+network.edges.get(id)!.lengthM,0);
   out.push({id:`school:${seed}:${school.id}`,kind:'school-bus',route,edgeIndex:0,distanceM:0,speedMps:8,seed,stopsM:[length*.4,length],dwellSeconds:20,schoolId:school.id,schoolName:school.name});break;
  }
 }
 return out;
}
export function policePatrolAgents(network:MobilityNetwork,seed:number):readonly MobilityAgent[]{
 const pool=[...network.edges.values()].filter(e=>e.allowed.includes('police')).sort((a,b)=>a.id.localeCompare(b.id)),out:MobilityAgent[]=[];
 for(let slot=0;slot<2&&slot<pool.length;slot++){let edge=pool[((seed>>>0)+slot*Math.floor(pool.length/2))%pool.length],length=0;const route:string[]=[];let state=((seed>>>0)+slot+1)>>>0;
  for(let i=0;i<128&&length<800;i++){route.push(edge.id);length+=edge.lengthM;const next=(network.outgoing.get(edge.to)??[]).map(id=>network.edges.get(id)!).filter(e=>e.allowed.includes('police'));if(!next.length)break;const forward=next.filter(e=>e.to!==edge.from),choices=forward.length?forward:next;state=(Math.imul(state,1664525)+1013904223)>>>0;edge=choices[state%choices.length];}
  out.push({id:`patrol:${seed}:${slot}`,kind:'police',route,edgeIndex:0,distanceM:0,speedMps:9,seed:seed+slot,patternId:`patrol:${slot}`});
 }
 return out;
}
