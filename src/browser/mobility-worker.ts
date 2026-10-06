import {prepareMobilityFleet,type FleetRequest,type FleetResult} from '../presentation/mobility-fleet';
import type {MobilityNetwork} from '../presentation/mobility-model';
import {createMobilityGeography} from './mobility-geography';
import {buildNetworkJob,type NetworkRequest,type NetworkResult} from '../presentation/mobility-network-job';
const scope=globalThis as unknown as {onmessage:(event:{data:NetworkRequest|FleetRequest})=>void;postMessage:(result:NetworkResult|FleetResult)=>void};
let network:MobilityNetwork|undefined,transit:FleetRequest['input']['transit']=null;
scope.onmessage=event=>{const request=event.data;if('fleetTicket' in request){if(!request.reuseTransit)transit=request.input.transit;scope.postMessage({fleetTicket:request.fleetTicket,revision:request.revision,agents:network?.revision===request.revision?prepareMobilityFleet(network,{...request.input,transit}):[]});return;}const decoder=createMobilityGeography(request.geometryBytes??8*1024*1024),tiles=request.tiles.flatMap(tile=>{const decoded=decoder.decode(tile);return decoded?[decoded]:[];}),result=buildNetworkJob({...request,tiles});if(!request.tiles.length)transit=null;network=result.network;scope.postMessage({...result,limited:result.limited||decoder.stats().limited||tiles.length<request.tiles.length});};
