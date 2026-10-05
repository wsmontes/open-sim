import {expect,test} from 'vitest';
import {createOsmSource} from '../src/adapters/osm/provider';
import {createMemoryTileCache,type TileCache} from '../src/adapters/osm/tile-cache';
import {createMemoryChunkCache} from '../src/adapters/osm/chunk-cache';

// The cache exists so a revisit costs nothing: the same vector tile covers 64 regions, so the bytes are worth keeping
// and the decoded features are not. These tests fix the four things that make such a cache safe to have.
const RESPONSE_BYTES=new Uint8Array([1,2,3,4,5]);
const serving=(counter:{requests:number})=>async()=>{counter.requests+=1;return new Response(RESPONSE_BYTES.slice());};

test('a new browser map source can reuse the already normalized region without tile decode or network',async()=>{
 const chunks=createMemoryChunkCache();
 const firstCount={requests:0};
 const first=createOsmSource({fetcher:serving(firstCount),chunks});
 const expected=await first.loadChunk('0:0');
 expect(firstCount.requests).toBe(1);
 let networkTouched=false;
 const reopened=createOsmSource({fetcher:async()=>{networkTouched=true;throw new Error('network should stay cold');},chunks});
 const restored=await reopened.loadChunk('0:0');
 expect(restored).toEqual(expected);
 expect(networkTouched).toBe(false);
});
test('normalized regions are invalidated when map source or overview zoom changes',async()=>{
 const chunks=createMemoryChunkCache();
 const a={requests:0},b={requests:0},counters={requests:0};
 const first=createOsmSource({tileUrl:'https://a.example/{z}/{x}/{y}',overviewZoom:11,fetcher:serving(a),chunks});
 await first.loadChunk('0:0','overview');
 expect(a.requests).toBe(1);
 const otherZoom=createOsmSource({tileUrl:'https://a.example/{z}/{x}/{y}',overviewZoom:10,fetcher:serving(b),chunks});
 await otherZoom.loadChunk('0:0','overview');
 expect(b.requests).toBe(1);
 const otherSource=createOsmSource({tileUrl:'https://b.example/{z}/{x}/{y}',overviewZoom:11,fetcher:serving(counters),chunks});
 await otherSource.loadChunk('0:0','overview');
 expect(counters.requests).toBe(1);
});
test('a second visit to the same place does not ask the network again',async()=>{
 const counter={requests:0};
 const cache=createMemoryTileCache();
 const maps=createOsmSource({fetcher:serving(counter),cache});
 await maps.loadChunk('0:0');
 const afterFirst=counter.requests;
 await maps.loadChunk('1:1');
 expect(counter.requests).toBe(afterFirst);
 // A different tile is a different key and must still be fetched.
 await maps.loadChunk('0:0','overview');
 expect(counter.requests).toBeGreaterThan(afterFirst);
});
test('what the cache keeps is exactly what the network sent',async()=>{
 const counter={requests:0};
 const store=new Map<string,Uint8Array>();
 const cache:TileCache={get:async key=>store.get(key)??null,put:async(key,bytes)=>{store.set(key,bytes.slice());}};
 const maps=createOsmSource({fetcher:serving(counter),cache});
 await maps.loadChunk('0:0');
 const kept=[...store.values()][0]!;
 expect([...kept]).toEqual([...RESPONSE_BYTES]);
});
test('a cached load and an uncached load of the same region are the same region',async()=>{
 const counter={requests:0};
 const warm=createOsmSource({fetcher:serving(counter),cache:createMemoryTileCache()});
 await warm.loadChunk('0:0');
 const cached=await warm.loadChunk('0:0');
 const cold=await createOsmSource({fetcher:serving(counter)}).loadChunk('0:0');
 expect(cached).toEqual(cold);
});
test('writing a freshly fetched tile never delays the chunk that uses it',async()=>{
 const counter={requests:0};
 let release!:()=>void,started=false;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const slow:TileCache={get:async()=>null,put:async()=>{started=true;await gate;}};
 const maps=createOsmSource({fetcher:serving(counter),cache:slow});
 const chunk=maps.loadChunk('0:0');
 // Let fetch/arrayBuffer reach the cache write. The map chunk must still finish while persistence is deliberately stuck.
 for(let i=0;i<20&&!started;i+=1)await Promise.resolve();
 expect(started).toBe(true);
 const outcome=await Promise.race([chunk.then(()=> 'chunk'),new Promise<string>(resolve=>setTimeout(()=>resolve('blocked'),50))]);
 expect(outcome).toBe('chunk');
 release();
});
test('a cache that cannot be read or written is a miss, never a failure',async()=>{
 const counter={requests:0};
 const broken:TileCache={get:async()=>{throw new Error('IndexedDB bloqueado');},put:async()=>{throw new Error('quota');}};
 const maps=createOsmSource({fetcher:serving(counter),cache:broken});
 expect((await maps.loadChunk('0:0')).cells).toHaveLength(1024);
 expect(counter.requests).toBe(1);
});
test('a tile older than the window is not served and is dropped',async()=>{
 let now=1_000_000;
 const cache=createMemoryTileCache({maxAgeMs:1000,now:()=>now});
 await cache.put('z/14/1/1',new Uint8Array(4));
 now+=999;
 expect(await cache.get('z/14/1/1')).not.toBeNull();
 now+=2;
 expect(await cache.get('z/14/1/1')).toBeNull();
 // Dropped, not merely hidden: the bytes are gone and the device has room for the fresh copy.
 expect(await cache.stats()).toEqual({tiles:0,bytes:0});
});
test('the bytes kept are pruned to the budget, oldest first',async()=>{
 const cache=createMemoryTileCache({maxBytes:10,now:()=>1_000_000});
 await cache.put('a',new Uint8Array(4));
 await cache.put('b',new Uint8Array(4));
 await cache.put('c',new Uint8Array(4));
 expect(await cache.get('a')).toBeNull();
 expect(await cache.get('b')).not.toBeNull();
 expect(await cache.get('c')).not.toBeNull();
 expect((await cache.stats()).bytes).toBeLessThanOrEqual(10);
});
test('reading a tile is what keeps it: the least recently used bytes go first',async()=>{
 const cache=createMemoryTileCache({maxBytes:10,now:()=>1_000_000});
 await cache.put('a',new Uint8Array(4));
 await cache.put('b',new Uint8Array(4));
 expect(await cache.get('a')).not.toBeNull();
 await cache.put('c',new Uint8Array(4));
 expect(await cache.get('a')).not.toBeNull();
 expect(await cache.get('b')).toBeNull();
});

test('raw bytes belong to the configured source',async()=>{
 const cache=createMemoryTileCache(),a={requests:0},b={requests:0};
 await createOsmSource({tileUrl:'https://a/{z}/{x}/{y}',fetcher:serving(a),cache}).loadChunk('0:0');
 await createOsmSource({tileUrl:'https://b/{z}/{x}/{y}',fetcher:serving(b),cache}).loadChunk('0:0');
 expect(b.requests).toBe(1);
});
test('a cache that never answers does not hold map request slots',async()=>{
 const maps=createOsmSource({timeoutMs:20,cache:{get:()=>new Promise(()=>{}),put:async()=>{}},fetcher:serving({requests:0})});
 const outcome=await Promise.race([maps.loadChunk('0:0').then(()=> 'loaded'),new Promise(resolve=>setTimeout(()=>resolve('stuck'),100))]);
 expect(outcome).toBe('loaded');
});

test('tile and normalized caches retry opens that miss their deadline',async()=>{
 const {vi}=await import('vitest');vi.useFakeTimers();
 const {IDBFactory}=await import('fake-indexeddb');const real=new IDBFactory();let opens=0;
 vi.stubGlobal('indexedDB',{open:(...args:Parameters<IDBFactory['open']>)=>++opens<=2?{}:real.open(...args)});
 try{
  const {createIndexedDbTileCache}=await import('../src/adapters/osm/tile-cache');
  const {createIndexedDbChunkCache}=await import('../src/adapters/osm/chunk-cache');
  const tiles=createIndexedDbTileCache(),chunks=createIndexedDbChunkCache();
  const pending=Promise.all([tiles.get('a'),chunks.get('a')]);await vi.advanceTimersByTimeAsync(8000);
  expect(await pending).toEqual([null,null]);vi.useRealTimers();
  await tiles.put('a',new Uint8Array([1]));expect(await tiles.get('a')).toEqual(new Uint8Array([1]));expect(await chunks.get('a')).toBeNull();expect(opens).toBe(4);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});
