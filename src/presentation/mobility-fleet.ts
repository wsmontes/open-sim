import type {TransitContent} from '../core/transit-data';
import type {SchoolSite} from '../core/traffic-data';
import type {MobilityAgent,MobilityNetwork} from './mobility-model';
import {buildTransitPatterns} from './transit-routes';
import {routeBuses} from './transit-motion';
import {policePatrolAgents,schoolBusAgents} from './school-transport';
export type FleetInput={seed:number;transit:TransitContent|null;schools:readonly SchoolSite[];civic:boolean;instant:string;transitVersion?:number};
export type FleetRequest={fleetTicket:number;revision:string;input:FleetInput;reuseTransit?:boolean};
export type FleetResult={fleetTicket:number;revision:string;agents:readonly MobilityAgent[]};
const fleetBases=new WeakMap<MobilityNetwork,{version:number|undefined;seed:number;buses:readonly MobilityAgent[];police:readonly MobilityAgent[]}>();
export function prepareMobilityFleet(network:MobilityNetwork,input:FleetInput):readonly MobilityAgent[]{
 let base=fleetBases.get(network);if(!base||base.version!==input.transitVersion||base.seed!==input.seed||input.transitVersion===undefined){base={version:input.transitVersion,seed:input.seed,buses:input.transit?routeBuses(buildTransitPatterns(input.transit,network),input.seed):[],police:policePatrolAgents(network,input.seed)};fleetBases.set(network,base);}
 return [...base.buses,...(input.civic?base.police:[]),...schoolBusAgents(input.schools,network,input.instant,input.seed)];
}
// A host without workers uses smaller topology and yields between individual trip patterns.
export async function prepareMobilityFleetAsync(network:MobilityNetwork,input:FleetInput,cancelled:()=>boolean):Promise<readonly MobilityAgent[]>{
 const agents:MobilityAgent[]=[],seen=new Set<string>();
 const yieldInput=async()=>{await new Promise<void>(r=>(globalThis as unknown as {setTimeout(callback:()=>void,ms:number):unknown}).setTimeout(r,0));if(cancelled())throw new Error('Fleet preparation cancelled');};
 if(input.transit)for(const route of input.transit.routes)for(const trip of route.trips){const key=JSON.stringify([route.providerId,trip.shapeId,trip.directionId,trip.stops.map(s=>s.stopId)]);if(seen.has(key))continue;seen.add(key);await yieldInput();const patterns=buildTransitPatterns({...input.transit,routes:[{...route,trips:[trip]}]},network,()=>{},256);agents.push(...routeBuses(patterns,input.seed));}
 await yieldInput();if(input.civic)agents.push(...policePatrolAgents(network,input.seed));
 for(const school of input.schools){await yieldInput();agents.push(...schoolBusAgents([school],network,input.instant,input.seed,256));if(agents.filter(a=>a.kind==='school-bus').length>=6)break;}
 return agents;
}
