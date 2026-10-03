import {it,expect} from 'vitest';
import capture from '../src/adapters/reality/data/vancouver-finance-2026.json';
import {readVancouverFinance,enrichVancouverFacts} from '../src/adapters/reality/vancouver';
it('official capture matches approval audit',()=>expect(readVancouverFinance(capture)).toMatchObject({territoryId:'Q24639',fiscalYear:2026,status:'approved-budget',operating:{value:2392516009,unit:'CAD'},capital:{value:894000000,unit:'CAD'}}));
it('rejects wrong territory',()=>expect(()=>readVancouverFinance({...capture,territoryId:'metro-vancouver'})).toThrow());
it('rejects multiyear as annual',()=>expect(()=>readVancouverFinance({...capture,capital:{...capture.capital,period:'multi-year'}})).toThrow());
it('normalizes thousands to CAD',()=>expect(readVancouverFinance({...capture,operating:{...capture.operating,value:1000,unit:'thousand-CAD'}}).operating.value).toBe(1000000));
it('rejects actuals and invalid amounts',()=>{expect(()=>readVancouverFinance({...capture,status:'actual'})).toThrow();expect(()=>readVancouverFinance({...capture,operating:{...capture.operating,value:-1}})).toThrow();});
it('enriches only same territory',()=>{const facts={id:'Q172',label:'Toronto',source:{dataset:'Wikidata',url:'https://www.wikidata.org',license:'CC0'}};expect(enrichVancouverFacts(facts,readVancouverFinance(capture))).toEqual(facts);});
