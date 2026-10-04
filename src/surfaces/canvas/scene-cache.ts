export function createSceneCache<T>(limitBytes:number,dispose:(value:T)=>void=()=>{}){
 const entries=new Map<string,{value:T;bytes:number}>();let bytes=0,hits=0,misses=0,evictions=0;
 const remove=(key:string)=>{const old=entries.get(key);if(old){entries.delete(key);bytes-=old.bytes;dispose(old.value);}};
 return {
  get(key:string):T|undefined{const old=entries.get(key);if(!old){misses++;return;}hits++;entries.delete(key);entries.set(key,old);return old.value;},
  set(key:string,value:T,size:number){if(!Number.isFinite(size)||size<0||size>limitBytes)return false;remove(key);while(bytes+size>limitBytes&&entries.size){remove(entries.keys().next().value!);evictions++;}entries.set(key,{value,bytes:size});bytes+=size;return true;},
  delete:remove,
  clear(){for(const key of entries.keys())remove(key);},
  stats:()=>({bytes,entries:entries.size,hits,misses,evictions}),
 };
}
// Raster resources have one owner; all consumers compete within the same byte budget.
export const sceneRasterCache=createSceneCache<{canvas:OffscreenCanvas}>(128*1024*1024,value=>{value.canvas.width=0;value.canvas.height=0;});
