import {expect,test} from 'vitest';
import {createGeographicStream} from '../src/browser/geographic-stream';
import {centerOn} from '../src/presentation/camera';
import {toCell} from '../src/core/coordinates';
import type {GeographicTile} from '../src/presentation/geographic-map';
const viewport={width:800,height:600};
const camera=centerOn(toCell(49.2827,-123.1207),{x:0,y:0,zoom:.01,rotation:0},viewport);
test('rapid navigation loads a bounded set, deduplicates tiles and does not show stale geography',async()=>{
 let active=0,peak=0,changed=0;
 const calls:string[]=[];
 const stream=createGeographicStream(async(z,x,y)=>{active++;peak=Math.max(peak,active);calls.push(`${z}:${x}:${y}`);await Promise.resolve();active--;return{z,x,y,features:[]} as GeographicTile;},()=>changed++);
 stream.update(camera,viewport);stream.update(camera,viewport);
 await stream.idle();
 expect(peak).toBeLessThanOrEqual(4);expect(new Set(calls).size).toBe(calls.length);
 expect(stream.scene().tiles.length).toBeGreaterThan(0);expect(changed).toBeGreaterThan(0);
 const globe={...camera,zoom:.000003};stream.update(globe,viewport);await stream.idle();
 expect(stream.scene().tiles).toHaveLength(0);
});
test('a failed visual tile can be retried without poisoning future requests',async()=>{
 let failed=true;
 const stream=createGeographicStream(async(z,x,y)=>{if(failed)throw new Error('offline');return{z,x,y,features:[]};},()=>{});
 stream.update(camera,viewport);await stream.idle();expect(stream.scene().error).toBe(true);
 failed=false;stream.retry();await stream.idle();expect(stream.scene().error).toBe(false);expect(stream.scene().tiles.length).toBeGreaterThan(0);
});

test('cached parent placeholders cannot overlap ready detail tiles after a partial failure',async()=>{
 const v={width:1280,height:800},at=centerOn(toCell(49.2827,-123.1207),{x:0,y:0,zoom:.025,rotation:Math.PI/4},v);
 const stream=createGeographicStream(async(z,x,y)=>{if(z===14&&x===2589)throw new Error('offline');return{z,x,y,features:[]};},()=>{});
 stream.update(at,v);await stream.idle();
 const {zoomTo}=await import('../src/presentation/camera');stream.update(zoomTo(at,v,.05),v);await stream.idle();
 const tiles=stream.scene().tiles;expect(stream.scene().error).toBe(true);
 for(const a of tiles)for(const b of tiles)if(a.z<b.z){const factor=2**(b.z-a.z);expect(a.x===Math.floor(b.x/factor)&&a.y===Math.floor(b.y/factor)).toBe(false);}
});
test('disposal releases retained tiles and ignores delayed loader publications',async()=>{let resolve!:(value:GeographicTile)=>void,changes=0;const stream=createGeographicStream(()=>new Promise(r=>resolve=r),()=>changes++);stream.update({x:0,y:0,zoom:.0001,rotation:0},{width:100,height:100});const before=changes;stream.dispose();resolve({z:0,x:0,y:0,features:[]});await new Promise(r=>setTimeout(r,0));expect(changes).toBe(before);expect(stream.scene().tiles).toHaveLength(0);});

test('adaptive detail updates without camera motion and bounded network demand',async()=>{
 let bias=0,active=0,peak=0;
 const stream=createGeographicStream(async(z,x,y)=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return{z,x,y,features:[]};},()=>{},()=>({zoomBias:bias,maxTiles:8,concurrency:1,cacheBytes:1024}));
 stream.update(camera,viewport);await stream.idle();const initial=stream.scene().tiles[0].z;
 bias=2;stream.update(camera,viewport);await stream.idle();
 expect(peak).toBe(1);expect(stream.scene().tiles.every(t=>t.z<initial)).toBe(true);expect(stream.scene().tiles.length).toBeLessThanOrEqual(8);
});

test('obsolete in-flight map responses do not refill the owned cache',async()=>{
 const finish:Array<()=>void>=[];const stream=createGeographicStream((z,x,y)=>new Promise(resolve=>finish.push(()=>resolve({z,x,y,features:[],encoded:new Uint8Array(2048)}))),()=>{});
 stream.update(camera,viewport);stream.update({...camera,zoom:.000003},viewport);for(const done of finish)done();await stream.idle();
 expect(stream.status().bytes).toBe(0);expect(stream.status().entries).toBe(0);
});
test('byte pressure evicts unneeded cached regions instead of relying on tile count',async()=>{
 const stream=createGeographicStream(async(z,x,y)=>({z,x,y,features:[],encoded:new Uint8Array(2048)}),()=>{},()=>({zoomBias:0,maxTiles:4,concurrency:1,cacheBytes:1000}));
 stream.update(camera,viewport);await stream.idle();expect(stream.status().bytes).toBeLessThanOrEqual(1000);
 stream.update({...camera,zoom:.000003},viewport);await stream.idle();expect(stream.status().bytes).toBe(0);
});

test('visible oversized tiles are rejected once and reported as pressure, not network failure',async()=>{
 let loads=0,pressure=0;const stream=createGeographicStream(async(z,x,y)=>{loads++;return {z,x,y,features:[],encoded:new Uint8Array(2048)};},()=>{},()=>({zoomBias:0,maxTiles:4,concurrency:1,cacheBytes:1000}),undefined,()=>pressure++);
 stream.update(camera,viewport);await stream.idle();const count=loads;stream.update(camera,viewport);await stream.idle();
 expect(stream.status().bytes).toBeLessThanOrEqual(1000);expect(loads).toBe(count);expect(pressure).toBeGreaterThan(0);expect(stream.scene().error).toBe(false);expect(stream.scene().loading).toBe(false);expect(stream.scene().limited).toBe(true);
});
test('same-camera budget shrink reconciles demanded retained tiles',async()=>{
 let cacheBytes=100000;const stream=createGeographicStream(async(z,x,y)=>({z,x,y,features:[],encoded:new Uint8Array(2048)}),()=>{},()=>({zoomBias:0,maxTiles:4,concurrency:1,cacheBytes}));
 stream.update(camera,viewport);await stream.idle();expect(stream.status().bytes).toBeGreaterThan(1000);cacheBytes=1000;stream.update(camera,viewport);await stream.idle();expect(stream.status().bytes).toBeLessThanOrEqual(cacheBytes);
});

 test('near source-floor coverage truncation remains explicitly limited after loading completes',async()=>{
 const v={width:1772,height:1568},at=centerOn(toCell(49.283,-123.121),{x:0,y:0,zoom:.06,rotation:Math.PI/4},v);
 let maxTiles=4;const stream=createGeographicStream(async(z,x,y)=>({z,x,y,features:[]}),()=>{},()=>({zoomBias:4,minimumZoom:14,maxTiles,concurrency:1,cacheBytes:100000}));
 stream.update(at,v);await stream.idle();expect(stream.scene().tiles).toHaveLength(4);expect(stream.scene().loading).toBe(false);expect(stream.scene().limited).toBe(true);expect(stream.scene().error).toBe(false);
 maxTiles=40;stream.update(at,v);await stream.idle();expect(stream.scene().limited).toBe(false);expect(stream.scene().tiles.length).toBeGreaterThan(4);
 });
test('oversized transport bodies are resource pressure rather than failed network retries',async()=>{const {ResourcePressure}=await import('../src/core/resource-pressure');let pressures=0;const stream=createGeographicStream(async()=>{throw new ResourcePressure();},()=>{},undefined,undefined,()=>pressures++);stream.update(camera,viewport);await stream.idle();expect(stream.scene().limited).toBe(true);expect(stream.scene().error).toBe(false);expect(pressures).toBeGreaterThan(0);stream.dispose();});
