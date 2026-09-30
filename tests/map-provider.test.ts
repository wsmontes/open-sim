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
