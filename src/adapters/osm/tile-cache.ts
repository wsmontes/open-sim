// The tile cache is what makes a revisit free. It keeps the *raw* vector bytes the map service sent, not the decoded
// features and not the normalized regions: one zoom-14 tile covers 64 regions, so the shared unit is the tile, and the
// decoded form (which is far bigger) stays in memory only while it is being used.
//
// It is a port on purpose. The provider only needs `get` and `put`, a test can hand a trivial fake, and a runtime
// without IndexedDB (private mode, an older browser) gets the no-op instead of a broken map: a cache that cannot be
// read or written must be a miss, never a failure.
export interface TileCache {
 get(key: string): Promise<Uint8Array | null>;
 put(key: string, bytes: Uint8Array): Promise<void>;
}
export type TileCacheStats = {tiles: number; bytes: number};
export type InspectableTileCache = TileCache & {stats(): Promise<TileCacheStats>};
// A runtime that cannot cache is still a runtime that can play.
export const NO_TILE_CACHE: TileCache = {get:async()=>null,put:async()=>{}};

export type TileCacheOptions = {
 // How long a tile is worth serving without asking again. Vector data changes slowly and the service sets its own
 // cache headers; a month keeps a familiar city instant without pretending the map never changes.
 maxAgeMs?: number;
 // How many bytes may be kept on the device. Pruning is oldest-first, so what a player visits often stays.
 maxBytes?: number;
 now?: () => number;
};
const DAY=24*60*60*1000;
const DEFAULTS={maxAgeMs:30*DAY,maxBytes:48*1024*1024};

// The same policy as the device cache, kept in a Map: used by tests, by the fallback path when IndexedDB is missing,
// and by any runtime that would rather not touch storage at all.
export function createMemoryTileCache(options:TileCacheOptions={}):InspectableTileCache {
 const maxAgeMs=options.maxAgeMs??DEFAULTS.maxAgeMs,maxBytes=options.maxBytes??DEFAULTS.maxBytes,now=options.now??Date.now;
 const entries=new Map<string,{bytes:Uint8Array;storedAt:number}>();
 let bytes=0;
 const drop=(key:string)=>{
  const entry=entries.get(key);
  if(!entry)return;
  bytes-=entry.bytes.byteLength;
  entries.delete(key);
 };
 const prune=()=>{
  while(bytes>maxBytes){
   const oldest=entries.keys().next().value;
   if(oldest===undefined)return;
   drop(oldest);
  }
 };
 return {
  async get(key){
   const entry=entries.get(key);
   if(!entry)return null;
   if(now()-entry.storedAt>maxAgeMs){drop(key);return null;}
   // Touching a tile moves it to the back of the queue: pruning then removes what nobody asks for.
   entries.delete(key);
   entries.set(key,entry);
   return entry.bytes;
  },
  async put(key,value){
   drop(key);
   const copy=value.slice();
   entries.set(key,{bytes:copy,storedAt:now()});
   bytes+=copy.byteLength;
   prune();
  },
  async stats(){return {tiles:entries.size,bytes};},
 };
}

const DB_NAME='open-sim-tiles',STORE='tiles',VERSION=1;
type StoredTile={bytes:ArrayBuffer;storedAt:number};
// The device cache. Everything it does can fail — private mode, a quota the browser refuses, a database another tab
// upgraded — and every failure is reported as a miss so the map keeps loading from the network.
export function createIndexedDbTileCache(options:TileCacheOptions={}):InspectableTileCache {
 const maxAgeMs=options.maxAgeMs??DEFAULTS.maxAgeMs,maxBytes=options.maxBytes??DEFAULTS.maxBytes,now=options.now??Date.now;
 let opening:Promise<IDBDatabase|null>|null=null;
 let knownBytes:number|null=null;
 const open=():Promise<IDBDatabase|null>=>{
  if(opening)return opening;
  opening=new Promise<IDBDatabase|null>(resolve=>{
   const factory=globalThis.indexedDB;
   if(!factory){resolve(null);return;}
   let request:IDBOpenDBRequest;
   try{request=factory.open(DB_NAME,VERSION);}catch{resolve(null);return;}
   request.onupgradeneeded=()=>{
    const db=request.result;
    if(!db.objectStoreNames.contains(STORE)){
     const store=db.createObjectStore(STORE,{keyPath:'key'});
     store.createIndex('storedAt','storedAt');
    }
   };
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>resolve(null);
   request.onblocked=()=>resolve(null);
  });
  return opening;
 };
 const withStore=async <T>(mode:IDBTransactionMode,work:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T|null>=>{
  const db=await open();
  if(!db)return null;
  return new Promise<T|null>(resolve=>{
   let transaction:IDBTransaction;
   try{transaction=db.transaction(STORE,mode);}catch{resolve(null);return;}
   const request=work(transaction.objectStore(STORE));
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>resolve(null);
   transaction.onabort=()=>resolve(null);
  });
 };
 const total=async():Promise<number>=>{
  if(knownBytes!==null)return knownBytes;
  const db=await open();
  if(!db)return 0;
  return new Promise<number>(resolve=>{
   let sum=0;
   try{
    const request=db.transaction(STORE,'readonly').objectStore(STORE).openCursor();
    request.onsuccess=()=>{
     const cursor=request.result;
     if(!cursor){knownBytes=sum;resolve(sum);return;}
     const value=cursor.value as {bytes?:ArrayBuffer};
     sum+=value.bytes?.byteLength??0;
     cursor.continue();
    };
    request.onerror=()=>resolve(sum);
   }catch{resolve(sum);}
  });
 };
 const prune=async():Promise<void>=>{
  let bytes=await total();
  if(bytes<=maxBytes)return;
  const db=await open();
  if(!db)return;
  await new Promise<void>(resolve=>{
   try{
    const transaction=db.transaction(STORE,'readwrite'),store=transaction.objectStore(STORE),cursor=store.index('storedAt').openCursor();
    cursor.onsuccess=()=>{
     const at=cursor.result;
     if(!at||bytes<=maxBytes){resolve();return;}
     const value=at.value as {bytes?:ArrayBuffer};
     bytes-=value.bytes?.byteLength??0;
     at.delete();
     at.continue();
    };
    cursor.onerror=()=>resolve();
    transaction.oncomplete=()=>resolve();
    transaction.onabort=()=>resolve();
   }catch{resolve();}
  });
  knownBytes=Math.max(0,bytes);
 };
 return {
  async get(key){
   try{
    const stored=await withStore<StoredTile|undefined>('readonly',store=>store.get(key) as IDBRequest<StoredTile|undefined>);
    if(!stored)return null;
    if(now()-stored.storedAt>maxAgeMs){
     await withStore('readwrite',store=>store.delete(key));
     if(knownBytes!==null)knownBytes=Math.max(0,knownBytes-(stored.bytes?.byteLength??0));
     return null;
    }
    return new Uint8Array(stored.bytes);
   }catch{return null;}
  },
  async put(key,value){
   const copy=value.slice();
   const stored:StoredTile & {key:string}={key,bytes:copy.buffer.slice(copy.byteOffset,copy.byteOffset+copy.byteLength),storedAt:now()};
   try{
    const done=await withStore('readwrite',store=>store.put(stored));
    if(done===null&&!(await open()))return;
    if(knownBytes!==null)knownBytes+=copy.byteLength;
    else knownBytes=await total();
    await prune();
   }catch{/* A cache that refuses a write is a cache miss next time, not a broken map. */}
  },
  async stats(){
   const bytes=await total();
   const count=await withStore<number>('readonly',store=>store.count());
   return {tiles:count??0,bytes};
  },
 };
}
