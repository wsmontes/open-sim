import type {Point} from './camera';
import type {GeographicTile} from './geographic-map';
import {tileKey} from './geographic-map';
import type {MobilityNetwork} from './mobility-model';
import {buildGeographicNetwork,buildGeographicNetworkAsync,NetworkBudgetExceeded,type NetworkConstructionBudget} from './mobility-network';
import {prepareMobilityRuntime} from './mobility-runtime';
export type NetworkRequest={ticket:number;revision:string;tiles:readonly GeographicTile[];maxEdges:number;geometryBytes?:number;center?:Point};
export type NetworkResult={ticket:number;network:MobilityNetwork;limited:boolean;acceptedTileKeys:readonly string[]};
const edgeLimit=(value:number)=>Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
const budgetFor=(maxEdges:number):NetworkConstructionBudget=>({maxEdges,maxSegments:maxEdges,maxComparisons:Math.max(4096,maxEdges*32)});
function selectWithinBudget(tiles:readonly GeographicTile[],maxEdges:number,center?:Point){
 const accepted:GeographicTile[]=[];let estimated=0,limited=false;
 for(const tile of tiles){
  const paths=tile.features.flatMap(feature=>feature.layer==='streets'&&feature.type===2?feature.geometry.map(path=>({feature,path,cost:Math.max(0,path.length-1)*(feature.oneway===1||feature.oneway===-1?1:2),distance:center&&path.length?Math.min(...[path[0],path[path.length-1]].map(p=>Math.hypot(p.x-center.x,p.y-center.y))):0})):[]);
  const edges=paths.reduce((sum,p)=>sum+p.cost,0);
  if(estimated+edges<=maxEdges){estimated+=edges;accepted.push(tile);continue;}
  limited=true;const features:GeographicTile['features']=[];
  // Complete paths preserve reported direction and bridge/tunnel identity. Never invent clipped endpoints.
  for(const candidate of paths.sort((a,b)=>a.distance-b.distance)){if(!candidate.cost||estimated+candidate.cost>maxEdges)continue;estimated+=candidate.cost;features.push({...candidate.feature,geometry:[candidate.path]});}
  if(features.length)accepted.push({...tile,features});
 }
 return {accepted,limited};
}
function shrinkSelection(accepted:GeographicTile[]){
 const last=accepted[accepted.length-1],paths=last.features.flatMap(feature=>feature.geometry.map(path=>({feature,path})));
 if(paths.length<=1)return accepted.slice(0,-1);
 return [...accepted.slice(0,-1),{...last,features:paths.slice(0,Math.floor(paths.length/2)).map(({feature,path})=>({...feature,geometry:[path]}))}];
}

export function buildNetworkJob(request:NetworkRequest):NetworkResult{
 const limit=edgeLimit(request.maxEdges),budget=budgetFor(limit);const selection=selectWithinBudget(request.tiles,limit,request.center);let accepted=selection.accepted,limited=selection.limited;
 let network:MobilityNetwork;
 for(;;){try{network=buildGeographicNetwork(accepted.flatMap(t=>t.features),request.revision,budget);break;}catch(error){if(!(error instanceof NetworkBudgetExceeded)||!accepted.length)throw error;accepted=shrinkSelection(accepted);limited=true;}}
 return {ticket:request.ticket,network:{...network,runtime:prepareMobilityRuntime(network)},limited:limited||accepted.length<request.tiles.length,acceptedTileKeys:accepted.map(tileKey)};
}
export function createNetworkJobQueue(build:(request:NetworkRequest)=>Promise<NetworkResult>,publish:(result:NetworkResult)=>void){
 let active=false,pending:NetworkRequest|undefined,latest=-1,disposed=false;
 const run=(request:NetworkRequest)=>{active=true;void build(request).then(result=>{if(!disposed&&result.ticket===latest)publish(result);}).catch(()=>{}).finally(()=>{active=false;if(!disposed&&pending){const next=pending;pending=undefined;run(next);}});};
 return {submit(request:NetworkRequest){if(disposed)return;latest=request.ticket;if(active)pending=request;else run(request);},dispose(){disposed=true;pending=undefined;},stats:()=>({active:Number(active),pending:Number(!!pending)})};
}

// Unsupported-worker hosts prepare smaller complete tile regions, yielding between bounded chunks.
export async function buildNetworkJobAsync(request:NetworkRequest,cancelled:()=>boolean=()=>false):Promise<NetworkResult>{
 let vertices=0;const tiles=request.tiles.filter(t=>{const size=t.features.reduce((n,f)=>n+f.geometry.reduce((n,r)=>n+r.length,0),0);if(vertices+size>6000)return false;vertices+=size;return true;}).slice(0,4);
 const limit=Math.min(20000,edgeLimit(request.maxEdges)),budget=budgetFor(limit);const selection=selectWithinBudget(tiles,limit,request.center);let accepted=selection.accepted,limited=selection.limited,network:MobilityNetwork;
 for(;;){try{network=await buildGeographicNetworkAsync(accepted.flatMap(t=>t.features),request.revision,cancelled,budget);break;}catch(error){if(!(error instanceof NetworkBudgetExceeded)||!accepted.length)throw error;accepted=shrinkSelection(accepted);limited=true;}}
 await new Promise<void>(resolve=>(globalThis as unknown as {setTimeout(callback:()=>void,ms:number):unknown}).setTimeout(resolve,0));if(cancelled())throw new Error('Mobility preparation cancelled');
 return {ticket:request.ticket,network:{...network,runtime:prepareMobilityRuntime(network)},limited:limited||accepted.length<request.tiles.length,acceptedTileKeys:accepted.map(tileKey)};
}
