import {expect,test} from 'vitest';
import {createSession} from '../src/session/local-session';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {executeCityRequest} from '../src/session/city-agent';
import {blank} from './fixtures/world';
async function city(){const session=createSession({maps:{loadChunk:async id=>blank(id),attribution:{text:'test',url:''}},saves:createMemoryStore(),worldId:'agent',seed:1});await session.initialize('0:0');return session;}
test('agents quote, build, advance, save and restore the same city state',async()=>{
 const s=await city(),action={type:'build',tool:'park',cells:[{x:1,y:1}]};
 const q=await executeCityRequest(s,{op:'quote',action});expect(q.ok&&q.result).toMatchObject({cost:30,status:'ok'});
 expect((await executeCityRequest(s,{op:'act',action})).ok).toBe(true);
 await executeCityRequest(s,{op:'advance',ticks:5});const before=s.getState();
 const save=await executeCityRequest(s,{op:'save'});expect(save.ok).toBe(true);
 await executeCityRequest(s,{op:'advance',ticks:1});
 expect((await executeCityRequest(s,{op:'load',save:save.ok?save.result:null})).ok).toBe(true);expect(s.getState()).toEqual(before);
});
test('malformed requests and unbounded advancement never mutate',async()=>{
 const s=await city(),before=s.getState();
 for(const request of [null,{op:'advance',ticks:10001},{op:'quote',action:{type:'unknown'}},{op:'act',action:{type:'build',cells:[]}},{op:'inspect',cell:{x:NaN,y:1}}])expect((await executeCityRequest(s,request)).ok).toBe(false);
 expect(s.getState()).toBe(before);
});
test('terminal round trips preserve browser viewpoint and unknown metadata',async()=>{
 const s=await city(),first=await executeCityRequest(s,{op:'save'});if(!first.ok)throw new Error('save');
 const saved=first.result as {view:Record<string,unknown>};saved.view.center={x:10.25,y:20.75};saved.view.extra={hello:2};(saved as unknown as Record<string,unknown>).extra={hello:1};
 await executeCityRequest(s,{op:'load',save:saved});const next=await executeCityRequest(s,{op:'save'});
 expect(next.ok&&next.result).toEqual(saved);
});
