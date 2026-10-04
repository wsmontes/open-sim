// The commit/save memo is licensed by one property of the core: it never mutates a value in place. This suite keeps
// that property honest. It compares the memoized output with a cache-free oracle byte for byte — the same string and
// the same SHA-256 — proves the memo is actually consulted (a Proxy counts the walks, a codec counts the addresses),
// and shows the one thing that would make it lie: an in-place mutation.
import {expect,test,afterEach} from 'vitest';
import {applyCommand,createGame} from '../src/core/commands';
import {adopt} from '../src/core/world';
import {encodeSave} from '../src/core/snapshot';
import {assertJsonSafe,canonicalJson,durableJson,setMemoEnabled} from '../src/core/protocol';
import {bytesHasher,sha256Hex} from '../src/adapters/hash/content';
import {isRecord} from '../src/core/guards';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {createWorldRepository} from '../src/session/world-repository';
import {createHostSession,readBody} from '../src/session/host-session';
import {importLegacy} from '../src/session/world-bundle';
import {RULES_VERSION} from '../src/core/model';
import type {Action,GameState,SavedGame,ViewState} from '../src/core/model';
import type {JsonValue} from '../src/world/model';
import type {IdentityProof} from '../src/world/permissions';
import type {MapSource} from '../src/session/ports';
import type {WorldCodec} from '../src/world/ports';
import type {SessionTransport} from '../src/session/multiplayer-ports';
import {blank,command} from './fixtures/world';

afterEach(()=>setMemoEnabled(true));

// The oracle: the cache-free walk the memo replaced, kept here so the comparison never depends on the code under
// test. It is deliberately a copy of the original algorithm, not a call into the memo.
function canonicalUncached(value:unknown):string{
 if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string')return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(canonicalUncached).join(',')}]`;
 if(typeof value==='object'){
  const source=value as Record<string,unknown>;
  return `{${Object.keys(source).filter(key=>source[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${canonicalUncached(source[key])}`).join(',')}}`;
 }
 throw new Error('Valor não serializável');
}
// `durableJson` without a memo is this projection plus the oracle; keeping the projection here makes the two texts
// comparable without reimplementing the memo.
function durableProjection(state:GameState):unknown{
 const {revision,actors,...durable}=state;
 return {identityVersion:2,state:{...durable,components:state.components}};
}
const view:ViewState={x:12.5,y:-4,zoom:1.5,speed:1,place:'Victoria',rotation:-0.75};
const actions=():Action[]=>[
 {type:'build',tool:'park',cells:[{x:1,y:1}]},
 {type:'component',key:'city.zone',entity:'parcel-7',value:{use:'park',plots:[1,2,3]}},
 {type:'tick'},
 {type:'build',tool:'road',cells:[{x:4,y:4},{x:5,y:4}]},
 {type:'component',key:'lifesim.residence',entity:'house-1',value:{people:4}},
 {type:'demolish',cells:[{x:1,y:1}]},
];

test('the memoized snapshot text and hash are byte-identical to a cache-free computation',async()=>{
 let state=createGame('mundo',42,blank('0:0'));
 for(let i=0;i<18;i+=1){
  const action=actions()[i%actions().length]!;
  const applied=applyCommand(state,command(state,action),[]);
  if(applied.status!=='applied')throw new Error(applied.reason);
  state=applied.state;
  const save:SavedGame={version:1,state,view};
  const memoized=encodeSave(save),oracle=canonicalUncached(save)+'\n';
  expect(memoized).toBe(oracle);
  const identity=durableJson(state),identityOracle=canonicalUncached(durableProjection(state))+'\n';
  expect(identity).toBe(identityOracle);
  // The world hash is the published contract: the memo may not move it.
  expect(await sha256Hex(memoized)).toBe(await sha256Hex(oracle));
  expect(await sha256Hex(identity)).toBe(await sha256Hex(identityOracle));
 }
});

test('canonicalJson reuses the serialized fragment of a shared subtree',()=>{
 let walked=0;
 const shared=Object.freeze({a:1,b:Object.freeze([1,2,Object.freeze({c:3})])});
 const counted=new Proxy(shared,{ownKeys(target){walked+=1;return Reflect.ownKeys(target);},get(target,key,receiver){walked+=1;return Reflect.get(target,key,receiver);}});
 const first=canonicalJson({left:counted,note:'one'});
 const afterFirst=walked;
 const second=canonicalJson({right:counted,note:'two'});
 expect(afterFirst).toBeGreaterThan(0);
 expect(walked-afterFirst).toBe(0);
 expect(first).not.toBe(second);
 expect(first).toBe(canonicalUncached({left:shared,note:'one'})+'\n');
 expect(second).toBe(canonicalUncached({right:shared,note:'two'})+'\n');
});

test('assertJsonSafe reuses a validated subtree and still counts it against the ceilings',()=>{
 let walked=0;
 const shared=Object.freeze({a:1,b:Object.freeze({c:2})});
 const counted=new Proxy(shared,{ownKeys(target){walked+=1;return Reflect.ownKeys(target);},getPrototypeOf(target){walked+=1;return Reflect.getPrototypeOf(target);},get(target,key,receiver){walked+=1;return Reflect.get(target,key,receiver);}});
 assertJsonSafe({left:counted},'Documento');
 const afterFirst=walked;
 assertJsonSafe({right:counted},'Documento');
 expect(afterFirst).toBeGreaterThan(0);
 expect(walked-afterFirst).toBe(0);
 // Reuse still charges the subtree's nodes: two memoized halves over the 8192-node ceiling have to be refused.
 const half=Object.freeze(Array.from({length:5000},(_,index)=>index));
 assertJsonSafe({half},'Metade');
 expect(()=>assertJsonSafe({left:half,right:half},'Documento')).toThrow(/grande demais/);
 expect(()=>assertJsonSafe([half,half],'Documento')).toThrow(/grande demais/);
 // And its depth: a subtree that fits at one depth is refused when a memoized parent carries it one level deeper.
 const chain=(levels:number):unknown=>{let nested:unknown=1;for(let level=0;level<levels;level+=1)nested=Object.freeze([nested]);return nested;};
 const leaf=chain(4);
 assertJsonSafe(leaf,'Folha');
 let nested:unknown=leaf;
 for(let level=0;level<12;level+=1)nested=[nested];
 assertJsonSafe(nested,'Raso');
 expect(()=>assertJsonSafe([nested],'Fundo')).toThrow(/profundo demais/);
});

test('mutable JSON is re-read and never frozen by serialization or validation',()=>{
 // The documented hazard, pinned so nobody mistakes the memo for a content hash of a mutable object.
 const value={a:1};
 const before=canonicalJson(value);
 value.a=2;
 expect(canonicalJson(value)).not.toBe(before);
 expect(Object.isFrozen(value)).toBe(false);
 const unsafe:{a:unknown}={a:1};assertJsonSafe(unsafe,'Payload');unsafe.a=Infinity;expect(()=>assertJsonSafe(unsafe,'Payload')).toThrow();
 expect(canonicalJson({a:2})).toBe('{"a":2}\n');
});
test('the core never mutates a frozen state, which is what makes identity a content key',()=>{
 const frozen=(value:unknown):void=>{
  if(value!==null&&typeof value==='object'&&!Object.isFrozen(value)){
   for(const key of Object.keys(value as Record<string,unknown>))frozen((value as Record<string,unknown>)[key]);
   Object.freeze(value);
  }
 };
 let state=createGame('mundo',42,blank('0:0'));
 frozen(state);
 for(let i=0;i<12;i+=1){
  const action=actions()[i%actions().length]!;
  const applied=applyCommand(state,command(state,action),[]);
  expect(applied.status).toBe('applied');
  state=applied.state;
  frozen(state);
  expect(durableJson(state)).toBe(canonicalUncached(durableProjection(state))+'\n');
  expect(encodeSave({version:1,state,view})).toBe(canonicalUncached({version:1,state,view})+'\n');
 }
});

// --- the session path: every commit re-addressed every frozen region before the memo ---------------------------
const NOW='2026-10-03T12:00:00Z';
const identity:IdentityProof={kind:'identity',principal:{scheme:'local',id:'0'.repeat(64)},sessionKey:'0'.repeat(64),scope:{worldId:'mundo',branchId:'main',sessionId:'sessao',notBefore:'2026-01-01T00:00:00Z',notAfter:'2027-01-01T00:00:00Z'},delegation:{algorithm:'Ed25519',key:'0'.repeat(64),value:'0'.repeat(128)}};
function stateWith(ids:readonly string[]):GameState{
 const game=createGame('mundo',7,blank(ids[0]!));
 const chunks={...game.chunks};
 for(const id of ids.slice(1))chunks[id]=adopt(blank(id));
 return {...game,chunks};
}
function countingCodec():{codec:WorldCodec;baseAddresses:number;cityStates:number}{
 const jcs=createJcsCodec();
 let baseAddresses=0,cityStates=0;
 return {
  get baseAddresses(){return baseAddresses;},
  get cityStates(){return cityStates;},
  codec:{encode:(value:JsonValue)=>{if(isRecord(value)&&value['kind']==='base-chunk')baseAddresses+=1;if(isRecord(value)&&value['kind']==='city-state')cityStates+=1;return jcs.encode(value);}},
 };
}
async function session(memo:boolean,ids:readonly string[]){
 const counter=countingCodec(),hasher=bytesHasher();
 const repository=createWorldRepository({storage:createWorldMemoryStorage(),codec:counter.codec,hasher,memo});
 const imported=await importLegacy({version:1,state:stateWith(ids),view},hasher,counter.codec);
 if(!imported.ok)throw new Error(imported.error.message);
 const created=await repository.create(imported.value);
 if(!created.ok)throw new Error(created.error.message);
 const sent:{to:string;body:JsonValue}[]=[];
 const transport:SessionTransport={send:async(to,message)=>{sent.push({to,body:message.body});},subscribe:()=>()=>{}};
 const bases:MapSource={loadChunk:async id=>blank(id),attribution:{text:'sintético',url:'https://example.test'}};
 const host=createHostSession({repository,transport,peer:'local',head:created.value,identity,grants:[],rules:{family:'city',version:RULES_VERSION},bases,verifier:{verify:async()=>true},codec:counter.codec,hasher,now:()=>NOW,sessionId:'sessao',epoch:1,peers:['replica'],memo});
 return {host,counter,sent,hasher,codec:counter.codec};
}

test('a host commit reuses the address of a frozen region instead of re-hashing every one',async()=>{
 const ids=['0:0','1:0','2:0','3:0'];
 const {host,counter}=await session(true,ids);
 await host.step();
 const afterFirst=counter.baseAddresses;
 await host.step();
 const afterSecond=counter.baseAddresses;
 await host.step();
 const afterThird=counter.baseAddresses;
 // First commit: the boot checkout and the commit each address the four regions once (4+4), never more.
 expect(afterFirst).toBe(ids.length*2);
 // Every later commit reuses them: no region is encoded again.
 expect(afterSecond-afterFirst).toBe(0);
 expect(afterThird-afterSecond).toBe(0);
});
test('with the memo off every commit re-addresses all frozen regions, which is the cost the memo removes',async()=>{
 const ids=['0:0','1:0','2:0','3:0'];
 const {host,counter}=await session(false,ids);
 await host.step();
 const afterFirst=counter.baseAddresses;
 await host.step();
 const afterSecond=counter.baseAddresses;
 // Boot (4) + first commit (4), then one encoding per region per commit again: 4 + 3*4.
 expect(afterFirst).toBe(ids.length*2);
 expect(afterSecond-afterFirst).toBe(ids.length);
});
test('the memoized base references a commit publishes are byte-identical to a cache-free recomputation',async()=>{
 const ids=['0:0','1:0','2:0','3:0'];
 const memo=await session(true,ids),plain=await session(false,ids);
 await memo.host.step();
 await plain.host.step();
 const read=(sent:{to:string;body:JsonValue}[])=>{
  const last=sent[sent.length-1]!;
  const parsed=readBody(last.body);
  if(!parsed.ok||parsed.value.kind!=='commit')throw new Error(`Sem commit anunciado: ${sent.length} enviados, ${parsed.ok?parsed.value.kind:parsed.error.message}`);
  return parsed.value.commit;
 };
 const memoized=read(memo.sent),oracle=read(plain.sent);
 expect(memoized.bases.map(entry=>entry.id)).toEqual([...ids].sort());
 expect(memoized.bases.map(entry=>entry.ref)).toEqual(oracle.bases.map(entry=>entry.ref));
 // And the oracle agrees with a direct address of each region, computed with a fresh hasher and codec.
 const {head,state}=await memo.host.checkpoint();
 const direct=createJcsCodec(),hasher=bytesHasher();
 for(const entry of memoized.bases){
  const ref=await hasher.ref(direct.encode({kind:'base-chunk',base:state.chunks[entry.id]!.base as unknown as JsonValue}));
  expect(entry.ref).toEqual(ref);
 }
 expect(head.generation).toBe(2);
});
test('a repeated delivery does not re-address the world it already addressed',async()=>{
 const counter=countingCodec(),hasher=bytesHasher();
 const repository=createWorldRepository({storage:createWorldMemoryStorage(),codec:counter.codec,hasher});
 const base=stateWith(['0:0','1:0']);
 const imported=await importLegacy({version:1,state:base,view},hasher,counter.codec);
 if(!imported.ok)throw new Error(imported.error.message);
 const created=await repository.create(imported.value);
 if(!created.ok)throw new Error(created.error.message);
 const built=applyCommand(base,command(base,{type:'build',tool:'park',cells:[{x:1,y:1}]}),[]);
 if(built.status!=='applied')throw new Error(built.reason);
 const change={id:'mudanca-1',state:built.state,operations:['op-1'],objects:[],author:'ana'};
 const first=await repository.commit(created.value,change);
 expect(first.ok).toBe(true);
 const afterFirst=counter.cityStates;
 expect(afterFirst).toBeGreaterThan(0);
 // The same change delivered again carries the same state object: the address memo answers it and the receipt
 // answers the delivery, so the world is never encoded a second time.
 const second=await repository.commit(created.value,change);
 expect(second.ok).toBe(true);
 expect(counter.cityStates).toBe(afterFirst);
});
test('frozen accessors remain dynamic and frozen deep input still hits the validation limit',()=>{let n=1;const value=Object.freeze({get x(){return n;}});expect(canonicalJson(value)).toBe('{"x":1}\n');assertJsonSafe(value,'Payload');n=2;expect(canonicalJson(value)).toBe('{"x":2}\n');n=NaN;expect(()=>assertJsonSafe(value,'Payload')).toThrow(/inválido/);let deep:unknown=0;for(let i=0;i<15000;i++)deep=Object.freeze([deep]);expect(()=>assertJsonSafe(deep,'Payload')).toThrow(/profundo demais/);});
