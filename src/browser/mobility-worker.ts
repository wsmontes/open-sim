import {prepareMobilityFleet,type FleetRequest,type FleetResult} from '../presentation/mobility-fleet';
import type {MobilityNetwork} from '../presentation/mobility-model';
import {createVisualTileDecoder,MOBILITY_LAYERS} from './visual-tile-decoder';
import {buildNetworkJob,type NetworkRequest,type NetworkResult} from '../presentation/mobility-network-job';
const scope=globalThis as unknown as {onmessage:(event:{data:NetworkRequest|FleetRequest})=>void;postMessage:(result:NetworkResult|FleetResult)=>void};
const decoder=createVisualTileDecoder(8*1024*1024,MOBILITY_LAYERS);
let network:MobilityNetwork|undefined,transit:FleetRequest['input']['transit']=null;
scope.onmessage=event=>{const request=event.data;if('fleetTicket' in request){if(!request.reuseTransit)transit=request.input.transit;scope.postMessage({fleetTicket:request.fleetTicket,revision:request.revision,agents:network?.revision===request.revision?prepareMobilityFleet(network,{...request.input,transit}):[]});return;}const result=buildNetworkJob({...request,tiles:request.tiles.map(t=>decoder.decode(t))});network=result.network;scope.postMessage(result);};
