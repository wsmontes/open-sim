import {createResourceCache} from '../../core/resource-cache';
import {decodeVisualTile} from './decode';
import type {GeographicTile} from '../../presentation/geographic-map';
import {prepareRegion,type RegionRequest,type RegionCoverage} from './region-cache';
import type {BaseChunk} from '../../core/model';
import {WORLD,chunkOrigin} from '../../core/coordinates';
import type {MapLevel,MapSource} from '../../session/ports';
import type {TileCache} from './tile-cache';
import type {ChunkCache} from './chunk-cache';
import {createWorkerMapDecoder,type MapDecoder,type MapDecodeStats} from './map-decoder';

export type OsmConfig={visualCacheBytes?:number;tileUrl?:string;fetcher?:typeof fetch;timeoutMs?:number;overviewZoom?:number;
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
export type OsmSource=MapSource&{loadEncodedTile(z:number,x:number,y:number):Promise<GeographicTile>;loadVisualTile(z:number,x:number,y:number):Promise<GeographicTile>;metadata:OsmSourceMetadata;decodeStats():MapDecodeStats;encodedStats():{bytes:number;entries:number};prepareRegion(request:RegionRequest,onProgress:(coverage:RegionCoverage)=>void,signal?:AbortSignal):Promise<RegionCoverage>;destroy():void};

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
 const encodedTiles=createResourceCache<GeographicTile>(config.visualCacheBytes??8*1024*1024,()=>{},64),encodedPending=new Map<string,Promise<GeographicTile>>(),controllers=new Set<AbortController>();let visualRevision=0,disposed=false;
 const pending=new Map<string,Promise<Uint8Array>>(),queue:Array<()=>void>=[];let active=0;

 async function limited<T>(job:()=>Promise<T>):Promise<T>{
  if(active>=4)await new Promise<void>(resolve=>queue.push(resolve));else active+=1;
  try{if(disposed)throw new Error('Map source disposed');return await job();}
  finally{const next=queue.shift();if(next)next();else active-=1;}
 }
 async function bytes(zoom:number,tileX:number,tileY:number,persist=true):Promise<Uint8Array>{
  if(disposed)throw new Error('Map source disposed');
  const key=`${zoom}:${tileX}:${tileY}`,inflight=pending.get(key);if(inflight)return inflight;
  const request=limited(async()=>{
   const abort=new AbortController();controllers.add(abort);const timer=setTimeout(()=>abort.abort(),config.timeoutMs??15000);
   try{
    const cached=kept?await kept.get(key).catch(()=>null):null;
    if(disposed)throw new Error('Map source disposed');
    if(cached&&cached.byteLength)return cached;
    const url=template.replace('{z}',String(zoom)).replace('{x}',String(tileX)).replace('{y}',String(tileY));
    const response=await fetcher(url,{signal:abort.signal});
    if(!response.ok)throw new Error(`Mapa indisponível (${response.status}). Tente novamente.`);
    const result=new Uint8Array(await response.arrayBuffer());
    if(disposed)throw new Error('Map source disposed');
    // IndexedDB persistence is a copy for a later visit, never a prerequisite for this frame.
    if(kept&&persist)void kept.put(key,result).catch(()=>{});
    return result;
   }finally{clearTimeout(timer);controllers.delete(abort);}
  });
  pending.set(key,request);
  try{return await request;}finally{pending.delete(key);}
 }

 return{
  attribution:{...ATTRIBUTION},
  metadata:{source:{id:'openstreetmap-shortbread-v1',dataset:DATASET,url:template},zooms:{detail:DETAIL_ZOOM,overview:overviewZoom},normalizer:{...NORMALIZER},attribution:{...ATTRIBUTION}},
  loadEncodedTile(z,x,y){
   if(disposed)return Promise.reject(new Error('Map source disposed'));
   const key=`${z}:${x}:${y}`,known=encodedTiles.get(key);if(known)return Promise.resolve(known);
   const inflight=encodedPending.get(key);if(inflight)return inflight;
   const result=bytes(z,x,y).then(encoded=>{if(disposed)throw new Error('Map source disposed');const tile={z,x,y,features:[],encoded,encodedRevision:String(++visualRevision)};encodedTiles.set(key,tile,encoded.byteLength);return tile;}).finally(()=>encodedPending.delete(key));
   encodedPending.set(key,result);return result;
  },
  loadVisualTile:async(z,x,y)=>decodeVisualTile(await bytes(z,x,y),z,x,y),
  prepareRegion:(request,onProgress,signal)=>prepareRegion(request,{
   zooms:{overview:overviewZoom,detail:DETAIL_ZOOM},
   read:key=>kept?kept.get(key):Promise.resolve(null),
   fetch:tile=>bytes(tile.zoom,tile.x,tile.y,false),
   write:async(key,value)=>{if(!kept)throw new Error('Armazenamento indisponível');await kept.put(key,value);},
  },onProgress,signal),
  decodeStats:()=>decoder.stats(),
  encodedStats:()=>encodedTiles.stats(),
  destroy:()=>{disposed=true;for(const abort of controllers)abort.abort();controllers.clear();encodedTiles.clear();encodedPending.clear();decoder.destroy?.();},
  async loadChunk(id,level:MapLevel='detail'){
   const zoom=level==='overview'?overviewZoom:DETAIL_ZOOM;
   const cacheKey=`${NORMALIZER.name}:${NORMALIZER.version}:${level}:z${zoom}:${template}:${id}`;
   const cached=normalized?await normalized.get(cacheKey).catch(()=>null):null;
   if(cached?.id===id)return cached;
   const origin=chunkOrigin(id),side=cellsPerTile(zoom),tileX=tileOf(origin.x,side),tileY=tileOf(origin.y,side);
   const source=level==='overview'?`${DATASET} (aproximação z${zoom})`:DATASET;
   const chunk=await decoder.decode({id,source,zoom,tileX,tileY,bytes:()=>bytes(zoom,tileX,tileY)});
   if(normalized)void normalized.put(cacheKey,chunk).catch(()=>{});
   return chunk;
  },
 };
}
