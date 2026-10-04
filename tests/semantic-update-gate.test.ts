import {expect,it} from 'vitest';
import {createSemanticUpdateGate} from '../src/presentation/semantic-update-gate';
it('skips unchanged state, throttles navigation and accepts immediate actions',()=>{const g=createSemanticUpdateGate(200);expect(g.shouldUpdate('a',0)).toBe(true);expect(g.shouldUpdate('a',400)).toBe(false);expect(g.shouldUpdate('b',100)).toBe(false);expect(g.shouldUpdate('b',200)).toBe(true);expect(g.shouldUpdate('c',201,true)).toBe(true);g.reset();expect(g.shouldUpdate('c',202)).toBe(true);});
