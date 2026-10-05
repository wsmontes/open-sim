import {it,expect} from 'vitest';
import {createFrameMerge} from '../src/presentation/frame-merge';
it('retains the combined snapshot until one constituent changes',()=>{const merge=createFrameMerge<number>(),a=[1],b=[2],first=merge(a,b);expect(merge(a,b)).toBe(first);expect(merge(a,[3])).toEqual([1,3]);expect(Object.isFrozen(first)).toBe(true);});
