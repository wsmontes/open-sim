import {expect,test} from 'vitest';
import {createPlayHost} from '../tools/play-host';
import {headerLines,prefeituraLines,factsLines} from '../src/surfaces/text/render';

test('the text header distinguishes the real municipality from simulated residents',async()=>{
 const {client}=await createPlayHost().open();
 await client.start();
 await client.do({do:'place',name:'Vancouver'});
 await client.idle();
 const lines=headerLines(client.view()).join('\n');
 expect(lines).toContain('População real 662.248 · 2021');
 expect(lines).not.toContain('Moradores');
 expect(prefeituraLines(client.view()).join('\n')).toContain('Moradores do bairro simulado:');
 expect(lines).not.toMatch(/Pessoas \d/);
 client.stop();
});

test('coordinates without demographic data clear the previous city census',async()=>{
 const {client}=await createPlayHost({facts:{named:async()=>null,near:async()=>null}}).open();
 await client.start();
 await client.do({do:'place',name:'Vancouver'});
 await client.idle();
 expect(client.view().facts?.population).toBe(662248);
 await client.do({do:'goTo',lat:0,lon:0});
 await client.idle();
 expect(client.view().facts).toBeNull();
 expect(client.view().scale).toBe('');
 client.stop();
});


test('a successful coordinate lookup retains its geographic anchor',async()=>{
 const real={id:'Qtest',label:'Outra cidade',population:123456,populationYear:2021,source:{dataset:'fixture',url:'https://example.com',license:'CC0'}};
 const {client}=await createPlayHost({facts:{named:async()=>null,near:async()=>real}}).open();
 await client.start();
 await client.do({do:'goTo',lat:48,lon:-122});
 await client.idle();
 expect(client.view().facts).toEqual(real);
 expect(client.view()).toHaveProperty('factsAt',{lat:48,lon:-122});
 client.stop();
});


test('text_surface_preserves_fact_source',async()=>{
 const {client}=await createPlayHost().open();await client.start();await client.do({do:'place',name:'Vancouver'});await client.idle();
 const facts=client.view().facts!;const lines=factsLines({...client.view(),facts:{...facts,measures:{population:{value:662248,unit:'people',source:{dataset:'Official census fixture',url:'https://example.test/census',territoryId:'2021A00055915022',observedYear:2021,retrievedAt:'2026-10-03T00:00:00Z',method:'reported'}}}}}).join('\n');
 expect(lines).toContain('Official census fixture');expect(lines).toContain('https://example.test/census');expect(lines).toContain('2021A00055915022');client.stop();
});
