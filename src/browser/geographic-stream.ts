import type {DetailDemand} from '../presentation/adaptive-detail';
import type {Camera,Viewport} from '../presentation/camera';
import {clipGeographicTile,geographicTiles,tileKey,GLOBE_ZOOM,type GeographicTile,type GeographicTileId,type GeographicScene} from '../presentation/geographic-map';

export function createGeographicStream(load:(z:number,x:number,y:number)=>Promise<GeographicTile>,changed:()=>void,budget?:()=>DetailDemand,observed?:(ms:number,ok:boolean)=>void){
 const cache=new Map<string,GeographicTile>(),pending=new Set<string>(),failed=new Set<string>();
 const sizes=new Map<string,number>();let bytes=0;
 const discard=(key:string)=>{bytes-=sizes.get(key)??0;sizes.delete(key);cache.delete(key);};
 // The nearest cached ancestor is what stands in for a region while its own tiles arrive, so eviction must not take it.
 const placeholder=(tile:GeographicTileId)=>{for(let z=tile.z-1;z>=0;z--){const factor=2**(tile.z-z),key=tileKey({z,x:Math.floor(tile.x/factor),y:Math.floor(tile.y/factor)}),cached=cache.get(key);if(cached)return{key,cached};}return null;};
 const trim=()=>{const protectedKeys=new Set(demand.map(tileKey));for(const tile of demand){const stand=placeholder(tile);if(stand)protectedKeys.add(stand.key);}for(const key of cache.keys()){if(cache.size<=64&&bytes<=(budget?.().cacheBytes??32*1024*1024))break;if(!protectedKeys.has(key))discard(key);}};
 let demand:GeographicTileId[]=[],signature='',revision=0,destroyed=false;
 const waiters:Array<()=>void>=[];
 let snapshot:GeographicScene|null=null;
 const wanted=()=>demand.filter(t=>!cache.has(tileKey(t))&&!pending.has(tileKey(t))&&!failed.has(tileKey(t)));
 const announce=()=>{if(destroyed)return;revision++;changed();};
 const pump=()=>{
  if(destroyed)return;
  for(const tile of wanted()){
   if(pending.size>=(budget?.().concurrency??4))break;
   const key=tileKey(tile),start=performance.now();pending.add(key);
   void load(tile.z,tile.x,tile.y).then(value=>{
    if(destroyed)return;observed?.(performance.now()-start,true);
    if(!demand.some(t=>tileKey(t)===key))return;
    discard(key);cache.set(key,value);const size=value.encoded?.byteLength??value.features.reduce((n,f)=>n+224+f.geometry.reduce((sum,r)=>sum+r.length*32,0),0);sizes.set(key,size);bytes+=size;trim();
   },()=>{if(!destroyed){observed?.(performance.now()-start,false);if(demand.some(t=>tileKey(t)===key))failed.add(key);}}).finally(()=>{pending.delete(key);announce();pump();});
  }
  if(pending.size===0&&wanted().length===0)for(const resolve of waiters.splice(0))resolve();
 };
 return{
  update(camera:Camera,viewport:Viewport){if(destroyed)return;
   const next=camera.zoom<GLOBE_ZOOM?[]:geographicTiles(camera,viewport,budget?.()),key=next.map(tileKey).join('|');
   if(key===signature)return;signature=key;demand=next;trim();announce();pump();
  },
  retry(){if(destroyed)return;failed.clear();announce();pump();},
  scene():GeographicScene{
   if(snapshot?.revision===revision)return snapshot;
   const visible=new Map<string,GeographicTile>();
   for(const tile of demand){
    const key=tileKey(tile),direct=cache.get(key);
    if(direct){visible.set(key,direct);continue;}
    // A clipped ancestor of exactly this location is a safe placeholder while detail arrives.
    const stand=placeholder(tile);
    if(stand)visible.set(key,clipGeographicTile(stand.cached,tile));
   }
   const tiles=[...visible.values()];
   return snapshot={tiles,revision,loading:demand.some(t=>!cache.has(tileKey(t))&&!failed.has(tileKey(t))),error:demand.some(t=>failed.has(tileKey(t)))};
  },
  status:()=>({bytes,entries:cache.size,pending:pending.size,demand:demand.length}),
  destroy(){destroyed=true;demand=[];cache.clear();sizes.clear();bytes=0;failed.clear();snapshot=null;revision++;for(const resolve of waiters.splice(0))resolve();},
  idle():Promise<void>{if(destroyed||pending.size===0&&wanted().length===0)return Promise.resolve();return new Promise(resolve=>waiters.push(resolve));},
 };
}
