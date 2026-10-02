// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,test,vi} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {createWorldRepository} from '../src/session/world-repository';
import {importLegacy} from '../src/session/world-bundle';
import {applyCommand,createGame} from '../src/core/commands';
import {bytesHasher,sha256Hex} from '../src/adapters/hash/content';
import {createWorldCard} from '../src/adapters/social/world-card';
import type {PublicWorldInfo} from '../src/adapters/social/world-card';
import {sessionDescriptor} from '../src/adapters/network/webrtc';
import type {SessionScope} from '../src/adapters/network/manual-signaling';
import {durableJson} from '../src/core/protocol';
import {checkEnvelope,envelopeOf} from '../src/world/osim';
import {createKernel} from '../src/world/kernel';
import {replayFixture,replayWorld} from '../src/world/world-replay';
import type {AcceptedOperation,ReplayCheckpoint} from '../src/world/world-replay';
import {checkWorldLink} from '../src/world/world-links';
import type {WorldLink} from '../src/world/world-links';
import {conformanceChecklist} from '../tools/world-replay';
import type {ReplayReport} from '../tools/world-replay';
import fixture from './fixtures/federated-world/conformance.json';
import type {Head,JsonValue,ObjectRef,WorldBundle} from '../src/world/model';
import type {GameState} from '../src/core/model';

const codec=createJcsCodec(),hasher=bytesHasher();
const ACTOR='did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
type FixtureCase={name:string;note:string;bundle:WorldBundle;operations:AcceptedOperation[];expected:{stateRef:ObjectRef;bases:{id:string;ref:ObjectRef}[];head:Head;generation:number;semanticHash:string;accepted:string[]}};
type Conformance={version:1;protocol:string;license:string;note:string;limitations:string[];cases:FixtureCase[]};
// The state object of a package: the world's own snapshot, which is the object everything else in the package points at.
const stateObjectOf=(bundle:WorldBundle):ObjectRef|undefined=>bundle.objects.find(object=>object.value!==null&&typeof object.value==='object'&&!Array.isArray(object.value)&&object.value['kind']==='city-state')?.ref;
// The commit the package's head points at: what the branch already recorded before these operations arrived.
const commitObjectOf=(bundle:WorldBundle):Record<string,JsonValue>|undefined=>{
 const found=bundle.objects.find(object=>object.ref.hash===bundle.head?.commit.hash);
 return found&&found.value!==null&&typeof found.value==='object'&&!Array.isArray(found.value)?found.value:undefined;
};
// The fixture is JSON, so the shapes above are the claim being verified rather than an unchecked assertion: every test
// below re-derives the addresses and the semantic hash from the bytes instead of trusting a field.
const conformance=fixture as unknown as Conformance;
const caseOf=(name:string):FixtureCase=>{
 const found=conformance.cases.find(entry=>entry.name===name);
 if(!found)throw new Error(`Caso ausente na fixture: ${name}`);
 return found;
};
const semanticOf=async(state:GameState):Promise<{semanticHash:string;semanticText:string}>=>{
 const semanticText=durableJson(state);
 return {semanticHash:(await hasher.ref(new TextEncoder().encode(semanticText))).hash,semanticText};
};

test('the §47 checklist is a program, not a paragraph',async()=>{
 const items=await conformanceChecklist();
 expect(items.map(entry=>entry.item)).toEqual([
  'envelope','identificadores','componentes desconhecidos','operações de estado','tempo','resolução','transporte',
 ]);
 expect(items.filter(entry=>!entry.ok)).toEqual([]);
});

test('every case replays to the version the reference repository recorded',async()=>{
 for(const entry of conformance.cases){
  const replayed=await replayWorld(entry.bundle,entry.operations,{codec,hasher});
  if(!replayed.ok)throw new Error(`${entry.name}: ${replayed.error.message}`);
  const checkpoint=replayed.value;
  expect(checkpoint.stateRef,entry.name).toEqual(entry.expected.stateRef);
  // The version is reproduced address for address: not only the state, but the tree and the commit the repository built.
  expect(checkpoint.head,entry.name).toEqual(entry.expected.head);
  expect(checkpoint.head.generation,entry.name).toBe(entry.expected.generation);
  // One line of application: each accepted operation is one version on top of the last, and the version before the
  // first operation is the package's own head.
  expect(checkpoint.commit.parents.length,entry.name).toBe(1);
  expect(checkpoint.commit.generation,entry.name).toBe((entry.bundle.head?.generation??0)+entry.operations.length);
  if(entry.operations.length===1)expect(checkpoint.commit.parents[0],entry.name).toEqual(entry.bundle.head?.commit);
  expect(checkpoint.bases,entry.name).toEqual(entry.expected.bases);
  expect(checkpoint.commit.accepted,entry.name).toEqual(entry.expected.accepted);
  expect(checkpoint.duplicates,entry.name).toEqual([]);
  // The ledger spans the branch: what the package already recorded, then what these operations added.
  const recorded=commitObjectOf(entry.bundle)?.['accepted'] as string[]??[];
  expect(checkpoint.ledger,entry.name).toEqual([...recorded,...entry.operations.map(operation=>operation.mark)]);
  expect(checkpoint.versions,entry.name).toEqual({worldProtocol:2,wireVersion:1,rules:{family:'city',version:1}});
  const semantic=await semanticOf(checkpoint.state);
  expect(semantic.semanticHash,entry.name).toBe(entry.expected.semanticHash);
 }
});

// The other half of the claim: the fixture is not a snapshot of the replay. The reference repository opens the package
// and reaches the very same heads by applying the same operations, so a drift between fixture and code has to be
// repaired on both sides at once — and the vector can always be regenerated from the suite.
test('the reference repository reaches the versions the fixture records',async()=>{
 const worlds=createWorldRepository({storage:createWorldMemoryStorage(),codec,hasher});
 for(const entry of conformance.cases){
  const opened=await worlds.create(entry.bundle);
  if(!opened.ok)throw new Error(`${entry.name}: ${opened.error.message}`);
  let head=opened.value;
  for(const operation of entry.operations){
   const current=await worlds.checkout(head);
   if(!current.ok)throw new Error(`${entry.name}: ${current.error.message}`);
   const next=operation.kind==='command'?applyCommand(current.value.state,operation.command,[]):{state:operation.state};
   if('status' in next&&next.status!=='applied')throw new Error(`${entry.name}: ${next.reason??'recusado'}`);
   const committed=await worlds.commit(head,{id:`fixture-${operation.mark.split('.')[2]!.split('@')[0]}`,state:next.state,operations:[operation.mark],objects:[],author:operation.actor});
   if(!committed.ok)throw new Error(`${entry.name}: ${committed.error.message}`);
   head=committed.value;
  }
  expect(head,entry.name).toEqual(entry.expected.head);
  const checkpoint=await worlds.checkout(head);
  if(!checkpoint.ok)throw new Error(`${entry.name}: ${checkpoint.error.message}`);
  expect(checkpoint.value.bases,entry.name).toEqual(entry.expected.bases);
 }
});

test('what each case was built to prove survives the replay',async()=>{
 const merge=caseOf('merge');
 const merged=await replayWorld(merge.bundle,merge.operations,{codec,hasher});
 if(!merged.ok)throw new Error(merged.error.message);
 // The main line's road and the branch's park, in one version: a merge composes instead of re-executing.
 const cells=merged.value.state.chunks['9:9']!.edits;
 expect(cells['33']).toEqual({terrain:'land',road:true,origin:'player'});
 expect(cells['66']).toEqual({terrain:'land',building:'park',stage:1,origin:'player'});
 expect(merged.value.state.money).toBe(19960);
 expect(merged.value.state.tick).toBe(0);

 const sources=caseOf('sources');
 const sourced=await replayWorld(sources.bundle,sources.operations,{codec,hasher});
 if(!sourced.ok)throw new Error(sourced.error.message);
 // The terms the package declares are not rewritten by the replay, and the component value names its own dataset.
 expect(sourced.value.terms).toEqual(sources.bundle.terms);
 expect(sourced.value.state.components['org.synthetic.landuse']!['parcela-1']).toEqual({source:'synthetic-terrain-v1',use:'parkland',observedAt:'2026-01-01T00:00:00Z'});

 const profiles=caseOf('profiles');
 const shared=await replayWorld(profiles.bundle,profiles.operations,{codec,hasher});
 if(!shared.ok)throw new Error(shared.error.message);
 expect(profiles.bundle.definition.profiles).toEqual(['city','explorer','transit']);
 // A namespace this client has no rules for arrives and leaves unchanged (§2.3).
 expect(shared.value.state.components['transit.schedule']!['linha-1']).toEqual({headwaySeconds:600,realtime:'not-included'});
 expect(shared.value.state.components['entity.index']!['linha-1']).toEqual({kind:'entity',name:'Ponto sintético',source:{dataset:'synthetic-terrain-v1',revision:'2026-01-01'}});
 expect(shared.value.state.components['city.zoning']).toBeUndefined();
 expect(shared.value.state.chunks['9:9']!.edits['99']).toEqual({terrain:'land',building:'residential',stage:0,origin:'player'});
});

test('a package with no accepted operations reproduces its own addresses, byte for byte',async()=>{
 for(const entry of conformance.cases){
  const replayed=await replayWorld(entry.bundle,[],{codec,hasher});
  if(!replayed.ok)throw new Error(`${entry.name}: ${replayed.error.message}`);
  expect(replayed.value.head,entry.name).toEqual(entry.bundle.head);
  expect(replayed.value.stateRef,entry.name).toEqual(stateObjectOf(entry.bundle));
 }
});

test('a package whose bytes do not match its addresses is refused before it is replayed',async()=>{
 const entry=caseOf('sources');
 const tampered:WorldBundle={...entry.bundle,objects:entry.bundle.objects.map(object=>{
  if(object.value===null||typeof object.value!=='object'||Array.isArray(object.value)||object.value['kind']!=='city-state')return object;
  const state=object.value['state'] as {money:number};
  return {...object,value:{...object.value,state:{...state,money:state.money+1}}};
 })};
 expect(await replayWorld(tampered,[],{codec,hasher})).toMatchObject({ok:false,error:{code:'HASH_MISMATCH'}});
 const stateRef=stateObjectOf(entry.bundle)!;
 const withoutState:WorldBundle={...entry.bundle,objects:entry.bundle.objects.filter(object=>object.ref.hash!==stateRef.hash)};
 expect(await replayWorld(withoutState,entry.operations,{codec,hasher})).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 const partial:WorldBundle={...entry.bundle,objects:[],completeness:{complete:false,missing:[entry.expected.stateRef]}};
 expect(await replayWorld(partial,entry.operations,{codec,hasher})).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 expect(await replayWorld({...entry.bundle,definition:{...entry.bundle.definition,rules:{family:'explorer',version:1}}},[],{codec,hasher})).toMatchObject({ok:false,error:{code:'WORLD_PROTOCOL_UNSUPPORTED'}});
});

test('the replay refuses what it cannot reproduce instead of guessing',async()=>{
 const entry=caseOf('sources');
 const first=entry.operations[0]!;
 if(first.kind!=='command')throw new Error('A fixture mudou de forma');
 // A mark that does not carry the digest it says it carries, and a digest that does not match the operation's bytes.
 expect(await replayWorld(entry.bundle,[{...first,mark:`p.1.${first.mark.split('.')[2]!.split('@')[0]}@${'a'.repeat(64)}`}],{codec,hasher}))
  .toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const otherTool={...first,command:{...first.command,action:{type:'build' as const,tool:'park' as const,cells:[{x:289,y:289}]}}};
 expect(await replayWorld(entry.bundle,[otherTool],{codec,hasher})).toMatchObject({ok:false,error:{code:'HASH_MISMATCH'}});
 expect(await replayWorld(entry.bundle,[{...first,kind:'teleport'} as unknown as AcceptedOperation],{codec,hasher}))
  .toMatchObject({ok:false,error:{code:'MALFORMED'}});
 // A stale command and a command for another world are refused even when their digest is honest: the digest proves
 // who wrote the operation, never that it still applies here.
 const stale={...first,command:{...first.command,expectedRevision:99}};
 expect(await replayWorld(entry.bundle,[await resealed(stale)],{codec,hasher})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 const elsewhere={...first,command:{...first.command,worldId:'outro-mundo'}};
 expect(await replayWorld(entry.bundle,[await resealed(elsewhere)],{codec,hasher})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 const many=Array.from({length:257},()=>first);
 expect(await replayWorld(entry.bundle,many,{codec,hasher})).toMatchObject({ok:false,error:{code:'LIMIT'}});
});

// The same operation with its digest recomputed, so a test can exercise a command whose digest is honest: the digest
// proves who wrote the operation, never that it still applies here.
async function resealed(operation:Extract<AcceptedOperation,{kind:'command'}>):Promise<AcceptedOperation>{
 const digest=(await hasher.ref(codec.encode({kind:'accepted-command',command:operation.command as unknown as JsonValue}))).hash;
 return {...operation,digest,mark:`p.1.${operation.mark.split('.')[2]!.split('@')[0]}@${digest}`};
}

test('a mark that arrives twice is answered, not applied twice',async()=>{
 const entry=caseOf('profiles');
 const once=await replayWorld(entry.bundle,entry.operations,{codec,hasher});
 const twice=await replayWorld(entry.bundle,[...entry.operations,entry.operations[0]!],{codec,hasher});
 if(!once.ok||!twice.ok)throw new Error('replay recusado');
 expect(twice.value.stateRef).toEqual(once.value.stateRef);
 expect(twice.value.head).toEqual(once.value.head);
 expect(twice.value.duplicates).toEqual([entry.operations[0]!.mark]);
 expect(twice.value.ledger).toEqual(once.value.ledger);
 expect(twice.value.receipts).toEqual(once.value.receipts);
});

test('the same package gives the same canonical bytes and the same hash in Node and in the browser',async()=>{
 // Node: the CLI reads the fixture from disk and reports what the replay addressed.
 const node=await replayFixture(conformance,{codec,hasher,hashText:sha256Hex});
 if(!node.ok)throw new Error(node.error.message);
 expect(node.value.protocol).toBe('osim/0.1');
 // Browser: the page fetches the very same fixture and runs the same replay in a DOM, with the fetch and the DOM
 // stubbed here so the harness itself is the browser path (tests/browser/world-replay.ts is served to real browsers).
 vi.stubGlobal('fetch',async(url:string)=>{
  // The page fetches from the server root; the repository root is both, and the jsdom environment gives `import.meta.url`
  // an http URL, so the stub resolves against the working directory instead.
  const text=readFileSync(join(process.cwd(),url.replace(/^\//,'')),'utf8');
  return {ok:true,status:200,text:async()=>text,json:async()=>JSON.parse(text) as unknown};
 });
 document.body.innerHTML='<pre id="resultado">executando…</pre><pre id="erro"></pre>';
 // The harness is the page script itself: a static import would run it once, before the fetch stub and the DOM exist,
 // and a page that only runs inside a real document is the path this test exists to exercise.
 await import('./browser/world-replay');
 const output=document.getElementById('resultado')?.textContent??'';
 expect(document.getElementById('erro')?.textContent).toBe('');
 const parsed:unknown=JSON.parse(output);
 if(!isReport(parsed))throw new Error(`A página não devolveu um relatório de replay: ${output.slice(0,200)}`);
 const browser=parsed;
 expect('__osimReplay' in window).toBe(true);
 expect(browser.cases.length).toBe(conformance.cases.length);
 for(const [index,entry] of conformance.cases.entries()){
  const nodeCase=node.value.cases[index]!,browserCase=browser.cases[index]!;
  expect(browserCase.name,entry.name).toBe(entry.name);
  expect(browserCase.stateRef,entry.name).toEqual(nodeCase.stateRef);
  expect(browserCase.semanticHash,entry.name).toBe(nodeCase.semanticHash);
  expect(browserCase.semanticText,entry.name).toBe(nodeCase.semanticText);
  expect(browserCase.stateRef,entry.name).toEqual(entry.expected.stateRef);
  expect(browserCase.semanticHash,entry.name).toBe(entry.expected.semanticHash);
 }
});

function isReport(value:unknown):value is ReplayReport{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 if(!('protocol' in value)||value.protocol!=='osim/0.1')return false;
 if(!('cases' in value)||!Array.isArray(value.cases))return false;
 return value.cases.every(entry=>!!entry&&typeof entry==='object'&&'name' in entry&&'stateRef' in entry&&'semanticHash' in entry&&'semanticText' in entry);
}

test('a broken case is reported with the case that broke, not as a generic failure',async()=>{
 const entry=caseOf('sources');
 const broken=await replayFixture({cases:[{...entry,operations:[{...entry.operations[0]!,kind:'teleport'} as unknown as AcceptedOperation]}]},{codec,hasher,hashText:sha256Hex});
 expect(broken).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 if(broken.ok)return;
 expect(broken.error.message).toMatch(/^sources: /);
 expect(await replayFixture({cases:[]},{codec,hasher,hashText:sha256Hex})).toMatchObject({ok:true,value:{protocol:'osim/0.1',cases:[]}});
});

// A published example has to say what it is and what it is not: licence, limits and a note per case. Without this the
// fixture would be a pile of bytes somebody found in the repository.
test('the fixture declares its licence and its limits like any other published example',()=>{
 expect(conformance.license).toBe('CC0-1.0');
 expect(conformance.protocol).toBe('osim/0.1');
 expect(conformance.limitations.length).toBeGreaterThanOrEqual(3);
 expect(conformance.note).toMatch(/sintétic/i);
 for(const entry of conformance.cases)expect(entry.note.length,entry.name).toBeGreaterThan(20);
});

// --- published schemas ------------------------------------------------------------------------------------------
type Schema={type?:string|string[];required?:string[];properties?:Record<string,Schema>;additionalProperties?:boolean|Schema;enum?:unknown[];const?:unknown;items?:Schema;oneOf?:Schema[];pattern?:string;minLength?:number;minimum?:number;$ref?:string;$defs?:Record<string,Schema>};
const schemaDir=join(process.cwd(),'schemas/world-v2');
const loaded=new Map<string,Schema>();
function schema(name:string):Schema{
 const found=loaded.get(name);
 if(found)return found;
 const parsed:unknown=JSON.parse(readFileSync(join(schemaDir,name),'utf8'));
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error(`Esquema inválido: ${name}`);
 loaded.set(name,parsed as Schema);
 return parsed as Schema;
}
// A reference is resolved against the file it was written in: `#/$defs/x` stays inside the document, and
// `other.schema.json` or `other.schema.json#/$defs/x` moves to that published schema.
function resolveRef(reference:string,file:string):Schema{
 const [name,fragment]=reference.split('#');
 const root=name?schema(name):schema(file);
 if(!fragment)return root;
 const found=root.$defs?.[fragment.replace('/$defs/','')];
 if(!found)throw new Error(`Referência não resolvida: ${reference} em ${file}`);
 return found;
}
// A deliberately small validator: the schemas only use the keywords below, and a test that used a full JSON Schema
// engine would be testing the engine. What it must catch is a published schema drifting from what the client emits.
function problemsWith(value:unknown,schema:Schema,path:string,file:string):string[]{
 const rule=schema.$ref?resolveRef(schema.$ref,file):schema;
 if(rule.oneOf){
  const matched=rule.oneOf.filter(branch=>problemsWith(value,branch,path,file).length===0);
  return matched.length===1?[]:[`${path}: ${matched.length} ramos de oneOf casaram`];
 }
 const problems:string[]=[];
 const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
 if(rule.type){
  const expected=Array.isArray(rule.type)?rule.type:[rule.type];
  const matches=expected.includes(kind)||(kind==='number'&&expected.includes('integer')&&Number.isInteger(value));
  if(!matches)problems.push(`${path}: ${kind} não é ${expected.join('|')}`);
 }
 if(rule.enum&&!rule.enum.includes(value))problems.push(`${path}: valor fora do enum`);
 if('const' in rule&&!Object.is(value,rule.const))problems.push(`${path}: valor diferente de const`);
 if(typeof value==='string'){
  if(rule.pattern&&!new RegExp(rule.pattern).test(value))problems.push(`${path}: não casa ${rule.pattern}`);
  if(rule.minLength!==undefined&&value.length<rule.minLength)problems.push(`${path}: curto demais`);
 }
 if(typeof value==='number'&&rule.minimum!==undefined&&value<rule.minimum)problems.push(`${path}: abaixo do mínimo`);
 if(kind==='array'&&rule.items)for(const [index,item] of (value as unknown[]).entries())problems.push(...problemsWith(item,rule.items,`${path}[${index}]`,file));
 if(kind==='object'){
  const record=value as Record<string,unknown>;
  for(const key of rule.required??[])if(!(key in record))problems.push(`${path}: falta ${key}`);
  for(const [key,item] of Object.entries(record)){
   const property=rule.properties?.[key];
   if(property)problems.push(...problemsWith(item,property,`${path}.${key}`,file));
   else if(rule.additionalProperties===false)problems.push(`${path}: campo não declarado ${key}`);
   else if(typeof rule.additionalProperties==='object')problems.push(...problemsWith(item,rule.additionalProperties,`${path}.${key}`,file));
  }
 }
 return problems;
}
const conformsTo=(name:string,value:unknown):void=>expect(problemsWith(value,schema(name),name,name)).toEqual([]);

test('the published schemas describe the objects this client emits',async()=>{
 const kernel=createKernel({state:undefined});
 const entity=await kernel.publish(envelopeOf('entity','osim:entity:house-42',ACTOR,{components:{'city.zoning':{zone:'residential'}}}));
 expect(entity.ok).toBe(true);
 conformsTo('envelope.schema.json',envelopeOf('event','osim:event:1',ACTOR,{}));
 conformsTo('entity.schema.json',envelopeOf('entity','osim:entity:house-42',ACTOR,{components:{'city.zoning':{zone:'residential'}}}));
 conformsTo('event.schema.json',envelopeOf('event','osim:event:1',ACTOR,{entity:'osim:entity:house-42',component:'city.zoning',op:'set',value:{zone:'residential'},timeline:'osim:timeline:earth-main',time:'2026-09-29T22:00:00Z'}));
 const scope:SessionScope={worldId:'victoria',branchId:'main',sessionId:'obra-1',epoch:1};
 conformsTo('session.schema.json',sessionDescriptor(scope,{actor:ACTOR,space:'osim:space:earth',participants:[ACTOR],mode:'realtime',startedAt:'2026-09-29T22:00:00Z'}));
 conformsTo('capability.schema.json',{type:'capability',issuer:ACTOR,subject:'did:key:guest',entity:'osim:entity:house-42',component:'city.zoning',actions:['set','merge']});
 const entry=caseOf('profiles');
 for(const object of entry.bundle.objects)conformsTo('snapshot.schema.json',object.value);
 const link:WorldLink={kind:'world-link',version:1,id:'urn:opensim:link:victoria',world:{worldId:'victoria',branchId:'main'},target:{kind:'commit',commit:entry.expected.stateRef},arrival:{kind:'view',uri:'osim://earth/ca/bc/victoria'},capabilities:[],actor:ACTOR,sources:[{copy:'relay',transport:'nostr'}]};
 expect(checkWorldLink(link)).toMatchObject({ok:true});
 conformsTo('world-link.schema.json',link);
 const info:PublicWorldInfo={id:'urn:opensim:card:victoria',world:link.world,title:'Victoria sintética',view:'osim://earth/ca/bc/victoria',actor:ACTOR,link,terms:entry.bundle.terms,capabilities:[]};
 conformsTo('world-card.schema.json',createWorldCard(info));
 // The envelope the kernel accepts is the envelope the schema describes, so a refusal cannot come from a schema that
 // describes something else.
 expect(checkEnvelope({osim:'0.1',type:'event',id:'osim:event:1',actor:ACTOR,body:{}})).toMatchObject({ok:true});
 expect(problemsWith({osim:'0.1',type:'event',id:'osim:event:1',actor:ACTOR,body:{},extra:1},schema('envelope.schema.json'),'envelope','envelope.schema.json')).not.toEqual([]);
});

test('the published city-state schema accepts both legacy and current rules, and const really means const',async()=>{
 // The frozen conformance vectors are rules v1, while a world exported by the current city client is rules v3.
 // Both are legitimate inputs; no other rules version is.
 const cells=Array.from({length:1024},()=>({terrain:'land' as const}));
 const state=createGame('current-schema',1,{id:'0:0',source:'synthetic',normalizerVersion:1,cells});
 const portable=await importLegacy({version:1,state,view:{x:0,y:0,zoom:1,speed:1,place:'Teste'}},hasher,codec);
 if(!portable.ok)throw new Error(portable.error.message);
 const current=portable.value.objects.find(object=>object.value&&typeof object.value==='object'&&!Array.isArray(object.value)&&object.value['kind']==='city-state');
 if(!current)throw new Error('Objeto city-state atual ausente');
 conformsTo('snapshot.schema.json',current.value);
 const snapshot=schema('snapshot.schema.json');
 expect(problemsWith({...portable.value.envelope,worldProtocol:999},schema('envelope.schema.json'),'envelope','envelope.schema.json')).not.toEqual([]);
 // The explicit enum is the compatibility promise: v2 never existed in this game, and future rules are not guessed.
 const bad={...(current.value as Record<string,unknown>),state:{...((current.value as Record<string,unknown>).state as Record<string,unknown>),rulesVersion:2}};
 expect(problemsWith(bad,snapshot,'snapshot','snapshot.schema.json')).not.toEqual([]);
});

test('a checkpoint from the repository satisfies the replay checkpoint shape',async()=>{
 const entry=caseOf('sources');
 const worlds=createWorldRepository({storage:createWorldMemoryStorage(),codec,hasher});
 const opened=await worlds.create(entry.bundle);
 if(!opened.ok)throw new Error(opened.error.message);
 const checkpoint=await worlds.checkout(opened.value);
 if(!checkpoint.ok)throw new Error(checkpoint.error.message);
 // The assignment below is the proof and the compiler runs it: the session layer's `Checkpoint` fills the world layer's
 // shape with no conversion and without `world` importing `session`. Only the replay's own accounting is extra.
 const asReplay:Omit<ReplayCheckpoint,'ledger'|'receipts'|'duplicates'>=checkpoint.value;
 // And the two descriptions of the same version agree, bases included — the repository computes them from the state,
 // the replay computes them from the state it read, and both address the same frozen regions.
 const replayed=await replayWorld(entry.bundle,[],{codec,hasher});
 if(!replayed.ok)throw new Error(replayed.error.message);
 expect(replayed.value.head).toEqual(asReplay.head);
 expect(replayed.value.stateRef).toEqual(asReplay.stateRef);
 expect(replayed.value.state).toEqual(asReplay.state);
 expect(replayed.value.bases).toEqual(asReplay.bases);
 expect(replayed.value.definition.profiles).toEqual(entry.bundle.definition.profiles);
});
