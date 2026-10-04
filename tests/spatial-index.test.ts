import {expect,it} from 'vitest';
import {createSpatialIndex} from '../src/presentation/spatial-index';
it('returns overlapping candidates once across buckets including negative coordinates',()=>{const index=createSpatialIndex([{bounds:{minX:-10,minY:-10,maxX:10,maxY:10},value:'a'},{bounds:{minX:20,minY:20,maxX:21,maxY:21},value:'b'}],4);expect(index.query({minX:-3,minY:-3,maxX:5,maxY:5})).toEqual(['a']);expect(index.query({minX:40,minY:40,maxX:41,maxY:41})).toEqual([]);});
it('retains wide entries without unbounded buckets',()=>{const index=createSpatialIndex([{bounds:{minX:-1e9,minY:-1e9,maxX:1e9,maxY:1e9},value:'wide'}],1);expect(index.query({minX:2,minY:2,maxX:3,maxY:3})).toEqual(['wide']);expect(index.query({minX:-1e9,minY:-1e9,maxX:1e9,maxY:1e9})).toEqual(['wide']);});
