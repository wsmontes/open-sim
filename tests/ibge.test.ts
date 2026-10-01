import {expect,test} from 'vitest';
import {createIbgeDirectory} from '../src/adapters/reality/ibge';

// The municipal figures the game shows for a Brazilian city. What matters here is not the parsing but the honesty of
// it: the year travels with the number, a figure the institute did not state is absent rather than zero, and a second
// question that fails never takes the first answer down with it.
const aggregate=(id:string,serie:Record<string,string>)=>({id,resultados:[{series:[{serie}]}]});
const json=(body:unknown)=>({ok:true,status:200,json:async()=>body}) as unknown as Response;
const failing=()=>({ok:false,status:503,json:async()=>null}) as unknown as Response;
const CENSUS='4714',PRODUCT='5938';
test('the census answers population, area and density with their year, and the product comes alongside',async()=>{
 const asked:string[]=[];
 const directory=createIbgeDirectory({fetcher:async(input:RequestInfo|URL)=>{
  const url=String(input);
  asked.push(url);
  if(url.includes(CENSUS))return json([
   aggregate('93',{'2022':'11451999','2010':'11253503'}),
   aggregate('6318',{'2022':'1521.11'}),
   aggregate('614',{'2022':'7528.6'}),
  ]);
  return json([aggregate('37',{'2021':'828980747','2020':'763891000'})]);
 }});
 const facts=await directory.byMunicipalCode('3550308');
 expect(facts).toMatchObject({
  id:'3550308',
  population:11451999,populationYear:2022,   // the newest census, not the first row
  areaKm2:1521.11,densityPerKm2:7528.6,
  gdpThousandsBrl:828980747,gdpYear:2021,
 });
 expect(facts?.source.dataset).toBe('IBGE');
 // Two questions: the census and the municipal product.
 expect(asked).toHaveLength(2);
 expect(asked[0]).toContain('localidades=N6[3550308]');
});

test('a figure the institute did not state is absent, not zero, and the answer is asked for only once',async()=>{
 let calls=0;
 const directory=createIbgeDirectory({fetcher:async()=>{
  calls+=1;
  return json([aggregate('93',{'2022':'398236'}),aggregate('6318',{'2022':'...'}),aggregate('614',{'2022':'-'})]);
 }});
 const facts=await directory.byMunicipalCode('3510609');
 expect(facts?.population).toBe(398236);
 expect(facts).not.toHaveProperty('areaKm2');
 expect(facts).not.toHaveProperty('densityPerKm2');
 expect(facts).not.toHaveProperty('gdpThousandsBrl');
 // A second look at the same city is answered from what was already read.
 expect(await directory.byMunicipalCode('3510609')).toEqual(facts);
 expect(calls).toBe(2); // census + product, once
});

test('the product failing leaves the census standing',async()=>{
 const directory=createIbgeDirectory({fetcher:async(input:RequestInfo|URL)=>String(input).includes(PRODUCT)?failing():json([aggregate('93',{'2022':'545796'})])});
 const facts=await directory.byMunicipalCode('3550308');
 expect(facts?.population).toBe(545796);
 expect(facts).not.toHaveProperty('gdpThousandsBrl');
});

test('a code that is not a municipal code is not worth a request',async()=>{
 let calls=0;
 const directory=createIbgeDirectory({fetcher:async()=>{calls+=1;return json([]);}});
 expect(await directory.byMunicipalCode('35503')).toBeNull();
 expect(await directory.byMunicipalCode('Q174')).toBeNull();
 expect(calls).toBe(0);
});

test('a failing source leaves the game without the number',async()=>{
 const directory=createIbgeDirectory({fetcher:async()=>failing()});
 expect(await directory.byMunicipalCode('3550308')).toBeNull();
});
