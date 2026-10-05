import {RULES_VERSION} from '../src/core/model';
import {expect,test} from 'vitest';
import {DEFAULT_LIMITS,decodeBundle,decodeUtf8,encodeBundle,parseStrictJson,verifyBundle} from '../src/world/codec';

test('strict JSON refuses reserved keys before assigning them at any depth',()=>{
 for(const text of ['{"__proto__":{"x":1}}','{"nested":{"__proto__":null}}','[{"constructor":1}]','{"prototype":2}'])
  expect(parseStrictJson(text)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(Object.getPrototypeOf((parseStrictJson('{"ok":2}') as {value:object}).value)).toBe(Object.prototype);
});
import type {DecodeLimits} from '../src/world/codec';
import {canonicalText,createJcsCodec,encodeJcs} from '../src/adapters/codec/jcs';
import {bytesHasher,sha256Bytes} from '../src/adapters/hash/content';
import {importLegacy} from '../src/session/world-bundle';
import {decodeSave} from '../src/core/snapshot';
import type {JsonValue,WorldBundle} from '../src/world/model';
import legacy from './fixtures/federated-world/legacy.json';

const codec=createJcsCodec(),hasher=bytesHasher(),bytes=(text:string)=>new TextEncoder().encode(text);
const txt=(value:Uint8Array)=>new TextDecoder().decode(value);
const terms=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];

test('a legacy save becomes a portable package that carries the state and leaves the camera behind',async()=>{
 const save=decodeSave(legacy);
 const imported=await importLegacy(save,hasher,codec,terms);
 expect(imported.ok).toBe(true);
 if(!imported.ok)return;
 const bundle=imported.value;
 expect(bundle.envelope).toEqual({worldProtocol:2,wireVersion:1,kind:'bundle'});
 expect(bundle.definition).toMatchObject({worldId:'victoria',branchId:'main',profiles:['city'],rules:{family:'city',version:RULES_VERSION}});
 expect(bundle.definition.origin.kind).toBe('legacy-save');
 expect(bundle.head).toBeUndefined();
 expect(bundle.completeness).toEqual({complete:true,missing:[]});
 expect(bundle.terms).toEqual(terms);
 // the durable state travels whole, extras and unknown components included
 const carried=(bundle.objects[0]!.value as {kind:string;state:unknown});
 expect(carried.kind).toBe('city-state');
 expect(carried.state).toEqual(save.state);
 expect((carried.state as Record<string,unknown>)['future-state']).toEqual({extra:true});
 expect(JSON.stringify(bundle)).toContain('lifesim.residence');
 // the camera is local presentation, not part of the world
 const text=txt(encodeBundle(bundle,codec));
 expect(text).not.toContain('Victoria');
 expect(text).not.toContain('"zoom"');
 // and the package verifies against its own addresses
 expect(await verifyBundle(bundle,hasher,codec)).toMatchObject({ok:true});
});

test('the extension space survives a round trip and the critical schemas stay closed',async()=>{
 const save=decodeSave(legacy);
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error('import falhou');
 const source=imported.value as unknown as Record<string,unknown>;
 source['extensions']={future:{at:'bundle'},'driving.hud':{visible:true},nested:{deep:[1,2,{three:3}]}};
 const text=encodeBundle(source as unknown as WorldBundle,codec);
 const decoded=decodeBundle(text);
 expect(decoded.ok).toBe(true);
 if(!decoded.ok)return;
 const copy=decoded.value as unknown as Record<string,unknown>;
 expect(copy['extensions']).toEqual({future:{at:'bundle'},'driving.hud':{visible:true},nested:{deep:[1,2,{three:3}]}});
 // what this client hands back is its own copy, not a window into the parsed file
 const copyExtensions=copy['extensions'] as Record<string,{at?:string}>;
 (copyExtensions['future'] as {at:string}).at='changed';
 expect(txt(encodeBundle(source as unknown as WorldBundle,codec))).toBe(txt(text));
 // a field this contract does not define belongs to a newer wire version, and is refused rather than ignored
 const closed:[string,unknown][]=[
  ['envelope',{worldProtocol:2,wireVersion:1,kind:'bundle',future:true}],
  ['definition',{...imported.value.definition,future:true}],
  ['regras',{...imported.value.definition,rules:{...imported.value.definition.rules,future:1}}],
  ['cabeça',{worldId:'victoria',branchId:'main',commit:{hash:'a'.repeat(64),bytes:1},generation:0,future:'x'}],
  ['referência',{hash:'a'.repeat(64),bytes:1,future:'x'}],
  ['completude',{complete:true,missing:[],future:'x'}],
 ];
 for(const [name,changed] of closed){
  const payload=name==='envelope'
   ?({...source,envelope:changed})
   :name==='cabeça'
    ?({...source,head:changed})
    :name==='referência'
     ?({...source,objects:[{ref:changed,value:null}]})
     :name==='completude'
      ?({...source,completeness:changed})
      :({...source,definition:changed});
  expect(decodeBundle(codec.encode(payload as JsonValue)),name).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 }
});

test('a package from another protocol, or a body that lies about itself, is refused',async()=>{
 const save=decodeSave(legacy);
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error('import falhou');
 const good=imported.value as unknown as Record<string,unknown>;
 const withEnvelope=(envelope:Record<string,unknown>)=>({...good,envelope});
 const cases:[string,Uint8Array,string][]=[
  ['protocolo de mundo desconhecido',codec.encode(withEnvelope({worldProtocol:3,wireVersion:1,kind:'bundle'}) as JsonValue),'WORLD_PROTOCOL_UNSUPPORTED'],
  ['versão de transporte desconhecida',codec.encode(withEnvelope({worldProtocol:2,wireVersion:2,kind:'bundle'}) as JsonValue),'WIRE_VERSION_UNSUPPORTED'],
  ['envelope de outro tipo',codec.encode(withEnvelope({worldProtocol:2,wireVersion:1,kind:'commit'}) as JsonValue),'MALFORMED'],
  ['chave JSON repetida',bytes('{"envelope":{"worldProtocol":2},"envelope":{"worldProtocol":2}}'),'MALFORMED'],
  ['JSON com lixo no fim',bytes('{"envelope":{}} extra'),'MALFORMED'],
  ['UTF-8 inválido',new Uint8Array([0x7b,0xff,0x7d]),'MALFORMED'],
  ['cabeça apontando para outro mundo',codec.encode({...good,head:{worldId:'outro',branchId:'main',commit:{hash:'a'.repeat(64),bytes:1},generation:0}} as JsonValue),'MALFORMED'],
  ['objeto repetido',codec.encode({...good,objects:[(good['objects'] as unknown[])[0],(good['objects'] as unknown[])[0]]} as JsonValue),'MALFORMED'],
  ['pacote parcial com objetos',codec.encode({...good,completeness:{complete:false,missing:[{hash:'b'.repeat(64),bytes:2}]}} as JsonValue),'MALFORMED'],
  ['pacote completo com ausentes',codec.encode({...good,completeness:{complete:true,missing:[{hash:'b'.repeat(64),bytes:2}]}} as JsonValue),'MALFORMED'],
  ['referência sem hash utilizável',codec.encode({...good,objects:[{ref:{hash:'curto',bytes:1},value:null}]} as JsonValue),'MALFORMED'],
 ];
 for(const [name,payload,expected] of cases){
  const result=decodeBundle(payload);
  expect(result.ok,name).toBe(false);
  if(!result.ok)expect(result.error.code,name).toBe(expected);
 }
});

test('limits stop a hostile body before it is understood',async()=>{
 const save=decodeSave(legacy);
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error('import falhou');
 const good=imported.value as unknown as Record<string,unknown>;
 const tight=(over:Partial<DecodeLimits>):DecodeLimits=>({...DEFAULT_LIMITS,...over});
 const payload=encodeBundle(good as unknown as WorldBundle,codec);
 expect(decodeBundle(payload,tight({maxBundleBytes:8}))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(decodeBundle(payload,tight({maxObjectBytes:4}))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 const nested=codec.encode({envelope:{worldProtocol:2,wireVersion:1,kind:'bundle',deep:{a:{b:{c:{d:1}}}}}} as JsonValue);
 expect(decodeBundle(nested,tight({maxDepth:3}))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(decodeBundle(nested,tight({maxNodes:2}))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(decodeBundle(payload)).toMatchObject({ok:true});
});

test('addresses are only trusted after the bytes are in hand',async()=>{
 const save=decodeSave(legacy);
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error('import falhou');
 const bundle=imported.value;
 const tampered:WorldBundle={...bundle,objects:[{ref:bundle.objects[0]!.ref,value:{kind:'city-state',state:{money:999999}}}]};
 expect(await verifyBundle(tampered,hasher,codec)).toMatchObject({ok:false,error:{code:'HASH_MISMATCH'}});
 const honest=await hasher.ref(codec.encode(tampered.objects[0]!.value));
 expect(await verifyBundle({...tampered,objects:[{ref:honest,value:tampered.objects[0]!.value}]},hasher,codec)).toMatchObject({ok:true});
 expect(await sha256Bytes(codec.encode(bundle.objects[0]!.value))).toBe(bundle.objects[0]!.ref.hash);
});

// RFC 8785 §3.2.2 and §3.2.3 publish the exact sample and the exact sorting order; these are those vectors.
test('canonical JSON follows RFC 8785 on numbers, strings and property order',()=>{
 const sample={numbers:[333333333.33333329,1e30,4.5,2e-3,1e-27],string:'€$\u000f\nA\'B"\\\\"/',literals:[null,true,false]};
 const expected=String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
 // the expected text denotes the same value: this is what makes the comparison below meaningful
 expect(parseStrictJson(expected)).toEqual({ok:true,value:sample});
 expect(canonicalText(sample as unknown as JsonValue)).toBe(expected);
 expect(canonicalText(sample as unknown as JsonValue)).not.toContain('\n');
 expect(txt(encodeJcs(sample as unknown as JsonValue))).toBe(expected);
 const sorted={'\u20ac':'Euro Sign','\r':'Carriage Return','\ufb33':'Hebrew Letter Dalet With Dagesh','1':'One','\ud83d\ude00':'Emoji: Grinning Face','\u0080':'Control','\u00f6':'Latin Small Letter O With Diaeresis'};
 const order=[...canonicalText(sorted as unknown as JsonValue).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map(match=>JSON.parse(`"${match[1]}"`) as string);
 expect(order).toEqual(['\r','1','\u0080','\u00f6','\u20ac','\ud83d\ude00','\ufb33']);
 expect(()=>canonicalText('\ud800' as unknown as JsonValue)).toThrow();
 expect(()=>canonicalText({n:Number.NaN} as unknown as JsonValue)).toThrow();
 expect(canonicalText({b:1,a:[{d:2,c:3}]} as unknown as JsonValue)).toBe('{"a":[{"c":3,"d":2}],"b":1}');
});

test('strict parsing refuses what JSON.parse would silently accept',()=>{
 expect(parseStrictJson('{"a":1,"a":2}')).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(parseStrictJson('{"a":1e999}')).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(parseStrictJson('"texto\u0000cru"')).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(parseStrictJson('"solto\ud800"')).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(parseStrictJson('{"a":}')).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(parseStrictJson('[1,2,]')).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(parseStrictJson('{"a":1} ')).toMatchObject({ok:true});
 expect(decodeUtf8(new Uint8Array([0xc0,0xaf]))).toMatchObject({ok:false});
 expect(decodeUtf8(new Uint8Array([0xe2,0x82]))).toMatchObject({ok:false});
 expect(decodeUtf8(bytes('café'))).toEqual({ok:true,value:'café'});
});
