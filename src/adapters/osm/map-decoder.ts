import type {BaseChunk} from '../../core/model';
import type {GeographicTile} from '../../presentation/geographic-map';
import {decodeVisualTile,decodeTile,type DecodedTile} from './decode';
import {normalizeChunk} from './normalize';

export type MapDecodeRequest={
 id:string;source:string;cacheSource?:string;zoom:number;tileX:number;tileY:number;
 bytes:()=>Promise<Uint8Array>;
};
export type MapDecodeStats={path:'main'|'worker';chunks:number;reused:number;transfers:number;decodeMs:number|null;normalizeMs:number|null};
export type MapVisualDecodeRequest=Omit<MapDecodeRequest,'id'>;
export interface MapDecoder{decodeVisual(request:MapVisualDecodeRequest):Promise<GeographicTile>;decode(request:MapDecodeRequest):Promise<BaseChunk>;stats():MapDecodeStats;destroy?():void}

const tileKey=(request:MapVisualDecodeRequest)=>`${request.cacheSource??request.source}:${request.zoom}:${request.tileX}:${request.tileY}`;

export function createMainMapDecoder(limit=32):MapDecoder{
 const visualCache=new Map<string,GeographicTile>(),visualPending=new Map<string,Promise<GeographicTile>>();
 const cache=new Map<string,DecodedTile>(),pending=new Map<string,Promise<DecodedTile>>();
 let chunks=0,reused=0,decodeMs:number|null=null,normalizeMs:number|null=null;
 const tile=async(request:MapDecodeRequest):Promise<{tile:DecodedTile;hit:boolean}>=>{
  const key=tileKey(request),cached=cache.get(key);
  if(cached){cache.delete(key);cache.set(key,cached);return{tile:cached,hit:true};}
  const inflight=pending.get(key);
  if(inflight)return{tile:await inflight,hit:true};
  const job=(async()=>{const bytes=await request.bytes(),started=performance.now(),decoded=decodeTile(bytes,request.zoom,request.tileX,request.tileY);decodeMs=performance.now()-started;return decoded;})();
  pending.set(key,job);
  try{
   const decoded=await job;cache.set(key,decoded);while(cache.size>limit)cache.delete(cache.keys().next().value!);return{tile:decoded,hit:false};
  }finally{pending.delete(key);}
 };
 return{
  async decodeVisual(request){
   const key=tileKey(request),cached=visualCache.get(key);
   if(cached){visualCache.delete(key);visualCache.set(key,cached);reused++;return cached;}
   const inflight=visualPending.get(key);if(inflight){reused++;return inflight;}
   const job=(async()=>{const bytes=await request.bytes(),started=performance.now();const visual=decodeVisualTile(bytes,request.zoom,request.tileX,request.tileY);decodeMs=performance.now()-started;return visual;})();
   visualPending.set(key,job);
   try{const visual=await job;visualCache.set(key,visual);while(visualCache.size>limit)visualCache.delete(visualCache.keys().next().value!);return visual;}finally{visualPending.delete(key);}
  },
  async decode(request){
   const decoded=await tile(request);if(decoded.hit)reused+=1;
   const started=performance.now(),chunk=normalizeChunk(request.id,decoded.tile.byChunk.get(request.id)??[],request.source);
   normalizeMs=performance.now()-started;chunks+=1;return chunk;
  },
  stats:()=>({path:'main',chunks,reused,transfers:0,decodeMs,normalizeMs}),
 };
}

type WorkerRequest={id:string;kind:'chunk'|'visual';chunk:string;source:string;cacheSource?:string;zoom:number;tileX:number;tileY:number;bytes:ArrayBuffer|null};
type WorkerResponse={id:string;kind?:'chunk'|'visual';visual?:GeographicTile;chunk?:BaseChunk;missing?:true;error?:string;decodeMs?:number|null;normalizeMs?:number;reused?:boolean};
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

export function createWorkerMapDecoder(factory:MapWorkerFactory=defaultWorkerFactory):MapDecoder{
 const fallback=createMainMapDecoder();
 let worker:MapWorkerLike|null=null;
 try{worker=factory();}catch{worker=null;}
 let destroyed=false,failed=false,sequence=0,chunks=0,reused=0,transfers=0,decodeMs:number|null=null,normalizeMs:number|null=null;
 const known=new Map<string,true>(),chains=new Map<string,Promise<BaseChunk|GeographicTile>>();
 const waiters=new Map<string,{resolve:(value:WorkerResponse)=>void;reject:(error:unknown)=>void}>();

 const disable=(reason:unknown)=>{
  if(failed)return;failed=true;
  const pending=[...waiters.values()];waiters.clear();known.clear();chains.clear();
  try{worker?.terminate();}catch{}worker=null;
  for(const waiter of pending)waiter.reject(reason);
 };
 if(worker){
  worker.onmessage=event=>{
   const response=event.data,waiter=waiters.get(response.id);if(!waiter)return;
   waiters.delete(response.id);
   if(response.error){waiter.reject(new Error(response.error));return;}
   waiter.resolve(response);
  };
  worker.onerror=()=>disable(new Error('worker do mapa falhou'));
  worker.onmessageerror=()=>disable(new Error('worker do mapa não conseguiu serializar a resposta'));
 }

 const post=(request:MapDecodeRequest,includeBytes:boolean,kind:'chunk'|'visual')=>new Promise<WorkerResponse>((resolve,reject)=>{
  if(!worker){reject(new Error('worker indisponível'));return;}
  const id=String(sequence++),message:WorkerRequest={id,kind,chunk:request.id,source:request.source,cacheSource:request.cacheSource,zoom:request.zoom,tileX:request.tileX,tileY:request.tileY,bytes:null};
  waiters.set(id,{resolve,reject});
  const send=(bytes?:Uint8Array)=>{
   try{
    if(!waiters.has(id)||!worker)return;
    if(bytes){const copy=bytes.slice();message.bytes=copy.buffer;transfers+=1;worker!.postMessage(message,[copy.buffer]);}
    else worker!.postMessage(message);
   }catch(error){waiters.delete(id);reject(error);}
  };
  if(includeBytes)request.bytes().then(send,error=>{waiters.delete(id);reject(requestError(error));});
  else send();
 });

 const decodeWorker=async(request:MapDecodeRequest,kind:'chunk'|'visual'):Promise<BaseChunk|GeographicTile>=>{
  const key=`${kind}:${tileKey(request)}`,work=async()=>{
   let response=await post(request,!known.has(key),kind);
   if(response.missing){known.delete(key);response=await post(request,true,kind);}
   if(response.missing||!(kind==='visual'?response.visual:response.chunk))throw new Error('worker do mapa não devolveu o trecho');
   known.delete(key);known.set(key,true);while(known.size>32)known.delete(known.keys().next().value!);
   decodeMs=response.decodeMs??decodeMs;normalizeMs=response.normalizeMs??normalizeMs;chunks+=1;if(response.reused)reused+=1;
   return (kind==='visual'?response.visual:response.chunk)!;
  };
  const previous=chains.get(key)??Promise.resolve(null as BaseChunk|null);
  const chained=previous.then(work,work);
  chains.set(key,chained);
  void chained.finally(()=>{if(chains.get(key)===chained)chains.delete(key);}).catch(()=>{});
  return chained;
 };

 const run=async(request:MapDecodeRequest,kind:'chunk'|'visual'):Promise<BaseChunk|GeographicTile>=>{
   if(destroyed)throw new Error('worker encerrado');
   let bytes:Promise<Uint8Array>|undefined;const reusable={...request,bytes:()=>bytes??=(request.bytes())};
   const main=()=>kind==='visual'?fallback.decodeVisual(reusable):fallback.decode(reusable);
   if(!worker||failed)return main();
   try{return await decodeWorker(reusable,kind);}
   catch(error){
    // A fetch/cache read failure is not a worker failure: the main decoder would need the same bytes and retrying here
    // would silently turn one map request into two. Let the map loader decide when an explicit retry is appropriate.
    if(destroyed||isRequestError(error))throw error;
    disable(error);
    return main();
   }
 };
 return{
  decode:request=>run(request,'chunk') as Promise<BaseChunk>,
  decodeVisual:request=>run({...request,id:''},'visual') as Promise<GeographicTile>,
  stats:()=>!worker||failed?{...fallback.stats(),path:'main',transfers}:{path:'worker',chunks,reused,transfers,decodeMs,normalizeMs},
  destroy(){destroyed=true;disable(new Error('worker encerrado'));},
 };
}
