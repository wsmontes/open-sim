import {it,expect} from 'vitest';
import {containsLocalArea} from '../src/presentation/municipal-coverage';
import data from '../src/adapters/reality/data/vancouver-local-areas.json';
it('municipal demographic coverage excludes YVR, UBC and municipalities across Burrard Inlet',()=>{for(const [lat,lon] of [[49.19,-123.185],[49.32,-123.075],[49.26,-123.245],[49.378,-123.3]])expect(containsLocalArea(data.areas,{lat,lon})).toBe(false);for(const [lat,lon] of [[49.283,-123.12],[49.22,-123.10],[49.265,-123.155]])expect(containsLocalArea(data.areas,{lat,lon})).toBe(true);});
it('respects holes and rejects invalid points',()=>{const area=[{rings:[[[0,0],[1,0],[1,1],[0,1],[0,0]],[[.4,.4],[.6,.4],[.6,.6],[.4,.6],[.4,.4]]]}];expect(containsLocalArea(area,{lat:.5,lon:.5})).toBe(false);expect(containsLocalArea(area,{lat:.2,lon:.2})).toBe(true);expect(containsLocalArea(area,{lat:NaN,lon:.2})).toBe(false);});
