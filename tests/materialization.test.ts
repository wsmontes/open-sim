import {expect,test} from 'vitest';
import {applyCommand,createGame} from '../src/core/commands';
import {summarize} from '../src/core/simulation';
import {toGeo,coordAt} from '../src/core/coordinates';
import type {GameState} from '../src/core/model';
import {checkCoreComponent} from '../src/world/osim';
import {
 POPULATION_NAMESPACE,charactersOf,dematerialize,emptyPopulation,materialize,materializedCount,
 populationChanges,populationComponents,populationOf,totalOf,
} from '../src/world/materialization';
import type {Components} from '../src/core/model';
import {blank,command} from './fixtures/world';

const WORLD='victoria',SEED=42,OWNER='did:key:z6MkWalker',OTHER_OWNER='did:key:z6MkOther';
const HOME='0:0#0';

// Sixteen homes of four residents each: the aggregate the spec works with.
function city():GameState {
 const base=blank();
 for(let i=0;i<16;i++)base.cells[i]={terrain:'land',building:'residential',stage:1,origin:'player'};
 for(let i=16;i<20;i++)base.cells[i]={terrain:'land',road:true};
 return createGame(WORLD,SEED,base);
}
// What a profile does with the components of the shared population: ordinary component commands, through the core.
function written(state:GameState,components:Components):GameState {
 let next=state;
 for(const key of Object.keys(components).sort())
  for(const entity of Object.keys(components[key]!).sort())
   next=applyCommand(next,command(next,{type:'component',key,entity,value:components[key]![entity]}),[]).state;
 return next;
}
const idsOf=(population:{reservations:readonly {ids:readonly string[]}[]})=>population.reservations.flatMap(entry=>[...entry.ids]);

test('four residents leave the aggregate, the total stays 64 and the economy does not move',()=>{
 const state=city();
 const before=populationOf(state);
 expect(before).toMatchObject({worldId:WORLD,seed:SEED,aggregate:64,reservations:[]});
 expect(totalOf(before)).toBe(64);
 const walked=materialize(before,{id:'walk-1',owner:OWNER,cell:HOME,count:4});
 expect(walked.ok).toBe(true);
 if(!walked.ok)return;
 expect(walked.value.aggregate).toBe(60);
 expect(materializedCount(walked.value)).toBe(4);
 expect(totalOf(walked.value)).toBe(64);
 expect(walked.value.reservations[0]).toMatchObject({id:'walk-1',owner:OWNER,cell:HOME});
 // the city reads the reservation where it landed and reports what is left of the aggregate
 const carried=written(state,populationChanges(before,walked.value));
 expect(summarize(carried).population).toBe(60);
 expect(carried.components[POPULATION_NAMESPACE]?.['walk-1']).toMatchObject({cell:HOME,count:4,owner:OWNER});
 expect(totalOf(populationOf(carried))).toBe(64);
 // four residents becoming entities is not a reason for income, energy or jobs to fall
 const beforeStats=summarize(state),afterStats=summarize(carried);
 expect({income:afterStats.income,energy:afterStats.energySupply,used:afterStats.energyUsed,jobs:afterStats.jobs})
  .toEqual({income:beforeStats.income,energy:beforeStats.energySupply,used:beforeStats.energyUsed,jobs:beforeStats.jobs});
 // returning them is an operation, not the removal of a component the city happens to read
 const back=dematerialize(walked.value,idsOf(walked.value));
 expect(back.ok).toBe(true);
 if(!back.ok)return;
 expect(back.value).toMatchObject({aggregate:64,reservations:[]});
 // the same operation says which entries go: the reservation and the components of the people who came back
 const returned=written(carried,populationChanges(walked.value,back.value));
 expect(returned.components[POPULATION_NAMESPACE]?.['walk-1']).toBeUndefined();
 // the person is gone from every namespace this contract writes, and the city counts the people it holds again
 for(const key of ['osim.transform','osim.existence','osim.name'])expect(Object.keys(returned.components[key]??{})).toEqual([]);
 expect(summarize(returned).population).toBe(64);
 expect(totalOf(populationOf(returned))).toBe(64);
 // and nothing else in the world moved with them
 expect(returned.money).toBe(carried.money);
 expect(returned.tick).toBe(carried.tick);
});

test('a repeated reservation is the same operation and two clients derive the same people for one slot',()=>{
 const population=populationOf(city());
 const first=materialize(population,{id:'walk-1',owner:OWNER,cell:HOME,count:4});
 expect(first.ok).toBe(true);
 if(!first.ok)return;
 // delivering the same reservation again answers the same state instead of adding people
 expect(materialize(first.value,{id:'walk-1',owner:OWNER,cell:HOME,count:4})).toEqual({ok:true,value:first.value});
 expect(materialize(first.value,{id:'walk-1',owner:OWNER,cell:HOME,count:2})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 // two clients reading the same state derive the same four people for the same slot: the shared state is the
 // coordinator, so a rival reservation names those people instead of minting four others
 const rival=materialize(population,{id:'walk-2',owner:OTHER_OWNER,cell:HOME,count:4});
 expect(rival).toMatchObject({ok:true});
 if(!rival.ok)return;
 expect(idsOf(rival.value)).toEqual(idsOf(first.value));
 // and both copies landing on the city are still four people living in a city of sixty plus four
 const merged=written(written(city(),populationComponents(first.value)),populationComponents(rival.value));
 expect(materializedCount(populationOf(merged))).toBe(4);
 expect(summarize(merged).population).toBe(60);
 expect(totalOf(populationOf(merged))).toBe(64);
 // four is the home, not the world: another slot is free, and the people are counted once each
 const second=materialize(first.value,{id:'walk-3',owner:OWNER,cell:'0:0#1',count:4});
 expect(second).toMatchObject({ok:true});
 if(!second.ok)return;
 expect(totalOf(second.value)).toBe(64);
 expect(new Set(idsOf(second.value)).size).toBe(8);
 // asking for more people than the aggregate holds changes nothing
 expect(materialize(population,{id:'walk-4',owner:OWNER,cell:HOME,count:65})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(materialize(population,{id:'walk-5',owner:OWNER,cell:'0:0',count:4})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(materialize(population,{id:'',owner:OWNER,cell:HOME,count:4})).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('two clients derive the same people, addressed as geodesic facts and not as cells of the engine',()=>{
 const one=materialize(populationOf(city()),{id:'walk-1',owner:OWNER,cell:HOME,count:4});
 const two=materialize(populationOf(city()),{id:'walk-2',owner:OTHER_OWNER,cell:HOME,count:4});
 expect(one.ok&&two.ok).toBe(true);
 if(!one.ok||!two.ok)return;
 expect(idsOf(one.value)).toEqual(idsOf(two.value));
 const components=populationComponents(one.value);
 const place=toGeo(coordAt('0:0',0));
 for(const id of idsOf(one.value)){
  const transform=components['osim.transform']?.[id];
  expect(checkCoreComponent('osim.transform',transform)).toMatchObject({ok:true});
  expect(transform).toMatchObject({space:'osim:space:earth',position:{lon:place.lon,lat:place.lat}});
  expect(transform).not.toHaveProperty('cell');
  expect(components['osim.existence']?.[id]).toEqual({level:'materialized'});
  expect(checkCoreComponent('osim.name',components['osim.name']?.[id])).toMatchObject({ok:true});
 }
 // the engine address travels in the reservation, which is where the declared approximation to the building lives
 expect(components[POPULATION_NAMESPACE]?.['walk-1']).toMatchObject({cell:HOME,count:4});
 expect(charactersOf(one.value).map(character=>character.uri)).toEqual(idsOf(one.value).map(id=>`osim:entity:${id}`));
});

test('dematerializing an unknown person says so and changes nothing',()=>{
 const population=populationOf(city());
 expect(populationOf(city()).reservations).toEqual([]);
 expect(dematerialize(population,[])).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(dematerialize(population,['p-nobody'])).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 const walked=materialize(population,{id:'walk-1',owner:OWNER,cell:HOME,count:4});
 expect(walked.ok).toBe(true);
 if(!walked.ok)return;
 const ids=idsOf(walked.value);
 expect(dematerialize(walked.value,[ids[0]!,'p-nobody'])).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 const partial=dematerialize(walked.value,[ids[0]!]);
 expect(partial).toMatchObject({ok:true});
 if(!partial.ok)return;
 expect(materializedCount(partial.value)).toBe(3);
 expect(partial.value.aggregate).toBe(61);
 expect(totalOf(partial.value)).toBe(64);
});

test('an empty population is a place, and a malformed reservation in the state is not counted',()=>{
 expect(emptyPopulation(WORLD,SEED,64)).toEqual({worldId:WORLD,seed:SEED,aggregate:64,reservations:[]});
 const state=city();
 const broken={...state,components:{...state.components,[POPULATION_NAMESPACE]:{'walk-1':{cell:HOME,count:'muitos',owner:OWNER}}}};
 // a value this contract cannot read is not silently counted as materialized people
 expect(populationOf(broken)).toMatchObject({aggregate:64,reservations:[]});
 expect(totalOf(populationOf(broken))).toBe(64);
});
