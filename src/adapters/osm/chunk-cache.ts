import {boundedDb} from '../storage/bounded-db';
import type {BaseChunk} from '../../core/model';

export interface ChunkCache {
 get(key:string):Promise<BaseChunk|null>;
 put(key:string,chunk:BaseChunk):Promise<void>;
}

export const NO_CHUNK_CACHE:ChunkCache={get:async()=>null,put:async()=>{}};

// A cached region is copied once, when it is stored, and frozen: every later read hands out the same object, so a
// revisit costs a map lookup instead of a deep copy of 1,024 cells, and a caller that tried to edit it would throw
// instead of silently changing the cache.
const frozenCopy=(chunk:BaseChunk):BaseChunk=>{
 const copy=structuredClone(chunk);
 for(const cell of copy.cells)Object.freeze(cell);
 Object.freeze(copy.cells);
 return Object.freeze(copy);
};
export function createMemoryChunkCache(limit=256):ChunkCache {
 const entries=new Map<string,BaseChunk>();
 return {
  async get(key){
   const found=entries.get(key);
   if(!found)return null;
   entries.delete(key);entries.set(key,found);
   return found;
  },
  async put(key,chunk){
   entries.delete(key);entries.set(key,frozenCopy(chunk));
   while(entries.size>limit){const first=entries.keys().next().value;if(first===undefined)break;entries.delete(first);}
  },
 };
}

const DB='open-sim-normalized-map',STORE='chunks';
type Stored={key:string;chunk:BaseChunk;storedAt:number};
export function createIndexedDbChunkCache(options:{maxEntries?:number;maxAgeMs?:number;now?:()=>number}={}):ChunkCache {
 const maxEntries=options.maxEntries??256,maxAgeMs=options.maxAgeMs??30*24*60*60*1000,now=options.now??Date.now;
 const connect=globalThis.indexedDB?boundedDb({name:DB,stores:[STORE],factory:globalThis.indexedDB,subject:'O cache de mapas',upgrade:db=>{if(!db.objectStoreNames.contains(STORE)){const store=db.createObjectStore(STORE,{keyPath:'key'});store.createIndex('storedAt','storedAt');}}}):null;
 const open=async():Promise<IDBDatabase|null>=>connect?connect().catch(()=>null):null;
 const withStore=<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T|null>=>open().then(db=>{
  if(!db)return null;
  return new Promise<T|null>(resolve=>{
   try{const tx=db.transaction(STORE,mode),request=work(tx.objectStore(STORE));request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null);tx.onabort=()=>resolve(null);}catch{resolve(null);}
  });
 });

 // A wide overview can finish hundreds of regions in the same turn. Persist them in one IndexedDB transaction instead
 // of opening one transaction (and one prune scan) per region; persistence is disposable and must never compete with
 // input/rendering for the main thread.
 type Waiting={chunk:BaseChunk;waiters:Array<()=>void>};
 const queued=new Map<string,Waiting>(),writing=new Map<string,BaseChunk>();
 let flushing=false,pruneTimer:ReturnType<typeof setTimeout>|null=null;
 const prune=async()=>{
  const db=await open();if(!db)return;
  await new Promise<void>(resolve=>{
   try{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),count=store.count();
    count.onsuccess=()=>{let excess=Math.max(0,count.result-maxEntries);if(!excess){resolve();return;}const cursor=store.index('storedAt').openCursor();cursor.onsuccess=()=>{const at=cursor.result;if(!at||excess<=0){resolve();return;}at.delete();excess-=1;at.continue();};cursor.onerror=()=>resolve();};
    count.onerror=()=>resolve();tx.oncomplete=()=>resolve();tx.onabort=()=>resolve();
   }catch{resolve();}
  });
 };
 const schedulePrune=()=>{
  if(pruneTimer!==null)return;
  pruneTimer=setTimeout(()=>{pruneTimer=null;void prune();},750);
 };
 const flush=async()=>{
  if(flushing||!queued.size)return;
  flushing=true;
  const batch=[...queued.entries()];queued.clear();
  for(const [key,value] of batch)writing.set(key,value.chunk);
  const db=await open();
  if(db)await new Promise<void>(resolve=>{
   try{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
    for(const [key,value] of batch)store.put({key,chunk:value.chunk,storedAt:now()} satisfies Stored);
    tx.oncomplete=()=>resolve();tx.onabort=()=>resolve();tx.onerror=()=>resolve();
   }catch{resolve();}
  });
  for(const [key,value] of batch){writing.delete(key);for(const done of value.waiters)done();}
  flushing=false;
  schedulePrune();
  if(queued.size)queueMicrotask(()=>{void flush();});
 };
 return {
  async get(key){
   const pending=queued.get(key)?.chunk??writing.get(key);
   if(pending)return structuredClone(pending);
   try{const stored=await withStore<Stored|undefined>('readonly',store=>store.get(key) as IDBRequest<Stored|undefined>);if(!stored)return null;if(now()-stored.storedAt>maxAgeMs){void withStore('readwrite',store=>store.delete(key));return null;}return stored.chunk;}catch{return null;}
  },
  put(key,chunk){
   return new Promise<void>(resolve=>{
    const current=queued.get(key);
    if(current){current.chunk=chunk;current.waiters.push(resolve);}
    else queued.set(key,{chunk,waiters:[resolve]});
    if(!flushing)queueMicrotask(()=>{void flush();});
   });
  },
 };
}

