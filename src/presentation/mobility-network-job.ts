import type {GeographicTile} from './geographic-map';
import {tileKey} from './geographic-map';
import type {MobilityNetwork} from './mobility-model';
import {buildGeographicNetwork,buildGeographicNetworkAsync} from './mobility-network';
import {prepareMobilityRuntime} from './mobility-runtime';
export type NetworkRequest={ticket:number;revision:string;tiles:readonly GeographicTile[];maxEdges:number};
export type NetworkResult={ticket:number;network:MobilityNetwork;limited:boolean;acceptedTileKeys:readonly string[]};
export function buildNetworkJob(request:NetworkRequest):NetworkResult{
 const limit=Math.max(0,Math.floor(request.maxEdges));let accepted=[...request.tiles],network=buildGeographicNetwork(accepted.flatMap(t=>t.features),request.revision);
 while(network.edges.size>limit&&accepted.length){accepted=accepted.slice(0,Math.max(0,accepted.length-Math.max(1,Math.ceil(accepted.length*.2))));network=buildGeographicNetwork(accepted.flatMap(t=>t.features),request.revision);}
 return {ticket:request.ticket,network:{...network,runtime:prepareMobilityRuntime(network)},limited:accepted.length<request.tiles.length,acceptedTileKeys:accepted.map(tileKey)};
}
export function createNetworkJobQueue(build:(request:NetworkRequest)=>Promise<NetworkResult>,publish:(result:NetworkResult)=>void){
 let active=false,pending:NetworkRequest|undefined,latest=-1,disposed=false;
 const run=(request:NetworkRequest)=>{active=true;void build(request).then(result=>{if(!disposed&&result.ticket===latest)publish(result);}).catch(()=>{}).finally(()=>{active=false;if(!disposed&&pending){const next=pending;pending=undefined;run(next);}});};
 return {submit(request:NetworkRequest){if(disposed)return;latest=request.ticket;if(active)pending=request;else run(request);},dispose(){disposed=true;pending=undefined;},stats:()=>({active:Number(active),pending:Number(!!pending)})};
}

// Unsupported-worker hosts prepare smaller complete tile regions, yielding between bounded chunks.
export async function buildNetworkJobAsync(request:NetworkRequest,cancelled:()=>boolean=()=>false):Promise<NetworkResult>{
 let vertices=0;const tiles=request.tiles.filter(t=>{const size=t.features.reduce((n,f)=>n+f.geometry.reduce((n,r)=>n+r.length,0),0);if(vertices+size>6000)return false;vertices+=size;return true;}).slice(0,4);
 const limit=Math.min(20000,Math.max(0,Math.floor(request.maxEdges)));let accepted=tiles,network=await buildGeographicNetworkAsync(accepted.flatMap(t=>t.features),request.revision,cancelled);
 while(network.edges.size>limit&&accepted.length){accepted=accepted.slice(0,-1);network=await buildGeographicNetworkAsync(accepted.flatMap(t=>t.features),request.revision,cancelled);}
 await new Promise<void>(resolve=>(globalThis as unknown as {setTimeout(callback:()=>void,ms:number):unknown}).setTimeout(resolve,0));if(cancelled())throw new Error('Mobility preparation cancelled');
 return {ticket:request.ticket,network:{...network,runtime:prepareMobilityRuntime(network)},limited:accepted.length<request.tiles.length,acceptedTileKeys:accepted.map(tileKey)};
}
