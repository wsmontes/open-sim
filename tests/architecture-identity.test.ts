import {expect,test} from 'vitest';
import {architectureOf,regionOf} from '../src/presentation/city-art';
import type {Footprint} from '../src/presentation/city-art';
const f=(area:number,seed:number):Footprint=>({rings:[[{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4},{x:0,y:0}]],minX:0,maxX:4,minY:0,maxY:area/4,area,seed,kind:''});
test('architecture keeps deterministic identity and distinguishes small houses, offices and factories',()=>{
 const house=architectureOf(f(3,5),undefined,undefined,'neutral'),office=architectureOf(f(45,6),'commercial',10,'vancouver'),factory=architectureOf(f(140,7),'industrial',2,'neutral');
 expect(house.archetype).toBe('house');expect(office.archetype).toBe('glass');expect(factory.archetype).toBe('warehouse');
 expect(architectureOf(f(45,6),'commercial',10,'vancouver')).toEqual(office);
 expect(new Set([house.roof,office.roof,factory.roof]).size).toBe(3);
});
test('regional architecture adds masonry and tiled roofs while respecting supplied height',()=>{
 expect(regionOf({lat:38.7223,lon:-9.1393})).toBe('lisbon');
 expect(regionOf({lat:-23.5505,lon:-46.6333})).toBe('sao-paulo');
 expect(regionOf({lat:49.2827,lon:-123.1207})).toBe('vancouver');
 expect(regionOf({lat:0,lon:0})).toBe('neutral');
 const lisbon=architectureOf(f(20,2),undefined,undefined,'lisbon'),vancouver=architectureOf(f(20,2),undefined,undefined,'vancouver');
 expect(lisbon.roofType).toBe('tile');expect(lisbon).not.toEqual(vancouver);
 expect(architectureOf({...f(20,2),height:60},undefined,undefined,'lisbon').floors).toBe(20);
});
test('unbuilt player zones remain construction sites rather than finished buildings',()=>{
 expect(architectureOf(f(1,1),'residential',0,'neutral').archetype).toBe('construction');
 expect(architectureOf(f(1,1),'residential',2,'neutral').archetype).not.toBe('construction');
});
