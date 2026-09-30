import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {CHUNK,WORLD,chunkOrigin} from '../../core/coordinates';
import type {MapLevel,MapSource} from '../../session/ports';
import {normalizeChunk,type MapFeature} from './normalize';
export type OsmConfig={tileUrl?:string;fetcher?:typeof fetch;timeoutMs?:number;overviewZoom?:number};
const layers=new Set(['land','sites','ocean','water_polygons','water_lines','buildings','streets','street_polygons']);
const WORLD_SIDE=WORLD;
// The same grid serves every zoom: a tile of zoom Z covers 2^(22-Z) cells per side and one tile pixel is therefore
// 2^(14-Z) cells. Buildings only exist at zoom 14 (Shortbread), so a coarser tile is an approximation of the same
// place — water, land use and main roads — which is what makes a wide view appear before the detail arrives.
const cellsPerTile=(zoom:number)=>WORLD_SIDE/2**zoom;
const tileOf=(cellX:number,cellsPerSide:number)=>Math.floor(cellX/cellsPerSide);
type TileData={features:MapFeature[];byChunk:Map<string,MapFeature[]>};
// A zoom 14 tile holds one `buildings` feature with thousands of rings and is shared by its 64 regions. Bucketing the
// features by region once per decoded tile, and clipping every ring to its own bounding box while normalizing, is the
// difference between a city that appears at once and one that drips in for minutes.
function bucket(tileX:number,tileY:number,cellsPerSide:number,features:MapFeature[]):Map<string,MapFeature[]>{
 const byChunk=new Map<string,MapFeature[]>();
 const chunksPerSide=cellsPerSide/CHUNK,firstX=tileX*chunksPerSide,firstY=tileY*chunksPerSide;
 for(const f of features){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const ring of f.geometry)for(const p of ring){
   if(p.x<minX)minX=p.x;if(p.x>maxX)maxX=p.x;if(p.y<minY)minY=p.y;if(p.y>maxY)maxY=p.y;
  }
  if(minX===Infinity)continue;
  // The same margin normalizeChunk uses when it clips a feature to a region.
  const width=f.layer==='streets'?(/motorway|trunk|primary/.test(f.kind)?1.1:.67):.65;
  const x0=Math.max(firstX,Math.floor((minX-width)/CHUNK)),x1=Math.min(firstX+chunksPerSide-1,Math.floor((maxX+width)/CHUNK));
  const y0=Math.max(firstY,Math.floor((minY-width)/CHUNK)),y1=Math.min(firstY+chunksPerSide-1,Math.floor((maxY+width)/CHUNK));
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   const key=`${x}:${y}`,list=byChunk.get(key);
   if(list)list.push(f);else byChunk.set(key,[f]);
  }
 }
 return byChunk;
}
export function createOsmSource(config:OsmConfig={}):MapSource {
 const template=config.tileUrl??'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt';
 const fetcher=config.fetcher??fetch;
 const overviewZoom=config.overviewZoom??11;
 const cache=new Map<string,TileData>(),pending=new Map<string,Promise<TileData>>();
 const queue:Array<()=>void>=[];let active=0;
 async function limited<T>(job:()=>Promise<T>):Promise<T>{if(active>=4)await new Promise<void>(resolve=>queue.push(resolve));else active++;try{return await job();}finally{const next=queue.shift();if(next)next();else active--;}}
 async function tile(zoom:number,tileX:number,tileY:number):Promise<TileData>{
  const key=`${zoom}:${tileX}:${tileY}`,cached=cache.get(key);if(cached){cache.delete(key);cache.set(key,cached);return cached;}if(pending.has(key))return pending.get(key)!;
  const promise=limited(async()=>{
   const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),config.timeoutMs??15000);
   try{
    const url=template.replace('{z}',String(zoom)).replace('{x}',String(tileX)).replace('{y}',String(tileY));
    const response=await fetcher(url,{signal:abort.signal});if(!response.ok)throw new Error(`Mapa indisponível (${response.status}). Tente novamente.`);
    const bytes=await response.arrayBuffer();const decoded=new VectorTile(new PbfReader(bytes));const features:MapFeature[]=[];
    const cellsPerSide=cellsPerTile(zoom),originX=tileX*cellsPerSide,originY=tileY*cellsPerSide;
    for(const [name,layer] of Object.entries(decoded.layers)){
     if(!layers.has(name))continue;
     for(let i=0;i<layer.length;i++){
      const f=layer.feature(i);if(f.type!==2&&f.type!==3)continue;
      if(name==='streets'&&(f.properties.tunnel===true||f.properties.rail===true))continue;
      features.push({layer:name,kind:String(f.properties.kind??''),bridge:f.properties.bridge===true,type:f.type,geometry:f.loadGeometry().map(r=>r.map(p=>({x:originX+p.x/f.extent*cellsPerSide,y:originY+p.y/f.extent*cellsPerSide})))});
     }
    }
    const data:TileData={features,byChunk:bucket(tileX,tileY,cellsPerSide,features)};
    cache.set(key,data);while(cache.size>32)cache.delete(cache.keys().next().value!);return data;
   }finally{clearTimeout(timer);}
  });pending.set(key,promise);try{return await promise;}finally{pending.delete(key);}
 }
 return{attribution:{text:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright'},async loadChunk(id,level:MapLevel='detail'){
  const p=chunkOrigin(id),zoom=level==='overview'?overviewZoom:14,cellsPerSide=cellsPerTile(zoom);
  const data=await tile(zoom,tileOf(p.x,cellsPerSide),tileOf(p.y,cellsPerSide));
  const source=level==='overview'?`OpenStreetMap · Shortbread v1 (aproximação z${zoom})`:'OpenStreetMap · Shortbread v1';
  return normalizeChunk(id,data.byChunk.get(id)??[],source);
 }};
}
