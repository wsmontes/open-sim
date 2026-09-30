import {expect,test} from 'vitest';
import {PROTOCOL_VERSION,decodeManifest,durableJson,encodeManifest,isComponentKey,isEntityId} from '../src/core/protocol';
import type {WorldManifest} from '../src/core/protocol';
import {applyCommand,createGame} from '../src/core/commands';
import type {Action} from '../src/core/model';
import {contentRef,sha256Hex} from '../src/adapters/hash/content';
import {blank,command} from './fixtures/world';

const manifest=():WorldManifest=>({
 protocol:1,
 worldId:'victoria-wagner',
 rules:{family:'city',version:1},
 base:{source:'OpenStreetMap · Shortbread v1',normalizerVersion:1},
 snapshot:{hash:'a'.repeat(64),bytes:42},
 parent:{worldId:'earth-osm',manifestHash:'b'.repeat(64)},
 authority:{kind:'local',actorId:'local-player'},
 extensions:[{key:'city.zone',version:1,durable:true},{key:'lifesim.residence',version:1,durable:true},{key:'vehicle.transform',version:2,durable:false}],
});

test('a manifest round-trips through canonical JSON and keeps what it does not know',()=>{
 const text=encodeManifest(manifest());
 expect(text.endsWith('\n')).toBe(true);
 const decoded=decodeManifest(JSON.parse(text));
 expect(decoded).toEqual(manifest());
 expect(encodeManifest(decoded)).toBe(text);
 // a field written by a later version of this contract survives a client that only knows this one
 const extended=JSON.parse(text) as Record<string,unknown>;
 (extended.extensions as Record<string,unknown>[])[0]!['note']='written elsewhere';
 extended['future']={anything:true};
 const kept=decodeManifest(extended);
 expect((kept.extensions[0] as Record<string,unknown>)['note']).toBe('written elsewhere');
 expect((kept as unknown as Record<string,unknown>)['future']).toEqual({anything:true});
 expect(PROTOCOL_VERSION).toBe(1);
});

test('a manifest from another protocol version or a malformed one is refused',()=>{
 const cases:[string,unknown][] = [
  ['unknown protocol',{...manifest(),protocol:2}],
  ['missing world',{...manifest(),worldId:''}],
  ['long world',{...manifest(),worldId:'m'.repeat(81)}],
  ['bad rules',{...manifest(),rules:{family:'',version:1}}],
  ['fractional rules version',{...manifest(),rules:{family:'city',version:1.5}}],
  ['bad base',{...manifest(),base:{source:'',normalizerVersion:1}}],
  ['unknown normalizer',{...manifest(),base:{source:'x',normalizerVersion:2}}],
  ['bad authority',{...manifest(),authority:{kind:'whoever'}}],
  ['bad snapshot hash',{...manifest(),snapshot:{hash:'zz',bytes:1}}],
  ['negative snapshot size',{...manifest(),snapshot:{hash:'a'.repeat(64),bytes:-1}}],
  ['empty parent',{...manifest(),parent:{worldId:''}}],
  ['extensions not a list',{...manifest(),extensions:{}}],
  ['extension without a namespace',{...manifest(),extensions:[{key:'city',version:1}]}],
  ['extension with version zero',{...manifest(),extensions:[{key:'city.zone',version:0}]}],
  ['null manifest',null],
  ['manifest as a list',[]],
 ];
 for(const [name,value] of cases)expect(()=>decodeManifest(value),name).toThrow();
});

test('component namespaces are namespaced, and payloads have to be plain JSON',()=>{
 for(const good of ['city.zone','lifesim.residence','vehicle.transform','population.aggregate','a.b_c.d'])
  expect(isComponentKey(good),good).toBe(true);
 for(const bad of ['city','City.zone','city.','.city.zone','city..zone','city.zone.','city.z*ne','__proto__','constructor.prototype'])
  expect(isComponentKey(bad),bad).toBe(false);
 for(const good of ['household-1','car_9','a','A'.repeat(80)])expect(isEntityId(good),good).toBe(true);
 for(const bad of ['','__proto__','household 1','a'.repeat(81),'house;hold'])expect(isEntityId(bad),bad).toBe(false);
});

test('the durable identity of a world ignores what a client only holds transiently',()=>{
 const base=createGame('world',42,blank());
 const zone:Action={type:'component',key:'city.zone',entity:'parcel-7',value:{use:'park'}};
 const transform:Action={type:'component',key:'vehicle.transform',entity:'car-9',value:{x:1,y:2,heading:.5}};
 const withZone=applyCommand(base,command(base,zone),[]).state;
 const withBoth=applyCommand(withZone,command(withZone,transform),[]).state;
 const extensions=[{key:'city.zone',version:1,durable:true},{key:'vehicle.transform',version:2,durable:false}];
 expect(durableJson(withBoth,extensions)).not.toBe(durableJson(base,extensions));
 const moved=applyCommand(withZone,command(withZone,{type:'component',key:'vehicle.transform',entity:'car-9',value:{x:9,y:9,heading:1.2}}),[]).state;
 expect(durableJson(moved,extensions)).toBe(durableJson(withBoth,extensions));
 // without declaring the namespace ephemeral, everything counts as durable
 expect(durableJson(withBoth)).not.toBe(durableJson(withZone));
});

test('a snapshot has a content address any client can compare',async()=>{
 expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
 const text=durableJson(createGame('world',1,blank()));
 const ref=await contentRef(text);
 expect(ref.bytes).toBe(new TextEncoder().encode(text).length);
 expect(ref.hash).toMatch(/^[0-9a-f]{64}$/);
 expect((await contentRef(text)).hash).toBe(ref.hash);
});
test('every known object of the manifest keeps the fields it does not implement',()=>{
 const source=JSON.parse(encodeManifest(manifest())) as Record<string,unknown>;
 const rules=source.rules as Record<string,unknown>,base=source.base as Record<string,unknown>;
 const authority=source.authority as Record<string,unknown>,snapshot=source.snapshot as Record<string,unknown>,parent=source.parent as Record<string,unknown>;
 rules['future']={tuning:2};base['future']='from a later protocol';authority['future']={delegates:['a']};
 snapshot['future']={algorithm:'sha-256'};parent['future']=[1,2,3];
 const decoded=decodeManifest(source) as unknown as Record<string,Record<string,unknown>>;
 expect(decoded.rules!['future']).toEqual({tuning:2});
 expect(decoded.base!['future']).toBe('from a later protocol');
 expect(decoded.authority!['future']).toEqual({delegates:['a']});
 expect(decoded.snapshot!['future']).toEqual({algorithm:'sha-256'});
 expect(decoded.parent!['future']).toEqual([1,2,3]);
 expect(encodeManifest(decodeManifest(source))).toBe(encodeManifest(decodeManifest(JSON.parse(JSON.stringify(decoded)))));
 // the copy never aliases the input
 (decoded.rules!['future'] as {tuning:number}).tuning=99;
 expect((source.rules as Record<string,unknown>)['future']).toEqual({tuning:2});
});
test('manifest fields keep strict types and namespaces cannot repeat',()=>{
 const cases:[string,unknown][]=[
  ['durability not boolean',{...manifest(),extensions:[{key:'city.zone',version:1,durable:'yes'}]}],
  ['authority actor with a space',{...manifest(),authority:{kind:'local',actorId:'two words'}}],
  ['extension key reserved',{...manifest(),extensions:[{key:'__proto__.x',version:1}]}],
  ['repeated namespace',{...manifest(),extensions:[{key:'city.zone',version:1},{key:'city.zone',version:2}]}],
  ['unknown field inside rules is not JSON',{...manifest(),rules:{family:'city',version:1,bad:Number.NaN}}],
  ['unknown field inside base is a function',{...manifest(),base:{source:'x',normalizerVersion:1,bad:()=>1}}],
  ['unknown field inside parent is not finite',{...manifest(),parent:{worldId:'earth',bad:Infinity}}],
 ];
 for(const [name,value] of cases)expect(()=>decodeManifest(value),name).toThrow();
});
