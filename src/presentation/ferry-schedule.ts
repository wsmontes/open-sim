import type {FerryScheduleCapture,MarineRoute,MarinePoint,ScheduledSailing} from '../core/maritime-data';
import type {VesselFrame} from './maritime-engine';
const distance=(a:MarinePoint,b:MarinePoint)=>{const r=Math.PI/180,dy=(b.lat-a.lat)*r,dx=(b.lon-a.lon)*r;return 12742017.6*Math.asin(Math.min(1,Math.sqrt(Math.sin(dy/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dx/2)**2)));};
type PreparedSailing={sailing:ScheduledSailing;route:MarineRoute;lengths:readonly number[];anchors:readonly number[];calls:readonly {depart:number;arrive:number}[];first:number;last:number};
type ScheduleRuntime={sailings:readonly PreparedSailing[];now?:number;snapshot?:readonly VesselFrame[]};
const prepared=new WeakMap<FerryScheduleCapture,WeakMap<readonly MarineRoute[],ScheduleRuntime>>();
function runtime(schedule:FerryScheduleCapture,routes:readonly MarineRoute[]):ScheduleRuntime{
 let byRoutes=prepared.get(schedule);if(!byRoutes){byRoutes=new WeakMap();prepared.set(schedule,byRoutes);}const known=byRoutes.get(routes);if(known)return known;
 const routeById=new Map(routes.filter(r=>r.verified&&r.allowed.includes('bc-ferry')).map(r=>[r.id,r])),geometry=new Map<MarineRoute,number[]>(),sailings:PreparedSailing[]=[];
 for(const sailing of schedule.sailings){if(sailing.status!=='scheduled'||sailing.serviceDate<schedule.validFrom||sailing.serviceDate>schedule.validUntil)continue;const route=routeById.get(sailing.routeId);if(!route||sailing.calls.length>2&&!route.terminalPathIndices)continue;
  let lengths=geometry.get(route);if(!lengths){lengths=[0];for(let i=1;i<route.path.length;i++)lengths.push(lengths.at(-1)!+distance(route.path[i-1],route.path[i]));geometry.set(route,lengths);}
  sailings.push({sailing,route,lengths,anchors:route.terminalPathIndices??[0,route.path.length-1],calls:sailing.calls.slice(0,-1).map((a,i)=>({depart:Date.parse(a.departureInstant??''),arrive:Date.parse(sailing.calls[i+1].arrivalInstant??'')})),first:Date.parse(sailing.calls[0].departureInstant??''),last:Date.parse(sailing.calls.at(-1)?.arrivalInstant??'')});
 }
 const result={sailings};byRoutes.set(routes,result);return result;
}
export function scheduledFerryFrames(schedule:FerryScheduleCapture,routes:readonly MarineRoute[],instant:string):readonly VesselFrame[]{
 const now=Date.parse(instant);if(!Number.isFinite(now))return [];const known=runtime(schedule,routes);if(known.now===now&&known.snapshot)return known.snapshot;const frames:VesselFrame[]=[];
 for(const {sailing,route,first,last,lengths,anchors,calls} of known.sailings){if(!(first<=now&&now<last))continue;let index=0,progress=0,phase:VesselFrame['phase']='sailing',speed=0;
  for(let i=0;i<calls.length;i++){const {depart,arrive}=calls[i];if(now<depart&&i>0){index=anchors[i];progress=0;phase='berthed';break;}if(now>=depart&&now<arrive){const start=lengths[anchors[i]],end=lengths[anchors[i+1]],elapsed=(now-depart)/(arrive-depart),smooth=elapsed*elapsed*(3-2*elapsed),target=start+(end-start)*smooth;let lo=0,hi=lengths.length-2;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(target>lengths[mid+1])lo=mid+1;else hi=mid;}index=lo;progress=(target-lengths[index])/(lengths[index+1]-lengths[index]||1);phase=elapsed<.05?'departing':elapsed>.95?'approach':'sailing';speed=(end-start)*6*elapsed*(1-elapsed)/((arrive-depart)/1000);break;}}
  const a=route.path[index],b=route.path[Math.min(index+1,route.path.length-1)],position={lat:a.lat+(b.lat-a.lat)*progress,lon:a.lon+(b.lon-a.lon)*progress};frames.push({id:`bc-ferry:${sailing.id}`,kind:'bc-ferry',operator:route.operator,routeId:route.id,position,headingDegrees:(Math.atan2((b.lon-a.lon)*Math.cos(position.lat*Math.PI/180),b.lat-a.lat)*180/Math.PI+360)%360,phase,waterElevationM:0,method:'schedule-estimate',speedMps:speed,vesselName:sailing.vesselName});if(frames.length>=24)break;
 }
 known.now=now;return known.snapshot=Object.freeze(frames);
}
