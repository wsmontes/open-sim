import type {BaseChunk} from '../../core/model';
import {createNormalizationCache} from './normalization-cache';
import {normalizeChunkAsync,type MapFeature} from './normalize';
import {resourcePolicy} from '../../presentation/resource-policy';
import {ResourcePressure} from '../../core/resource-pressure';

export type MapDecodeRequest={
 id:string;source:string;zoom:number;tileX:number;tileY:number;
 bytes:()=>Promise<Uint8Array>;
};
export type MapDecodeStats={path:'main'|'worker';chunks:number;reused:number;transfers:number;decodeMs:number|null;normalizeMs:number|null;retainedBytes?:number};
export interface MapDecoder{decode(request:MapDecodeRequest):Promise<BaseChunk>;stats():MapDecodeStats;destroy?():void}

const tileKey=(request:Pick<MapDecodeRequest,'zoom'|'tileX'|'tileY'>)=>`${request.zoom}:${request.tileX}:${request.tileY}`;

export type MapDecoderBudget={cacheBytes?:number;geometryBytes?:number;inputBytes?:number;timeoutMs?:number};
export function createMainMapDecoder(limit=32,options:MapDecoderBudget={}):MapDecoder{
 const cache=createNormalizationCache(options.cacheBytes??resourcePolicy().normalizationBytes,limit),pending=new Map<string,Promise<readonly MapFeature[]>>();
 let chunks=0,reused=0,decodeMs:number|null=null,normalizeMs:number|null=null,disposed=false,chain=Promise.resolve();
 const tile=async(request:MapDecodeRequest):Promise<{features:readonly MapFeature[];hit:boolean}>=>{
  const key=tileKey(request),cached=cache.get(key);if(cached)return{features:cached,hit:true};
  const inflight=pending.get(key);if(inflight)return{features:await inflight,hit:true};
  const job=(async()=>{const bytes=await request.bytes();if(bytes.byteLength>(options.inputBytes??resourcePolicy().maxTileBytes))throw new ResourcePressure();if(disposed)throw new Error('Map decoder disposed');const started=performance.now(),features=cache.decode(key,bytes,request.zoom,request.tileX,request.tileY,Math.min(options.geometryBytes??4096*64,4096*64));decodeMs=performance.now()-started;return features;})();
  pending.set(key,job);try{return {features:await job,hit:false};}finally{pending.delete(key);}
 };
 return{
  decode(request){const run=async()=>{if(disposed)throw new Error('Map decoder disposed');const decoded=await tile(request);if(decoded.hit)reused++;
   const started=performance.now(),chunk=await normalizeChunkAsync(request.id,decoded.features,request.source,()=>disposed);normalizeMs=performance.now()-started;chunks++;return chunk;};
   const result=chain.then(run,run);chain=result.then(()=>{},()=>{});return result;
  },
  stats:()=>({path:'main',chunks,reused,transfers:0,decodeMs,normalizeMs,retainedBytes:cache.stats().bytes}),destroy(){disposed=true;cache.clear();pending.clear();},
 };
}

type WorkerRequest={id:string;chunk:string;source:string;zoom:number;tileX:number;tileY:number;bytes:ArrayBuffer|null;cacheBytes:number;geometryBytes:number};
type WorkerResponse={id:string;chunk?:BaseChunk;missing?:true;error?:string;decodeMs?:number|null;normalizeMs?:number;reused?:boolean;resourcePressure?:boolean};
export type MapWorkerLike={
 postMessage(message:WorkerRequest,transfer?:Transferable[]):void;
 terminate():void;
 onmessage:((event:MessageEvent<WorkerResponse>)=>void)|null;
 onerror:((event:Event)=>void)|null;
 onmessageerror:((event:MessageEvent)=>void)|null;
};
export type MapWorkerFactory=()=>MapWorkerLike|null;

const defaultWorkerFactory:MapWorkerFactory=()=>{
 if(typeof Worker!=='function')return null;
 try{return new Worker(new URL('./map-worker.ts',import.meta.url),{type:'module'}) as unknown as MapWorkerLike;}catch{return null;}
};
const requestError=(error:unknown)=>Object.assign(error instanceof Error?error:new Error(String(error)),{mapRequest:true});
const isRequestError=(error:unknown)=>Boolean((error as {mapRequest?:unknown}|null)?.mapRequest);

export function createWorkerMapDecoder(factory:MapWorkerFactory=defaultWorkerFactory,options:MapDecoderBudget={}):MapDecoder{
 const inputBytes=options.inputBytes??resourcePolicy().maxTileBytes,cacheBytes=options.cacheBytes??(resourcePolicy().normalizationBytes-inputBytes)/2,geometryBytes=options.geometryBytes??cacheBytes;
 const fallback=createMainMapDecoder(32,{cacheBytes,geometryBytes,inputBytes});
 let worker:MapWorkerLike|null=null;
 try{worker=factory();}catch{worker=null;}
 let disposed=false,failed=false,sequence=0,chunks=0,reused=0,transfers=0,decodeMs:number|null=null,normalizeMs:number|null=null;
 let workerChain=Promise.resolve(null as BaseChunk|null);
 const known=new Map<string,true>(),chains=new Map<string,Promise<BaseChunk>>();
 const waiters=new Map<string,{resolve:(value:WorkerResponse)=>void;reject:(error:unknown)=>void;timer?:ReturnType<typeof setTimeout>}>();

 const disable=(reason:unknown)=>{
  if(failed)return;failed=true;
  const pending=[...waiters.values()];waiters.clear();known.clear();chains.clear();
  try{worker?.terminate();}catch{}worker=null;
  for(const waiter of pending){if(waiter.timer!==undefined)clearTimeout(waiter.timer);waiter.reject(reason);}
 };
 if(worker){
  worker.onmessage=event=>{
   const response=event.data,waiter=waiters.get(response.id);if(!waiter)return;
   waiters.delete(response.id);if(waiter.timer!==undefined)clearTimeout(waiter.timer);
   if(response.error){waiter.reject(response.resourcePressure?requestError(new ResourcePressure()):new Error(response.error));return;}
   waiter.resolve(response);
  };
  worker.onerror=()=>disable(new Error('worker do mapa falhou'));
  worker.onmessageerror=()=>disable(new Error('worker do mapa não conseguiu serializar a resposta'));
 }

 const post=(request:MapDecodeRequest,includeBytes:boolean)=>new Promise<WorkerResponse>((resolve,reject)=>{
  if(!worker){reject(new Error('worker indisponível'));return;}
  const id=String(sequence++),message:WorkerRequest={id,chunk:request.id,source:request.source,zoom:request.zoom,tileX:request.tileX,tileY:request.tileY,bytes:null,cacheBytes,geometryBytes};
  const entry:{resolve:(value:WorkerResponse)=>void;reject:(error:unknown)=>void;timer?:ReturnType<typeof setTimeout>}={resolve,reject};waiters.set(id,entry);
  const send=(bytes?:Uint8Array)=>{
   try{
    if(disposed||!worker)throw new Error('Map decoder disposed');
    if(bytes&&bytes.byteLength>inputBytes)throw requestError(new ResourcePressure());
    entry.timer=setTimeout(()=>disable(new Error('Map worker response deadline exceeded')),options.timeoutMs??15000);
    if(bytes){const copy=bytes.slice();message.bytes=copy.buffer;transfers+=1;worker!.postMessage(message,[copy.buffer]);}
    else worker!.postMessage(message);
   }catch(error){if(entry.timer!==undefined)clearTimeout(entry.timer);waiters.delete(id);reject(error);}
  };
  if(includeBytes)request.bytes().then(send,error=>{waiters.delete(id);reject(requestError(error));});
  else send();
 });

 const decodeWorker=async(request:MapDecodeRequest):Promise<BaseChunk>=>{
  const key=tileKey(request),work=async()=>{
   let response=await post(request,!known.has(key));
   if(response.missing){known.delete(key);response=await post(request,true);}
   if(response.missing||!response.chunk)throw new Error('worker do mapa não devolveu o trecho');
   known.delete(key);known.set(key,true);while(known.size>32)known.delete(known.keys().next().value!);
   decodeMs=response.decodeMs??decodeMs;normalizeMs=response.normalizeMs??normalizeMs;chunks+=1;if(response.reused)reused+=1;
   return response.chunk;
  };
  const previous=workerChain;
  const chained=previous.then(work,work);
  workerChain=chained;chains.set(key,chained);
  void chained.finally(()=>{if(chains.get(key)===chained)chains.delete(key);}).catch(()=>{});
  return chained;
 };

 return{
  async decode(request){
   if(disposed)throw new Error('Map decoder disposed');
   if(!worker||failed)return fallback.decode(request);
   try{return await decodeWorker(request);}
   catch(error){
    // A fetch/cache read failure is not a worker failure: the main decoder would need the same bytes and retrying here
    // would silently turn one map request into two. Let the map loader decide when an explicit retry is appropriate.
    if(disposed||isRequestError(error))throw error;
    disable(error);
    return fallback.decode(request);
   }
  },
  stats:()=>!worker||failed?{...fallback.stats(),path:'main',transfers}:{path:'worker',chunks,reused,transfers,decodeMs,normalizeMs},
  destroy(){disposed=true;disable(new Error('Map decoder disposed'));fallback.destroy?.();},
 };
}
