import {expect,test} from 'vitest';
import {createFactsController} from '../src/client/facts-controller';
import {PLACES,type CityFacts} from '../src/client/facts';
test('late Vancouver does not replace Lisbon',async()=>{
 let release!:(value:CityFacts)=>void;
 const pending=new Promise<CityFacts>(resolve=>{release=resolve;});
 const readings:Array<CityFacts|null>=[];
 const controller=createFactsController({named:async name=>name==='Vancouver'?pending:PLACES['Lisboa']!.facts,near:async()=>null},facts=>readings.push(facts));
 const old=controller.named('Vancouver');
 await controller.named('Lisboa');
 release(PLACES['Vancouver']!.facts);await old;
 expect(readings.map(f=>f?.id)).toEqual(['Q597']);
});
test('named lookup can fall back to coordinates without a stale response winning',async()=>{
 const readings:Array<CityFacts|null>=[];
 const controller=createFactsController({named:async()=>null,near:async(lat,lon)=>lat===49&&lon===-123?PLACES['Vancouver']!.facts:null},f=>readings.push(f));
 await controller.lookup(49,-123,'Vancouver');
 expect(readings.at(-1)?.population).toBe(662248);
});
test('failure clears only the newest request and allows later retry',async()=>{
 let fails=true;
 const readings:Array<CityFacts|null>=[];
 const controller=createFactsController({named:async()=>{if(fails)throw Error('offline');return PLACES['Vancouver']!.facts;},near:async()=>null},f=>readings.push(f));
 await controller.named('Vancouver');
 expect(readings).toEqual([null]);
 fails=false;await controller.named('Vancouver');
 expect(readings.at(-1)?.id).toBe('Q24639');
});
