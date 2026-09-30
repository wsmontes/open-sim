// Layer composition and scenario comparison (plan Task 14, spec §4 and §12). The two futures below share one frozen
// ground — the same commit, the same base hashes — and differ only in the project a player decided, so a comparison
// that answers "what changed" is answering about the simulation and not about two copies of a guess.
import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {applyCommand,createGame} from '../src/core/commands';
import {coordAt} from '../src/core/coordinates';
import type {BaseChunk,Command,GameState,Tool,ViewState} from '../src/core/model';
import type {ExtensionDeclaration} from '../src/core/protocol';
import {durableJson} from '../src/core/protocol';
import {importLegacy} from '../src/session/world-bundle';
import {createWorldRepository} from '../src/session/world-repository';
import type {Checkpoint,WorldRepository} from '../src/session/world-repository';
import type {CellField,ChangeField} from '../src/world/changes';
import {compareScenarios,composeWorld,layerWrites,runScenario} from '../src/world/composition';
import type {Composition,LayerContract,LayerEffect,ResolvedObjects,ScenarioInput,ScenarioRun} from '../src/world/composition';
import {createKernel} from '../src/world/kernel';
import type {JsonValue,ObjectRef,WorldError,WorldResult} from '../src/world/model';
import {checkCoreComponent} from '../src/world/osim';
import {describeScenarios} from '../src/presentation/world-composition';
import {command} from './fixtures/world';
import fixtureA from './fixtures/federated-world/base-a.json';

const codec=createJcsCodec(),hasher=bytesHasher();
const WORLD_ID='victoria',REGION='48557:74362',ACTOR='did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
const VIEW:ViewState={x:0,y:0,zoom:1,speed:0,place:'Victoria'};
const mapA=fixtureA as BaseChunk;
// One block of the fixture region: two streets, a house, the plant that pays for the growth, and the cell where the
// two projects disagree. The bases themselves are not touched by either project.
const BLOCK={street:165,street2:166,house:197,target:198,plant:199};
const CELL={street:coordAt(REGION,BLOCK.street),street2:coordAt(REGION,BLOCK.street2),house:coordAt(REGION,BLOCK.house),target:coordAt(REGION,BLOCK.target),plant:coordAt(REGION,BLOCK.plant)};
// Fields are named one by one against the place they belong to, so a write and its declaration cannot drift apart.
const fieldWrites=(index:number,...fields:readonly CellField[]):ChangeField[]=>fields.map(field=>({scope:'cell',at:{chunkId:REGION,index,x:coordAt(REGION,index).x,y:coordAt(REGION,index).y},field}));
const PROJECT_WRITES:readonly ChangeField[]=[
 {scope:'world',field:'money'},
 ...fieldWrites(BLOCK.street,'road','origin'),
 ...fieldWrites(BLOCK.street2,'road','origin'),
 ...fieldWrites(BLOCK.house,'building','stage','origin'),
 ...fieldWrites(BLOCK.target,'building','stage','origin'),
 ...fieldWrites(BLOCK.plant,'building','stage','origin'),
];
// `scenario.visual` holds what only the screen shows; `x.experimental.rain` is a namespace of somebody else, carried
// with every field it has (protocol §2.3).
const EXTENSIONS:readonly ExtensionDeclaration[]=[{key:'scenario.visual',version:1,durable:false},{key:'x.experimental.rain',version:1,durable:true}];
const INTERVAL={fromTick:0,toTick:60};
const INPUTS:readonly ScenarioInput[]=[{id:'chuva-2026-09-29T20:00Z',atTick:10,kind:'observed',payload:{mm:12.5,unit:'mm'}}];

const built=(state:GameState,action:Command['action']):GameState=>{
 const applied=applyCommand(state,command(state,action),[]);
 expect(applied.status).toBe('applied');
 return applied.state;
};
// The one block both scenarios start from, plus the tool they disagree on.
const block=(base:GameState,tool:Tool):GameState=>{
 let state=built(base,{type:'build',tool:'road',cells:[CELL.street,CELL.street2]});
 state=built(state,{type:'build',tool:'residential',cells:[CELL.house]});
 state=built(state,{type:'build',tool:'power',cells:[CELL.plant]});
 return built(state,{type:'build',tool,cells:[CELL.target]});
};
// A layer state that carries component data and touches nothing else: what only the screen shows, or a namespace of
// somebody else that this client carries with every field it has (protocol §2.3).
const carried=(base:GameState,key:string,entity:string,value:JsonValue):GameState=>({...base,components:{...base.components,[key]:{...(base.components[key]??{}),[entity]:value}}});
// A layer is a commit of its own: the project a player or a scenario decided, pinned by the hash of what it produced.
type Layer={contract:LayerContract;commit:ObjectRef;state:GameState};
async function layerOf(worlds:WorldRepository,from:Checkpoint,branchId:string,state:GameState,contract:LayerContract):Promise<Layer>{
 const forked=await worlds.fork(from.head,{worldId:from.head.worldId,branchId});
 if(!forked.ok)throw new Error(forked.error.message);
 const committed=await worlds.commit(forked.value,{id:`${branchId}-project`,state,operations:[],objects:[],author:'local-player'});
 if(!committed.ok)throw new Error(committed.error.message);
 return {contract,commit:committed.value.commit,state};
}
const contract=(id:string,effect:LayerEffect,writes:readonly ChangeField[],extra:Partial<LayerContract>={}):LayerContract=>({
 id,source:`scenario:${id}`,priority:10,effect,rules:{family:'city',version:1},
 reads:[],writes,dependsOn:[],areas:[REGION],capabilities:[],...extra,
});
type Blocks={worlds:WorldRepository;point:Checkpoint;ground:string;baseJson:string;parque:Layer;industria:Layer;chuva:Layer;transito:Layer;exotica:Layer;nuvem:Layer};
let cached:Promise<Blocks>|null=null;
async function build():Promise<Blocks>{
 const worlds=createWorldRepository({storage:createWorldMemoryStorage({}),codec,hasher});
 const base=createGame(WORLD_ID,1,mapA);
 const bundle=await importLegacy({version:1,state:base,view:VIEW},hasher,codec);
 if(!bundle.ok)throw new Error(bundle.error.message);
 const created=await worlds.create(bundle.value);
 if(!created.ok)throw new Error(created.error.message);
 const checked=await worlds.checkout(created.value);
 if(!checked.ok)throw new Error(checked.error.message);
 const point=checked.value;
 return {
  worlds,point,
  ground:durableJson(point.state,EXTENSIONS),
  baseJson:JSON.stringify(point.state),
  parque:await layerOf(worlds,point,'parque',block(base,'park'),contract('parque','durable',PROJECT_WRITES)),
  industria:await layerOf(worlds,point,'industria',block(base,'industrial'),contract('industria','durable',PROJECT_WRITES)),
  chuva:await layerOf(worlds,point,'chuva-visual',carried(base,'scenario.visual','chuva',{mm:12.5}),contract('chuva-visual','visual',[{scope:'component',key:'scenario.visual',entity:'chuva'}],{priority:10})),
  transito:await layerOf(worlds,point,'transito-visual',carried(base,'scenario.visual','transito',{level:'alto'}),contract('transito-visual','visual',[{scope:'component',key:'scenario.visual',entity:'transito'}],{priority:10})),
  exotica:await layerOf(worlds,point,'chuva-experimental',carried(base,'x.experimental.rain','chuva',{mm:12.5,'x.wagner.experimentalPrecision':'0.1'}),contract('chuva-experimental','durable',[{scope:'component',key:'x.experimental.rain',entity:'chuva'}])),
  // A layer that writes a namespace this composition never declared is refused before anything is applied.
  nuvem:await layerOf(worlds,point,'nuvem-visual',carried(base,'scenario.outro','nuvem',{cover:'alta'}),contract('nuvem-visual','visual',[{scope:'component',key:'scenario.outro',entity:'nuvem'}])),
 };
}
const fixture=():Promise<Blocks>=>{cached??=build();return cached;};
const resolved=(blocks:Blocks,...layers:readonly Layer[]):ResolvedObjects=>{
 const states:Record<string,GameState>={[blocks.point.head.commit.hash]:blocks.point.state};
 for(const layer of layers)states[layer.commit.hash]=layer.state;
 return {states};
};
const compositionOf=(blocks:Blocks,layers:readonly Layer[],overrides:Partial<Composition>={}):Composition=>({
 worldId:WORLD_ID,branchId:'main',actor:ACTOR,rules:{family:'city',version:1},
 base:{commit:blocks.point.head.commit,identity:blocks.ground,bases:blocks.point.bases},
 layers:layers.map(layer=>({contract:layer.contract,commit:layer.commit})),
 parameters:{},
 temporal:{timeline:'osim:timeline:cenario',parent:'osim:timeline:earth-main',forkAt:'2026-09-29T20:00:00Z',rate:1},
 extensions:EXTENSIONS,
 ...overrides,
});
const valueOf=<T>(result:WorldResult<T>):T=>{
 if(!result.ok)throw new Error(result.error.message);
 return result.value;
};
// The refusal of a call, so a test can assert on the code and the sentence without a cast.
const refusal=(result:WorldResult<unknown>):WorldError=>{
 expect(result.ok).toBe(false);
 return result.ok?{code:'MALFORMED',message:'esperava uma recusa'}:result.error;
};

test('a layer whose dependency is absent is refused, and a cycle of layers is refused as well',async()=>{
 const blocks=await fixture();
 const orphan={...blocks.parque,contract:{...blocks.parque.contract,dependsOn:['chuva']}};
 const missing=refusal(composeWorld(compositionOf(blocks,[orphan]),resolved(blocks,orphan)));
 expect(missing.code).toBe('MISSING_OBJECT');
 expect(missing.message).toContain('chuva');
 const a={...blocks.parque,contract:{...blocks.parque.contract,id:'a',dependsOn:['b']}};
 const b={...blocks.industria,contract:{...blocks.industria.contract,id:'b',dependsOn:['a']}};
 const cycle=refusal(composeWorld(compositionOf(blocks,[a,b]),resolved(blocks,a,b)));
 expect(cycle.code).toBe('CONFLICT');
 expect(cycle.message).toContain('Dependência cíclica');
});

test('two durable layers writing the same field are a conflict, even when they wrote the same value',async()=>{
 const blocks=await fixture();
 const different=refusal(composeWorld(compositionOf(blocks,[blocks.parque,blocks.industria]),resolved(blocks,blocks.parque,blocks.industria)));
 expect(different.code).toBe('CONFLICT');
 expect(different.message).toContain('parque');
 expect(different.message).toContain('industria');
 // The message groups the disputed fields by site, so the cell the two projects disagree on is named once.
 expect(different.message).toContain(`cell:${REGION}#${BLOCK.target} (building, stage, origin)`);
 // The same project twice is still two layers writing one field: there is no silent "last layer wins" (spec §4).
 const twin={...blocks.parque,contract:{...blocks.parque.contract,id:'parque-2'}};
 const equal=refusal(composeWorld(compositionOf(blocks,[blocks.parque,twin]),resolved(blocks,blocks.parque,twin)));
 expect(equal.code).toBe('CONFLICT');
 expect(equal.message).toContain('parque-2');
});

test('a layer that writes a field it did not declare, or outside its declared areas, is refused',async()=>{
 const blocks=await fixture();
 const undeclared={...blocks.parque,contract:{...blocks.parque.contract,writes:blocks.parque.contract.writes.filter(write=>!(write.scope==='cell'&&write.at.index===BLOCK.target&&write.field==='building'))}};
 const missing=refusal(composeWorld(compositionOf(blocks,[undeclared]),resolved(blocks,undeclared)));
 expect(missing.code).toBe('CONFLICT');
 expect(missing.message).toContain(`cell:${REGION}#${BLOCK.target}:building`);
 const narrow={...blocks.parque,contract:{...blocks.parque.contract,areas:['0:0']}};
 const outside=refusal(composeWorld(compositionOf(blocks,[narrow]),resolved(blocks,narrow)));
 expect(outside.code).toBe('CONFLICT');
 expect(outside.message).toContain('fora das áreas');
});

test('a visual layer may not write durable state, a durable layer may not write an ephemeral namespace, and neither may write a namespace the composition never declared',async()=>{
 const blocks=await fixture();
 const visual:Layer={...blocks.parque,contract:{...blocks.parque.contract,effect:'visual'}};
 const wrote=refusal(composeWorld(compositionOf(blocks,[visual]),resolved(blocks,visual)));
 expect(wrote.code).toBe('CONFLICT');
 expect(wrote.message).toContain('visual');
 const durable:Layer={...blocks.chuva,contract:{...blocks.chuva.contract,effect:'durable'}};
 const ephemeral=refusal(composeWorld(compositionOf(blocks,[durable]),resolved(blocks,durable)));
 expect(ephemeral.code).toBe('CONFLICT');
 expect(ephemeral.message).toContain('efêmero');
 const undeclared=refusal(composeWorld(compositionOf(blocks,[blocks.nuvem]),resolved(blocks,blocks.nuvem)));
 expect(undeclared.code).toBe('MALFORMED');
 expect(undeclared.message).toContain('scenario.outro');
});

test('a layer authored for another version of the rules is refused instead of composed',async()=>{
 const blocks=await fixture();
 const v2={...blocks.parque,contract:{...blocks.parque.contract,rules:{family:'city',version:2}}};
 const refused=refusal(composeWorld(compositionOf(blocks,[v2]),resolved(blocks,v2)));
 expect(refused.code).toBe('CONFLICT');
 expect(refused.message).toContain('v2');
});

test('a composition whose ground is not the state it pinned is refused, and so is a layer nobody resolved',async()=>{
 const blocks=await fixture();
 const other=compositionOf(blocks,[],{base:{commit:blocks.point.head.commit,identity:'outra identidade',bases:blocks.point.bases}});
 const mismatch=refusal(composeWorld(other,resolved(blocks)));
 expect(mismatch.code).toBe('CONFLICT');
 const absent=refusal(composeWorld(compositionOf(blocks,[blocks.parque]),resolved(blocks)));
 expect(absent.code).toBe('NOT_FOUND');
 expect(absent.message).toContain('parque');
});

test('swapping the visible order of two layers changes what is on screen and never the durable result',async()=>{
 const blocks=await fixture();
 const first=valueOf(composeWorld(compositionOf(blocks,[blocks.chuva,blocks.transito]),resolved(blocks,blocks.chuva,blocks.transito)));
 const second=valueOf(composeWorld(compositionOf(blocks,[blocks.transito,blocks.chuva]),resolved(blocks,blocks.transito,blocks.chuva)));
 expect(first.visual).toEqual(['chuva-visual','transito-visual']);
 expect(second.visual).toEqual(['transito-visual','chuva-visual']);
 expect(second.identity).toBe(first.identity);
 expect(durableJson(second.state,EXTENSIONS)).toBe(durableJson(first.state,EXTENSIONS));
 expect(second.state.components['scenario.visual']).toEqual(first.state.components['scenario.visual']);
 // Nothing durable was applied at all: the order decides what is visible and nothing else.
 expect(first.applied).toEqual([]);
 expect(first.identity).toBe(blocks.ground);
});

test('a visual layer stands outside the durable identity of the world',async()=>{
 const blocks=await fixture();
 const plain=valueOf(composeWorld(compositionOf(blocks,[]),resolved(blocks)));
 const visible=valueOf(composeWorld(compositionOf(blocks,[blocks.chuva]),resolved(blocks,blocks.chuva)));
 expect(visible.identity).toBe(plain.identity);
 expect(visible.identity).toBe(blocks.ground);
 expect(visible.state.components['scenario.visual']).toEqual({chuva:{mm:12.5}});
 // The declaration is what keeps it out: without it the same state would be another durable identity.
 expect(durableJson(visible.state)).not.toBe(durableJson(plain.state));
 // A commit that carries only visible data does not move the world's semantic identity either.
 expect(durableJson(blocks.chuva.state,EXTENSIONS)).toBe(blocks.ground);
});

test('a component this client does not implement crosses the composition intact',async()=>{
 const blocks=await fixture();
 const composed=valueOf(composeWorld(compositionOf(blocks,[blocks.exotica]),resolved(blocks,blocks.exotica)));
 expect(composed.state.components['x.experimental.rain']).toEqual({chuva:{mm:12.5,'x.wagner.experimentalPrecision':'0.1'}});
 expect(composed.identity).not.toBe(blocks.ground);
 expect(composed.applied).toEqual(['chuva-experimental']);
});

test('every layer is an entity carrying osim.layer and every scenario is a derived timeline',async()=>{
 const blocks=await fixture();
 const composed=valueOf(composeWorld(compositionOf(blocks,[blocks.parque,blocks.chuva]),resolved(blocks,blocks.parque,blocks.chuva)));
 expect(composed.layers.map(layer=>layer.uri)).toEqual(['osim:entity:parque','osim:entity:chuva-visual']);
 const kernel=createKernel();
 for(const layer of composed.layers){
  const published=await kernel.publish(layer.envelope);
  expect(published.ok).toBe(true);
  const restored=kernel.resolve(layer.uri);
  const entity=restored.ok?restored.value:null;
  expect(entity?.components?.['osim.layer']).toMatchObject({source:layer.contract.source,priority:layer.contract.priority,effect:layer.contract.effect});
  const checked=checkCoreComponent('osim.layer',entity?.components?.['osim.layer']);
  expect(checked.ok).toBe(true);
  expect(checked.ok?checked.value['commit']:null).toBe(`sha256:${layer.commit.hash}`);
 }
 const timeline=await kernel.publish(composed.timeline);
 expect(timeline.ok).toBe(true);
 const stored=kernel.resolve(composed.timeline.id);
 expect(stored.ok?stored.value?.body:null).toMatchObject({clock:'utc',parent:'osim:timeline:earth-main',forkAt:'2026-09-29T20:00:00Z',rate:1});
});

// The acceptance case: one ground, two projects, the same interval and the same declared inputs.
async function futures():Promise<{blocks:Blocks;parque:ScenarioRun;industria:ScenarioRun}>{
 const blocks=await fixture();
 const request=(id:string,premise:string)=>({id,interval:INTERVAL,inputs:INPUTS,premises:[premise]});
 return {
  blocks,
  parque:valueOf(runScenario(compositionOf(blocks,[blocks.parque]),resolved(blocks,blocks.parque),request('parque','projeto de parque no bloco'))),
  industria:valueOf(runScenario(compositionOf(blocks,[blocks.industria]),resolved(blocks,blocks.industria),request('industria','projeto industrial no bloco'))),
 };
}

test('two projects on one ground share the base hashes and never share a balance',async()=>{
 const {blocks,parque,industria}=await futures();
 // The ground is shared by content: the same commit and the same frozen regions on both sides.
 expect(parque.composition.base.commit.hash).toBe(industria.composition.base.commit.hash);
 expect(parque.composition.base.bases).toEqual(industria.composition.base.bases);
 expect(parque.composition.base.identity).toBe(industria.composition.base.identity);
 expect(parque.composition.base.identity).toBe(blocks.ground);
 // The ledgers are not shared: each future paid for its own project and the ground was never written.
 expect(JSON.stringify(blocks.point.state)).toBe(blocks.baseJson);
 expect(parque.initial.state).not.toBe(industria.initial.state);
 expect(industria.initial.state.money).toBe(parque.initial.state.money-50);
 expect(parque.state).not.toBe(industria.state);
 expect(durableJson(parque.state,EXTENSIONS)).not.toBe(durableJson(industria.state,EXTENSIONS));
 expect(parque.indicators).toMatchObject({tick:60,population:4,jobs:0,happiness:65,energyUsed:2,money:19370,managed:1});
 expect(industria.indicators).toMatchObject({tick:60,population:4,jobs:10,happiness:50,energyUsed:4,money:19340,managed:1});
});

test('the comparison explains the divergence by the decisions, the premises and the indicators that moved',async()=>{
 const {parque,industria}=await futures();
 const comparison=compareScenarios(parque,industria);
 expect(comparison.comparable).toBe(true);
 expect(comparison.reasons).toEqual([]);
 expect(comparison.baseCommit).toBe(parque.composition.base.commit.hash);
 expect(comparison.baseIdentity).toBe(parque.composition.base.identity);
 expect(comparison.sharedBases).toHaveLength(1);
 expect(comparison.interval).toEqual(INTERVAL);
 expect(comparison.decisions).toEqual({a:['parque'],b:['industria']});
 expect(comparison.declared).toEqual([{side:'a',premise:'projeto de parque no bloco'},{side:'b',premise:'projeto industrial no bloco'}]);
 expect(comparison.parameters).toEqual([]);
 expect(comparison.indicators).toEqual([
  {key:'money',a:19370,b:19340,delta:-30},
  {key:'jobs',a:0,b:10,delta:10},
  {key:'energyUsed',a:2,b:4,delta:2},
  {key:'happiness',a:65,b:50,delta:-15},
  {key:'income',a:-20,b:-10,delta:10},
 ]);
});

test('the comparison refuses a different interval, undeclared premises and undeclared external inputs',async()=>{
 const {blocks,parque,industria}=await futures();
 const silent=valueOf(runScenario(compositionOf(blocks,[blocks.industria]),resolved(blocks,blocks.industria),{id:'industria-muda',interval:INTERVAL,inputs:INPUTS,premises:[]}));
 const undeclared=compareScenarios(parque,silent);
 expect(undeclared.comparable).toBe(false);
 expect(undeclared.reasons.join(' · ')).toContain('sem premissas declaradas');
 expect(undeclared.decisions).toEqual({a:['parque'],b:['industria']});
 expect(undeclared.declared).toEqual([{side:'a',premise:'projeto de parque no bloco'}]);
 const short=valueOf(runScenario(compositionOf(blocks,[blocks.parque]),resolved(blocks,blocks.parque),{id:'parque-curto',interval:{fromTick:0,toTick:30},inputs:INPUTS,premises:['projeto de parque no bloco']}));
 const intervals=compareScenarios(parque,short);
 expect(intervals.comparable).toBe(false);
 expect(intervals.interval).toBeNull();
 expect(intervals.reasons.join(' · ')).toContain('intervalos de ticks');
 expect(intervals.indicators).not.toEqual([]);
 const rain=valueOf(runScenario(compositionOf(blocks,[blocks.parque]),resolved(blocks,blocks.parque),{id:'parque-chuva',interval:INTERVAL,inputs:[{...INPUTS[0]!,id:'chuva-2026-09-30T20:00Z'}],premises:[]}));
 const inputs=compareScenarios(parque,rain);
 expect(inputs.comparable).toBe(false);
 expect(inputs.reasons.join(' · ')).toContain('entradas externas');
 const declared=compareScenarios(parque,{...rain,premises:['projeto de parque no bloco']});
 expect(declared.comparable).toBe(true);
 expect(declared.parameters).toEqual([]);
 // Parameters are declared hypotheses, so a difference is explained instead of refused.
 expect(compareScenarios(parque,{...rain,premises:['projeto de parque no bloco']}).reasons).toEqual([]);
});

test('the panel reads the same numbers the comparison explains',async()=>{
 const {parque,industria}=await futures();
 const info=describeScenarios(parque,industria,compareScenarios(parque,industria));
 expect(info.a?.id).toBe('parque');
 expect(info.b?.id).toBe('industria');
 expect(info.a?.decisions).toEqual(['parque']);
 expect(info.a?.premises).toEqual(['projeto de parque no bloco']);
 expect(info.a?.interval).toBe('tick 0 → 60');
 expect(info.a?.ground).toContain(parque.composition.base.commit.hash.slice(0,7));
 expect(info.a?.rows.find(row=>row.label==='Empregos')?.value).toBe('0');
 expect(info.b?.rows.find(row=>row.label==='Empregos')?.value).toBe('10');
 expect(info.comparison?.comparable).toBe(true);
 expect(info.comparison?.summary).toContain('Comparável');
 expect(info.comparison?.rows).toEqual([
  {label:'Saldo',a:'19.370',b:'19.340',delta:'-30',direction:'a'},
  {label:'Empregos',a:'0',b:'10',delta:'+10',direction:'b'},
  {label:'Energia usada',a:'2',b:'4',delta:'+2',direction:'b'},
  {label:'Felicidade',a:'65',b:'50',delta:'-15',direction:'a'},
  {label:'Renda por ciclo',a:'-20',b:'-10',delta:'+10',direction:'b'},
 ]);
 expect(info.comparison?.declared).toEqual(['parque: projeto de parque no bloco','industria: projeto industrial no bloco']);
});

test('the writes a project made are derived from the material, so a caller can declare them',async()=>{
 const blocks=await fixture();
 expect(valueOf(layerWrites(blocks.point.state,blocks.parque.state))).toEqual(PROJECT_WRITES);
 // A visual layer's material is component-only, which is exactly what keeps it outside the durable identity.
 expect(valueOf(layerWrites(blocks.point.state,blocks.transito.state))).toEqual([{scope:'component',key:'scenario.visual',entity:'transito'}]);
});
