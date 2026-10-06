import {createResourceCache} from '../../core/resource-cache';
import type {TerrainManifest,TerrainTile} from '../../presentation/terrain-model';
export function encodeTerrainTile(tile:TerrainTile):Uint8Array{
 const {heightsM,valid,...header}=tile;const json=new TextEncoder().encode(JSON.stringify(header));const n=tile.size*tile.size;
 if(heightsM.length!==n||valid.length!==n)throw new Error('Terrain sample count');
 const bytes=new Uint8Array(8+json.length+n*5);const view=new DataView(bytes.buffer);bytes.set(new TextEncoder().encode('OST1'));view.setUint32(4,json.length,true);bytes.set(json,8);
 for(let i=0;i<n;i++){view.setFloat32(8+json.length+i*4,heightsM[i],true);bytes[8+json.length+n*4+i]=valid[i];}
 return bytes;
}
export function decodeTerrainTile(bytes:Uint8Array,manifest:TerrainManifest):TerrainTile{
 if(bytes.length<8||bytes.length>32768||new TextDecoder().decode(bytes.subarray(0,4))!=='OST1')throw new Error('Corrupt terrain header');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const length=view.getUint32(4,true);
 if(length>4096||8+length>bytes.length)throw new Error('Corrupt terrain metadata');
 const h=JSON.parse(new TextDecoder().decode(bytes.subarray(8,8+length))) as Omit<TerrainTile,'heightsM'|'valid'>;
 const entry=manifest.tiles.find(t=>t.id===h.id),source=manifest.sources.find(s=>s.id===h.sourceId);
 if(manifest.version!==1||h.size!==65||!entry||!source||source.horizontalCrs!=='EPSG:4326'||h.verticalDatum!==source.verticalDatum||h.kind!==source.kind||manifest.sources.some(s=>s.verticalDatum!==source.verticalDatum)||h.spacingM!==entry.spacingM||!h.bounds||['west','south','east','north'].some(k=>h.bounds[k as keyof typeof h.bounds]!==entry.bounds[k as keyof typeof h.bounds]))throw new Error('Terrain identity, bounds or datum mismatch');
 const n=h.size*h.size;if(bytes.length!==8+length+n*5)throw new Error('Corrupt terrain length');
 const heightsM=new Float32Array(n),valid=bytes.slice(8+length+n*4);
 for(let i=0;i<n;i++){heightsM[i]=view.getFloat32(8+length+i*4,true);if(valid[i]>1||valid[i]===1&&!Number.isFinite(heightsM[i]))throw new Error('Corrupt terrain samples');if(!valid[i])heightsM[i]=NaN;}
 return {...h,sourceResolutionM:source.resolutionM,heightsM,valid};
}
export function createTerrainSource(fetchBytes:(url:string,signal:AbortSignal)=>Promise<Uint8Array>,manifest:TerrainManifest,options:{cacheBytes?:number;concurrency?:number}={}){
 const cache=createResourceCache<TerrainTile>(options.cacheBytes??32*1024*1024);let active=0,disposed=false;
 const controllers=new Set<AbortController>(),waiting:Array<{wake:()=>void;reject:(error:Error)=>void}>=[];
 const release=()=>{const next=waiting.shift();if(next)next.wake();else active--;};
 return {async load(id:string,signal:AbortSignal):Promise<TerrainTile>{
  if(disposed)throw new Error('Terrain source disposed');if(signal.aborted)throw new DOMException('Aborted','AbortError');
  const entry=manifest.tiles.find(t=>t.id===id);if(!entry)throw new Error('No terrain capture');
  const known=cache.get(id);if(known)return known;
  if(active>=(options.concurrency??8))await new Promise<void>((resolve,reject)=>{
   const queued={wake:()=>{signal.removeEventListener('abort',cancel);resolve();},reject:(error:Error)=>{signal.removeEventListener('abort',cancel);reject(error);}};
   const cancel=()=>{const index=waiting.indexOf(queued);if(index>=0)waiting.splice(index,1);queued.reject(new DOMException('Aborted','AbortError'));};waiting.push(queued);signal.addEventListener('abort',cancel,{once:true});
  });else active++;
  const abort=new AbortController(),cancel=()=>abort.abort();controllers.add(abort);signal.addEventListener('abort',cancel,{once:true});
  try{
   if(disposed)throw new Error('Terrain source disposed');if(signal.aborted)throw new DOMException('Aborted','AbortError');
   const bytes=await fetchBytes(entry.url,abort.signal);if(disposed)throw new Error('Terrain source disposed');if(abort.signal.aborted)throw new DOMException('Aborted','AbortError');
   if(bytes.length!==entry.bytes)throw new Error('Terrain download length mismatch');
   const tile=decodeTerrainTile(bytes,manifest);if(tile.id!==id)throw new Error('Wrong terrain tile');
   cache.set(id,tile,tile.heightsM.byteLength+tile.valid.byteLength);return tile;
  }finally{signal.removeEventListener('abort',cancel);controllers.delete(abort);release();}
 },status:()=>({...cache.stats(),active,queued:waiting.length}),dispose(){disposed=true;cache.clear();for(const abort of controllers)abort.abort();for(const entry of waiting.splice(0))entry.reject(new Error('Terrain source disposed'));}};
}
