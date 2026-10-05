import type {MobilityAgent} from './mobility-model';
import type {TransitRoutePattern} from './transit-routes';
export function routeBuses(patterns:readonly TransitRoutePattern[],seed:number):readonly MobilityAgent[]{
 const seen=new Set<string>(),buses:MobilityAgent[]=[];
 for(const pattern of patterns){
  if(seen.has(pattern.id)||!pattern.edges.length||pattern.edgeLengthsM.length!==pattern.edges.length||pattern.edgeLengthsM.some(m=>!Number.isFinite(m)||m<=0))continue;seen.add(pattern.id);
  const length=pattern.edgeLengthsM.reduce((sum,m)=>sum+m,0);
  for(let slot=0;slot<2&&buses.length<480;slot++){
   let distanceM=slot*length/2,edgeIndex=0;while(edgeIndex<pattern.edges.length-1&&distanceM>=pattern.edgeLengthsM[edgeIndex])distanceM-=pattern.edgeLengthsM[edgeIndex++];
   buses.push({id:`bus:${seed}:${pattern.id}:${slot}`,kind:'bus',patternId:pattern.id,tripId:pattern.id,route:pattern.edges,edgeIndex,distanceM,speedMps:8.3,stopsM:pattern.stopDistancesM,seed:(seed^Math.imul(slot+1,2654435761))>>>0});
  }
 }
 return buses;
}
