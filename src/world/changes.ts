import {validCalibration} from '../core/municipal-calibration';
import type {MunicipalCalibration} from '../core/municipal-calibration';
// Intentions, differences and proposals (docs/superpowers/specs/2026-09-29-federated-world-design.md §5.2–§5.3). Pure:
// the caller supplies the world and the command, nothing here reads the environment. A ChangeSet is what somebody has
// to review before an operation lands in another version: per operation an id, the intention, the fields read and
// written, the preconditions, the frozen regions it rests on and the operations it depends on. Two honesties are
// structural: an intention is only ever what a command recorded — a legacy overlay becomes an opaque cell replacement
// instead of an invented build — and a declared author is carried for reading, never consulted as an authorization.
import type {BaseChunk,Cell,CellCoord,Command,GameState,ManagedChunk,Tool} from '../core/model';
import {COST} from '../core/model';
import type {Head,JsonValue,ObjectRef,WorldObject,WorldResult} from './model';
import {MAX_OBJECT_BYTES,failed,isRef,ok,sameRef} from './model';
import type {ContentHasher,WorldCodec} from './ports';
import {cellIndex,chunkId,coordAt} from '../core/coordinates';
import {getCell} from '../core/world';
import {isComponentKey,isEntityId} from '../core/protocol';

// --- what a change is made of (spec §5.3) ----------------------------------------------------------------------
export type CellField='terrain'|'road'|'roadClass'|'building'|'stage'|'origin';
// A cell is addressed by region and index, and it also carries the coordinates it came from so a reviewer never has to
// reconstruct them and two clients cannot disagree about which cell an operation means.
export type CellPlace={chunkId:string;index:number;x:number;y:number};
export type ChangeField=
 | {scope:'cell';at:CellPlace;field:CellField}
 | {scope:'world';field:'money'|'tick'|'revision'}
 | {scope:'component';key:string;entity:string};
// Where a change was produced. The branch is optional because the core state does not know it; the caller that has a
// checkpoint supplies it. This is provenance for reading, not a permission.
export type ChangeOrigin={worldId:string;branchId?:string};
// A frozen region is identified by the region, the provider that filled it and the normalizer that shaped it. A hash
// is not required to name it — `attachBases` adds the content addresses when the proposal travels.
export type BaseReference={chunkId:string;source:string;normalizerVersion:number};
export type ChangeIntent=
 | {kind:'build';tool:Tool}
 | {kind:'demolish'}
 | {kind:'tick'}
 | {kind:'component';key:string;entity:string}
 | {kind:'municipal-calibration';calibration:MunicipalCalibration|null}
 | {kind:'policy';tax?:number;services?:number;borrow?:number}
 | {kind:'opaque';note:string};
export type Precondition=
 | {kind:'chunk-base';base:BaseReference}
 | {kind:'cell-clear';at:CellPlace}
 | {kind:'cell-occupied';at:CellPlace}
 | {kind:'cell-terrain';at:CellPlace;terrain:Cell['terrain']};
export type ChangeOperation={
 id:string;
 intent:ChangeIntent;
 places:readonly CellPlace[];
 reads:readonly ChangeField[];
 writes:readonly ChangeField[];
 requires:readonly Precondition[];
 basedOn:readonly BaseReference[];
 dependsOn:readonly string[];
 before:readonly JsonValue[];
 after:readonly JsonValue[];
};
export type ChangeSet={
 version:1;
 origins:readonly ChangeOrigin[];
 author?:string;
 operations:readonly ChangeOperation[];
 bases:readonly WorldObject[];
 extensions:Record<string,JsonValue>;
};
// The destination side of a proposal. `Checkpoint` satisfies this shape structurally, so a prepared project can be
// computed against a restored version without this layer knowing the repository.
export type ProjectTarget={head:Head;state:GameState;bases?:readonly {id:string;ref:ObjectRef}[]};
// The destination side of a proposal. `Checkpoint` satisfies this shape structurally, so a prepared project can be
// computed against a restored version without this layer knowing the repository. The digest of the preview is not
// here on purpose: preparing is synchronous and hash-free, and the commit step that persists the change is the one that
// can address it by content.
export type PreparedChange={
 origins:readonly ChangeOrigin[];
 target:Head;
 selection:readonly string[];
 operations:readonly ChangeOperation[];
 bases:readonly WorldObject[];
 cost:number;
 moneyAfter:number;
 tick:number;
 requires:readonly Precondition[];
 // A project is a recipe the destination replays under its own rules, so it names the actions and no state. A merge or
 // a base update composes two versions the caller already holds by comparing cells, and names the state it produces;
 // exactly one of the two is the authority of a prepared change, and the repository never replays actions when the
 // state is present.
 state?:GameState;
 // What the version records about this change besides its operations: a base adoption, an overlay preserved over new
 // real data, a compensation. They are what a history reader sees, and they never authorize anything.
 records?:readonly string[];
};
// Importing a project is the destination's own action, so it never borrows the sequence of whoever produced the file.
export const PROJECT_ACTOR='project';

const CELL_FIELDS:readonly CellField[]=['terrain','road','roadClass','building','stage','origin'];
const editIndexes=(chunk:ManagedChunk):number[]=>Object.keys(chunk.edits).map(Number).sort((a,b)=>a-b);

export function sameCell(a:Cell,b:Cell):boolean{return CELL_FIELDS.every(field=>a[field]===b[field]);}
export function sameJson(a:JsonValue|null,b:JsonValue|null):boolean{
 if(a===b)return true;
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((entry,index)=>sameJson(entry,b[index]??null));
 if(a&&b&&typeof a==='object'&&typeof b==='object'&&!Array.isArray(a)&&!Array.isArray(b)){
  const keysA=Object.keys(a),keysB=Object.keys(b);
  return keysA.length===keysB.length&&keysA.every(key=>sameJson(a[key]??null,b[key]??null));
 }
 return false;
}
function changedFields(before:Cell,after:Cell):CellField[]{
 const fields:CellField[]=[];
 for(const field of CELL_FIELDS)if(before[field]!==after[field])fields.push(field);
 return fields;
}
const placeOf=(cell:CellCoord):CellPlace=>{const chunk=chunkId(cell),index=cellIndex(cell);const at=coordAt(chunk,index);return{chunkId:chunk,index,x:at.x,y:at.y};};
const baseOf=(state:GameState,chunk:string):BaseReference|undefined=>{const managed=state.chunks[chunk];return managed?{chunkId:chunk,source:managed.base.source,normalizerVersion:managed.base.normalizerVersion}:undefined;};
const cellFields=(at:CellPlace,fields:readonly CellField[]):ChangeField[]=>fields.map(field=>({scope:'cell',at,field}));
const componentValue=(state:GameState,key:string,entity:string):JsonValue|null=>{const stored=state.components[key]?.[entity];return stored===undefined?null:(stored as JsonValue);};

// --- describing what a command did (spec §5.3) ------------------------------------------------------------------
// The intention comes from the command, never from the difference: a cell that changed because the simulation grew it
// is not a decision, and an operation is only listed when it truly changed something (a road laid over a road is
// accepted by the core and is not an operation).
export function describeChange(before:GameState,command:Command,after:GameState,origin?:ChangeOrigin):ChangeSet{
 const action=command.action,operations:ChangeOperation[]=[];
 if(action.type==='build'||action.type==='demolish'){
  const seen=new Set<string>();
  for(const cell of action.cells){
   const at=placeOf(cell),key=`${at.chunkId}#${at.index}`;
   if(seen.has(key))continue;
   seen.add(key);
   // A region the command itself adopted was not in the state before it, but the cell it started from is not unknown:
   // it is the frozen base cell the region was adopted with.
   const frozen=after.chunks[at.chunkId]?.base.cells[at.index];
   const was=getCell(before,cell)??frozen,now=getCell(after,cell);
   if(!was||!now||sameCell(was,now))continue;
   const base=baseOf(after,at.chunkId)??baseOf(before,at.chunkId);
   const reads=action.type==='build'?cellFields(at,['terrain','road','building']):cellFields(at,['road','building']);
   const requires:Precondition[]=base?[{kind:'chunk-base',base}]:[];
   if(action.type==='build')requires.push({kind:'cell-clear',at},{kind:'cell-terrain',at,terrain:was.terrain});
   else requires.push({kind:'cell-occupied',at});
   operations.push({
    id:action.type==='build'?`build:${action.tool}@${key}`:`demolish@${key}`,
    intent:action.type==='build'?{kind:'build',tool:action.tool}:{kind:'demolish'},
    places:[at],reads,writes:cellFields(at,changedFields(was,now)),requires,basedOn:base?[base]:[],dependsOn:[],
    before:[was],after:[now],
   });
  }
 }else if(action.type==='component'){
  const was=componentValue(before,action.key,action.entity),now=componentValue(after,action.key,action.entity);
  if(!sameJson(was,now)){
   const field:ChangeField={scope:'component',key:action.key,entity:action.entity};
   operations.push({
    id:`component:${action.key}@${action.entity}`,
    intent:{kind:'component',key:action.key,entity:action.entity},
    places:[],reads:[field],writes:[field],requires:[],basedOn:[],dependsOn:[],
    before:[was],after:[now],
   });
  }
 }else if(action.type==='municipal-calibration'){
  const was=componentValue(before,'city.economy','calibration'),now=componentValue(after,'city.economy','calibration');
  if(!sameJson(was,now)){
   const field:ChangeField={scope:'component',key:'city.economy',entity:'calibration'};
   operations.push({id:`municipal-calibration@${after.revision}`,intent:{kind:'municipal-calibration',calibration:action.calibration},places:[],reads:[field],writes:[field],requires:[],basedOn:[],dependsOn:[],before:[was],after:[now]});
  }
 }else if(action.type==='policy'){
  const field:ChangeField={scope:'component',key:'city.economy',entity:'policy'};
  const was=componentValue(before,'city.economy','policy'),now=componentValue(after,'city.economy','policy');
  if(!sameJson(was,now)||before.money!==after.money){
   const writes:ChangeField[]=[field];
   const reads:ChangeField[]=[field];
   const beforeValues:JsonValue[]=[was],afterValues:JsonValue[]=[now];
   if(before.money!==after.money){
    const money:ChangeField={scope:'world',field:'money'};
    reads.push(money);writes.push(money);beforeValues.push(before.money);afterValues.push(after.money);
   }
   operations.push({
    id:`policy@${after.revision}`,
    intent:{kind:'policy',...(action.tax!==undefined?{tax:action.tax}:{}),...(action.services!==undefined?{services:action.services}:{}),...(action.borrow!==undefined?{borrow:action.borrow}:{})},
    places:[],reads,writes,requires:[],basedOn:[],dependsOn:[],before:beforeValues,after:afterValues,
   });
  }
 }else if(action.type==='tick'&&before.tick!==after.tick){
  // A tick is not a decision: its world fields are named and the cells it grew are left to the world diff, so a
  // proposal never carries another version's simulation.
  const writes:ChangeField[]=[{scope:'world',field:'tick'}];
  if(before.money!==after.money)writes.push({scope:'world',field:'money'});
  if(before.revision!==after.revision)writes.push({scope:'world',field:'revision'});
  operations.push({id:`tick@${after.tick}`,intent:{kind:'tick'},places:[],reads:[{scope:'world',field:'tick'}],writes,requires:[],basedOn:[],dependsOn:[],before:[],after:[]});
 }
 return{version:1,origins:[origin??{worldId:before.worldId}],operations,bases:[],extensions:{}};
}

// A save written before intentions existed keeps its overlay as whole-cell replacements: the review sees what changed
// and that nobody recorded why, which is the only honest reading of that file.
export function describeEdits(state:GameState,origin?:ChangeOrigin):ChangeSet{
 const operations:ChangeOperation[]=[];
 for(const chunk of Object.keys(state.chunks).sort()){
  const managed=state.chunks[chunk]!;
  for(const index of editIndexes(managed)){
   const was=managed.base.cells[index],now=managed.edits[String(index)];
   if(!was||!now||sameCell(was,now))continue;
   const at=placeOf(coordAt(chunk,index)),base=baseOf(state,chunk);
   operations.push({
    id:`opaque@${chunk}#${index}`,
    intent:{kind:'opaque',note:'Edição de um save antigo: a intenção não foi registrada.'},
    places:[at],reads:[],writes:cellFields(at,changedFields(was,now)),
    requires:base?[{kind:'chunk-base',base}]:[],basedOn:base?[base]:[],dependsOn:[],
    before:[was],after:[now],
   });
  }
 }
 return{version:1,origins:[origin??{worldId:state.worldId}],operations,bases:[],extensions:{}};
}

// Combining proposals is where order becomes explicit: an operation that writes a cell, a region or a component an
// earlier operation already wrote depends on it, and two operations over different cells stay independent. Unknown
// extension fields merge shallowly with the later set winning.
export function combineChanges(...sets:readonly ChangeSet[]):ChangeSet{
 const origins:ChangeOrigin[]=[],seenOrigins=new Set<string>(),operations:ChangeOperation[]=[],bases:WorldObject[]=[],seenBases=new Set<string>(),extensions:Record<string,JsonValue>={};
 const taken=new Set<string>(),writtenBy=new Map<string,string>();
 let author:string|undefined;
 for(const set of sets){
  for(const origin of set.origins){const key=`${origin.worldId}/${origin.branchId??''}`;if(seenOrigins.has(key))continue;seenOrigins.add(key);origins.push(origin);}
  for(const object of set.bases){if(seenBases.has(object.ref.hash))continue;seenBases.add(object.ref.hash);bases.push(object);}
  author=set.author??author;
  for(const [key,value] of Object.entries(set.extensions))extensions[key]=value;
  // Two sets can carry an operation with the same name (the same change twice, or a cell built again after a
  // demolish). The second one gets a distinct id, and its dependencies follow that renaming instead of pointing at the
  // operation of the other set.
  const renamed=new Map<string,string>();
  for(const operation of set.operations){
   let id=operation.id,suffix=2;
   while(taken.has(id))id=`${operation.id}~${suffix++}`;
   taken.add(id);
   renamed.set(operation.id,id);
   const targets=operation.places.length?operation.places.map(place=>`${place.chunkId}#${place.index}`):operation.writes.filter(field=>field.scope==='component').map(field=>`${field.key}/${field.entity}`);
   const dependsOn=new Set(operation.dependsOn.map(dependency=>renamed.get(dependency)??dependency));
   for(const target of targets){const writer=writtenBy.get(target);if(writer&&writer!==id)dependsOn.add(writer);}
   for(const target of targets)writtenBy.set(target,id);
   operations.push({...operation,id,dependsOn:[...dependsOn]});
  }
 }
 const combined:ChangeSet={version:1,origins,operations,bases,extensions};
 if(author!==undefined)combined.author=author;
 return combined;
}

// --- carrying the frozen regions a proposal rests on (spec §5.5) ------------------------------------------------
export type CarriedBase={chunkId:string;source:string;normalizerVersion:number;ref:ObjectRef;base:BaseChunk};
// This module's only boundary guard: a JsonValue that can be indexed as an object. Every field is still checked by
// name, because proving an object proves nothing about what is inside it.
const jsonRecord=(value:JsonValue|undefined):value is Record<string,JsonValue>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const TERRAINS:readonly Cell['terrain'][]=['land','water','green'];
function cellFrom(value:JsonValue):Cell|null{
 if(!jsonRecord(value)||!TERRAINS.includes(value['terrain'] as Cell['terrain']))return null;
 const road=value['road'],roadClass=value['roadClass'],building=value['building'],stage=value['stage'],origin=value['origin'];
 if(road!==undefined&&typeof road!=='boolean')return null;
 if(roadClass!==undefined&&!['street','avenue','highway'].includes(roadClass as string))return null;
 if(roadClass!==undefined&&road!==true)return null;
 if(building!==undefined&&!['residential','commercial','industrial','park','power'].includes(building as string))return null;
 if(stage!==undefined&&!Number.isSafeInteger(stage))return null;
 if(origin!==undefined&&origin!=='imported'&&origin!=='player')return null;
 return value as unknown as Cell;
}
// A frozen region a proposal carries becomes a base this client adopts, so its cells are checked before they can reach
// the economy: a garbage chunk would otherwise be adopted as a region with a nonsensical capacity and income.
function baseChunkFrom(value:JsonValue):BaseChunk|null{
 if(!jsonRecord(value)||typeof value['id']!=='string'||typeof value['source']!=='string'||value['normalizerVersion']!==1)return null;
 const cells=value['cells'];
 if(!Array.isArray(cells))return null;
 const checked:Cell[]=[];
 for(const entry of cells){const cell=cellFrom(entry);if(!cell)return null;checked.push(cell);}
 return {id:value['id'],source:value['source'],normalizerVersion:1,cells:checked};
}
export function carriedBases(carrier:{bases:readonly WorldObject[]}):CarriedBase[]{
 const carried:CarriedBase[]=[];
 for(const object of carrier.bases){
  const value=object.value;
  if(!jsonRecord(value)||value['kind']!=='base-chunk')continue;
  const base=baseChunkFrom(value['base']??null);
  if(!base)continue;
  carried.push({chunkId:base.id,source:base.source,normalizerVersion:1,ref:object.ref,base});
 }
 return carried;
}
// What the operations say they rest on is what has to travel, and nothing else: a proposal carries the regions it uses,
// addressed by content, so a destination that never adopted them can still check and adopt exactly that base.
export async function attachBases(set:ChangeSet,bases:readonly BaseChunk[],hasher:ContentHasher,codec:WorldCodec):Promise<WorldResult<ChangeSet>>{
 const wanted=new Set<string>();
 for(const operation of set.operations)for(const reference of operation.basedOn)wanted.add(reference.chunkId);
 const objects:WorldObject[]=[];
 for(const chunkId of [...wanted].sort()){
  const reference=set.operations.flatMap(operation=>operation.basedOn).find(entry=>entry.chunkId===chunkId)!;
  const base=bases.find(entry=>entry.id===chunkId);
  if(!base)return failed('MISSING_OBJECT',`A região ${chunkId} que a proposta usa não veio junto`);
  if(base.source!==reference.source||base.normalizerVersion!==reference.normalizerVersion)return failed('CONFLICT',`A região ${chunkId} veio de outra base`);
  const value:JsonValue={kind:'base-chunk',base:base as unknown as JsonValue};
  const bytes=codec.encode(value);
  if(bytes.byteLength>MAX_OBJECT_BYTES)return failed('LIMIT',`Objeto de ${bytes.byteLength} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
  objects.push({ref:await hasher.ref(bytes),value});
 }
 return ok({...set,bases:objects});
}

// --- the proposal on the wire (spec §5.5, §9.2) ----------------------------------------------------------------
export function changeSetValue(set:ChangeSet):JsonValue{
 const value:Record<string,JsonValue>={version:set.version,origins:set.origins as unknown as JsonValue,operations:set.operations as unknown as JsonValue,bases:set.bases as unknown as JsonValue,extensions:set.extensions};
 if(set.author!==undefined)value['author']=set.author;
 return value;
}
const INTENT_KINDS:readonly string[]=['build','demolish','tick','component','policy','municipal-calibration','opaque'];
const BUILD_TOOLS=new Set<Tool>((Object.keys(COST) as Array<Tool|'demolish'>).filter((tool):tool is Tool=>tool!=='demolish'));
function placeFrom(value:JsonValue):WorldResult<CellPlace>{
 if(!jsonRecord(value))return failed('MALFORMED','Célula sem endereço');
 const chunk=value['chunkId'],index=value['index'],x=value['x'],y=value['y'];
 if(typeof chunk!=='string'||!chunk||!Number.isSafeInteger(index)||!Number.isSafeInteger(x)||!Number.isSafeInteger(y))return failed('MALFORMED','Célula sem endereço');
 return ok({chunkId:chunk,index:index as number,x:x as number,y:y as number});
}
function fieldFrom(value:JsonValue):WorldResult<ChangeField>{
 if(!jsonRecord(value))return failed('MALFORMED','Campo sem escopo');
 if(value['scope']==='world')return value['field']==='money'||value['field']==='tick'||value['field']==='revision'?ok({scope:'world',field:value['field']}):failed('MALFORMED','Campo de mundo desconhecido');
 if(value['scope']==='component')return typeof value['key']==='string'&&typeof value['entity']==='string'?ok({scope:'component',key:value['key'],entity:value['entity']}):failed('MALFORMED','Componente sem namespace');
 if(value['scope']!=='cell')return failed('MALFORMED','Campo sem escopo');
 const at=placeFrom(value['at'] as JsonValue);
 if(!at.ok)return at;
 const field=value['field'];
 if(!CELL_FIELDS.includes(field as CellField))return failed('MALFORMED','Campo de célula desconhecido');
 return ok({scope:'cell',at:at.value,field:field as CellField});
}
function requirementFrom(value:JsonValue):WorldResult<Precondition>{
 if(!jsonRecord(value))return failed('MALFORMED','Precondição inválida');
 if(value['kind']==='chunk-base'){
  const base=value['base'];
  if(!jsonRecord(base)||typeof base['chunkId']!=='string'||typeof base['source']!=='string'||base['normalizerVersion']!==1)return failed('MALFORMED','Precondição de base inválida');
  return ok({kind:'chunk-base',base:{chunkId:base['chunkId'],source:base['source'],normalizerVersion:1}});
 }
 if(value['kind']!=='cell-clear'&&value['kind']!=='cell-occupied'&&value['kind']!=='cell-terrain')return failed('MALFORMED','Precondição desconhecida');
 const at=placeFrom(value['at'] as JsonValue);
 if(!at.ok)return at;
 if(value['kind']==='cell-clear')return ok({kind:'cell-clear',at:at.value});
 if(value['kind']==='cell-occupied')return ok({kind:'cell-occupied',at:at.value});
 const terrain=value['terrain'];
 if(terrain!=='land'&&terrain!=='water'&&terrain!=='green')return failed('MALFORMED','Terreno desconhecido na precondição');
 return ok({kind:'cell-terrain',at:at.value,terrain});
}
function baseReferenceFrom(value:JsonValue):WorldResult<BaseReference>{
 if(!jsonRecord(value)||typeof value['chunkId']!=='string'||typeof value['source']!=='string'||value['normalizerVersion']!==1)return failed('MALFORMED','Referência de base inválida');
 return ok({chunkId:value['chunkId'],source:value['source'],normalizerVersion:1});
}
function intentFrom(value:JsonValue):WorldResult<ChangeIntent>{
 if(!jsonRecord(value)||typeof value['kind']!=='string'||!INTENT_KINDS.includes(value['kind']))return failed('MALFORMED','Intenção desconhecida');
 if(value['kind']==='build'){const tool=value['tool'];return typeof tool==='string'&&BUILD_TOOLS.has(tool as Tool)?ok({kind:'build',tool:tool as Tool}):failed('MALFORMED','Ferramenta de construção desconhecida');}
 if(value['kind']==='municipal-calibration'){
  const calibration=value['calibration'];
  return calibration===null||validCalibration(calibration)?ok({kind:'municipal-calibration',calibration}):failed('MALFORMED','Calibração municipal inválida');
 }
 if(value['kind']==='policy'){
  const tax=value['tax'],services=value['services'],borrow=value['borrow'];
  if(tax===undefined&&services===undefined&&borrow===undefined)return failed('MALFORMED','Política sem alteração');
  for(const entry of [tax,services,borrow])if(entry!==undefined&&(typeof entry!=='number'||!Number.isFinite(entry)))return failed('MALFORMED','Política com valor inválido');
  return ok({kind:'policy',...(tax!==undefined?{tax}:{}),...(services!==undefined?{services}:{}),...(borrow!==undefined?{borrow}:{})} as ChangeIntent);
 }
 if(value['kind']==='component'){
  const key=value['key'],entity=value['entity'];
  // A namespace travels because another profile owns it; it still has to be one this contract can carry and preserve.
  if(typeof key!=='string'||!isComponentKey(key)||typeof entity!=='string'||!isEntityId(entity))return failed('MALFORMED','Componente com namespace ou identificador não portável');
  return ok({kind:'component',key,entity});
 }
 if(value['kind']==='opaque')return ok({kind:'opaque',note:typeof value['note']==='string'?value['note']:'Intenção não registrada'});
 return ok({kind:value['kind'] as 'demolish'|'tick'});
}
function listFrom<T>(value:JsonValue|undefined,read:(entry:JsonValue)=>WorldResult<T>):WorldResult<T[]>{
 if(!Array.isArray(value))return failed('MALFORMED','Lista ausente na proposta');
 const parsed:T[]=[];
 for(const entry of value){const item=read(entry);if(!item.ok)return item;parsed.push(item.value);}
 return ok(parsed);
}
function operationFrom(value:JsonValue):WorldResult<ChangeOperation>{
 if(!jsonRecord(value))return failed('MALFORMED','Operação inválida');
 const {id,intent,places,reads,writes,requires,basedOn,dependsOn,before,after}=value;
 if(typeof id!=='string'||!id)return failed('MALFORMED','Operação sem identificador');
 const parsedIntent=intentFrom(intent??null);
 if(!parsedIntent.ok)return parsedIntent;
 const parsedPlaces=listFrom(places as JsonValue,placeFrom);
 if(!parsedPlaces.ok)return parsedPlaces;
 const parsedReads=listFrom(reads as JsonValue,fieldFrom);
 if(!parsedReads.ok)return parsedReads;
 const parsedWrites=listFrom(writes as JsonValue,fieldFrom);
 if(!parsedWrites.ok)return parsedWrites;
 const parsedRequires=listFrom(requires as JsonValue,requirementFrom);
 if(!parsedRequires.ok)return parsedRequires;
 const parsedBasedOn=listFrom(basedOn as JsonValue,baseReferenceFrom);
 if(!parsedBasedOn.ok)return parsedBasedOn;
 if(!Array.isArray(dependsOn)||dependsOn.some(entry=>typeof entry!=='string'))return failed('MALFORMED','Dependências inválidas');
 if(!Array.isArray(before)||!Array.isArray(after))return failed('MALFORMED','Valores ausentes na operação');
 return ok({
  id,intent:parsedIntent.value,places:parsedPlaces.value,reads:parsedReads.value,writes:parsedWrites.value,
  requires:parsedRequires.value,basedOn:parsedBasedOn.value,dependsOn:dependsOn as string[],
  before:before as JsonValue[],after:after as JsonValue[],
 });
}
function originFrom(value:JsonValue):WorldResult<ChangeOrigin>{
 if(!jsonRecord(value)||typeof value['worldId']!=='string'||!value['worldId'])return failed('MALFORMED','Origem inválida');
 const origin:ChangeOrigin={worldId:value['worldId']};
 if(value['branchId']!==undefined){if(typeof value['branchId']!=='string')return failed('MALFORMED','Ramificação inválida');origin.branchId=value['branchId'];}
 return ok(origin);
}
function objectFrom(value:JsonValue):WorldResult<WorldObject>{
 if(!jsonRecord(value)||!isRef(value['ref']))return failed('MALFORMED','Objeto sem endereço de conteúdo');
 return ok({ref:{hash:value['ref'].hash,bytes:value['ref'].bytes},value:value['value']??null});
}
export function parseChangeSet(value:JsonValue):WorldResult<ChangeSet>{
 if(!jsonRecord(value))return failed('MALFORMED','Proposta não é um objeto');
 if(value['version']!==1)return failed('MALFORMED','Versão de proposta desconhecida');
 const origins=listFrom(value['origins'],originFrom);
 if(!origins.ok)return origins;
 const operations=listFrom(value['operations'],operationFrom);
 if(!operations.ok)return operations;
 const bases=listFrom(value['bases'],objectFrom);
 if(!bases.ok)return bases;
 const ids=new Set<string>();
 for(const operation of operations.value){if(ids.has(operation.id))return failed('MALFORMED',`Operação repetida na proposta: ${operation.id}`);ids.add(operation.id);}
 const declared=value['author'];
 if(declared!==undefined&&typeof declared!=='string')return failed('MALFORMED','Autor inválido');
 // Fields a later client added are carried through instead of being dropped by a reader that does not know them, and
 // the explicit extension space travels unchanged.
 const extensions:Record<string,JsonValue>={};
 const declaredExtensions=value['extensions'];
 if(declaredExtensions!==undefined){
  if(!jsonRecord(declaredExtensions))return failed('MALFORMED','Extensões inválidas');
  for(const [key,entry] of Object.entries(declaredExtensions))extensions[key]=entry;
 }
 for(const [key,entry] of Object.entries(value))if(!['version','origins','author','operations','bases','extensions'].includes(key))extensions[key]=entry;
 const parsed:ChangeSet={version:1,origins:origins.value,operations:operations.value,bases:bases.value,extensions};
 if(typeof declared==='string')parsed.author=declared;
 return ok(parsed);
}
// Bytes and coverage are checked before a single operation is taken seriously: an object that does not match its
// address, and a region an operation uses without carrying it, are refused instead of adopted by guesswork.
export async function verifyChangeSet(set:ChangeSet,hasher:ContentHasher,codec:WorldCodec):Promise<WorldResult<ChangeSet>>{
 for(const object of set.bases){
  const bytes=codec.encode(object.value);
  if(bytes.byteLength>MAX_OBJECT_BYTES)return failed('LIMIT',`Objeto de ${bytes.byteLength} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
  if(!sameRef(await hasher.ref(bytes),object.ref))return failed('HASH_MISMATCH',`Objeto ${object.ref.hash.slice(0,12)}… não corresponde ao conteúdo`);
 }
 const carried=new Map<string,CarriedBase>();
 for(const base of carriedBases(set))carried.set(base.chunkId,base);
 for(const operation of set.operations)for(const reference of operation.basedOn){
  const base=carried.get(reference.chunkId);
  if(!base)return failed('MISSING_OBJECT',`A proposta usa a região ${reference.chunkId} sem trazer a base congelada`);
  if(base.source!==reference.source||base.normalizerVersion!==reference.normalizerVersion)return failed('CONFLICT',`A região ${reference.chunkId} veio de outra base`);
 }
 return ok(set);
}
