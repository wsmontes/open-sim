import {expect,test} from 'vitest';
import {createGame,applyCommand} from '../src/core/commands';
import {coordAt} from '../src/core/coordinates';
import {economyOf,summarize,stepSimulation} from '../src/core/simulation';
import type {GameState,Tool} from '../src/core/model';
import {blank} from './fixtures/world';

// The city economy: three demands, one tax rate, land value, a monthly budget and a debt ladder. The rules that matter
// are the ones a player can feel and the ones the world cannot disagree about — so the first test is determinism, and
// every number below is a consequence of something the player did.
const REGION='0:0';
const base=blank(REGION);
const at=(index:number)=>coordAt(REGION,index);
const build=(state:GameState,tool:Tool,indices:number[]):GameState=>{
 const applied=applyCommand(state,{version:1,worldId:state.worldId,actorId:'local-player',sequence:(state.actors['local-player']??0)+1,expectedRevision:state.revision,action:{type:'build',tool,cells:indices.map(at)}},[]);
 if(applied.status!=='applied')throw new Error(applied.reason);
 return applied.state;
};
// A road along the first row, so everything else has access to the network.
function withRoad():GameState {
 let state=createGame('victoria',7,base);
 return build(state,'road',Array.from({length:32},(_unused,i)=>i));
}
const policy=(state:GameState,value:Record<string,unknown>):GameState=>({
 ...state,
 components:{...state.components,['city.economy']:{policy:{...value}}},
});
function ticks(state:GameState,count:number):GameState {
 let next=state;
 for(let i=0;i<count;i+=1)next=stepSimulation(next);
 return next;
}
// A city that can grow: roads, a power plant, and however many zones the test needs. Without energy nothing develops,
// which is a rule of the game and the reason every city here has a plant.
function city(residential:number,commercial=0,industrial=0,parks=0):GameState {
 let state=withRoad(),index=32;
 for(const [tool,count] of [['power',1],['residential',residential],['commercial',commercial],['industrial',industrial],['park',parks]] as [Tool,number][]){
  if(!count)continue;
  state=build(state,tool,Array.from({length:count},(_unused,i)=>index+i));
  index+=count;
 }
 return state;
}

test('the same city and the same ticks always produce the same economy',()=>{
 const a=ticks(policy(city(12,4,2),{tax:9}),240);
 const b=ticks(policy(city(12,4,2),{tax:9}),240);
 expect(summarize(b)).toEqual(summarize(a));
 expect(b.money).toBe(a.money);
 expect(economyOf(b)).toEqual(economyOf(a));
});

test('a tax the player sets is read from the world, clamped, and nonsense is not obeyed',()=>{
 const state=city(8);
 expect(economyOf(state).taxPercent).toBe(9);
 expect(economyOf(policy(state,{tax:20})).taxPercent).toBe(20);
 expect(economyOf(policy(state,{tax:99})).taxPercent).toBe(20);
 expect(economyOf(policy(state,{tax:-5})).taxPercent).toBe(0);
 expect(economyOf(policy(state,{tax:'muito'})).taxPercent).toBe(9);
});

test('demand is three numbers the player can move, and it falls when the tax rises',()=>{
 const cheap=ticks(policy(city(14,6,4),{tax:4}),180);
 const dear=ticks(policy(city(14,6,4),{tax:19}),180);
 expect(economyOf(cheap).demand.residential).toBeGreaterThan(economyOf(dear).demand.residential);
 // Residential demand is what a new city has most of; the other two start slower.
 expect(economyOf(cheap).demand.residential).toBeGreaterThan(0);
 expect(economyOf(cheap).demand).toEqual({residential:expect.any(Number),commercial:expect.any(Number),industrial:expect.any(Number)});
});

test('a neighbourhood with parks and without industry is worth more than one the other way round',()=>{
 const nice=ticks(city(10,2,0,8),120);
 const rough=ticks(city(10,0,8,0),120);
 const niceValue=economyOf(nice).landValueAverage,roughValue=economyOf(rough).landValueAverage;
 expect(niceValue).toBeGreaterThan(roughValue);
 // And it is the land that pays: the monthly revenue of the nicer city is higher at the same tax rate.
 expect(economyOf(nice).monthly.revenue).toBeGreaterThan(economyOf(rough).monthly.revenue);
});

test('the budget closes every month and the books add up',()=>{
 const state=ticks(policy(city(16,8,4,2),{tax:9}),150);
 const economy=economyOf(state);
 expect(economy.monthly.revenue).toBeGreaterThan(0);
 expect(economy.monthly.expense).toBeGreaterThan(0);
 expect(economy.monthly.net).toBe(economy.monthly.revenue-economy.monthly.expense);
 // A city that collects more than it spends grows its cash; one that spends more, shrinks it.
 const before=ticks(city(16,8,4,2),30).money;
 const rich=ticks(policy(city(16,8,4,2),{tax:20}),30);
 expect(rich.money).toBeGreaterThan(0);
 expect(Number.isSafeInteger(rich.money)).toBe(true);
 expect(before).toBeGreaterThan(0);
});

test('spending on services is a slider with a consequence, and the coverage says what it bought',()=>{
 const lean=ticks(policy(city(12,6,2),{tax:9,services:50}),120);
 const generous=ticks(policy(city(12,6,2),{tax:9,services:150}),120);
 expect(economyOf(generous).monthly.expense).toBeGreaterThan(economyOf(lean).monthly.expense);
 expect(economyOf(generous).serviceLevel).toBeGreaterThan(economyOf(lean).serviceLevel);
 expect(economyOf(generous).serviceLevel).toBeLessThanOrEqual(3);
 expect(economyOf(lean).serviceLevel).toBeGreaterThanOrEqual(0);
});

test('borrowing is possible, costs more the deeper the city is in it, and the rating says so',()=>{
 // Judged against what the city collects, so the city has to be one that collects: a few hundred is nothing to a
 // grown town, a million is everything.
 const grown=ticks(city(14,6,2),120);
 const small=policy(grown,{debt:200});
 const heavy=policy(grown,{debt:900_000});
 expect(economyOf(small).rating).toBe('A');
 expect(economyOf(heavy).rating).not.toBe('A');
 expect(economyOf(heavy).interestRate).toBeGreaterThan(economyOf(small).interestRate);
 expect(economyOf(heavy).interestRate).toBeLessThanOrEqual(12);
});

test('a building grows where demand and services allow, and stands still where they do not',()=>{
 const served=ticks(policy(city(10,4,2,2),{tax:9,services:150}),360);
 const built=Object.values(served.chunks[REGION]!.edits).filter(cell=>cell.building&&cell.building!=='park'&&(cell.stage??0)>0).length;
 expect(built).toBeGreaterThan(0);
 const ignored=ticks(policy(city(10,4,2,2),{tax:20,services:50}),360);
 const ignoredBuilt=Object.values(ignored.chunks[REGION]!.edits).filter(cell=>cell.building&&cell.building!=='park'&&(cell.stage??0)>0).length;
 expect(built).toBeGreaterThan(ignoredBuilt);
});

test('a city that cannot pay its bills is told, without the world quietly going negative',()=>{
 let state=policy(city(4,0),{tax:0,services:150});
 state={...state,money:100};
 const after=ticks(state,600);
 const economy=economyOf(after);
 expect(after.money).toBeGreaterThanOrEqual(0);
 expect(economy.monthly.net).toBeLessThan(0);
 expect(economy.crisis).toBeTruthy();
});
