import {it,expect} from 'vitest';
import {readMobilityAttributes} from '../src/adapters/osm/decode';
it('preserves Shortbread reverse one-way instead of assuming forward',()=>expect(readMobilityAttributes({oneway:true,oneway_reverse:true,layer:1,osm_id:'42'},14)).toEqual({oneway:-1,level:1,sourceId:'osm/42',tunnel:undefined}));
it('does not invent unavailable low-zoom directions or levels',()=>expect(readMobilityAttributes({},12)).toEqual({oneway:undefined,level:undefined,sourceId:undefined,tunnel:undefined}));
it('retains tunnel and explicit two-way metadata',()=>expect(readMobilityAttributes({oneway:false,tunnel:true,layer:-1},14)).toMatchObject({oneway:0,tunnel:true,level:-1}));
