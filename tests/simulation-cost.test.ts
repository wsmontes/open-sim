import {expect,test} from 'vitest';
import type {Cell,GameState} from '../src/core/model';
import {adopt} from '../src/core/world';
import {stepSimulation,summarize} from '../src/core/simulation';

// A dense city of `side × side` regions: a street every third column and homes everywhere else.
function denseCity(side:number):GameState{
 const chunks:GameState['chunks']={};
 for(let cy=0;cy<side;cy++)for(let cx=0;cx<side;cx++){
  const cells=Array.from({length:1024},(_,i):Cell=>i%32%3===0?{terrain:'land',road:true}:{terrain:'land',building:'residential',stage:1});
  const id=`${1000+cx}:${1000+cy}`;
  chunks[id]=adopt({id,source:'cost-test',normalizerVersion:1,cells});
 }
 return {formatVersion:1,rulesVersion:3,worldId:'cost',seed:1,revision:0,tick:4,money:1e6,chunks,actors:{},components:{}};
}
const fastest=(run:()=>void,times=3)=>{let best=Infinity;for(let i=0;i<times;i++){const t=performance.now();run();best=Math.min(best,performance.now()-t);}return best;};

// The city's numbers are read every tick, so their cost has to grow with the city, not with its square. Land value used
// to recompute the city centre per lot, which made four regions cost sixteen times one region. The bound is a ratio,
// not a clock, so a slow machine does not fail it: linear work quadruples, quadratic work would be ~16×.
test('summarize and a growth tick scale linearly with the size of the city',()=>{
 const one=denseCity(1),four=denseCity(2);
 summarize(one);stepSimulation(one); // warm up the JIT before measuring
 const summarizeRatio=fastest(()=>summarize(four))/fastest(()=>summarize(one));
 const stepRatio=fastest(()=>stepSimulation(four))/fastest(()=>stepSimulation(one));
 expect(summarizeRatio).toBeLessThan(9);
 expect(stepRatio).toBeLessThan(9);
 // And an absolute ceiling far above what a linear pass needs, so a regression to per-lot rescans is caught outright.
 expect(fastest(()=>summarize(four),1)).toBeLessThan(2000);
});
