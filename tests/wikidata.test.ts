import {expect,test} from 'vitest';
import {createWikidataDirectory} from '../src/adapters/reality/wikidata';

// Real demography has to arrive with its own honesty: the number a source states is the number the game shows, and a
// value nobody stated stays absent. These tests fix that alongside the two ways of finding a city.
const sparql=(rows:Array<{qid:string;label:string;pop?:number;year?:number;area?:number;country?:string;municipalCode?:string}>=[])=>({
 results:{bindings:rows.flatMap(row=>{
  const bindings:Array<Record<string,{value:string}>>=[];
  if(row.pop!==undefined)bindings.push({city:{value:`http://www.wikidata.org/entity/${row.qid}`},cityLabel:{value:row.label},pop:{value:String(row.pop)},...(row.year?{date:{value:`${row.year}-01-01T00:00:00Z`}}:{}),...(row.area?{area:{value:String(row.area)}}:{})});
  else bindings.push({city:{value:`http://www.wikidata.org/entity/${row.qid}`},cityLabel:{value:row.label}});
  if(row.country)for(const entry of bindings)entry['countryLabel']={value:row.country};
  if(row.municipalCode)for(const entry of bindings)entry['municipalCode']={value:row.municipalCode};
  return bindings;
 })},
});
const response=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/sparql-results+json'}});

test('a city is reported with the population the source states, the year it states and where it came from',async()=>{
 const calls:string[]=[];
 const directory=createWikidataDirectory({fetcher:async(input)=>{calls.push(String(input));return response(sparql([{qid:'Q174',label:'São Paulo',pop:11_904_961,year:2025,area:1521.11,country:'Brasil'}]));}});
 const facts=await directory.named('São Paulo','pt');
 expect(facts).toMatchObject({
  id:'Q174',label:'São Paulo',country:'Brasil',population:11_904_961,populationYear:2025,areaKm2:1521.11,
  source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q174',license:'CC0'},
 });
 expect(calls[0]).toContain('query.wikidata.org');
});
test('several records of the same city resolve to the most recent one, not the largest',async()=>{
 const directory=createWikidataDirectory({fetcher:async()=>response(sparql([
  {qid:'Q597',label:'Lisboa',pop:552_700,year:2011},
  {qid:'Q597',label:'Lisboa',pop:545_796,year:2021},
  {qid:'Q597',label:'Lisboa',pop:509_000,year:1991},
 ]))});
 const facts=await directory.named('Lisboa','pt');
 expect(facts?.population).toBe(545_796);
 expect(facts?.populationYear).toBe(2021);
});
test('a city the source never counted comes back without a population instead of zero',async()=>{
 const directory=createWikidataDirectory({fetcher:async()=>response(sparql([{qid:'Q999999',label:'Vila Sem Censo'}]))});
 const facts=await directory.named('Vila Sem Censo','pt');
 expect(facts).toEqual({id:'Q999999',label:'Vila Sem Censo',source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q999999',license:'CC0'}});
 expect('population' in (facts ?? {})).toBe(false);
});
test('a source that fails or answers garbage leaves the game without a number, never with an invented one',async()=>{
 const cases:[string,() => Promise<Response>][]=[
  ['erro de rede',async()=>{throw new Error('sem rede');}],
  ['resposta 503',async()=>new Response('',{status:503})],
  ['corpo que não é SPARQL',async()=>new Response('{"oi":true}',{status:200})],
  ['bindings que não são lista',async()=>new Response('{"results":{"bindings":"nada"}}',{status:200})],
 ];
 for(const [label,fetcher] of cases){
  const directory=createWikidataDirectory({fetcher});
  expect(await directory.named('Qualquer','pt'),label).toBeNull();
 }
});
test('a field the source wrote badly is dropped, not guessed, and the city still arrives',async()=>{
 const broken=new Response(JSON.stringify({results:{bindings:[
  {city:{value:'http://www.wikidata.org/entity/Q1'},cityLabel:{value:'X'},pop:{value:'muitos'},area:{value:'muito grande'},date:{value:'não é data'}},
 ]}}),{status:200});
 const directory=createWikidataDirectory({fetcher:async()=>broken});
 const facts=await directory.named('X','pt');
 expect(facts).toEqual({id:'Q1',label:'X',source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q1',license:'CC0'}});
});
test('a city is found by where the player is looking, with a query that asks for a neighbourhood and nothing more',async()=>{
 const seen:string[]=[];
 const directory=createWikidataDirectory({fetcher:async(input,init)=>{
  seen.push(String(input));
  // The request carries the coordinates and the radius in the query body, and the test reads them back from there.
  seen.push(String(init?.body ?? ''));
  return response(sparql([{qid:'Q24639',label:'Vancouver',pop:662_248,year:2021}]));
 }});
 const facts=await directory.near(49.2827,-123.1207,25);
 expect(facts?.label).toBe('Vancouver');
 expect(facts?.population).toBe(662_248);
 const sent=seen.join(' ');
 expect(sent).toContain('around');
 expect(sent).toContain('49.2827');
 expect(sent).toContain('-123.1207');
 expect(sent).toContain('25');
});

// The one test that talks to the real service. It is skipped unless asked for, it asserts ranges instead of exact
// numbers (a census is republished), and it never runs as part of the suite.
test.skipIf(!process.env.OSIM_LIVE_WIKIDATA)('the real Wikidata answers for a named city and for a place on the map',async()=>{
 const directory=createWikidataDirectory();
 const sao=await directory.named('São Paulo','pt');
 expect(sao?.population).toBeGreaterThan(10_000_000);
 expect(sao?.populationYear).toBeGreaterThanOrEqual(2010);
 expect(sao?.country).toBe('Brasil');
 const vancouver=await directory.near(49.2827,-123.1207,30);
 expect(vancouver?.label).toBe('Vancouver');
 expect(vancouver?.population).toBeGreaterThan(500_000);
},30000);

test('a municipal code is carried through only when it has the shape a statistics office uses',async()=>{
 // It is what joins the two sources without trusting that two cities with the same name are the same city, so a value
 // of the wrong shape is dropped rather than handed to the second source.
 const read=async(value:string)=>{
  const directory=createWikidataDirectory({fetcher:async()=>response(sparql([{qid:'Q174',label:'São Paulo',pop:11_904_961,year:2025,...({municipalCode:value} as Record<string,string>)}]))});
  return (await directory.named('São Paulo','pt'))?.municipalCode;
 };
 expect(await read('3550308')).toBe('3550308');
 expect(await read('35503')).toBeUndefined();
 expect(await read('Q174')).toBeUndefined();
});

test('both queries ask the service for a place, and for the code that joins the second source',async()=>{
 // The one test here that reads the query instead of the answer, and on purpose: it is the *service* that decides
 // whether "Rio de Janeiro" means the city or the 2016 Olympic Games, so no fake payload can notice that the filter
 // went missing. Before that line existed, this adapter reported an event's population — or none at all — for Rio,
 // Campinas, Salvador and Recife, and the municipal code never arrived from a coordinate.
 const bodies:string[]=[];
 const directory=createWikidataDirectory({fetcher:async(_input:RequestInfo|URL,init?:RequestInit)=>{
  bodies.push(String(init?.body??''));
  return response(sparql([{qid:'Q174',label:'São Paulo',pop:11_904_961,year:2025}]));
 }});
 await directory.named('São Paulo','pt');
 await directory.near(-23.55,-46.63,25);
 expect(bodies).toHaveLength(2);
 for(const body of bodies){
  const query=decodeURIComponent(body.replace(/^query=/,''));
  expect(query).toContain('wdt:P31/wdt:P279* wd:Q486972');
  expect(query).toContain('wdt:P1585');
 }
});

test('newest non deprecated population retains its individual provenance',async()=>{
 const body=sparql([{qid:'Q24639',label:'Vancouver',pop:662248,year:2021,country:'Canadá'},{qid:'Q24639',label:'Vancouver',pop:999999,year:2025,country:'Canadá'}]);
 body.results.bindings[1]!['rank']={value:'http://wikiba.se/ontology#DeprecatedRank'};
 const directory=createWikidataDirectory({fetcher:async()=>response(body)});
 const facts=await directory.named('Vancouver','pt');
 expect(facts?.population).toBe(662248);
 expect(facts?.measures?.population).toMatchObject({value:662248,unit:'people',source:{territoryId:'Q24639',observedYear:2021,dataset:'Wikidata',method:'reported'}});
 expect(facts?.country).toBe('Canadá');
});
test('country code is preserved independently of the translated country name',async()=>{
 const body=sparql([{qid:'Q24639',label:'Vancouver',pop:662248,year:2021,country:'Canadá'}]);
 body.results.bindings[0]!['countryCode']={value:'CA'};
 const facts=await createWikidataDirectory({fetcher:async()=>response(body)}).named('Vancouver','pt');
 expect(facts?.countryCode).toBe('CA');
});
test('financial measures never replace the census attribution',async()=>{
 const facts=await createWikidataDirectory({fetcher:async()=>response(sparql([{qid:'Q24639',label:'Vancouver',pop:662248,year:2021}]))}).named('Vancouver','pt');
 expect(facts?.measures?.population?.source.dataset).toBe('Wikidata');
 expect(facts?.finance).toBeUndefined();
});
