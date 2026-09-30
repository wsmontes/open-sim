import {expect,test} from 'vitest';
import {createGame,applyCommand} from '../src/core/commands';
import type {Action} from '../src/core/model';
import {blank,command} from './fixtures/world';
const at={x:1,y:1};
test('retry cannot charge or build twice and original is unchanged',()=>{
 const s=createGame('world',42,blank()), before=JSON.stringify(s), c=command(s,{type:'build',tool:'road',cells:[at,at]});
 const a=applyCommand(s,c,[]); expect(a.status).toBe('applied');expect(a.state.money).toBe(19990);expect(JSON.stringify(s)).toBe(before);
 const b=applyCommand(a.state,c,[]);expect(b.status).toBe('duplicate');expect(b.state).toEqual(a.state);
});
test('rejects sequence gaps and stale revisions without modifying state',()=>{
 const s=createGame('world',42,blank()), c=command(s,{type:'build',tool:'road',cells:[at]});
 expect(applyCommand(s,{...c,sequence:2},[]).status).toBe('rejected');expect(applyCommand(s,{...c,expectedRevision:8},[]).state).toEqual(s);
});
test('invalid batch is atomic and never adopts unknown or water regions',()=>{
 const b=blank('1:0');b.cells[0]={terrain:'water'};const s=createGame('world',42,blank());
 for(const available of [[],[b]]){const r=applyCommand(s,command(s,{type:'build',tool:'road',cells:[at,{x:32,y:0}]}),available);expect(r.status).toBe('rejected');expect(r.state).toEqual(s);}
});
test('demolished imported building stays explicitly empty',()=>{
 const b=blank();b.cells[33]={terrain:'land',building:'residential',stage:1,origin:'imported'};const s=createGame('w',1,b);
 const r=applyCommand(s,command(s,{type:'demolish',cells:[at]}),[]);expect(r.state.chunks['0:0'].edits['33'].building).toBeUndefined();expect(r.state.money).toBe(19995);
});
test('existing road is free and unaffordable construction is rejected',()=>{
 const b=blank();b.cells[33]={terrain:'land',road:true};const s=createGame('w',1,b);
 expect(applyCommand(s,command(s,{type:'build',tool:'road',cells:[at]}),[]).state.money).toBe(20000);
 const poor={...s,money:0};expect(applyCommand(poor,command(poor,{type:'build',tool:'park',cells:[{x:2,y:2}]}),[]).status).toBe('rejected');
});
test('a profile writes and deletes its own namespaced fact without touching the city economy',()=>{
 const s=createGame('world',42,blank());
 const value={residents:4,cell:{x:3,y:4}};
 const write=command(s,{type:'component',key:'lifesim.residence',entity:'household-1',value});
 const applied=applyCommand(s,write,[]);
 expect(applied.status).toBe('applied');
 expect(applied.state.money).toBe(20000);
 expect(applied.state.revision).toBe(1);
 expect(applied.state.components['lifesim.residence']!['household-1']).toEqual(value);
 expect(s.components).toEqual({});
 expect(applyCommand(applied.state,write,[]).status).toBe('duplicate');
 const remove=command(applied.state,{type:'component',key:'lifesim.residence',entity:'household-1',value:null});
 const deleted=applyCommand(applied.state,remove,[]).state;
 expect(deleted.components['lifesim.residence']!['household-1']).toBeUndefined();
 expect(applied.state.components['lifesim.residence']!['household-1']).toEqual(value);
});
test('a component command is refused when the namespace, the identifier or the payload is not portable',()=>{
 const s=createGame('world',42,blank());
 const cases:Action[]=[
  {type:'component',key:'City.Zone',entity:'parcel-1',value:{}},
  {type:'component',key:'city',entity:'parcel-1',value:{}},
  {type:'component',key:'city.zone',entity:'__proto__',value:{}},
  {type:'component',key:'city.zone',entity:'parcel 1',value:{}},
  {type:'component',key:'city.zone',entity:'parcel-1',value:Number.NaN},
  {type:'component',key:'city.zone',entity:'parcel-1',value:{deep:{deeper:{deepest:Infinity}}}},
 ];
 for(const action of cases)expect(applyCommand(s,command(s,action),[]).status,'rejects '+JSON.stringify(action)).toBe('rejected');
});
