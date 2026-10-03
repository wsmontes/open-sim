import {describe,it,expect} from 'vitest';
import capture from '../src/adapters/reality/data/vancouver-demography.json';
import {readStatCanCapture,mergeDemographics} from '../src/adapters/reality/statcan';
import {readBcStatsCapture} from '../src/adapters/reality/bc-stats';
import {CITY_IDENTITIES} from '../src/client/source-selection';
const city=CITY_IDENTITIES.Q24639;
const facts={id:city.qid,label:city.name,identity:city,source:{dataset:'Wikidata',url:'https://www.wikidata.org',license:'CC0'}};
describe('official Canadian demography',()=>{
 it('reads Vancouver CSD census population',()=>expect(readStatCanCapture(capture.statcan,city).find(o=>o.key==='population')).toMatchObject({value:662248,period:'2021',geographyId:'2021A00055915022',kind:'census'}));
 it('rejects metro and mismatched geography',()=>{expect(readStatCanCapture(capture.statcan,{...city,geography:'metro'})).toEqual([]);expect(readStatCanCapture(capture.statcan,{...city,dguid:'other'})).toEqual([]);});
 it('preserves income reference year',()=>expect(readStatCanCapture(capture.statcan,city).find(o=>o.key==='median-income')).toMatchObject({value:82000,period:'2020',unit:'CAD'}));
 it('keeps suppressed values missing',()=>{const c=structuredClone(capture.statcan);c.rows.forEach(r=>{r.FLAG='x';});expect(readStatCanCapture(c,city)).toEqual([]);});
 it('keeps estimates separate from census',()=>{const f=mergeDemographics(facts,[...readStatCanCapture(capture.statcan,city),...readBcStatsCapture(capture.bcStats,city)]);expect(f.population).toBe(662248);expect(f.populationYear).toBe(2021);expect(f.demographics?.find(o=>o.key==='population'&&o.kind==='estimate')?.value).toBe(740443);});
 it('does not double count age categories',()=>{const ages=readStatCanCapture(capture.statcan,city).filter(o=>o.key==='age-share');expect(ages).toHaveLength(3);expect(ages.reduce((a,o)=>a+o.value,0)).toBeCloseTo(100);});
 it('preserves commuting denominator',()=>expect(readStatCanCapture(capture.statcan,city).find(o=>o.key==='commute-share'&&o.category==='public-transit')).toMatchObject({denominator:{value:233960,period:'2021',geographyId:city.dguid}}));
 it('keeps census if BC is absent',()=>expect(mergeDemographics(facts,[...readStatCanCapture(capture.statcan,city),...readBcStatsCapture(null,city)]).population).toBe(662248));
 it('rejects invalid and duplicate observations',()=>{const c=structuredClone(capture.statcan);c.rows.push(c.rows[0]);expect(readStatCanCapture(c,city).filter(o=>o.key==='population')).toHaveLength(1);expect(readStatCanCapture(null,city)).toEqual([]);});
});
