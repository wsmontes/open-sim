import {expect,test,vi} from 'vitest';
import {createCityClient,type ActionRouter} from '../src/client/city-client';
import {createSession} from '../src/session/local-session';
import {createFixtureMap} from '../src/adapters/map/fixture';
import {createPlayHost} from '../tools/play-host';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {createManualTime,debounce} from '../src/client/time';
import {parseCommand} from '../src/surfaces/text/parse';
import {executeCityRequest} from '../src/surfaces/json/city-json';

test('stopping a client cancels a pending save and refuses further mutation',async()=>{
 const saves=createMemoryStore(),{client,time}=await createPlayHost({saves,start:'0:0'}).open();
 await client.start();await client.idle();
 await client.do({do:'tool',tool:'park'});await client.do({do:'commit',cells:[{x:3,y:3}]});
 const before=client.snapshot().state;
 client.stop();
 await time.advance(1000);await client.idle();
 expect(saves.slots.size).toBe(0);
 expect(await client.do({do:'tick',count:1})).toMatchObject({ok:false});
 expect(client.snapshot().state).toEqual(before);
});

test('the portable client refuses excessive ticks before changing state',async()=>{
 const {client}=await createPlayHost({start:'0:0'}).open();
 await client.start();await client.idle();
 const before=client.snapshot().state;
 expect(await client.do({do:'tick',count:10001})).toMatchObject({ok:false});
 expect(client.snapshot().state).toEqual(before);client.stop();
});

test('raw terminal JSON refuses malformed intents',()=>{
 for(const line of ['json null','json {"do":"speed","speed":99}','json {"do":"pan","dx":"x","dy":1}','json {"do":"tick","count":10001}','json {"do":"unknown"}'])
  expect(parseCommand(line,{x:0,y:0})).toHaveProperty('error');
});

test('JSON quotes refuse actions that cannot be executed by that surface',async()=>{
 const {client}=await createPlayHost({start:'0:0'}).open();
 await client.start();await client.idle();
 for(const action of [{type:'tick'},{type:'component',key:'city.x',entity:'a',value:1}])
  expect(await executeCityRequest(client,{op:'quote',action})).toMatchObject({ok:false});
 client.stop();
});

test('a cancelled debounce can be scheduled again without running the abandoned task',async()=>{
 const time=createManualTime();let runs=0;
 const task=debounce(time,100,()=>{runs++;}) as (()=>void)&{cancel():void};
 task();task.cancel();await time.advance(100);expect(runs).toBe(0);
 task();await time.advance(100);expect(runs).toBe(1);
});

async function delayedClient(){
 const local=createSession({maps:createFixtureMap(),saves:createMemoryStore(),worldId:'lifecycle',seed:1}),time=createManualTime();
 let release!:(receipt:{status:string})=>void;
 const router:ActionRouter={mode:()=> 'local',state:()=>local.getState(),submitAction:()=>new Promise(resolve=>{release=resolve;}),refusal:()=>({cells:[{x:3,y:3}],reason:'Espere o mapa carregar',preview:null}),tick:async()=>{},status:()=>({kind:'ready',detail:''}),setPersistence:()=>{}};
 const afterAction=vi.fn(),loads=vi.spyOn(local,'loadVisible');
 const client=createCityClient({local,router,time,initialChunk:'0:0',afterAction});
 await client.start();await client.idle();loads.mockClear();
 return {client,local,router,time,afterAction,loads,release:()=>release({status:'accepted'})};
}
test('a delayed build receipt after stop triggers no action hook or detail loading',async()=>{
 const {client,time,afterAction,loads,release}=await delayedClient();
 await client.do({do:'tool',tool:'park'});
 const pending=client.do({do:'commit',cells:[{x:3,y:3}]});client.stop();release();
 expect(await pending).toMatchObject({ok:false,message:'Cliente encerrado'});
 await time.advance(1000);await client.idle();expect(afterAction).not.toHaveBeenCalled();expect(loads).not.toHaveBeenCalled();
});
test('a delayed policy receipt after stop triggers no action hook',async()=>{
 const {client,afterAction,release}=await delayedClient();
 const pending=client.do({do:'policy',tax:.1});client.stop();release();
 expect(await pending).toMatchObject({ok:false,message:'Cliente encerrado'});expect(afterAction).not.toHaveBeenCalled();
});
test('syncSession after stop never starts a router refresh',async()=>{
 const {client,router}=await delayedClient();router.mode=()=> 'host';const refresh=vi.fn(async()=>{});router.refresh=refresh;
 client.stop();await client.syncSession();expect(refresh).not.toHaveBeenCalled();
});
test('an in-flight session refresh after stop never recalculates the preview',async()=>{
 const {client,router,loads}=await delayedClient();router.mode=()=> 'host';
 let release!:()=>void;router.refresh=()=>new Promise(resolve=>{release=resolve;});
 const state=vi.spyOn(router,'state');
 const pending=client.syncSession();client.stop();state.mockClear();release();await pending;
 expect(state).not.toHaveBeenCalled();expect(loads).not.toHaveBeenCalled();
});
