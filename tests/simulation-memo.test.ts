import {expect,test} from 'vitest';
import {applyCommand,createGame} from '../src/core/commands';
import {memoStats,poweredCells,resetSimulationMemo,stepSimulation,summarize} from '../src/core/simulation';
import type {Action,GameState,ManagedChunk,Tool} from '../src/core/model';
import {adopt} from '../src/core/world';
import {referenceApplyCommand,referenceCreateGame,referenceStepSimulation,referenceSummarize,poweredCells as referencePoweredCells} from './fixtures/simulation-reference';
import {blank,command} from './fixtures/world';

const DERIVED_FIELDS=['population','jobs','energySupply','energyUsed','happiness','income','managed'] as const;
// A deterministic stream so the comparison below is a test, not a lottery.
function prng(seed:number){let a=seed>>>0;return()=>{a=(a+0x6d2b79f5)>>>0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
// A city nobody can grow: no plant means nothing is on the grid, so every tick must reuse the same chunk objects and
// the same derived values. Roads and lots of every kind keep the land and happiness scans busy.
function staticWorld():GameState {
 const base=blank();
 for(let x=0;x<32;x+=1)base.cells[x]={terrain:'land',road:true,origin:'player'};
 for(let i=32;i<1024;i+=1){
  const kind=i%3===0?'residential':i%3===1?'commercial':'industrial';
  base.cells[i]={terrain:'land',building:kind,stage:1+(i%3),origin:'player'};
 }
 base.cells[500]={terrain:'land',building:'park',stage:1,origin:'player'};
 return createGame('static',7,base);
}
function grid(lots:number):GameState {
 const chunks:Record<string,ManagedChunk>={};
 for(let cy=0;cy<3;cy+=1)for(let cx=0;cx<3;cx+=1){
  const id=`${cx}:${cy}`,base=blank(id);
  base.cells[0]={terrain:'land',road:true,origin:'player'};
  for(let i=0;i<lots;i+=1)base.cells[64+i]={terrain:'land',building:i%2?'commercial':'residential',stage:1,origin:'player'};
  chunks[id]=adopt(base);
 }
 return {formatVersion:1,rulesVersion:4,worldId:'memo',seed:3,revision:0,tick:0,money:200000,chunks,actors:{},components:{}};
}
const TOOLS:Tool[]=['road','avenue','highway','residential','commercial','industrial','park','power'];

// (a) Nothing edited: the derived values are the ones from the first tick, and the memo served every one of them.
test('a tick of an unedited city recomputes nothing',()=>{
 resetSimulationMemo();
 let city=staticWorld();
 const first=summarize(city);
 poweredCells(city); // the grid is global and would warm on the first growth tick; warm it here so the count is honest
 const before={derived:memoStats.derivedRecomputations,land:memoStats.landRecomputations,grid:memoStats.gridRecomputations};
 for(let i=0;i<35;i+=1)city=stepSimulation(city);
 const last=summarize(city);
 expect(memoStats.derivedRecomputations,'derived chunk recomputations').toBe(before.derived);
 expect(memoStats.landRecomputations,'land-sum recomputations').toBe(before.land);
 expect(memoStats.gridRecomputations,'grid rebuilds').toBe(before.grid);
 for(const field of DERIVED_FIELDS)expect(last[field],field).toBe(first[field]);
 expect(last.economy.landValueAverage).toBe(first.economy.landValueAverage);
 expect(last.economy.monthly).toEqual(first.economy.monthly);
 // A second read of the last state is still free: the memo is keyed on the world, not on the state object.
 summarize(city);
 expect(memoStats.derivedRecomputations).toBe(before.derived);
});

// (b) The reference: the same commands and ticks against a frozen copy of the released core produce the same state.
test('the memoised tick agrees with the released implementation',()=>{
 resetSimulationMemo();
 const initial=blank();
 const real0={...createGame('memo',42,initial),money:200000};
 const reference0={...referenceCreateGame('memo',42,initial),money:200000};
 let real=real0,reference=reference0;
 const rng=prng(0x5eed);
 for(let step=0;step<90;step+=1){
  const roll=rng();
  const action:Action=roll<0.5?{type:'tick'}
   :roll<0.75?{type:'build',tool:TOOLS[Math.floor(rng()*TOOLS.length)]!,cells:[{x:Math.floor(rng()*32),y:Math.floor(rng()*32)}]}
   :roll<0.88?{type:'demolish',cells:[{x:Math.floor(rng()*32),y:Math.floor(rng()*32)}]}
   :{type:'policy',tax:Math.floor(rng()*21),services:50+Math.floor(rng()*101),borrow:0};
  const c=command(real,action);
  const applied=applyCommand(real,c,[]),expected=referenceApplyCommand(reference,c,[]);
  expect(applied.status,expected.reason??'').toBe(expected.status);
  real=applied.state;reference=expected.state;
  expect(real,`step ${step}: ${JSON.stringify(action)}`).toEqual(reference);
 }
 for(let i=0;i<25;i+=1){real=stepSimulation(real);reference=referenceStepSimulation(reference);}
 expect(real).toEqual(reference);
 expect(summarize(real)).toEqual(referenceSummarize(reference));
 expect([...poweredCells(real)].sort((a,b)=>a-b)).toEqual([...referencePoweredCells(reference)].sort((a,b)=>a-b));
});

// (c) The dirty radius is the sampling radius: one edited chunk can only move the values of itself and its neighbours.
test('an edit dirties at most the 3x3 block of chunks',()=>{
 resetSimulationMemo();
 const city=grid(20);
 summarize(city); // warm every chunk so the count below measures the edit alone
 const before=memoStats.derivedRecomputations;
 const edited=applyCommand(city,command(city,{type:'build',tool:'road',cells:[{x:32+5,y:32+5}]}),[]).state;
 expect(edited.chunks['1:1']).not.toBe(city.chunks['1:1']);
 summarize(edited);
 const recomputed=memoStats.derivedRecomputations-before;
 expect(recomputed,'chunks recomputed for one edit').toBeGreaterThan(0);
 expect(recomputed,'chunks recomputed for one edit').toBeLessThanOrEqual(9);
 // The values themselves still agree with the released implementation after the edit.
 expect(summarize(edited)).toEqual(referenceSummarize(edited));
});

// (d) The memo is process-wide, so the same chunk id in two different worlds must not share an entry.
test('two worlds at the same chunk id never share a memo entry',()=>{
 resetSimulationMemo();
 const home=blank(),shop=blank();
 home.cells[0]={terrain:'land',building:'residential',stage:2,origin:'player'};
 shop.cells[0]={terrain:'land',building:'commercial',stage:2,origin:'player'};
 const before=memoStats.derivedRecomputations;
 const a=summarize(createGame('A',1,home));
 expect(memoStats.derivedRecomputations).toBe(before+1);
 const b=summarize(createGame('B',1,shop));
 expect(memoStats.derivedRecomputations,'a foreign chunk must rebuild').toBe(before+2);
 expect(a.population).toBe(4);expect(a.jobs).toBe(0);
 expect(b.population).toBe(0);expect(b.jobs).toBe(6);
});
