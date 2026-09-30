import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {chunkOrigin} from '../../core/coordinates';
import type {MapSource} from '../../session/ports';
import {normalizeChunk,type MapFeature} from './normalize';
export type OsmConfig={tileUrl?:string;fetcher?:typeof fetch;timeoutMs?:number};
const layers=new Set(['land','sites','ocean','water_polygons','water_lines','buildings','streets','street_polygons']);
export function createOsmSource(config:OsmConfig={}):MapSource {
 const template=config.tileUrl??'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt';
 const fetcher=config.fetcher??fetch;
 const cache=new Map<string,MapFeature[]>(),pending=new Map<string,Promise<MapFeature[]>>();
 const queue:Array<()=>void>=[];let active=0;
 async function limited<T>(job:()=>Promise<T>):Promise<T>{if(active>=4)await new Promise<void>(resolve=>queue.push(resolve));else active++;try{return await job();}finally{const next=queue.shift();if(next)next();else active--;}}
 async function tile(tx:number,ty:number):Promise<MapFeature[]>{
  const key=`${tx}:${ty}`,cached=cache.get(key);if(cached){cache.delete(key);cache.set(key,cached);return cached;}if(pending.has(key))return pending.get(key)!;
  const promise=limited(async()=>{
   const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),config.timeoutMs??15000);
   try{
    const url=template.replace('{z}','14').replace('{x}',String(tx)).replace('{y}',String(ty));
    const response=await fetcher(url,{signal:abort.signal});if(!response.ok)throw new Error(`Mapa indisponível (${response.status}). Tente novamente.`);
    const bytes=await response.arrayBuffer();const decoded=new VectorTile(new PbfReader(bytes));const features:MapFeature[]=[];
    for(const [name,layer] of Object.entries(decoded.layers)){
     if(!layers.has(name))continue;
     for(let i=0;i<layer.length;i++){
      const f=layer.feature(i);if(f.type!==2&&f.type!==3)continue;
      if(name==='streets'&&(f.properties.tunnel===true||f.properties.rail===true))continue;
      features.push({layer:name,kind:String(f.properties.kind??''),bridge:f.properties.bridge===true,type:f.type,geometry:f.loadGeometry().map(r=>r.map(p=>({x:tx*256+p.x/f.extent*256,y:ty*256+p.y/f.extent*256})))});
     }
    }
    cache.set(key,features);while(cache.size>32)cache.delete(cache.keys().next().value!);return features;
   }finally{clearTimeout(timer);}
  });pending.set(key,promise);try{return await promise;}finally{pending.delete(key);}
 }
 return{attribution:{text:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright'},async loadChunk(id){const p=chunkOrigin(id);return normalizeChunk(id,await tile(Math.floor(p.x/256),Math.floor(p.y/256)));}};
}
