import {ResourcePressure} from '../core/resource-pressure';
import type {DetailDemand} from '../presentation/adaptive-detail';
import type {Camera,Viewport} from '../presentation/camera';
import {geographicSelection,tileKey,GLOBE_ZOOM,type GeographicTile,type GeographicTileId,type GeographicScene} from '../presentation/geographic-map';

export function createGeographicStream(load:(z:number,x:number,y:number)=>Promise<GeographicTile>,changed:()=>void,budget?:()=>DetailDemand,observed?:(ms:number,ok:boolean)=>void,pressure?:()=>void){
 const cache=new Map<string,GeographicTile>(),pending=new Set<string>(),failed=new Set<string>(),rejected=new Set<string>();
 const sizes=new Map<string,number>();let bytes=0;
 const discard=(key:string)=>{bytes-=sizes.get(key)??0;sizes.delete(key);cache.delete(key);};
 let demand:GeographicTileId[]=[],signature='',revision=0,disposed=false,lastBudget=-1,selectionLimited=false;
 const limit=()=>Math.max(0,budget?.().cacheBytes??32*1024*1024);
 const trim=(reserve=0)=>{
  const protectedKeys=new Set(demand.map(tileKey));
  for(const key of cache.keys()){if(cache.size<=(reserve?63:64)&&bytes+reserve<=limit())break;if(!protectedKeys.has(key))discard(key);}
  if(reserve)return;
  for(const tile of [...demand].reverse()){if(bytes<=limit())break;const key=tileKey(tile);if(cache.has(key)){discard(key);rejected.add(key);pressure?.();}}
 };
 const waiters:Array<()=>void>=[];
 let snapshot:GeographicScene|null=null;
 const wanted=()=>demand.filter(t=>!cache.has(tileKey(t))&&!pending.has(tileKey(t))&&!failed.has(tileKey(t))&&!rejected.has(tileKey(t)));
 const announce=()=>{if(disposed)return;revision++;snapshot=null;changed();};
 const pump=()=>{if(disposed)return;
  for(const tile of wanted()){
   if(pending.size>=(budget?.().concurrency??4))break;
   const key=tileKey(tile),start=performance.now();pending.add(key);
   void load(tile.z,tile.x,tile.y).then(value=>{
    if(disposed)return;observed?.(performance.now()-start,true);
    if(!demand.some(t=>tileKey(t)===key))return;
    const size=value.encoded?.byteLength??value.features.reduce((n,f)=>n+224+f.geometry.reduce((sum,r)=>sum+r.length*32,0),0);trim(size);if(size>limit()||bytes+size>limit()){rejected.add(key);pressure?.();return;}discard(key);cache.set(key,value);sizes.set(key,size);bytes+=size;
   },error=>{if(!disposed){if(error instanceof ResourcePressure){if(demand.some(t=>tileKey(t)===key)){rejected.add(key);pressure?.();}}else{observed?.(performance.now()-start,false);if(demand.some(t=>tileKey(t)===key))failed.add(key);}}}).finally(()=>{pending.delete(key);announce();pump();});
  }
  if(pending.size===0&&wanted().length===0)for(const resolve of waiters.splice(0))resolve();
 };
 return{
  update(camera:Camera,viewport:Viewport){if(disposed)return;
   const selection=camera.zoom<GLOBE_ZOOM?{tiles:[],limited:false}:geographicSelection(camera,viewport,budget?.()),next=selection.tiles,key=next.map(tileKey).join('|');
   const cap=limit(),budgetChanged=cap!==lastBudget;
   if(key===signature&&!budgetChanged&&selection.limited===selectionLimited)return;
   selectionLimited=selection.limited;
   if(key!==signature||cap>lastBudget)rejected.clear();lastBudget=cap;signature=key;demand=next;
   const keys=new Set(next.map(tileKey));for(const key of failed)if(!keys.has(key))failed.delete(key);
   trim();announce();pump();
  },
  retry(){failed.clear();rejected.clear();announce();pump();},
  scene():GeographicScene{
   if(snapshot?.revision===revision)return snapshot;
   const visible=new Map<string,GeographicTile>();
   for(const tile of demand){
    const key=tileKey(tile),direct=cache.get(key);
    if(direct){visible.set(key,direct);continue;}
    // A parent of exactly this location is a safe placeholder while detail arrives.
    for(let z=tile.z-1;z>=0;z--){const factor=2**(tile.z-z),parentKey=tileKey({z,x:Math.floor(tile.x/factor),y:Math.floor(tile.y/factor)}),parent=cache.get(parentKey);if(parent){visible.set(parentKey,parent);break;}}
   }
   const tiles=[...visible.values()].filter(parent=>![...visible.values()].some(child=>{
    if(child.z<=parent.z)return false;const factor=2**(child.z-parent.z);
    return parent.x===Math.floor(child.x/factor)&&parent.y===Math.floor(child.y/factor);
   }));
   return snapshot={tiles,revision,loading:demand.some(t=>!cache.has(tileKey(t))&&!failed.has(tileKey(t))&&!rejected.has(tileKey(t))),limited:selectionLimited||demand.some(t=>rejected.has(tileKey(t))),error:demand.some(t=>failed.has(tileKey(t)))};
  },
  status:()=>({bytes,entries:cache.size,pending:pending.size,rejected:rejected.size,limitBytes:limit(),demand:demand.length,selectionLimited}),
  dispose(){disposed=true;selectionLimited=false;demand=[];cache.clear();sizes.clear();bytes=0;failed.clear();rejected.clear();snapshot=null;revision++;for(const resolve of waiters.splice(0))resolve();},
  idle():Promise<void>{if(pending.size===0&&wanted().length===0)return Promise.resolve();return new Promise(resolve=>waiters.push(resolve));},
 };
}
