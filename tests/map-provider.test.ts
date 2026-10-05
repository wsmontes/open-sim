import {expect,test} from 'vitest';
import {createOsmSource} from '../src/adapters/osm/provider';
test('simultaneous region requests share their underlying tile',async()=>{let requests=0;const maps=createOsmSource({fetcher:async()=>{requests++;return new Response(new Uint8Array());}});const [a,b]=await Promise.all([maps.loadChunk('0:0'),maps.loadChunk('1:0')]);expect(a.id).toBe('0:0');expect(b.id).toBe('1:0');expect(requests).toBe(1);});
test('network failures never become invented terrain and can be retried',async()=>{let fail=true;const maps=createOsmSource({fetcher:async()=>fail?new Response('',{status:503}):new Response(new Uint8Array())});await expect(maps.loadChunk('0:0')).rejects.toThrow();fail=false;expect((await maps.loadChunk('0:0')).source).toContain('OpenStreetMap');});
test('timed out request releases its slot for an explicit retry',async()=>{let attempts=0;const maps=createOsmSource({timeoutMs:5,fetcher:async(_input,init)=>{if(++attempts>1)return new Response(new Uint8Array());return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('timeout'))));}});await expect(maps.loadChunk('0:0')).rejects.toThrow();expect((await maps.loadChunk('0:0')).cells).toHaveLength(1024);});
test('the overview level asks for a coarser tile and says so in the chunk source',async()=>{
 const urls:string[]=[];
 const maps=createOsmSource({overviewZoom:11,fetcher:async(input)=>{urls.push(String(input));return new Response(new Uint8Array());}});
 const detail=await maps.loadChunk('0:0');
 const overview=await maps.loadChunk('0:0','overview');
 expect(urls[0]).toContain('/14/');
 expect(urls[1]).toContain('/11/');
 expect(detail.source).toBe('OpenStreetMap · Shortbread v1');
 expect(overview.source).toContain('aproximação z11');
 expect(overview.cells).toHaveLength(1024);
 expect(overview.id).toBe('0:0');
});
test('regions of one coarse tile share a single request',async()=>{
 let requests=0;
 const maps=createOsmSource({overviewZoom:11,fetcher:async()=>{requests++;return new Response(new Uint8Array());}});
 // a zoom 11 tile spans 2048 cells per side, so these two regions belong to the same tile
 await Promise.all([maps.loadChunk('0:0','overview'),maps.loadChunk('1:1','overview'),maps.loadChunk('63:63','overview')]);
 expect(requests).toBe(1);
});
test('region download budgets are enforced before the provider writes any tile',async()=>{
 const {createMemoryTileCache}=await import('../src/adapters/osm/tile-cache');const cache=createMemoryTileCache();
 const maps=createOsmSource({cache,fetcher:async()=>new Response(new Uint8Array(10))});
 const coverage=await maps.prepareRegion({bounds:{west:-123.13,east:-123.12,south:49.28,north:49.29},levels:['detail'],maxBytes:1},()=>{});
 expect(coverage.complete).toBe(false);expect((await cache.stats()).bytes).toBe(0);
});
test('offline preparation uses the configured overview resolution',async()=>{
 const {createMemoryTileCache}=await import('../src/adapters/osm/tile-cache');const urls:string[]=[];
 const maps=createOsmSource({overviewZoom:10,cache:createMemoryTileCache(),fetcher:async url=>{urls.push(String(url));return new Response(new Uint8Array([8,0]));}});
 await maps.prepareRegion({bounds:{west:-123.13,east:-123.12,south:49.28,north:49.29},levels:['overview'],maxBytes:100},()=>{});
 expect(urls.length).toBeGreaterThan(0);expect(urls.every(url=>url.includes('/10/'))).toBe(true);
});
test('shares compact visual tile bytes without decoding them on the caller thread',async()=>{let requests=0;const maps=createOsmSource({fetcher:async()=>{requests++;return new Response(new Uint8Array([8,0]));}});const [a,b]=await Promise.all([maps.loadEncodedTile(14,1,2),maps.loadEncodedTile(14,1,2)]);expect(a).toBe(b);expect(a.features).toEqual([]);expect(a.encoded).toEqual(new Uint8Array([8,0]));expect(await maps.loadEncodedTile(14,1,2)).toBe(a);expect(requests).toBe(1);maps.destroy();});
test('pausing region download aborts its network request',async()=>{
 const abort=new AbortController();let started!:()=>void,networkAborted=false;
 const ready=new Promise<void>(resolve=>{started=resolve;});
 const maps=createOsmSource({fetcher:async(_url,init)=>{started();return new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>{networkAborted=true;reject(new Error('abort'));}));}});
 const pending=maps.prepareRegion({bounds:{west:0,east:0,south:0,north:0},levels:['detail'],maxBytes:100},()=>{},abort.signal);
 await ready;abort.abort();await pending;expect(networkAborted).toBe(true);
});
test('region preparation and normal map loading reuse the same source-scoped raw tile',async()=>{
 const {createMemoryTileCache}=await import('../src/adapters/osm/tile-cache');let requests=0;
 const maps=createOsmSource({cache:createMemoryTileCache(),fetcher:async()=>{requests++;return new Response(new Uint8Array([8,0]));}});
 const prepared=await maps.prepareRegion({bounds:{west:-180,east:-180,south:85.05112878,north:85.05112878},levels:['detail'],maxBytes:100},()=>{});
 expect(prepared.complete).toBe(true);await maps.loadChunk('0:0');expect(requests).toBe(1);
});
test('destroy cancels cache waits and prevents late cache misses starting fetch',async()=>{
 let release!:(value:null)=>void,requests=0;
 const maps=createOsmSource({cache:{get:()=>new Promise(resolve=>{release=resolve;}),put:async()=>{}},fetcher:async()=>{requests++;return new Response(new Uint8Array());}});
 const pending=maps.loadChunk('0:0');await Promise.resolve();await Promise.resolve();maps.destroy();
 release(null);await expect(pending).rejects.toThrow();expect(requests).toBe(0);
 await expect(maps.loadChunk('0:0')).rejects.toThrow();expect(requests).toBe(0);
});
test('destroy aborts active requests and never starts queued fetches or persists late bytes',async()=>{
 let requests=0,aborted=0,writes=0;const releases:Array<(response:Response)=>void>=[];
 const maps=createOsmSource({cache:{get:async()=>null,put:async()=>{writes++;}},fetcher:async(_url,init)=>{requests++;init?.signal?.addEventListener('abort',()=>{aborted++;});return new Promise(resolve=>{releases.push(resolve);});}});
 const pending=Array.from({length:6},(_,i)=>maps.loadChunk(`${i*8}:0`).then(()=> 'loaded',()=> 'canceled'));
 for(let i=0;i<30&&requests<4;i++)await Promise.resolve();expect(requests).toBe(4);maps.destroy();
 for(const release of releases)release(new Response(new Uint8Array()));
 expect(await Promise.all(pending)).toEqual(Array(6).fill('canceled'));expect(aborted).toBe(4);expect(requests).toBe(4);expect(writes).toBe(0);
});
test('destroy interrupts normalized cache waits before decode begins',async()=>{
 let release!:(value:null)=>void,requests=0;
 const maps=createOsmSource({chunks:{get:()=>new Promise(resolve=>{release=resolve;}),put:async()=>{}},fetcher:async()=>{requests++;return new Response(new Uint8Array());}});
 const pending=maps.loadChunk('0:0');maps.destroy();release(null);await expect(pending).rejects.toThrow();expect(requests).toBe(0);
});
test('destroy cancels region cache wait without a fetch or late progress',async()=>{
 let requests=0,progress=0;
 const maps=createOsmSource({cache:{get:()=>new Promise(()=>{}),put:async()=>{}},fetcher:async()=>{requests++;return new Response(new Uint8Array());}});
 const pending=maps.prepareRegion({bounds:{west:0,east:0,south:0,north:0},levels:['detail'],maxBytes:100},()=>{progress++;});maps.destroy();
 expect((await pending).stopReason).toBe('paused');expect(requests).toBe(0);expect(progress).toBe(0);
 await expect(maps.prepareRegion({bounds:{west:0,east:0,south:0,north:0},levels:['detail'],maxBytes:100},()=>{})).rejects.toThrow();
});
