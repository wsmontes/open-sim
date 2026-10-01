import {expect,test} from 'vitest';
import {applyCommand,createGame} from '../src/core/commands';
import {quoteAction} from '../src/core/quote';
import {coordAt} from '../src/core/coordinates';
import {cellEconomy,getCell} from '../src/core/world';
import {landValueAt,stepSimulation} from '../src/core/simulation';
import {COST,ROAD_CLASS,roadClassOf} from '../src/core/model';
import type {GameState,Tool} from '../src/core/model';
import {blank} from './fixtures/world';

// Roads have classes: a street, an avenue and a highway. What makes them worth having is that each one changes the
// game — the price, the upkeep, how tall the city may grow facing it, and what it does to the land around it — so
// these tests are about those consequences, not about a field existing in the state.
const REGION='0:0';
const base=blank(REGION);
const at=(index:number)=>coordAt(REGION,index);
const build=(state:GameState,tool:Tool,indices:number[]):GameState=>{
 const applied=applyCommand(state,{version:1,worldId:state.worldId,actorId:'local-player',sequence:(state.actors['local-player']??0)+1,expectedRevision:state.revision,action:{type:'build',tool,cells:indices.map(at)}},[]);
 if(applied.status!=='applied')throw new Error(applied.reason);
 return applied.state;
};
const ask=(state:GameState,tool:Tool,indices:number[])=>quoteAction(state,{type:'build',tool,cells:indices.map(at)},[]);
function ticks(state:GameState,count:number):GameState {
 let next=state;
 for(let i=0;i<count;i+=1)next=stepSimulation(next);
 return next;
}
// A neighbourhood nice enough to want the tallest buildings: the land has to be good for that, so the test builds the
// parks and the shops that make it good, and the services that reach them. Index 32 is the lot under test: the first
// building in the region, which is what the growth pass reaches first.
function neighbourhood(road:Tool):GameState {
 let state=build(createGame('victoria',7,base),road,Array.from({length:32},(_unused,i)=>i));
 state=build(state,'residential',[32]);
 state=build(state,'power',[63]);
 state=build(state,'park',Array.from({length:12},(_unused,i)=>64+i));
 state=build(state,'commercial',Array.from({length:16},(_unused,i)=>96+i));
 return {...state,components:{...state.components,['city.economy']:{policy:{tax:9,services:110}}}};
}

test('each class costs what it says, is kept for what it says, and only the taller ones write a class',()=>{
 for(const [tool,kind] of [['road','street'],['avenue','avenue'],['highway','highway']] as const){
  const state=build(createGame('victoria',7,base),tool,[40]);
  const cell=getCell(state,at(40))!;
  expect(roadClassOf(cell),tool).toBe(kind);
  // A street writes exactly the cell it has always written, which is what keeps every map and every save made before
  // the classes existed valid — and hashing the same.
  if(kind==='street')expect(cell).toEqual({terrain:'land',road:true,origin:'player'});
  else expect(cell).toEqual({terrain:'land',road:true,roadClass:kind,origin:'player'});
  expect(20000-state.money,tool).toBe(COST[tool]);
  expect(cellEconomy(cell),tool).toBe(-ROAD_CLASS[kind].upkeep);
 }
});

test('the preview and the command charge the same for the same road',()=>{
 // They mirror each other by construction now; this is the test that notices if they ever stop doing so.
 const state=createGame('victoria',7,base);
 for(const tool of ['road','avenue','highway'] as const){
  const cells=[60,61,62];
  const quoted=ask(state,tool,cells);
  expect(quoted.status,tool).toBe('ok');
  expect(20000-build(state,tool,cells).money,tool).toBe(quoted.cost);
 }
});

test('the road facing a lot is the ceiling of what may be built on it',()=>{
 // The same city, the same demand, the same services: the only difference is the road in front of the house.
 const stageAfter=(road:Tool)=>getCell(ticks(neighbourhood(road),200),at(32))!.stage??0;
 expect(stageAfter('road')).toBe(2);
 expect(stageAfter('avenue')).toBe(3);
 expect(stageAfter('highway')).toBe(1);
 // And the tallest building the game has is therefore reachable at all: a city can still grow up, it just needs the
 // avenue to do it — which is the decision the class is there to create.
 expect(stageAfter('avenue')).toBeGreaterThan(stageAfter('road'));
});

test('an avenue raises the land around it and a highway takes it away',()=>{
 // Index 1 is a road cell and index 33 sits beside it, so the only difference between the three cities is the class.
 const value=(road:Tool)=>landValueAt(build(createGame('victoria',7,base),road,[1]),at(33));
 expect(value('avenue')).toBeGreaterThan(value('road'));
 expect(value('highway')).toBeLessThan(value('road'));
});
