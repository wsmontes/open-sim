import type {Camera,Viewport} from '../presentation/camera';
import {clipGeographicTile,geographicTiles,tileKey,GLOBE_ZOOM,type GeographicTile,type GeographicTileId,type GeographicScene} from '../presentation/geographic-map';

export function createGeographicStream(load:(z:number,x:number,y:number)=>Promise<GeographicTile>,changed:()=>void){
 const cache=new Map<string,GeographicTile>(),pending=new Set<string>(),failed=new Set<string>();
 let demand:GeographicTileId[]=[],signature='',revision=0,destroyed=false;
 const waiters:Array<()=>void>=[];
 let snapshot:GeographicScene|null=null;
 const wanted=()=>demand.filter(t=>!cache.has(tileKey(t))&&!pending.has(tileKey(t))&&!failed.has(tileKey(t)));
 const announce=()=>{if(destroyed)return;revision++;changed();};
 const pump=()=>{
  if(destroyed)return;
  for(const tile of wanted()){
   if(pending.size>=4)break;
   const key=tileKey(tile);pending.add(key);
   void load(tile.z,tile.x,tile.y).then(value=>{
    if(destroyed)return;
    cache.set(key,value);
    const protectedKeys=new Set(demand.map(tileKey));
    for(const kept of cache.keys()){if(cache.size<=64)break;if(!protectedKeys.has(kept))cache.delete(kept);}
   },()=>{if(!destroyed)failed.add(key);}).finally(()=>{pending.delete(key);announce();pump();});
  }
  if(pending.size===0&&wanted().length===0)for(const resolve of waiters.splice(0))resolve();
 };
 return{
  update(camera:Camera,viewport:Viewport){
   if(destroyed)return;
   const next=camera.zoom<GLOBE_ZOOM?[]:geographicTiles(camera,viewport),key=next.map(tileKey).join('|');
   if(key===signature)return;signature=key;demand=next;announce();pump();
  },
  retry(){if(destroyed)return;failed.clear();announce();pump();},
  scene():GeographicScene{
   if(snapshot?.revision===revision)return snapshot;
   const visible=new Map<string,GeographicTile>();
   for(const tile of demand){
    const key=tileKey(tile),direct=cache.get(key);
    if(direct){visible.set(key,direct);continue;}
    // A parent of exactly this location is a safe placeholder while detail arrives.
    for(let z=tile.z-1;z>=0;z--){const factor=2**(tile.z-z),parentKey=tileKey({z,x:Math.floor(tile.x/factor),y:Math.floor(tile.y/factor)}),parent=cache.get(parentKey);if(parent){visible.set(key,clipGeographicTile(parent,tile));break;}}
   }
   const tiles=[...visible.values()];
   return snapshot={tiles,revision,loading:demand.some(t=>!cache.has(tileKey(t))&&!failed.has(tileKey(t))),error:demand.some(t=>failed.has(tileKey(t)))};
  },
  destroy(){destroyed=true;demand=[];cache.clear();failed.clear();snapshot=null;for(const resolve of waiters.splice(0))resolve();},
  idle():Promise<void>{if(destroyed||pending.size===0&&wanted().length===0)return Promise.resolve();return new Promise(resolve=>waiters.push(resolve));},
 };
}
