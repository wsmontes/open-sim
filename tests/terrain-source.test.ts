import {it,expect} from 'vitest';
import {decodeTerrainTile,encodeTerrainTile,createTerrainSource} from '../src/adapters/map/terrain-source';
import type {TerrainManifest,TerrainTile} from '../src/presentation/terrain-model';
const bounds={west:-123.2,south:49.2,east:-123.18,north:49.22};
const manifest:TerrainManifest={version:1,tiles:[{id:'test',url:'/test.bin',bytes:0,bounds,spacingM:30}],sources:[{id:'synthetic',url:'https://example.org',retrievedAt:'2026-10-03',license:'test',kind:'dtm',horizontalCrs:'EPSG:4326',verticalDatum:'CGVD2013',resolutionM:30}]};
const tile=():TerrainTile=>({id:'test',bounds,size:65,spacingM:30,heightsM:new Float32Array(4225).fill(100),valid:new Uint8Array(4225).fill(1),kind:'dtm',verticalDatum:'CGVD2013',sourceId:'synthetic'});
it('missing is not zero terrain',()=>{const t=tile();t.valid[5]=0;t.heightsM[5]=NaN;const decoded=decodeTerrainTile(encodeTerrainTile(t),manifest);expect(decoded.valid[5]).toBe(0);expect(decoded.heightsM[5]).toBeNaN();});
it('preserves DSM quality',()=>{const t={...tile(),kind:'dsm' as const};expect(decodeTerrainTile(encodeTerrainTile(t),{...manifest,sources:[{...manifest.sources[0],kind:'dsm'}]}).kind).toBe('dsm');});
it('rejects incompatible datum',()=>expect(()=>decodeTerrainTile(encodeTerrainTile({...tile(),verticalDatum:'EGM2008'}),manifest)).toThrow());
it('rejects corrupt byte length',()=>expect(()=>decodeTerrainTile(encodeTerrainTile(tile()).slice(0,-1),manifest)).toThrow());
it('encoded tile is bounded',()=>expect(encodeTerrainTile(tile()).byteLength).toBeLessThanOrEqual(32768));
it('absent capture does not claim real coverage',async()=>{const source=createTerrainSource(async()=>encodeTerrainTile(tile()),{...manifest,tiles:[]});await expect(source.load('test',new AbortController().signal)).rejects.toThrow();});
it('cached tiles avoid repeated fetches',async()=>{let reads=0;const bytes=encodeTerrainTile(tile());const source=createTerrainSource(async()=>{reads++;return bytes;},{...manifest,tiles:[{...manifest.tiles[0],bytes:bytes.length}]});await source.load('test',new AbortController().signal);await source.load('test',new AbortController().signal);expect(reads).toBe(1);});
it('caps concurrent terrain reads at eight',async()=>{
 let active=0,max=0;const release:(()=>void)[]=[];const bytes=encodeTerrainTile(tile());
 const source=createTerrainSource(async()=>{active++;max=Math.max(max,active);await new Promise<void>(r=>release.push(r));active--;return bytes;},{...manifest,tiles:[{...manifest.tiles[0],bytes:bytes.length}]});
 const loads=Array.from({length:12},()=>source.load('test',new AbortController().signal));expect(max).toBe(8);
 while(release.length){release.shift()!();await Promise.resolve();await Promise.resolve();}
 await Promise.all(loads);expect(max).toBe(8);
});
it('official adjacent captures share identical border samples',async()=>{
 const {readFile}=await import('node:fs/promises');const {default:capture}=await import('../src/adapters/map/data/vancouver-terrain/manifest.json');const m=capture as TerrainManifest;
 const read=async(id:string)=>decodeTerrainTile(new Uint8Array(await readFile(`public/terrain/vancouver/${id}.bin`)),m);
 const a=await read('regional-6-10'),b=await read('regional-7-10');
 for(let y=0;y<65;y++){expect(a.valid[y*65+64]).toBe(b.valid[y*65]);expect(a.heightsM[y*65+64]).toEqual(b.heightsM[y*65]);}
 expect(m.sources.every(s=>s.verticalDatum==='CGVD2013')).toBe(true);
});
it('rejects cache admission above its byte partition and disposes in-flight reads',async()=>{const bytes=encodeTerrainTile(tile()),m={...manifest,tiles:[{...manifest.tiles[0],bytes:bytes.length}]};let reads=0;const source=createTerrainSource(async()=>{reads++;return bytes;},m,{cacheBytes:1,concurrency:1});await source.load('test',new AbortController().signal);await source.load('test',new AbortController().signal);expect(reads).toBe(2);expect(source.status().bytes).toBe(0);source.dispose();await expect(source.load('test',new AbortController().signal)).rejects.toThrow('disposed');});
it('abort releases a queued terrain request without starting another fetch',async()=>{const bytes=encodeTerrainTile(tile()),m={...manifest,tiles:[{...manifest.tiles[0],bytes:bytes.length}]};let finish!:(bytes:Uint8Array)=>void,reads=0;const source=createTerrainSource(async()=>{reads++;return new Promise(resolve=>finish=resolve);},m,{concurrency:1});const active=source.load('test',new AbortController().signal),abort=new AbortController(),queued=source.load('test',abort.signal);abort.abort();await expect(queued).rejects.toMatchObject({name:'AbortError'});expect(source.status().queued).toBe(0);finish(bytes);await active;expect(reads).toBe(1);source.dispose();});
