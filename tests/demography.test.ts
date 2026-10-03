import {expect,test} from 'vitest';
import {createPlayHost} from '../tools/play-host';
import {headerLines} from '../src/surfaces/text/render';

test('the text header distinguishes the real municipality from simulated residents',async()=>{
 const {client}=await createPlayHost().open();
 await client.start();
 await client.do({do:'place',name:'Vancouver'});
 await client.idle();
 const lines=headerLines(client.view()).join('\n');
 expect(lines).toContain('População real 662.248 · 2021');
 expect(lines).toContain('Moradores simulados');
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
