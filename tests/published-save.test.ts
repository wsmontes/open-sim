import {expect,test} from 'vitest';
import {createGame} from '../src/core/commands';
import {decodeSave,encodeSave} from '../src/core/snapshot';
import {blank} from './fixtures/world';
import {TICK_PERIOD_MS} from '../src/presentation/clock';

test('the known published rules-4 save and 3x preference round trip without losing the city',()=>{
 const state={...createGame('published-city',7,blank()),rulesVersion:4,money:18750,components:{'city.custom':{note:'preservar'}}};
 const raw=JSON.parse(JSON.stringify({version:1,state,view:{x:12,y:23,zoom:.35,speed:3,rotation:.7,place:'Vancouver'}}));
 const opened=decodeSave(raw);
 expect(opened).toEqual(raw);expect(decodeSave(encodeSave(opened))).toEqual(raw);
 expect(TICK_PERIOD_MS[3 as keyof typeof TICK_PERIOD_MS]).toBe(333);
});
test('known earlier saves upgrade to the published rules while unknown versions remain protected',()=>{
 for(const rulesVersion of [1,3]){
  const raw={version:1,state:{...createGame('old',7,blank()),rulesVersion},view:{x:0,y:0,zoom:.05,speed:0,place:'Vancouver'}};
  expect(decodeSave(raw).state.rulesVersion).toBe(4);
 }
 const unknown={version:1,state:{...createGame('unknown',7,blank()),rulesVersion:99},view:{x:0,y:0,zoom:1,speed:0,place:'unknown'}};
 expect(()=>decodeSave(unknown)).toThrow('Versão de regras desconhecida');
});
