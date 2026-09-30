import {expect,test} from 'vitest';
import {toCell,chunkId} from '../src/core/coordinates';
test('world wraps longitude and clamps polar latitude',()=>{expect(toCell(0,180)).toEqual(toCell(0,-180));expect(toCell(90,0).y).toBe(0);expect(toCell(-90,0).y).toBe(4194303);expect(chunkId({x:32,y:31})).toBe('1:0');});
test('invalid geographic input cannot create corrupt cells',()=>{expect(()=>toCell(NaN,0)).toThrow();expect(()=>toCell(0,Infinity)).toThrow();});
