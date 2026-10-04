import {expect,it} from 'vitest';
import {createPerformanceSamples,type FrameSample} from '../src/presentation/performance-samples';
const sample=(at:number):FrameSample=>({at,intervalMs:16,workMs:3,phases:{render:2},presented:true});
it('retains a bounded chronological sample history',()=>{const s=createPerformanceSamples(3);for(let i=0;i<5;i++)s.record(sample(i));expect(s.snapshot().map(x=>x.at)).toEqual([2,3,4]);s.clear();expect(s.snapshot()).toEqual([]);});
it('snapshots and caller-owned phase maps cannot mutate recorded measurements',()=>{const s=createPerformanceSamples(3),input=sample(1);s.record(input);(input.phases as Record<string,number>).render=100;const copy=s.snapshot();(copy[0].phases as Record<string,number>).render=200;expect(s.snapshot()[0].phases.render).toBe(2);});
