// Measures the per-tick cost of the simulation core, before and after the per-chunk memo, in Node with the game's own
// code. The "before" side is the frozen reference core (tests/fixtures/simulation-reference.ts); the "after" side is
// the release. The scene is a city that is not growing — every lot is already at its top stage and the demand valves
// are negative — because that is the case the memo is for: a city the player has touched but stopped editing, where
// the released core still re-scans every administered chunk on every tick.
//
//   npx tsx tools/bench-tick.ts [ticks]
import type {GameState,ManagedChunk} from '../src/core/model';
import {resetSimulationMemo,stepSimulation,summarize} from '../src/core/simulation';
import {adopt} from '../src/core/world';
import {referenceStepSimulation,referenceSummarize} from '../tests/fixtures/simulation-reference';
import {blank} from '../tests/fixtures/world';

const TICKS=Math.max(1,Number(process.argv[2])||20);
const SIZES=[50,200,800];

// A row of adjacent chunks: a road along y=0 ties them together, one plant per chunk feeds the grid, and four rows of
// lots sit on top. Every lot is at stage 3 and the valves are negative, so no tick can change a chunk.
function makeCity(chunks:number):GameState {
 const built:Record<string,ManagedChunk>={};
 for(let i=0;i<chunks;i+=1){
  const id=`${i}:0`,base=blank(id);
  for(let x=0;x<32;x+=1)base.cells[x]={terrain:'land',road:true,origin:'player'};
  base.cells[32]={terrain:'land',building:'power',stage:1,origin:'player'};
  for(let y=1;y<=4;y+=1)for(let x=0;x<32;x+=1){
   const index=y*32+x;
   if(index===32)continue;
   const kind=index%3===0?'residential':index%3===1?'commercial':'industrial';
   base.cells[index]={terrain:'land',building:kind,stage:3,origin:'player'};
  }
  built[id]=adopt(base);
 }
 return {formatVersion:1,rulesVersion:4,worldId:'bench',seed:1,revision:0,tick:10,money:1_000_000,chunks:built,actors:{},components:{'city.economy':{policy:{tax:9,services:100,debt:0,months:0,valves:{residential:-200,commercial:-200,industrial:-200}}}}};
}
const run=(step:(s:GameState)=>GameState,initial:GameState,ticks:number):GameState=>{let s=initial;for(let i=0;i<ticks;i+=1)s=step(s);return s;};
function msPerTick(step:(s:GameState)=>GameState,initial:GameState):number {
 let best=Number.POSITIVE_INFINITY;
 for(let pass=0;pass<3;pass+=1){const t0=performance.now();run(step,initial,TICKS);best=Math.min(best,(performance.now()-t0)/TICKS);}
 return best;
}
const row=(label:string,before:string,after:string,note='')=>`${label.padEnd(22)}${before.padStart(11)}${after.padStart(11)}  ${note}`;

console.log(`scene: a static city, ${TICKS} ticks per pass, best of 3`);
console.log('');
console.log(row('chunks', 'before', 'after'));
const lotsPerChunk=Object.values(makeCity(1).chunks)[0]!.base.cells.filter(c=>c.building&&c.building!=='park'&&c.building!=='power'&&(c.stage??0)>0).length;
for(const chunks of SIZES){
 const initial=makeCity(chunks);
 run(referenceStepSimulation,initial,2);
 const before=msPerTick(referenceStepSimulation,initial);
 resetSimulationMemo();
 run(stepSimulation,initial,2);
 const after=msPerTick(stepSimulation,initial);
 console.log(row(`${chunks} chunks`,`${before.toFixed(2)} ms`,`${after.toFixed(2)} ms`,`${(before/Math.max(after,1e-6)).toFixed(1)}x`));
}
console.log('');
console.log(`lots per chunk: ${lotsPerChunk}  (each one a 289-cell land scan in the released core, per tick)`);
// The two cores must agree on the very city the numbers are taken from.
const sample=makeCity(50);
assertSame(summarize(run(stepSimulation,sample,TICKS)),referenceSummarize(run(referenceStepSimulation,sample,TICKS)),'final stats');
function assertSame(actual:unknown,expected:unknown,what:string):void {
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`bench city diverges on ${what}`);
}
