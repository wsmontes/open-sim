import {expect,it,vi} from 'vitest';
import {createSceneCache,sceneRasterCache} from '../src/surfaces/canvas/scene-cache';
it('accounts replacements and evicts the least recently touched surface exactly once',()=>{const disposed=vi.fn(),cache=createSceneCache<string>(10,disposed);cache.set('a','A',4);cache.set('b','B',4);cache.get('a');cache.set('c','C',4);expect(cache.get('b')).toBeUndefined();expect(disposed).toHaveBeenCalledExactlyOnceWith('B');expect(cache.stats().bytes).toBe(8);cache.set('a','A2',2);expect(cache.stats().bytes).toBe(6);cache.clear();expect(cache.stats().bytes).toBe(0);expect(disposed.mock.calls.map(x=>x[0])).toEqual(['B','A','C','A2']);});
it('rejects oversized or invalid allocations without discarding retained entries',()=>{const cache=createSceneCache<number>(10);cache.set('a',1,4);expect(cache.set('b',2,11)).toBe(false);expect(cache.set('b',2,NaN)).toBe(false);expect(cache.get('a')).toBe(1);cache.delete('a');cache.delete('a');expect(cache.stats().entries).toBe(0);});
it('shrinks the live byte budget and disposes already allocated resources',()=>{const freed:number[]=[],c=createSceneCache<number>(100,v=>freed.push(v));c.set('a',1,40);c.set('b',2,40);c.setLimit(50);expect(c.stats().bytes).toBe(40);expect(freed).toEqual([1]);expect(c.set('too-big',3,60)).toBe(false);c.setLimit(0);expect(c.stats().bytes).toBe(0);expect(freed).toEqual([1,2]);});
it('bounds native surface count even when pixel allocations are tiny',()=>{
 const freed:number[]=[],cache=createSceneCache<number>(1024,v=>freed.push(v),3);
 for(let i=0;i<100;i++)cache.set(String(i),i,1);
 expect(cache.stats().entries).toBe(3);
 expect(cache.stats().bytes).toBe(3);
 expect(freed).toHaveLength(97);
 expect(cache.get('97')).toBe(97);
 cache.set('100',100,1);
 expect(cache.get('98')).toBeUndefined();
 expect(cache.get('97')).toBe(97);
 cache.clear();expect(freed).toHaveLength(101);
});

it('releases native raster surfaces when the production cache reaches its context budget',()=>{
 sceneRasterCache.clear();
 const canvases=Array.from({length:300},()=>({width:1,height:1} as OffscreenCanvas));
 try {
  canvases.forEach((canvas,i)=>sceneRasterCache.set(String(i),{canvas},4));
  expect(sceneRasterCache.stats().entries).toBe(256);
  expect(canvases.filter(canvas=>canvas.width===0&&canvas.height===0)).toHaveLength(44);
  expect(canvases.at(-1)!.width).toBe(1);
 } finally {sceneRasterCache.clear();}
 expect(canvases.every(canvas=>canvas.width===0&&canvas.height===0)).toBe(true);
});
it('closes immutable raster pixels exactly once on eviction and teardown',()=>{
 sceneRasterCache.clear();const close=vi.fn(),bitmap={width:2,height:2,close} as unknown as ImageBitmap;
 sceneRasterCache.set('immutable',{canvas:bitmap},16);sceneRasterCache.delete('immutable');sceneRasterCache.delete('immutable');sceneRasterCache.clear();
 expect(close).toHaveBeenCalledOnce();
});
