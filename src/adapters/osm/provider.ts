import type {GeographicTile} from '../../presentation/geographic-map';
import {prepareRegion,type RegionRequest,type RegionCoverage} from './region-cache';
import type {BaseChunk} from '../../core/model';
import {WORLD,chunkOrigin} from '../../core/coordinates';
import type {MapLevel,MapSource} from '../../session/ports';
import type {TileCache} from './tile-cache';
import type {ChunkCache} from './chunk-cache';
import {createWorkerMapDecoder,type MapDecoder,type MapDecodeStats} from './map-decoder';

export type OsmConfig={tileUrl?:string;fetcher?:typeof fetch;timeoutMs?:number;overviewZoom?:number;
 // Raw service bytes survive visits; normalized chunks make a warm reopen skip PBF decode and geometry normalization.
 cache?:TileCache;chunks?:ChunkCache;
 // Decoding is a port so tests/non-browser runtimes use the same main implementation while the browser defaults to
 // a module worker. A worker crash degrades to main-thread decoding instead of breaking the map.
 decoder?:MapDecoder;
};
export type OsmSourceMetadata={
 source:{id:string;dataset:string;url:string};
 zooms:{detail:number;overview:number};
 normalizer:{name:string;version:BaseChunk['normalizerVersion']};
 attribution:{text:string;url:string};
};
export type OsmSource=MapSource&{loadVisualTile(z:number,x:number,y:number):Promise<GeographicTile>;metadata:OsmSourceMetadata;decodeStats():MapDecodeStats;prepareRegion(request:RegionRequest,onProgress:(coverage:RegionCoverage)=>void,signal?:AbortSignal):Promise<RegionCoverage>;destroy():void};

const DEFAULT_TILE_URL='https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt';
const DATASET='OpenStreetMap · Shortbread v1';
const DETAIL_ZOOM=14,DEFAULT_OVERVIEW_ZOOM=11;
const ATTRIBUTION={text:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright'};
const NORMALIZER:OsmSourceMetadata['normalizer']={name:'osm-shortbread',version:1};
const cellsPerTile=(zoom:number)=>WORLD/2**zoom;
const tileOf=(cell:number,side:number)=>Math.floor(cell/side);

export function createOsmSource(config:OsmConfig={}):OsmSource{
 const template=config.tileUrl??DEFAULT_TILE_URL,fetcher=config.fetcher??fetch,overviewZoom=config.overviewZoom??DEFAULT_OVERVIEW_ZOOM;
 const kept=config.cache,normalized=config.chunks,decoder=config.decoder??createWorkerMapDecoder();
 const pending=new Map<string,Promise<Uint8Array>>(),queue:Array<()=>void>=[];let active=0;
 const lifetime=new AbortController(),controllers=new Set<AbortController>();
 const alive=()=>{if(lifetime.signal.aborted)throw new DOMException('Mapa encerrado','AbortError');};
 const live=<T>(pending:Promise<T>):Promise<T>=>new Promise<T>((resolve,reject)=>{
  const cancel=()=>{lifetime.signal.removeEventListener('abort',cancel);reject(new DOMException('Mapa encerrado','AbortError'));};
  if(lifetime.signal.aborted){pending.catch(()=>{});cancel();return;}
  lifetime.signal.addEventListener('abort',cancel,{once:true});
  pending.then(resolve,reject).finally(()=>lifetime.signal.removeEventListener('abort',cancel));
 });

 async function cacheRead<T>(read:Promise<T>):Promise<T|null>{
  let timer:ReturnType<typeof setTimeout>;
  try{return await live(Promise.race([read.catch(()=>null),new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),Math.min(1000,config.timeoutMs??1000));})]));}finally{clearTimeout(timer!);}
 }
 async function limited<T>(job:()=>Promise<T>):Promise<T>{
  alive();
  if(active>=4){
   let queued!:()=>void;
   try{await live(new Promise<void>(resolve=>{queued=resolve;queue.push(queued);}));}
   catch(error){const index=queue.indexOf(queued);if(index>=0)queue.splice(index,1);throw error;}
  }else active+=1;
  try{alive();return await job();}
  finally{const next=queue.shift();if(next)next();else active-=1;}
 }
 async function bytes(zoom:number,tileX:number,tileY:number,persist=true,signal?:AbortSignal):Promise<Uint8Array>{
  alive();
  const key=`${template}:${zoom}:${tileX}:${tileY}`,pendingKey=signal?`${key}:region`:key,inflight=pending.get(pendingKey);if(inflight)return inflight;
  const request=limited(async()=>{
   if(signal?.aborted)throw new DOMException('Pausado','AbortError');
   const abort=new AbortController(),cancel=()=>abort.abort();signal?.addEventListener('abort',cancel,{once:true});
   controllers.add(abort);
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{
    const cached=kept?await cacheRead(kept.get(key)):null;
    alive();if(abort.signal.aborted)throw new DOMException('Pausado','AbortError');
    if(cached&&cached.byteLength)return cached;
    const url=template.replace('{z}',String(zoom)).replace('{x}',String(tileX)).replace('{y}',String(tileY));
    timer=setTimeout(()=>abort.abort(),config.timeoutMs??15000);
    const response=await live(fetcher(url,{signal:abort.signal}));
    alive();
    if(!response.ok)throw new Error(`Mapa indisponível (${response.status}). Tente novamente.`);
    const result=new Uint8Array(await live(response.arrayBuffer()));
    alive();
    // IndexedDB persistence is a copy for a later visit, never a prerequisite for this frame.
    if(kept&&persist)void kept.put(key,result).catch(()=>{});
    return result;
   }finally{clearTimeout(timer);controllers.delete(abort);signal?.removeEventListener('abort',cancel);}
  });
  pending.set(pendingKey,request);
  try{return await request;}finally{pending.delete(pendingKey);}
 }

 return{
  attribution:{...ATTRIBUTION},
  metadata:{source:{id:'openstreetmap-shortbread-v1',dataset:DATASET,url:template},zooms:{detail:DETAIL_ZOOM,overview:overviewZoom},normalizer:{...NORMALIZER},attribution:{...ATTRIBUTION}},
  loadVisualTile:async(z,x,y)=>{alive();const result=await live(decoder.decodeVisual({source:template,cacheSource:template,zoom:z,tileX:x,tileY:y,bytes:()=>bytes(z,x,y)}));alive();return result;},
  prepareRegion:async(request,onProgress,signal)=>{
   alive();const region=new AbortController(),cancel=()=>region.abort();
   if(signal?.aborted)region.abort();
   signal?.addEventListener('abort',cancel,{once:true});lifetime.signal.addEventListener('abort',cancel,{once:true});
   try{return await prepareRegion(request,{
   zooms:{overview:overviewZoom,detail:DETAIL_ZOOM},
   read:key=>{alive();return kept?cacheRead(kept.get(`${template}:${key}`)):Promise.resolve(null);},
   fetch:(tile,signal)=>bytes(tile.zoom,tile.x,tile.y,false,signal),
   write:async(key,value)=>{alive();if(!kept)throw new Error('Armazenamento indisponível');await kept.put(`${template}:${key}`,value);},
   },coverage=>{if(!lifetime.signal.aborted)onProgress(coverage);},region.signal);}
   finally{signal?.removeEventListener('abort',cancel);lifetime.signal.removeEventListener('abort',cancel);}
  },
  decodeStats:()=>decoder.stats(),
  destroy:()=>{if(lifetime.signal.aborted)return;lifetime.abort();for(const controller of controllers)controller.abort();decoder.destroy?.();},
  async loadChunk(id,level:MapLevel='detail'){
   alive();
   const zoom=level==='overview'?overviewZoom:DETAIL_ZOOM;
   const cacheKey=`${NORMALIZER.name}:${NORMALIZER.version}:${level}:z${zoom}:${template}:${id}`;
   const cached=normalized?await cacheRead(normalized.get(cacheKey)):null;
   alive();
   if(cached?.id===id)return cached;
   const origin=chunkOrigin(id),side=cellsPerTile(zoom),tileX=tileOf(origin.x,side),tileY=tileOf(origin.y,side);
   const source=level==='overview'?`${DATASET} (aproximação z${zoom})`:DATASET;
   const chunk=await live(decoder.decode({id,source,cacheSource:template,zoom,tileX,tileY,bytes:()=>bytes(zoom,tileX,tileY)}));
   alive();
   if(normalized)void normalized.put(cacheKey,chunk).catch(()=>{});
   return chunk;
  },
 };
}
