import {WORLD} from '../core/coordinates';
import type {TrafficCount} from '../core/traffic-data';
import type {MobilityDemand,MobilityNetwork} from './mobility-model';
import {metresPerCellAt} from './terrain-surface';
// Rates remain in observations/hour here. The presentation host must choose an
// explicit sampling scale before converting them into visible agent targets.
export function calibrateDemand(network:MobilityNetwork,counts:readonly TrafficCount[],instant:string):ReadonlyMap<string,MobilityDemand>{
 const time=Date.parse(instant),matched=new Map<string,Map<TrafficCount['vehicleClass'],number>>();
 if(!Number.isFinite(time))return new Map();
 for(const count of counts){
  const from=Date.parse(count.from),to=Date.parse(count.to);if(!(from<=time&&time<to)||!Number.isFinite(count.count)||count.count<0)continue;
  const p={x:(count.lon+180)/360*WORLD,y:(1-Math.asinh(Math.tan(count.lat*Math.PI/180))/Math.PI)/2*WORLD},scale=metresPerCellAt(count.lat);
  let best:string|undefined,bestDistance=25+1e-8,ambiguous=false;
  for(const edge of network.edges.values()){
   if(edge.level!==0||!edge.allowed.includes(count.vehicleClass==='pedestrian'?'pedestrian':count.vehicleClass==='truck'?'truck':'car'))continue;
   for(let i=1;i<edge.path.length;i++){
    const a=edge.path[i-1],b=edge.path[i],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;if(!l2)continue;
    const bearing=(Math.atan2(dx,-dy)*180/Math.PI+360)%360;
    if(count.direction!==undefined&&Math.abs(((bearing-count.direction+540)%360)-180)>30)continue;
    const px=p.x+Math.round((a.x-p.x)/WORLD)*WORLD,t=Math.max(0,Math.min(1,((px-a.x)*dx+(p.y-a.y)*dy)/l2));
    const distance=Math.hypot(px-a.x-t*dx,p.y-a.y-t*dy)*scale;
    if(distance<bestDistance-1e-7){best=edge.id;bestDistance=distance;ambiguous=false;}
    else if(best!==edge.id&&Math.abs(distance-bestDistance)<1e-7)ambiguous=true;
   }
  }
  if(!best||ambiguous)continue;
  const rates=matched.get(best)??new Map();if(!matched.has(best))matched.set(best,rates);
  // Duplicate overlapping observations do not multiply demand. Prefer the highest
  // declared volume, keeping all-vehicles separate from class-specific observations.
  rates.set(count.vehicleClass,Math.max(rates.get(count.vehicleClass)??0,count.count*3600000/(to-from)));
 }
 const out=new Map<string,MobilityDemand>();
 for(const [id,rates] of matched){const classified=(rates.get('car')??0)+(rates.get('truck')??0),vehicles=rates.get('all-vehicles')??classified;out.set(id,{vehicles,pedestrians:rates.get('pedestrian')??0,truckShare:vehicles?Math.min(1,(rates.get('truck')??0)/vehicles):0,hour:Number(new Intl.DateTimeFormat('en-CA',{timeZone:'America/Vancouver',hour:'numeric',hourCycle:'h23'}).format(time)),volumeUnit:'per-hour',method:'derived'});}
 return out;
}
