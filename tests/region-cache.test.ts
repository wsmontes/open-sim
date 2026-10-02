import {expect,test} from 'vitest';
import {tilesForRegion,prepareRegion} from '../src/adapters/osm/region-cache';
import {createMemoryTileCache} from '../src/adapters/osm/tile-cache';
const request={bounds:{west:-123.13,south:49.27,east:-123.11,north:49.29},levels:['overview','detail'] as const,maxBytes:1000};
test('region coverage is resumable and verified from stored tiles',async()=>{
 const cache=createMemoryTileCache();let fetched=0;
 const source={read:(key:string)=>cache.get(key),fetch:async()=>{fetched++;return new Uint8Array([1,2,3]);},write:(key:string,bytes:Uint8Array)=>cache.put(key,bytes)};
 const first=await prepareRegion(request,source,()=>{});expect(first.complete).toBe(true);expect(fetched).toBe(tilesForRegion(request).length);
 await prepareRegion(request,source,()=>{});expect(fetched).toBe(first.required);
});
test('failed persistence cannot claim offline readiness',async()=>{
 const result=await prepareRegion(request,{read:async()=>null,fetch:async()=>new Uint8Array([1]),write:async()=>{throw new Error('quota');}},()=>{});
 expect(result.complete).toBe(false);expect(result.stored).toBe(0);expect(result.failures).toBeGreaterThan(0);
});
test('wrapped longitude is bounded and a byte budget prevents unlimited downloads',async()=>{
 expect(tilesForRegion({...request,bounds:{west:179.99,east:-179.99,south:0,north:.01}}).length).toBeLessThan(20);
 const cache=createMemoryTileCache();let count=0;
 const result=await prepareRegion({...request,maxBytes:1},{read:key=>cache.get(key),fetch:async()=>{count++;return new Uint8Array([1,2,3]);},write:(key,b)=>cache.put(key,b)},()=>{});
 expect(result.complete).toBe(false);expect(result.bytes).toBeLessThanOrEqual(1);expect(count).toBe(1);
});
test('final coverage bytes describe retained assets after eviction',async()=>{
 const cache=createMemoryTileCache({maxBytes:3});
 const result=await prepareRegion(request,{read:key=>cache.get(key),fetch:async()=>new Uint8Array([1,2,3]),write:(key,b)=>cache.put(key,b)},()=>{});
 expect(result.bytes).toBe((await cache.stats()).bytes);expect(result.complete).toBe(false);
});
