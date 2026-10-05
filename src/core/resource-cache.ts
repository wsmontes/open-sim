// Platform-independent byte admission and explicit disposal. Callers retain ownership when set returns false.
export function createResourceCache<T>(limitBytes:number,dispose:(value:T)=>void=()=>{},maxEntries=Infinity){
 const entries=new Map<string,{value:T;bytes:number}>();let bytes=0,hits=0,misses=0,evictions=0;
 const remove=(key:string)=>{const old=entries.get(key);if(old){entries.delete(key);bytes-=old.bytes;dispose(old.value);}};
 return {
  get(key:string):T|undefined{const old=entries.get(key);if(!old){misses++;return;}hits++;entries.delete(key);entries.set(key,old);return old.value;},
  set(key:string,value:T,size:number){if(!Number.isFinite(size)||size<0||size>limitBytes||maxEntries<=0)return false;remove(key);while((bytes+size>limitBytes||entries.size>=maxEntries)&&entries.size){remove(entries.keys().next().value!);evictions++;}entries.set(key,{value,bytes:size});bytes+=size;return true;},
  setLimit(next:number){if(!Number.isFinite(next)||next<0)throw new Error('Invalid resource budget');limitBytes=next;while(bytes>limitBytes&&entries.size){remove(entries.keys().next().value!);evictions++;}},
  delete:remove,
  clear(){for(const key of entries.keys())remove(key);},
  stats:()=>({bytes,entries:entries.size,hits,misses,evictions}),
 };
}
