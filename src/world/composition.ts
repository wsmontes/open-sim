// Composing versioned layers into one world, and comparing two futures of the same ground (spec §4 and §12; protocol
// §11 and §19). A composition fixes exact references — the ground it rests on, the commit of every layer, the rules,
// the parameters and the temporal frame — and this is where a disagreement is refused instead of silently resolved:
// the visual order of layers decides only what is visible, and two layers writing the same durable field are a
// conflict (spec §4: the order of the buttons never decides which city exists, so there is no "the last layer wins").
//
// Nothing here hashes and nothing reads a clock: the caller resolves the states and addresses them by content
// (`ResolvedObjects`), so one composition is reproducible in any runtime, and `durableJson` of the core is what says
// whether two compositions mean the same world — a layer that only shows something never moves that identity.
import {coordAt} from '../core/coordinates';
import type {Cell,GameState,ManagedChunk} from '../core/model';
import type {ExtensionDeclaration} from '../core/protocol';
import {assertJsonSafe,durableJson,isComponentKey,isEntityId} from '../core/protocol';
import {stepSimulation,summarize} from '../core/simulation';
import type {CellField,CellPlace,ChangeField} from './changes';
import {sameCell,sameJson} from './changes';
import type {JsonValue,ObjectRef,WorldError,WorldResult} from './model';
import {failed,isRef,ok,sameRef} from './model';
import type {OsimEnvelope} from './osim';
import {checkCoreComponent,entityUri,envelopeOf,parseOsimUri} from './osim';

// --- what a composition is made of (spec §4) --------------------------------------------------------------------
// A frozen region by identity alone. A `Checkpoint`'s `bases` satisfies this shape structurally, so the world layer
// never has to import the session that owns the repository.
export type FrozenBase={id:string;ref:ObjectRef};
// A layer either takes part in the simulation or only changes what is visible, and the declaration is what keeps a
// visual layer out of the durable identity of the world.
export type LayerEffect='visual'|'durable';
export type LayerContract={
 // The entity id this layer is published under, and the source it declares (`osim.layer`, protocol §19).
 id:string;
 source:string;
 // §19 `priority`: the visible order among visual layers. It never orders a durable write — the dependency graph does.
 priority:number;
 effect:LayerEffect;
 // Rules a layer was authored under. Another version may require an incompatible branch, not a visual filter.
 rules:{family:string;version:number};
 reads:readonly ChangeField[];
 writes:readonly ChangeField[];
 dependsOn:readonly string[];
 areas:readonly string[];
 capabilities:readonly string[];
};
export type CompositionLayer={contract:LayerContract;commit:ObjectRef};
// §11: a derived timeline names the frame it came from and the instant it forked.
export type TemporalPolicy={timeline:string;parent:string;forkAt:string;rate:number};
export type Composition={
 worldId:string;
 branchId:string;
 // The principal that publishes the layers (§48). A message without an actor with a scheme is not publishable.
 actor:string;
 rules:{family:string;version:number};
 // The ground: the commit both futures start from, the durable identity it resolved to, and the frozen regions.
 base:{commit:ObjectRef;identity:string;bases:readonly FrozenBase[]};
 layers:readonly CompositionLayer[];
 parameters:Record<string,JsonValue>;
 temporal:TemporalPolicy;
 extensions:readonly ExtensionDeclaration[];
};
// What the caller resolved for this composition: the state of every version it names, keyed by commit. Resolving a
// commit belongs to the repository (`checkout`) and to the kernel (`resolve`), so this layer only reads what it is
// given.
export type ResolvedObjects={states:Record<string,GameState>};
export type PublishedLayer={id:string;uri:string;commit:ObjectRef;contract:LayerContract;envelope:OsimEnvelope};
export type ComposedWorld={
 worldId:string;
 branchId:string;
 rules:{family:string;version:number};
 parameters:Record<string,JsonValue>;
 base:{commit:ObjectRef;identity:string;bases:readonly FrozenBase[]};
 layers:readonly PublishedLayer[];
 // Durable layers in the order their writes were applied (dependencies first), and the visible order of the rest.
 applied:readonly string[];
 visual:readonly string[];
 state:GameState;
 // `durableJson` of the composed state: the semantic identity the visual layers may not move.
 identity:string;
 timeline:OsimEnvelope;
};

type ResolvedLayer={contract:LayerContract;commit:ObjectRef;state:GameState;writes:readonly ChangeField[]};
const CELL_FIELDS:readonly CellField[]=['terrain','road','roadClass','building','stage','origin'];
// ISO-8601 instants as §13 states them, the same form the boundary validates (`src/world/osim.ts`).
const INSTANT=/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))$/;
const INDICATORS:readonly (keyof ScenarioIndicators)[]=['money','population','jobs','energySupply','energyUsed','happiness','income','managed','tick'];

function uriProblem(value:string,label:string):WorldError|null{
 try{parseOsimUri(value);return null;}catch{return {code:'MALFORMED',message:`${label} precisa ser um identificador com esquema`};}
}
// §4: our timeline URIs are ours to read, and anything else with a scheme belongs to another ecosystem and travels as
// it is. A local URI that is not a timeline is refused, because it is not a temporal frame (`osim:entity:x` is one).
function timelineProblem(value:string,label:string):WorldError|null{
 try{
  const parsed=parseOsimUri(value);
  return parsed.scheme==='osim'&&parsed.kind!=='timeline'?{code:'MALFORMED',message:`${label} precisa ser uma linha do tempo osim:timeline:…`}:null;
 }catch{return {code:'MALFORMED',message:`${label} precisa ser um identificador com esquema`};}
}
function temporalProblem(temporal:TemporalPolicy):WorldError|null{
 const timeline=timelineProblem(temporal.timeline,'A linha do tempo do cenário');
 if(timeline)return timeline;
 if(temporal.parent===temporal.timeline)return {code:'MALFORMED',message:'Uma linha do tempo derivada não pode ser o seu próprio quadro de origem'};
 const parent=timelineProblem(temporal.parent,'O quadro de origem da linha do tempo');
 if(parent)return parent;
 if(typeof temporal.forkAt!=='string'||!INSTANT.test(temporal.forkAt)||Number.isNaN(Date.parse(temporal.forkAt)))return {code:'MALFORMED',message:'O instante de derivação da linha do tempo não é um instante ISO-8601'};
 // §11: 0 is paused, and a negative rate would mean reverse simulation, which the protocol does not require.
 if(!Number.isFinite(temporal.rate)||temporal.rate<0)return {code:'MALFORMED',message:'A taxa da linha do tempo é inválida'};
 return null;
}
function shapeProblem(definition:Composition):WorldError|null{
 for(const [value,label] of [[definition.worldId,'Mundo'],[definition.branchId,'Ramificação']] as const){
  if(typeof value!=='string'||!value.length||value.length>80)return {code:'MALFORMED',message:`${label} inválido na composição`};
 }
 const actor=uriProblem(definition.actor,'O ator da composição');
 if(actor)return actor;
 if(!definition.rules.family.length||!Number.isSafeInteger(definition.rules.version)||definition.rules.version<1)return {code:'MALFORMED',message:'Regras inválidas na composição'};
 if(!isRef(definition.base.commit))return {code:'MALFORMED',message:'A base da composição não é endereçada por conteúdo'};
 if(!definition.base.bases.length)return {code:'MALFORMED',message:'A composição não fixa nenhuma base congelada'};
 for(const base of definition.base.bases)if(!base.id||!isRef(base.ref))return {code:'MALFORMED',message:`A composição fixa uma base inválida: ${base.id||'(sem região)'}`};
 const temporal=temporalProblem(definition.temporal);
 if(temporal)return temporal;
 try{assertJsonSafe(definition.parameters,'Parâmetros da composição');}catch(error){return {code:'MALFORMED',message:error instanceof Error?error.message:'Parâmetros da composição inválidos'};}
 const declared=new Set<string>();
 for(const extension of definition.extensions){
  if(!isComponentKey(extension.key))return {code:'MALFORMED',message:`Namespace inválido nas extensões da composição: ${extension.key}`};
  if(!Number.isSafeInteger(extension.version)||extension.version<1)return {code:'MALFORMED',message:`Versão inválida na extensão ${extension.key}`};
  if(declared.has(extension.key))return {code:'MALFORMED',message:`Namespace declarado duas vezes na composição: ${extension.key}`};
  declared.add(extension.key);
 }
 return null;
}
function contractProblem(definition:Composition,contract:LayerContract):WorldError|null{
 if(!isEntityId(contract.id))return {code:'MALFORMED',message:`Identificador de camada inválido: ${contract.id}`};
 if(!contract.source.length)return {code:'MALFORMED',message:`A camada ${contract.id} não declara a sua fonte`};
 if(!Number.isFinite(contract.priority))return {code:'MALFORMED',message:`A camada ${contract.id} tem prioridade inválida`};
 if(contract.effect!=='visual'&&contract.effect!=='durable')return {code:'MALFORMED',message:`A camada ${contract.id} não declara efeito visual ou durável`};
 if(!contract.rules.family.length||!Number.isSafeInteger(contract.rules.version)||contract.rules.version<1)return {code:'MALFORMED',message:`A camada ${contract.id} declara regras inválidas`};
 // Another version of the rules may require an incompatible branch, not a visual filter (spec §4).
 if(contract.rules.family!==definition.rules.family||contract.rules.version!==definition.rules.version)return {code:'CONFLICT',message:`A camada ${contract.id} foi feita para ${contract.rules.family} v${contract.rules.version} e a composição roda ${definition.rules.family} v${definition.rules.version}`};
 return null;
}
// A declaration covers a write when it names the same field: a cell by region and index, a world field by name, a
// component by namespace and entity. The coordinates of a cell travel for the reader, they are not compared.
function covers(declared:readonly ChangeField[],write:ChangeField):boolean{
 for(const entry of declared){
  if(entry.scope==='cell'&&write.scope==='cell'&&entry.at.chunkId===write.at.chunkId&&entry.at.index===write.at.index&&entry.field===write.field)return true;
  if(entry.scope==='world'&&write.scope==='world'&&entry.field===write.field)return true;
  if(entry.scope==='component'&&write.scope==='component'&&entry.key===write.key&&entry.entity===write.entity)return true;
 }
 return false;
}
function keyOf(write:ChangeField):string{
 if(write.scope==='cell')return `cell:${write.at.chunkId}#${write.at.index}:${write.field}`;
 if(write.scope==='world')return `world:${write.field}`;
 return `component:${write.key}:${write.entity}`;
}
// A layer writes over a frozen base; replacing the base itself is base update (Tarefa 5), a different operation. The
// writes are derived from the material so a declaration is checked against what a commit actually changed.
export function layerWrites(ground:GameState,project:GameState):WorldResult<readonly ChangeField[]>{
 const writes:ChangeField[]=[];
 if(ground.money!==project.money)writes.push({scope:'world',field:'money'});
 if(ground.tick!==project.tick)writes.push({scope:'world',field:'tick'});
 const regions=[...new Set([...Object.keys(ground.chunks),...Object.keys(project.chunks)])].sort();
 for(const id of regions){
  const before=ground.chunks[id],after=project.chunks[id];
  if(!before||!after)return failed('CONFLICT',`A camada ${before?'removeu':'acrescentou'} a região ${id}: isso é outra base, não uma camada`);
  if(before.base.source!==after.base.source||before.base.normalizerVersion!==after.base.normalizerVersion||before.base.cells.some((cell,index)=>!sameCell(cell,after.base.cells[index]??cell)))
   return failed('CONFLICT',`A camada trocou a base congelada da região ${id}`);
  const indexes=new Set<number>();
  for(const key of [...Object.keys(before.edits),...Object.keys(after.edits)])indexes.add(Number(key));
  for(const index of [...indexes].sort((a,b)=>a-b)){
   const was=before.edits[String(index)]??before.base.cells[index],now=after.edits[String(index)]??after.base.cells[index];
   if(!was||!now)continue;
   for(const field of CELL_FIELDS){
    if(was[field]===now[field])continue;
    let at:CellPlace;
    try{const point=coordAt(id,index);at={chunkId:id,index,x:point.x,y:point.y};}
    catch{return failed('MALFORMED',`Trecho inválido na camada: ${id}`);}
    writes.push({scope:'cell',at,field});
   }
  }
 }
 const namespaces=[...new Set([...Object.keys(ground.components),...Object.keys(project.components)])].sort();
 for(const key of namespaces){
  if(!isComponentKey(key))return failed('MALFORMED',`Namespace inválido na camada: ${key}`);
  const before=ground.components[key]??{},after=project.components[key]??{};
  for(const entity of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()){
   if(!isEntityId(entity))return failed('MALFORMED',`Entidade inválida na camada: ${entity}`);
   const was=before[entity],now=after[entity];
   if(was===undefined&&now===undefined)continue;
   if(was===undefined||now===undefined||!sameJson(was as JsonValue,now as JsonValue))writes.push({scope:'component',key,entity});
   // A core component is checked by the vocabulary of §9, and a field a newer client added survives the check.
   if(now!==undefined&&key.startsWith('osim.')){
    const checked=checkCoreComponent(key,now);
    if(!checked.ok)return failed(checked.error.code,checked.error.message);
   }
  }
 }
 return ok(writes);
}
// The declaration is an upper bound, and it is what makes a layer reviewable: writing a field nobody named, outside
// the areas it said it touched, or into data of the wrong kind is refused before anything is applied (spec §4).
function layerProblem(definition:Composition,contract:LayerContract,writes:readonly ChangeField[]):WorldError|null{
 for(const write of writes){
  if(!covers(contract.writes,write))return {code:'CONFLICT',message:`A camada ${contract.id} escreveu ${keyOf(write)} sem declarar`};
  if(write.scope==='cell'&&!contract.areas.includes(write.at.chunkId))return {code:'CONFLICT',message:`A camada ${contract.id} escreveu ${keyOf(write)}, fora das áreas que declarou`};
  if(write.scope!=='component'){
   if(contract.effect==='visual')return {code:'CONFLICT',message:`A camada visual ${contract.id} escreve ${keyOf(write)}, que é estado durável`};
   continue;
  }
  const extension=definition.extensions.find(entry=>entry.key===write.key);
  if(!extension)return {code:'MALFORMED',message:`A camada ${contract.id} escreve o namespace ${write.key}, que a composição não declara`};
  if(contract.effect==='visual'&&extension.durable)return {code:'CONFLICT',message:`A camada visual ${contract.id} escreve o namespace durável ${write.key}`};
  if(contract.effect==='durable'&&!extension.durable)return {code:'CONFLICT',message:`A camada durável ${contract.id} escreve o namespace efêmero ${write.key}`};
 }
 return null;
}
// Two durable layers writing the same field are a conflict even when they wrote the same value: there is no generic
// "last layer wins", and a composition that wants to resolve one has to declare a versioned rule (spec §4). The
// message groups the shared fields by site — the cell, the component, the world field — so a disputed block reads as
// a handful of places instead of thirty fields.
function conflictProblem(layers:readonly ResolvedLayer[]):string|null{
 const owner:Record<string,string|undefined>={};
 const involved=new Set<string>();
 const sites:{site:string;fields:string[]}[]=[];
 for(const layer of layers){
  if(layer.contract.effect!=='durable')continue;
  for(const write of layer.writes){
   const key=keyOf(write),taken=owner[key];
   if(!taken){owner[key]=layer.contract.id;continue;}
   involved.add(taken);
   involved.add(layer.contract.id);
   const site=write.scope==='cell'?`cell:${write.at.chunkId}#${write.at.index}`:key;
   const found=sites.find(entry=>entry.site===site);
   if(found){
    if(write.scope==='cell'&&!found.fields.includes(write.field))found.fields.push(write.field);
    continue;
   }
   sites.push({site,fields:write.scope==='cell'?[write.field]:[]});
  }
 }
 if(!sites.length)return null;
 sites.sort((a,b)=>(a.site<b.site?-1:a.site>b.site?1:0));
 const shown=sites.slice(0,6).map(entry=>entry.fields.length?`${entry.site} (${entry.fields.join(', ')})`:entry.site);
 return `Camadas duráveis escrevem o mesmo campo: ${shown.join('; ')}${sites.length>6?`; e mais ${sites.length-6}`:''} — ${[...involved].sort().join(', ')}`;
}
// §4: layers that affect the simulation are pinned and validated together, so a dependency has to be in the
// composition and the graph has to be acyclic. The order below is the one durable writes are applied in.
function order(layers:readonly CompositionLayer[]):WorldResult<CompositionLayer[]>{
 const byId:Record<string,CompositionLayer|undefined>={};
 for(const layer of layers)byId[layer.contract.id]=layer;
 const done=new Set<string>(),visiting=new Set<string>(),ordered:CompositionLayer[]=[];
 const visit=(id:string,path:readonly string[]):WorldError|null=>{
  if(done.has(id))return null;
  if(visiting.has(id))return {code:'CONFLICT',message:`Dependência cíclica entre camadas: ${[...path,id].join(' → ')}`};
  const layer=byId[id];
  if(!layer)return {code:'MISSING_OBJECT',message:`A camada ${path[path.length-1]??id} depende de ${id}, que não está na composição`};
  visiting.add(id);
  for(const dependency of [...layer.contract.dependsOn].sort()){
   const problem=visit(dependency,[...path,id]);
   if(problem)return problem;
  }
  visiting.delete(id);
  done.add(id);
  ordered.push(layer);
  return null;
 };
 for(const id of Object.keys(byId).sort()){
  const problem=visit(id,[]);
  if(problem)return failed(problem.code,problem.message);
 }
 return ok(ordered);
}
function pick<K extends CellField>(base:Cell,claimed:readonly {field:CellField;from:Cell}[],field:K):Cell[K]{
 for(const entry of claimed)if(entry.field===field)return entry.from[field];
 return base[field];
}
// The fields of a cell are named here because each one is optional (a road is absent rather than false) and TypeScript
// cannot index a union of keys with a value of its own union.
function mergeCell(base:Cell,claimed:readonly {field:CellField;from:Cell}[]):Cell{
 const merged:Cell={terrain:pick(base,claimed,'terrain')};
 const road=pick(base,claimed,'road');if(road!==undefined)merged.road=road;
 const roadClass=pick(base,claimed,'roadClass');if(roadClass!==undefined)merged.roadClass=roadClass;
 const building=pick(base,claimed,'building');if(building!==undefined)merged.building=building;
 const stage=pick(base,claimed,'stage');if(stage!==undefined)merged.stage=stage;
 const origin=pick(base,claimed,'origin');if(origin!==undefined)merged.origin=origin;
 return merged;
}
// The published component carries the whole contract, so a receiver composes a layer it can check instead of a layer
// whose name it trusts. `commit` travels as a `sha256:` identifier (§4), the same kind of address an asset carries.
function layerComponent(contract:LayerContract,commit:ObjectRef):Record<string,unknown>{
 return {
  source:contract.source,
  priority:contract.priority,
  effect:contract.effect,
  commit:`sha256:${commit.hash}`,
  rules:{family:contract.rules.family,version:contract.rules.version},
  reads:[...contract.reads],
  writes:[...contract.writes],
  dependsOn:[...contract.dependsOn],
  areas:[...contract.areas],
  capabilities:[...contract.capabilities],
 };
}
// `envelopeOf` validates and throws on anything the protocol refuses; every field was checked above, so a throw here
// would be a defect — and it is still reported as a refusal instead of escaping to the caller.
function envelope(kind:'entity'|'timeline',id:string,actor:string,body:JsonValue):WorldResult<OsimEnvelope>{
 try{return ok(envelopeOf(kind,id,actor,body));}catch(error){return failed('MALFORMED',error instanceof Error?error.message:'Envelope inválido');}
}

export function composeWorld(definition:Composition,objects:ResolvedObjects):WorldResult<ComposedWorld>{
 const shape=shapeProblem(definition);
 if(shape)return failed(shape.code,shape.message);
 const base=objects.states[definition.base.commit.hash];
 if(!base)return failed('NOT_FOUND',`A base ${definition.base.commit.hash.slice(0,12)}… não foi resolvida`);
 if(base.worldId!==definition.worldId)return failed('MALFORMED','A base resolvida é de outro mundo');
 // The composition pins the ground by its durable identity: composing over a state that merely looks similar would
 // make every comparison below meaningless.
 if(durableJson(base,definition.extensions)!==definition.base.identity)return failed('CONFLICT','A base resolvida não é a que a composição fixa');
 const position:Record<string,number|undefined>={};
 for(const [index,layer] of definition.layers.entries()){
  const problem=contractProblem(definition,layer.contract);
  if(problem)return failed(problem.code,problem.message);
  if(position[layer.contract.id]!==undefined)return failed('MALFORMED',`A camada ${layer.contract.id} aparece duas vezes na composição`);
  if(!isRef(layer.commit))return failed('MALFORMED',`A camada ${layer.contract.id} não é endereçada por conteúdo`);
  position[layer.contract.id]=index;
 }
 const ordered=order(definition.layers);
 if(!ordered.ok)return ordered;
 const layers:ResolvedLayer[]=[];
 for(const layer of ordered.value){
  const state=objects.states[layer.commit.hash];
  if(!state)return failed('NOT_FOUND',`A camada ${layer.contract.id} não foi resolvida`);
  if(state.worldId!==definition.worldId)return failed('MALFORMED',`A camada ${layer.contract.id} é de outro mundo`);
  const writes=layerWrites(base,state);
  if(!writes.ok)return failed(writes.error.code,`${layer.contract.id}: ${writes.error.message}`);
  const problem=layerProblem(definition,layer.contract,writes.value);
  if(problem)return failed(problem.code,problem.message);
  layers.push({...layer,writes:writes.value,state});
 }
 const conflict=conflictProblem(layers);
 if(conflict)return failed('CONFLICT',conflict);
 // Every field belongs to one layer by now, so composing is applying instead of choosing.
 const cells:Record<string,{chunkId:string;index:number;claimed:{field:CellField;from:Cell}[]}|undefined>={};
 const components:Record<string,Record<string,unknown>>={...base.components};
 let money=base.money,tick=base.tick;
 const apply=(state:GameState,writes:readonly ChangeField[]):void=>{
  for(const write of writes){
   if(write.scope==='cell'){
    const managed=state.chunks[write.at.chunkId];
    const cell=managed?managed.edits[String(write.at.index)]??managed.base.cells[write.at.index]:undefined;
    if(!cell)continue;
    const key=`${write.at.chunkId}#${write.at.index}`;
    const entry=cells[key]??{chunkId:write.at.chunkId,index:write.at.index,claimed:[]};
    entry.claimed.push({field:write.field,from:cell});
    cells[key]=entry;
    continue;
   }
   if(write.scope==='component'){
    const namespace={...(components[write.key]??{})};
    const value=state.components[write.key]?.[write.entity];
    if(value===undefined)delete namespace[write.entity];else namespace[write.entity]=value;
    components[write.key]=namespace;
    continue;
   }
   if(write.field==='money')money=state.money;
   else if(write.field==='tick')tick=state.tick;
  }
 };
 const durable=layers.filter(layer=>layer.contract.effect==='durable');
 for(const layer of durable)apply(layer.state,layer.writes);
 // §19: the order of the layers may decide what is *visible*, and the visible order is the declared one — priority
 // first, then the position in the composition. It is applied last and only over ephemeral namespaces, so what a
 // visual layer changes can never decide which city exists.
 const visual=layers.filter(layer=>layer.contract.effect==='visual').sort((a,b)=>b.contract.priority-a.contract.priority||(position[a.contract.id]??0)-(position[b.contract.id]??0));
 for(const layer of visual)apply(layer.state,layer.writes);
 const chunks:Record<string,ManagedChunk>={...base.chunks};
 for(const key of Object.keys(cells).sort()){
  const entry=cells[key];
  if(!entry)continue;
  const managed=chunks[entry.chunkId];
  const previous=managed?managed.edits[String(entry.index)]??managed.base.cells[entry.index]:undefined;
  if(!managed||!previous)return failed('MISSING_OBJECT',`A célula ${key} não existe na base`);
  chunks[entry.chunkId]={...managed,edits:{...managed.edits,[entry.index]:mergeCell(previous,entry.claimed)}};
 }
 // `revision` and `actors` stay the ground's: numbering a scenario's own history is the repository's business, and
 // neither of them belongs to the durable identity anyway (src/core/protocol.ts).
 const state:GameState={...base,chunks,components,money,tick};
 const published:PublishedLayer[]=[];
 for(const layer of definition.layers){
  const uri=entityUri(layer.contract.id);
  const checked=checkCoreComponent('osim.layer',layerComponent(layer.contract,layer.commit));
  if(!checked.ok)return failed(checked.error.code,checked.error.message);
  const body={components:{'osim.layer':checked.value}} as unknown as JsonValue;
  const entity=envelope('entity',uri,definition.actor,body);
  if(!entity.ok)return entity;
  published.push({id:layer.contract.id,uri,commit:layer.commit,contract:layer.contract,envelope:entity.value});
 }
 const timeline=envelope('timeline',definition.temporal.timeline,definition.actor,{clock:'utc',rate:definition.temporal.rate,parent:definition.temporal.parent,forkAt:definition.temporal.forkAt});
 if(!timeline.ok)return timeline;
 return ok({
  worldId:definition.worldId,
  branchId:definition.branchId,
  rules:{...definition.rules},
  parameters:{...definition.parameters},
  base:{commit:definition.base.commit,identity:definition.base.identity,bases:[...definition.base.bases]},
  layers:published,
  applied:durable.map(layer=>layer.contract.id),
  visual:visual.map(layer=>layer.contract.id),
  state,
  identity:durableJson(state,definition.extensions),
  timeline:timeline.value,
 });
}

// --- running a scenario (spec §4, plan Task 14) -----------------------------------------------------------------
// An external input the scenario pins. Its *effect* is a versioned rule and the city profile has none yet — giving an
// observation an economic consequence is Task 15 — so this record fixes what a run was given without inventing an
// effect for it: two runs are the same experiment when they were given the same inputs.
export type ScenarioInput={id:string;atTick:number;kind:'observed'|'forecast';payload:JsonValue};
// The numbers a scenario reports side by side, written out instead of derived from `CityStats`: this is a table of
// deltas, and the city's economy is a nested object that would either break the table or lie as a single number.
export type ScenarioIndicators={money:number;population:number;jobs:number;energySupply:number;energyUsed:number;happiness:number;income:number;managed:number;tick:number};
const indicatorsOf=(state:GameState):ScenarioIndicators=>{
 const stats=summarize(state);
 return {money:stats.money,population:stats.population,jobs:stats.jobs,energySupply:stats.energySupply,energyUsed:stats.energyUsed,happiness:stats.happiness,income:stats.income,managed:stats.managed,tick:state.tick};
};
export type ScenarioRun={
 id:string;
 composition:Composition;
 initial:{state:GameState;identity:string};
 interval:{fromTick:number;toTick:number};
 inputs:readonly ScenarioInput[];
 // What this future assumes. A divergence nobody declared is refused by `compareScenarios` instead of being shown as
 // one experiment.
 premises:readonly string[];
 state:GameState;
 indicators:ScenarioIndicators;
};
export type ScenarioRequest={id:string;interval:{fromTick:number;toTick:number};inputs:readonly ScenarioInput[];premises:readonly string[]};

function requestProblem(composed:ComposedWorld,request:ScenarioRequest):WorldError|null{
 if(!isEntityId(request.id))return {code:'MALFORMED',message:`Identificador de cenário inválido: ${request.id}`};
 const {fromTick,toTick}=request.interval;
 if(!Number.isSafeInteger(fromTick)||!Number.isSafeInteger(toTick)||fromTick<0||toTick<fromTick)return {code:'MALFORMED',message:'Intervalo de ticks inválido'};
 // A run starts where its composition left the world, so the interval cannot begin somewhere else.
 if(composed.state.tick!==fromTick)return {code:'CONFLICT',message:`O estado da composição está no tick ${composed.state.tick} e o intervalo começa em ${fromTick}`};
 const seen=new Set<string>();
 for(const input of request.inputs){
  if(typeof input.id!=='string'||!input.id.length)return {code:'MALFORMED',message:'Entrada externa sem identificador'};
  if(seen.has(input.id))return {code:'MALFORMED',message:`Entrada externa repetida: ${input.id}`};
  seen.add(input.id);
  if(!Number.isSafeInteger(input.atTick)||input.atTick<fromTick||input.atTick>toTick)return {code:'MALFORMED',message:`A entrada ${input.id} não cai dentro do intervalo do cenário`};
  if(input.kind!=='observed'&&input.kind!=='forecast')return {code:'MALFORMED',message:`A entrada ${input.id} não é observação nem previsão`};
  try{assertJsonSafe(input.payload,`Entrada ${input.id}`);}catch(error){return {code:'MALFORMED',message:error instanceof Error?error.message:`Entrada ${input.id} inválida`};}
 }
 for(const premise of request.premises)if(typeof premise!=='string'||!premise.length)return {code:'MALFORMED',message:'Premissa vazia no cenário'};
 return null;
}
// A scenario is a simulation, not a validated forecast: the same ground, the same interval and the same declared
// inputs, run by the profile's own rules, and the indicators it ends on.
function* scenarioSteps(definition:Composition,objects:ResolvedObjects,request:ScenarioRequest):Generator<number,WorldResult<ScenarioRun>,void>{
 const composed=composeWorld(definition,objects);
 if(!composed.ok)return composed;
 const problem=requestProblem(composed.value,request);
 if(problem)return failed(problem.code,problem.message);
 let state=composed.value.state;
 while(state.tick<request.interval.toTick){state=stepSimulation(state);yield state.tick-request.interval.fromTick;}
 return ok({
  id:request.id,
  composition:definition,
  initial:{state:composed.value.state,identity:composed.value.identity},
  interval:{fromTick:request.interval.fromTick,toTick:request.interval.toTick},
  inputs:[...request.inputs],
  premises:[...request.premises],
  state,
  indicators:indicatorsOf(state),
 });
}

export function runScenario(definition:Composition,objects:ResolvedObjects,request:ScenarioRequest):WorldResult<ScenarioRun>{
 const steps=scenarioSteps(definition,objects,request);
 let next=steps.next();while(!next.done)next=steps.next();return next.value;
}

// Scheduling belongs to the host: portable scenario execution never reads a clock or assumes a browser.
export type ScenarioExecution={
 yield():Promise<void>;
 cancelled?():boolean;
 batchTicks?:number;
 progress?(completed:number,total:number):void;
};
export async function runScenarioAsync(definition:Composition,objects:ResolvedObjects,request:ScenarioRequest,execution:ScenarioExecution):Promise<WorldResult<ScenarioRun>|null>{
 if(execution.cancelled?.())return null;
 const steps=scenarioSteps(definition,objects,request),total=request.interval.toTick-request.interval.fromTick;
 const batch=execution.batchTicks??5;
 if(!Number.isSafeInteger(batch)||batch<1)return failed('MALFORMED','Lote de ticks inválido');
 let completed=0;
 while(true){
  if(execution.cancelled?.())return null;
  const next=steps.next();
  if(next.done){if(completed>0&&completed%batch!==0)execution.progress?.(completed,total);return next.value;}
  completed=next.value;
  if(completed%batch===0){
   execution.progress?.(completed,total);
   if(completed<total)await execution.yield();
  }
 }
}

// --- comparing two futures (spec §12 "Dois futuros da mesma praça") ---------------------------------------------
export type IndicatorDelta={key:keyof ScenarioIndicators;a:number;b:number;delta:number};
export type DeclaredPremise={side:'a'|'b';premise:string};
export type ScenarioComparison={
 comparable:boolean;
 // Why the two runs are not comparable, in the order the checks ran; empty when they are.
 reasons:readonly string[];
 worldId:string|null;
 baseCommit:string|null;
 baseIdentity:string|null;
 sharedBases:readonly FrozenBase[];
 interval:{fromTick:number;toTick:number}|null;
 // The durable decisions each side applied, and the parameter keys whose values differ.
 decisions:{a:readonly string[];b:readonly string[]};
 parameters:readonly string[];
 // Premises only one side declared: the hypotheses that explain the divergence.
 declared:readonly DeclaredPremise[];
 // Only the indicators that moved, in the order the profile reports them.
 indicators:readonly IndicatorDelta[];
};
// Comparing futures is not validating a forecast: when the ground, the interval or the frame differ the two runs are
// not the same experiment and the comparison says so instead of showing a difference it cannot explain.
export function compareScenarios(a:ScenarioRun,b:ScenarioRun):ScenarioComparison{
 const reasons:string[]=[];
 const sameWorld=a.composition.worldId===b.composition.worldId;
 if(!sameWorld)reasons.push('Os dois cenários são de mundos diferentes');
 const sameGround=sameWorld&&sameRef(a.composition.base.commit,b.composition.base.commit)&&a.composition.base.identity===b.composition.base.identity;
 if(!sameGround)reasons.push('Os dois cenários não partem da mesma base');
 const sharedBases:FrozenBase[]=[];
 for(const base of a.composition.base.bases){
  const other=b.composition.base.bases.find(entry=>entry.id===base.id);
  if(other&&sameRef(base.ref,other.ref))sharedBases.push(base);
 }
 if(sharedBases.length!==a.composition.base.bases.length||sharedBases.length!==b.composition.base.bases.length)reasons.push('Os dois cenários não compartilham as mesmas bases congeladas');
 const sameFrame=a.composition.temporal.parent===b.composition.temporal.parent&&a.composition.temporal.forkAt===b.composition.temporal.forkAt;
 if(!sameFrame)reasons.push('As linhas do tempo dos dois cenários derivam de quadros diferentes');
 const sameInterval=a.interval.fromTick===b.interval.fromTick&&a.interval.toTick===b.interval.toTick;
 if(!sameInterval)reasons.push('Os intervalos de ticks são diferentes');
 const decisions:{a:string[];b:string[]}={a:[],b:[]};
 const runs:{a:ScenarioRun;b:ScenarioRun}={a,b};
 for(const side of ['a','b'] as const)for(const layer of runs[side].composition.layers)if(layer.contract.effect==='durable')decisions[side].push(layer.contract.id);
 decisions.a.sort();
 decisions.b.sort();
 // A divergence is readable when each side said what it was testing: hypotheses belong to the scenario, and a silent
 // one is refused instead of being presented as one experiment.
 const declared=a.premises.length>0&&b.premises.length>0;
 if(!(decisions.a.length===decisions.b.length&&decisions.a.every((id,index)=>id===decisions.b[index]))&&!declared)reasons.push('As decisões aplicadas diferem sem premissas declaradas');
 const sameInputs=a.inputs.length===b.inputs.length&&a.inputs.every((input,index)=>{
  const other=b.inputs[index];
  return !!other&&input.id===other.id&&input.atTick===other.atTick&&input.kind===other.kind&&sameJson(input.payload,other.payload);
 });
 if(!sameInputs&&!declared)reasons.push('As entradas externas diferem sem premissas declaradas');
 const parameters=[...new Set([...Object.keys(a.composition.parameters),...Object.keys(b.composition.parameters)])]
  .filter(key=>!sameJson(a.composition.parameters[key]??null,b.composition.parameters[key]??null)).sort();
 const indicators:IndicatorDelta[]=[];
 for(const key of INDICATORS)if(a.indicators[key]!==b.indicators[key])indicators.push({key,a:a.indicators[key],b:b.indicators[key],delta:b.indicators[key]-a.indicators[key]});
 return {
  comparable:reasons.length===0,
  reasons,
  worldId:sameWorld?a.composition.worldId:null,
  baseCommit:sameGround?a.composition.base.commit.hash:null,
  baseIdentity:sameGround?a.composition.base.identity:null,
  sharedBases,
  interval:sameInterval?{fromTick:a.interval.fromTick,toTick:a.interval.toTick}:null,
  decisions,
  parameters,
  declared:[
   ...a.premises.filter(premise=>!b.premises.includes(premise)).map(premise=>({side:'a' as const,premise})),
   ...b.premises.filter(premise=>!a.premises.includes(premise)).map(premise=>({side:'b' as const,premise})),
  ],
  indicators,
 };
}
