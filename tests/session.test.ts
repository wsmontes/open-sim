import {expect,test} from 'vitest';
import {applyCommand} from '../src/core/commands';
import {decodeSave,encodeSave} from '../src/core/snapshot';
import {createSession} from '../src/session/local-session';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {blank,command} from './fixtures/world';
import type {BaseChunk,CellCoord,SavedGame,ViewState} from '../src/core/model';
import type {MapSource,SaveStore} from '../src/session/ports';
type Waiter={resolve:(b:BaseChunk)=>void;reject:(e:unknown)=>void};
const view=(place:string):ViewState=>({x:12.5,y:-4,zoom:1.5,speed:1,place,rotation:-0.75});
// Cells inside the initial region '9:9', whose origin is (288,288).
const at=(x:number,y:number):CellCoord=>({x:288+x,y:288+y});
function fakeMaps(){
 const calls:string[]=[],bases=new Map<string,BaseChunk>(),waiting=new Map<string,Waiter[]>(),broken=new Set<string>(),arrivals=new Map<string,Array<()=>void>>();
 const base=(id:string)=>{let b=bases.get(id);if(!b){b=blank(id);bases.set(id,b);}return b;};
 const arrived=(id:string)=>{const list=arrivals.get(id)??[];arrivals.set(id,[]);for(const f of list)f();};
 const levels:Array<[string,string]>=[];
 const source:MapSource={attribution:{text:'© OpenStreetMap',url:'https://www.openstreetmap.org/copyright'},loadChunk(id,level){levels.push([id,level??'detail']);calls.push(id);arrived(id);if(broken.has(id))return Promise.reject(new Error('Falha de rede'));return new Promise<BaseChunk>((resolve,reject)=>{waiting.set(id,[...(waiting.get(id)??[]),{resolve,reject}]);});}};
 const release=(id:string,ok:boolean)=>{const list=waiting.get(id)??[];waiting.set(id,[]);for(const w of list)ok?w.resolve(base(id)):w.reject(new Error('Falha de rede'));};
 return {source,calls,levels,base,broken,pending:(id:string)=>(waiting.get(id)??[]).length,arrival:(id:string)=>(waiting.get(id)?.length??0)>0?Promise.resolve():new Promise<void>(f=>arrivals.set(id,[...(arrivals.get(id)??[]),f])),resolve:(id:string)=>release(id,true),reject:(id:string)=>release(id,false)};
}
async function boot(saves:SaveStore,m=fakeMaps()){
 const s=createSession({maps:m.source,saves,worldId:'mundo',seed:7});
 const started=s.initialize('9:9');await m.arrival('9:9');m.resolve('9:9');await started;
 return {s,m};
}
test('an empty slot starts a new game from the initial region',async()=>{
 const {s,m}=await boot(createMemoryStore());
 expect(m.calls).toEqual(['9:9']);
 expect(s.getState().money).toBe(20000);
 expect(s.getChunk('9:9')?.status).toBe('ready');
 expect((s.getChunk('9:9') as {base:BaseChunk}).base).toBe(m.base('9:9'));
 expect(s.getChunk('0:0')).toBeUndefined();
 expect(s.restoredView).toBeNull();
 expect(s.getSaveStatus()).toEqual({status:'idle',blocked:false});
 await s.initialize('9:9');
 expect(m.calls).toEqual(['9:9']);
});
test('save and restore keep terrain, balance, clock, revision, actors and the view without asking the map again',async()=>{
 const store=createMemoryStore(),m=fakeMaps();
 m.base('9:9').cells[66]={terrain:'land',building:'residential',stage:1,origin:'imported'};
 const {s}=await boot(store,m);
 expect(s.dispatch({type:'build',tool:'park',cells:[at(1,1)]}).status).toBe('applied');
 expect(s.dispatch({type:'demolish',cells:[at(2,2)]}).status).toBe('applied');
 expect(s.dispatch({type:'tick'}).status).toBe('applied');
 expect(s.dispatch({type:'tick'}).status).toBe('applied');
 const saved=view('Vancouver');await s.save(saved);
 const later=fakeMaps(),r=createSession({maps:later.source,saves:store,worldId:'mundo',seed:7});
 await r.initialize('1:0');
 expect(later.calls).toEqual([]);
 const state=r.getState();
 expect(state.money).toBe(19965);expect(state.tick).toBe(2);expect(state.revision).toBe(4);expect(state.actors['local-player']).toBe(4);
 expect(state.chunks['9:9'].edits['33']).toEqual({terrain:'land',building:'park',stage:1,origin:'player'});
 expect(state.chunks['9:9'].edits['66']).toEqual({terrain:'land'});
 expect(r.getChunk('9:9')?.status).toBe('ready');
 expect((r.getChunk('9:9') as {base:BaseChunk}).base).toEqual(m.base('9:9'));
 expect(r.getChunk('1:0')).toBeUndefined();
 expect(r.restoredView).toEqual(saved);
 expect(r.getSaveStatus()).toEqual({status:'idle',blocked:false});
});
test('a restored game ignores replayed commands and keeps the balance',async()=>{
 const store=createMemoryStore(),{s}=await boot(store);
 const replayed=command(s.getState(),{type:'build',tool:'park',cells:[at(1,1)]});
 expect(s.dispatch(replayed.action).status).toBe('applied');
 const money=s.getState().money;await s.save(view('São Paulo'));
 const later=fakeMaps(),r=createSession({maps:later.source,saves:store,worldId:'mundo',seed:7});
 await r.initialize('9:9');
 expect(applyCommand(r.getState(),replayed,[]).status).toBe('duplicate');
 expect(r.getState().money).toBe(money);
});
test('a late region only moves its own status and never joins the economy',async()=>{
 const {s,m}=await boot(createMemoryStore());
 const first=s.loadVisible(['0:0']);await m.arrival('0:0');
 expect(s.getChunk('0:0')?.status).toBe('loading');expect(m.pending('0:0')).toBe(1);
 const second=s.loadVisible(['1:0']);await m.arrival('1:0');m.resolve('1:0');await second;
 expect(s.getChunk('1:0')?.status).toBe('ready');
 m.resolve('0:0');await first;
 expect(s.getChunk('0:0')?.status).toBe('ready');expect(s.getChunk('1:0')?.status).toBe('ready');
 expect((s.getChunk('1:0') as {base:BaseChunk}).base).toBe(m.base('1:0'));
 expect(Object.keys(s.getState().chunks)).toEqual(['9:9']);
 expect(s.getState().revision).toBe(0);
 await s.loadVisible(['1:0','1:0']);
 expect(m.calls).toEqual(['9:9','0:0','1:0']);
});
test('a failed region reports the error and a later call retries',async()=>{
 const {s,m}=await boot(createMemoryStore());
 m.broken.add('3:0');
 await expect(s.loadVisible(['3:0'])).rejects.toThrow('Falha de rede');
 expect(s.getChunk('3:0')).toEqual({status:'error',message:'Falha de rede'});
 m.broken.delete('3:0');
 const retry=s.loadVisible(['3:0']);await m.arrival('3:0');expect(m.pending('3:0')).toBe(1);m.resolve('3:0');await retry;
 expect(s.getChunk('3:0')?.status).toBe('ready');
});
test('a corrupt slot is reported, never overwritten until the player asks, and play continues',async()=>{
 for(const raw of ['not json',JSON.stringify({version:2,state:{},view:{}})]){
  const store=createMemoryStore({'open-sim':raw}),{s}=await boot(store);
  expect(s.getSaveStatus()).toEqual({status:'error',message:expect.any(String),blocked:true});
  expect(s.getState().money).toBe(20000);expect(s.restoredView).toBeNull();
  expect(s.getChunk('9:9')?.status).toBe('ready');
  expect(s.dispatch({type:'build',tool:'park',cells:[at(1,1)]}).status).toBe('applied');
  await s.save(view('Lisboa'));
  expect(store.slots.get('open-sim')).toBe(raw);
  expect(s.getState().money).toBe(19970);
  s.enableSaving();
  await s.save(view('Lisboa'));
  expect(s.getSaveStatus()).toEqual({status:'saved',blocked:false});
  expect(store.slots.get('open-sim')).not.toBe(raw);
  expect(decodeSave(JSON.parse(store.slots.get('open-sim')!)).view).toEqual(view('Lisboa'));
 }
});
test('a failed write reports the error and keeps the progress in memory',async()=>{
 const inner=createMemoryStore();let failing=true;
 const saves:SaveStore={read:slot=>inner.read(slot),write:async(slot,data)=>{if(failing)throw new Error('Disco cheio');await inner.write(slot,data);}};
 const {s}=await boot(saves);
 expect(s.dispatch({type:'build',tool:'park',cells:[at(1,1)]}).status).toBe('applied');
 await s.save(view('Vancouver'));
 expect(s.getSaveStatus()).toEqual({status:'error',message:'Disco cheio',blocked:false});
 expect(s.getState().money).toBe(19970);expect(inner.slots.has('open-sim')).toBe(false);
 failing=false;await s.save(view('Vancouver'));
 expect(s.getSaveStatus()).toEqual({status:'saved',blocked:false});
 expect(decodeSave(JSON.parse(inner.slots.get('open-sim')!)).state.money).toBe(19970);
});
test('a store that throws synchronously still cannot reject save',async()=>{
 const inner=createMemoryStore();
 const saves:SaveStore={read:slot=>inner.read(slot),write:(slot: string,data:SavedGame)=>{throw new Error('Sem transação');}};
 const {s}=await boot(saves);
 await s.save(view('Vancouver'));
 expect(s.getSaveStatus()).toEqual({status:'error',message:'Sem transação',blocked:false});
 expect(s.getState().money).toBe(20000);expect(inner.slots.has('open-sim')).toBe(false);
});
test('a region adopted by a build comes back frozen with the player edit',async()=>{
 const store=createMemoryStore(),{s,m}=await boot(store);
 const load=s.loadVisible(['1:0']);await m.arrival('1:0');m.resolve('1:0');await load;
 expect(s.dispatch({type:'build',tool:'road',cells:[{x:33,y:0}]}).status).toBe('applied');
 await s.save(view('Vancouver'));
 const later=fakeMaps(),r=createSession({maps:later.source,saves:store,worldId:'mundo',seed:7});
 await r.initialize('9:9');
 expect(later.calls).toEqual([]);expect(r.getChunk('1:0')?.status).toBe('ready');
 expect(r.getState().chunks['1:0'].edits['1']).toEqual({terrain:'land',road:true,origin:'player'});
});
test('subscribers hear applied commands and region status changes only',async()=>{
 const {s,m}=await boot(createMemoryStore());
 let count=0;const off=s.subscribe(()=>{count++;});
 const load=s.loadVisible(['0:0']);await m.arrival('0:0');m.resolve('0:0');await load;
 expect(count).toBe(2);const before=count;
 expect(s.dispatch({type:'build',tool:'park',cells:[at(1,1)]}).status).toBe('applied');
 expect(count).toBe(before+1);
 // A session envelope always carries the next sequence, so 'duplicate' cannot be produced by dispatch;
 // the core test replays envelopes and dispatch only notifies for 'applied'.
 expect(s.dispatch({type:'build',tool:'park',cells:[at(1,1)]}).status).toBe('rejected');
 expect(count).toBe(before+1);
 off();s.dispatch({type:'demolish',cells:[at(1,1)]});expect(count).toBe(before+1);
 off();
});
test('the save queue is serial and the newest state wins',async()=>{
 const inner=createMemoryStore(),order:number[]=[],waits:Array<()=>void>=[];
 let active=0,maxActive=0,last='';
 const saves:SaveStore={read:slot=>inner.read(slot),write:async(slot,data)=>{active++;maxActive=Math.max(maxActive,active);order.push(data.state.revision);await new Promise<void>(r=>waits.push(r));active--;last=encodeSave(data);await inner.write(slot,data);}};
 const {s}=await boot(saves);
 const first=view('Vancouver'),firstSave=s.save(first);
 expect(s.dispatch({type:'build',tool:'park',cells:[at(1,1)]}).status).toBe('applied');
 const second=view('Lisboa'),secondSave=s.save(second);
 expect(waits.length).toBe(1);expect(active).toBe(1);
 waits.shift()!();await firstSave;
 expect(waits.length).toBe(1);expect(active).toBe(1);
 waits.shift()!();await secondSave;
 expect(maxActive).toBe(1);expect(active).toBe(0);expect(order).toEqual([0,1]);
 expect(last).toBe(encodeSave({version:1,state:s.getState(),view:second}));
 expect(decodeSave(JSON.parse(inner.slots.get('open-sim')!)).view).toEqual(second);
});

test('a coarse region paints at once, upgrades to detail, and never enters the economy while coarse',async()=>{
 const {s,m}=await boot(createMemoryStore());
 const coarse=s.loadVisible(['1:0'],'overview');await m.arrival('1:0');m.resolve('1:0');await coarse;
 expect(m.levels).toEqual([['9:9','detail'],['1:0','overview']]);
 expect(s.getChunk('1:0')).toMatchObject({status:'ready',level:'overview'});
 // an intervention in a region that only exists as an approximation is refused, not silently built on guesses
 const rejected=s.dispatch({type:'build',tool:'road',cells:[{x:33,y:0}]});
 expect(rejected.status).toBe('rejected');
 expect(rejected.reason).toContain('Espere o mapa carregar');
 // the same region at detail level replaces the approximation and the intervention goes through
 const upgrade=s.loadVisible(['1:0']);await m.arrival('1:0');m.resolve('1:0');await upgrade;
 expect(m.levels).toEqual([['9:9','detail'],['1:0','overview'],['1:0','detail']]);
 expect(s.getChunk('1:0')).toMatchObject({status:'ready',level:'detail'});
 expect(s.dispatch({type:'build',tool:'road',cells:[{x:33,y:0}]}).status).toBe('applied');
});
test('a detail region is never downgraded by a later coarse request',async()=>{
 const {s,m}=await boot(createMemoryStore());
 const detail=s.loadVisible(['2:0']);await m.arrival('2:0');m.resolve('2:0');await detail;
 const before=m.levels.length;
 await s.loadVisible(['2:0'],'overview');
 expect(m.levels.length).toBe(before);
 expect(s.getChunk('2:0')).toMatchObject({status:'ready',level:'detail'});
});
