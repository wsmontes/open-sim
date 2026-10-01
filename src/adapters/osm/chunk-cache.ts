import type {BaseChunk} from '../../core/model';

export interface ChunkCache {
 get(key:string):Promise<BaseChunk|null>;
 put(key:string,chunk:BaseChunk):Promise<void>;
}

export const NO_CHUNK_CACHE:ChunkCache={get:async()=>null,put:async()=>{}};

export function createMemoryChunkCache(limit=256):ChunkCache {
 const entries=new Map<string,BaseChunk>();
 return {
  async get(key){
   const found=entries.get(key);
   if(!found)return null;
   entries.delete(key);entries.set(key,found);
   return structuredClone(found);
  },
  async put(key,chunk){
   entries.delete(key);entries.set(key,structuredClone(chunk));
   while(entries.size>limit){const first=entries.keys().next().value;if(first===undefined)break;entries.delete(first);}
  },
 };
}

const DB='open-sim-normalized-map',STORE='chunks',VERSION=1;
type Stored={key:string;chunk:BaseChunk;storedAt:number};
export function createIndexedDbChunkCache(options:{maxEntries?:number;maxAgeMs?:number;now?:()=>number}={}):ChunkCache {
 const maxEntries=options.maxEntries??256,maxAgeMs=options.maxAgeMs??30*24*60*60*1000,now=options.now??Date.now;
 let opening:Promise<IDBDatabase|null>|null=null;
 const open=()=>opening??=new Promise<IDBDatabase|null>(resolve=>{
  if(!globalThis.indexedDB){resolve(null);return;}
  let request:IDBOpenDBRequest;
  try{request=indexedDB.open(DB,VERSION);}catch{resolve(null);return;}
  request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE)){const store=db.createObjectStore(STORE,{keyPath:'key'});store.createIndex('storedAt','storedAt');}};
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null);request.onblocked=()=>resolve(null);
 });
 const withStore=<T>(mode:IDBTransactionMode,work:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T|null>=>open().then(db=>{
  if(!db)return null;
  return new Promise<T|null>(resolve=>{
   try{const tx=db.transaction(STORE,mode),request=work(tx.objectStore(STORE));request.onsuccess=()=>resolve(request.result);request.onerror=()=>resolve(null);tx.onabort=()=>resolve(null);}catch{resolve(null);}
  });
 });
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
 return {
  async get(key){
   try{const stored=await withStore<Stored|undefined>('readonly',store=>store.get(key) as IDBRequest<Stored|undefined>);if(!stored)return null;if(now()-stored.storedAt>maxAgeMs){void withStore('readwrite',store=>store.delete(key));return null;}return stored.chunk;}catch{return null;}
  },
  async put(key,chunk){
   try{await withStore('readwrite',store=>store.put({key,chunk,storedAt:now()}));void prune();}catch{}
  },
 };
}
