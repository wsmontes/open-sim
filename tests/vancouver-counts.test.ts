import {it,expect} from 'vitest';
import {parseVancouverCounts} from '../src/adapters/reality/vancouver-counts';
const source={dataset:'fixture',url:'https://example.test/counts',territoryId:'5915022',retrievedAt:'2026-10-03T00:00:00Z',method:'reported'};
const count={id:'fixture',lat:49.28,lon:-123.12,from:'2019-09-05T14:30:00Z',to:'2019-09-05T14:45:00Z',vehicleClass:'all-vehicles',count:120,source};
it('preserves local recorded counts and explicit units without inventing speed',()=>{expect(parseVancouverCounts([count])).toEqual([count]);});
it('rejects missing geometry and malformed observations rather than inventing locations',()=>{expect(parseVancouverCounts({features:[{attributes:{OBJECTID:1,pkhrvol:'717'},geometry:null}]})).toEqual([]);expect(parseVancouverCounts([{...count,count:-1},{...count,to:count.from},{...count,lat:100}])).toEqual([]);});
it('requires dated source provenance and unique identifiers',()=>{expect(parseVancouverCounts([count,count])).toHaveLength(1);expect(parseVancouverCounts([{...count,source:{}}])).toEqual([]);});
