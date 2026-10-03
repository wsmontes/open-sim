import type {FerryScheduleCapture,MarineRoute,MarinePoint} from '../core/maritime-data';
import type {VesselFrame} from './maritime-engine';
const distance=(a:MarinePoint,b:MarinePoint)=>{const r=Math.PI/180,dy=(b.lat-a.lat)*r,dx=(b.lon-a.lon)*r;return 12742017.6*Math.asin(Math.min(1,Math.sqrt(Math.sin(dy/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dx/2)**2)));};
export function scheduledFerryFrames(schedule:FerryScheduleCapture,routes:readonly MarineRoute[],instant:string):readonly VesselFrame[]{
 const now=Date.parse(instant);if(!Number.isFinite(now))return [];const frames:VesselFrame[]=[];
 for(const sailing of schedule.sailings){if(sailing.status!=='scheduled'||sailing.serviceDate<schedule.validFrom||sailing.serviceDate>schedule.validUntil)continue;const route=routes.find(r=>r.id===sailing.routeId&&r.verified&&r.allowed.includes('bc-ferry'));if(!route)continue;const first=Date.parse(sailing.calls[0].departureInstant??''),last=Date.parse(sailing.calls.at(-1)?.arrivalInstant??'');if(!(first<=now&&now<last))continue;
  const lengths=[0];for(let i=1;i<route.path.length;i++)lengths.push(lengths.at(-1)!+distance(route.path[i-1],route.path[i]));let index=0,progress=0,phase:VesselFrame['phase']='sailing',speed=0;
  // Intermediate terminal vertices must be explicit and source-validated.
  if(sailing.calls.length>2&&!route.terminalPathIndices)continue;
  const anchors=route.terminalPathIndices??[0,route.path.length-1];
  for(let i=0;i<sailing.calls.length-1;i++){const a=sailing.calls[i],b=sailing.calls[i+1],depart=Date.parse(a.departureInstant??''),arrive=Date.parse(b.arrivalInstant??'');if(now<depart&&i>0){index=anchors[i];progress=0;phase='berthed';break;}if(now>=depart&&now<arrive){const start=lengths[anchors[i]],end=lengths[anchors[i+1]],elapsed=(now-depart)/(arrive-depart),smooth=elapsed*elapsed*(3-2*elapsed),target=start+(end-start)*smooth;while(index<lengths.length-2&&target>lengths[index+1])index++;progress=(target-lengths[index])/(lengths[index+1]-lengths[index]||1);phase=elapsed<.05?'departing':elapsed>.95?'approach':'sailing';speed=(end-start)*6*elapsed*(1-elapsed)/((arrive-depart)/1000);break;}}
  const a=route.path[index],b=route.path[Math.min(index+1,route.path.length-1)],position={lat:a.lat+(b.lat-a.lat)*progress,lon:a.lon+(b.lon-a.lon)*progress};frames.push({id:`bc-ferry:${sailing.id}`,kind:'bc-ferry',operator:route.operator,routeId:route.id,position,headingDegrees:(Math.atan2((b.lon-a.lon)*Math.cos(position.lat*Math.PI/180),b.lat-a.lat)*180/Math.PI+360)%360,phase,waterElevationM:0,method:'schedule-estimate',speedMps:speed,vesselName:sailing.vesselName});if(frames.length>=24)break;
 }return frames;
}
