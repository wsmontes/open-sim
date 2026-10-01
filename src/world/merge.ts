// Three-way merges, real-base updates and compensations (docs/superpowers/specs/2026-09-29-federated-world-design.md
// §5.2–§5.4). Pure: the caller supplies the three versions, the capture and the review's decisions, so nothing here
// reads the clock, the network or a random source, and nothing is written anywhere. Three honesties are structural.
// A relation this profile does not know is never resolved in silence — an unknown component namespace becomes a
// decision, never a last layer winning. A version's balance and tick are never imported: the change is quoted by the
// destination's own price table, and data that arrived now pays no retroactive income. And a cell, region or ancestor
// the merge cannot compare cell by cell is refused with a reason instead of being composed by guesswork.
import type {BaseChunk,Cell,CityStats,GameState,ManagedChunk,Tool} from '../core/model';
import {roadClassOf} from '../core/model';
import {CHUNK,cellIndex,coordAt} from '../core/coordinates';
import {cloneJson} from '../core/protocol';
import {summarize} from '../core/simulation';
import {adopt,getCell} from '../core/world';
import type {ApprovedBaseUpdate,CellResolution} from '../core/base-update';
import {applyBaseUpdate,baseDisagreements} from '../core/base-update';
import type {Head,JsonValue,ObjectRef,WorldObject,WorldResult} from './model';
import {failed,ok,sameRef} from './model';
import type {CapturedBase} from './reality';
import type {CellField,CellPlace,ChangeOperation,ChangeOrigin,Precondition,PreparedChange} from './changes';
import {describeEdits,sameJson} from './changes';
import {CITY_PROFILE} from './city-profile';

// --- what a merge reads (spec §5.1, §5.3) -----------------------------------------------------------------------
// A `Checkpoint` satisfies this shape structurally, so this layer never imports the repository and a merge is reviewed
// against restored copies, another client's version or a version just opened from a file.
export type MergeVersion={
 head:Head;
 state:GameState;
 bases?:readonly {id:string;ref:ObjectRef}[];
 versions?:{worldProtocol:number;wireVersion:number;rules:{family:string;version:number}};
};
// What a compensation reads from the version it undoes: the ids its commit recorded. `WorldCommit` satisfies this.
export type CommitRecord={accepted:readonly string[];generation?:number};
export type MergeResolution='target'|'source';
export type ConflictKind=
 |'field'|'remove-edit'|'dependency'|'overlay'|'relation'|'spend'
 |'world'|'rules'|'ancestor'|'revision'|'captured'|'selection';
export type ConflictChoice={conflict:string;choose:MergeResolution};
export type MergeConflict={
 id:string;
 kind:ConflictKind;
 message:string;
 // A conflict nothing in the contract can decide has no choices, and a preview that carries one is never applied.
 choices:readonly MergeResolution[];
 at?:CellPlace;
 field?:CellField;
 key?:string;
 entity?:string;
 ancestor?:JsonValue|null;
 target?:JsonValue|null;
 source?:JsonValue|null;
};
export type MergePreview={
 kind:'merge'|'base';
 target:MergeVersion;
 ancestor?:MergeVersion;
 source?:MergeVersion;
 selection:readonly string[];
 actions:readonly ChangeOperation[];
 captured:readonly CapturedBase[];
 updates:readonly ApprovedBaseUpdate[];
 conflicts:readonly MergeConflict[];
 candidate:GameState;
 stats:{before:CityStats;after:CityStats};
 // `cost`, `moneyAfter` and `stats` describe the candidate: what the change would leave behind if every open question
 // stayed on the player's side. A decided review is quoted again by `resolveMerge`, so the price of adopting the other
 // side is never hidden behind the price of keeping this one.
 cost:number;
 moneyAfter:number;
 tick:number;
 // A merge has no preconditions of its own: the decisions are the conditions, and the head it rests on is in `target`.
 // A project's preconditions are checked by `prepareProject`.
 requires:readonly Precondition[];
 origins:readonly ChangeOrigin[];
 records:readonly string[];
 bases:readonly WorldObject[];
};

const SIDES:readonly CellField[]=['terrain','road','roadClass','building','stage','origin'];
type CellPart=Cell[CellField];
const DEPENDENCIES=new Map(CITY_PROFILE.dependencies.map(entry=>[entry.field,entry.dependsOn]));
const depends=(field:CellField,other:CellField):boolean=>(DEPENDENCIES.get(field)??[]).includes(other);
const sameCell=(a:Cell|undefined,b:Cell|undefined):boolean=>(a&&b?SIDES.every(field=>a[field]===b[field]):a===b);
const placeOf=(region:string,index:number):CellPlace=>{const at=coordAt(region,index);return{chunkId:region,index,x:at.x,y:at.y};};
const toolOf=(cell:Cell|undefined):Tool|null=>cell?.road?(roadClassOf(cell)==='street'?'road':roadClassOf(cell)):(cell?.building??null);
const sameBase=(a:BaseChunk,b:BaseChunk):boolean=>a.id===b.id&&a.source===b.source&&a.normalizerVersion===b.normalizerVersion&&a.cells.length===b.cells.length&&a.cells.every((cell,index)=>sameCell(cell,b.cells[index]));
const originOf=(version:MergeVersion):ChangeOrigin=>({worldId:version.head.worldId,branchId:version.head.branchId});
const statsOf=(before:GameState,after:GameState)=>({before:summarize(before),after:summarize(after)});
const compareRegions=(a:string,b:string)=>(Number(a.split(':')[0])-Number(b.split(':')[0]))||(Number(a.split(':')[1])-Number(b.split(':')[1]));
const record=(value:JsonValue|undefined):value is {[key:string]:JsonValue}=>!!value&&typeof value==='object'&&!Array.isArray(value);
// A cell is written field by field through one record, so a merge can compose exactly the fields the two sides
// changed instead of replacing the whole cell and losing what only one of them decided.
const partsOf=(cell:Cell):Record<CellField,CellPart>=>({terrain:cell.terrain,road:cell.road,roadClass:cell.roadClass,building:cell.building,stage:cell.stage,origin:cell.origin});
// A field nobody decided is absent, not present-and-undefined: carrying `road: undefined` as an own key would put a
// value the JSON contract does not have into the world state, and the canonical writer is right to refuse it.
const cellOf=(parts:Record<CellField,CellPart>):Cell=>{
 const cell:Cell={terrain:parts.terrain as Cell['terrain']};
 if(parts.road!==undefined)cell.road=parts.road as boolean;
 if(parts.roadClass!==undefined)cell.roadClass=parts.roadClass as Cell['roadClass'];
 if(parts.building!==undefined)cell.building=parts.building as Cell['building'];
 if(parts.stage!==undefined)cell.stage=parts.stage as number;
 if(parts.origin!==undefined)cell.origin=parts.origin as Cell['origin'];
 return cell;
};

type Composition={
 candidate:GameState;
 conflicts:MergeConflict[];
 actions:readonly ChangeOperation[];
 cost:number;
 records:string[];
 bases:WorldObject[];
 updates:ApprovedBaseUpdate[];
 changed:boolean;
 revision:number;
};

// The three-way comparison itself: per region the ground, then per cell the fields the two sides decided, then the
// relations this client cannot read. `chosen` is the review's decisions; a conflict that is not decided stays on the
// player's side in the candidate, which is why the candidate is what a reviewer sees before deciding anything.
function composeMerge(ancestor:MergeVersion,target:MergeVersion,source:MergeVersion,selection:readonly string[],chosen:ReadonlyMap<string,MergeResolution>):Composition{
 const conflicts:MergeConflict[]=[],records:string[]=[],bases:WorldObject[]=[],updates:ApprovedBaseUpdate[]=[];
 const working:GameState={...target.state,chunks:{...target.state.chunks},components:{...target.state.components}};
 const actions=describeEdits(source.state,originOf(source)).operations;
 for(const id of selection)if(!actions.some(action=>action.id===id))conflicts.push({id:`selection:${id}`,kind:'selection',message:`A seleção nomeia ${id}, que a origem não mudou`,choices:[]});
 const selected=actions.filter(action=>selection.includes(action.id));
 let cost=0,work=false;
 const regions=[...new Set([...Object.keys(ancestor.state.chunks),...Object.keys(target.state.chunks),...Object.keys(source.state.chunks)])].sort(compareRegions);
 for(const region of regions){
  const was=ancestor.state.chunks[region],now=target.state.chunks[region],origin=source.state.chunks[region];
  if(!now&&!origin)continue;
  // A three-way comparison needs the three versions to have frozen the region: cells nobody compared are not composed.
  if(!was){
   conflicts.push({id:`ancestor:${region}`,kind:'ancestor',message:`A região ${region} não está no ancestral comum: o merge não tem como comparar células`,choices:[]});
   continue;
  }
  // 1. The ground. New real data is adopted when the source moved its frozen region and this version did not, and every
  //    cell where the player's overlay and the new ground claim the same place becomes a decision.
  const ground=origin?.base,current=now?.base;
  if(ground&&(!current||!sameBase(current,ground))&&!sameBase(was.base,ground)){
   const ref=source.bases?.find(entry=>entry.id===region)?.ref;
   if(!ref)conflicts.push({id:`base:${region}`,kind:'revision',message:`A origem de ${region} não traz o endereço da base congelada que adotou`,choices:[]});
   else{
    bases.push({ref,value:{kind:'base-chunk',base:ground as unknown as JsonValue}});
    if(now&&current){
     const resolutions:CellResolution[]=[],diverged:string[]=[];
     for(const index of baseDisagreements(now,ground)){
      const id=`overlay:${region}#${index}`,at=placeOf(region,index);
      conflicts.push({
       id,kind:'overlay',at,choices:['target','source'],
       message:`A base nova de ${region} e a obra do jogador disputam a célula ${at.x},${at.y}`,
       target:(now.edits[String(index)]??current.cells[index]??null) as JsonValue|null,
       source:(ground.cells[index]??null) as JsonValue|null,
      });
      const decision=chosen.get(id)??'target';
      resolutions.push({at:coordAt(region,index),choose:decision==='source'?'base':'player'});
      if(decision==='target')diverged.push(`base-divergence:${region}#${index}`);
     }
     const update:ApprovedBaseUpdate={
      id:`base-update:${region}@${ref.hash.slice(0,12)}`,
      chunkId:region,
      base:ground,
      expect:{source:current.source,normalizerVersion:current.normalizerVersion},
      expectedRevision:target.state.revision+updates.length,
      resolutions,
     };
     updates.push(update);
     records.push(update.id,...diverged);
     const applied=applyBaseUpdate(working,{...update,expectedRevision:working.revision});
     if(applied.status!=='applied')conflicts.push({id:`base:${region}`,kind:'revision',message:applied.reason??`A região ${region} não pôde adotar a base nova`,choices:[]});
     else{working.chunks={...working.chunks,[region]:applied.state.chunks[region]!};working.revision=applied.state.revision;}
    }else{
     working.chunks={...working.chunks,[region]:adopt(ground)};
     records.push(`base-adopt:${region}@${ref.hash.slice(0,12)}`);
    }
   }
  }
  // 2. The work. A source overlay composes with what this version decided, field by field, and only the fields the two
  //    sides claim differently need a decision.
  for(const action of selected){
   const place=action.places[0];
   if(!place||place.chunkId!==region)continue;
   const index=place.index,chunk=working.chunks[region],brought=action.after[0];
   if(!chunk||!record(brought))continue;
   const base=chunk.base,ancestorCell=was.edits[String(index)]??was.base.cells[index];
   if(!ancestorCell)continue;
   const incoming=brought as unknown as Cell;
   // What this version decided is its overlay: a cell it took from the frozen ground is the ground, not a decision.
   const decided=chunk.edits[String(index)]??ancestorCell;
   const parts=partsOf(decided);
   const targetFields=SIDES.filter(field=>decided[field]!==ancestorCell[field]);
   const sourceFields=SIDES.filter(field=>incoming[field]!==ancestorCell[field]);
   const overlap=SIDES.filter(field=>targetFields.includes(field)&&sourceFields.includes(field));
   // Two fields that depend on each other, and that the field decisions did not both cover, are decided as a cell:
   // composing them field by field would claim a relation nobody validated, so the whole cell follows one side. A cell
   // where one side removed a value the other edited is reported as such, because that is the question being decided.
   const coupled=(field:CellField,other:CellField)=>(overlap.includes(field)&&overlap.includes(other))?false:depends(field,other)||depends(other,field);
   const pair=targetFields.find(field=>sourceFields.some(other=>other!==field&&coupled(field,other)));
   if(pair){
    const other=sourceFields.find(candidate=>candidate!==pair&&coupled(pair,candidate))!;
    const removal=overlap.some(field=>incoming[field]===undefined||decided[field]===undefined);
    const id=`dependency:${region}#${index}`;
    conflicts.push({
     id,kind:removal?'remove-edit':'dependency',at:place,choices:['target','source'],
     message:removal
      ?`Uma versão removeu ${pair===other?'a célula':`${pair} e ${other}`} em ${place.x},${place.y} e a outra editou: a célula precisa de revisão`
      :`A célula ${place.x},${place.y} mistura ${pair} com ${other}, e um campo só significa algo sobre o que ele depende`,
     target:decided as unknown as JsonValue,source:incoming as unknown as JsonValue,
    });
    const side=chosen.get(id)==='source';
    for(const field of SIDES)parts[field]=side?incoming[field]:decided[field];
   }else{
    // A field only one side changed composes on its own, a field both sides reached with the same value is one fact
    // instead of two, and a field both sides changed differently needs a decision.
    for(const field of SIDES){
     const mine=targetFields.includes(field),theirs=sourceFields.includes(field);
     if(!mine&&!theirs)continue;
     if(theirs&&!mine){parts[field]=incoming[field];continue;}
     if(!theirs||incoming[field]===decided[field])continue;
     const id=`field:${region}#${index}/${field}`;
     const removal=incoming[field]===undefined||decided[field]===undefined;
     conflicts.push({
      id,kind:removal?'remove-edit':'field',at:place,field,choices:['target','source'],
      message:`As duas versões mudaram ${field} em ${place.x},${place.y}`,
      ancestor:(ancestorCell[field]??null) as JsonValue|null,
      target:(decided[field]??null) as JsonValue|null,
      source:(incoming[field]??null) as JsonValue|null,
     });
     parts[field]=chosen.get(id)==='source'?incoming[field]:decided[field];
    }
   }
   const composed=cellOf(parts);
   // The destination's own price table charges the work the source brings; the balance of the other version never travels.
   const gained=toolOf(composed),lost=toolOf(decided);
   if(gained&&gained!==lost)cost+=CITY_PROFILE.costs[gained];
   else if(lost&&!gained)cost+=CITY_PROFILE.costs.demolish;
   const edits={...chunk.edits};
   if(sameCell(composed,base.cells[index]))delete edits[String(index)];else edits[String(index)]=composed;
   if(!sameCell(composed,chunk.edits[String(index)]??base.cells[index]))work=true;
   working.chunks={...working.chunks,[region]:{...chunk,edits}};
  }
 }
 // 3. Relations. The city profile implements no component namespace, so a relation another profile wrote is unknown
 //    here: it is preserved and only adopted when the review says so, never by whoever arrived last.
 const namespaces=[...new Set([...Object.keys(ancestor.state.components),...Object.keys(target.state.components),...Object.keys(source.state.components)])].sort();
 for(const key of namespaces){
  const mine=ancestor.state.components[key]??{},theirs=target.state.components[key]??{},brought=source.state.components[key]??{};
  const entities=[...new Set([...Object.keys(mine),...Object.keys(theirs),...Object.keys(brought)])].sort();
  for(const entity of entities){
   const before=(mine[entity]??null) as JsonValue|null,held=(theirs[entity]??null) as JsonValue|null,incoming=(brought[entity]??null) as JsonValue|null;
   if(sameJson(before,incoming)||sameJson(held,incoming))continue;
   const id=`component:${key}@${entity}`;
   conflicts.push({
    id,kind:'relation',key,entity,choices:['target','source'],
    message:`O namespace ${key} não é conhecido aqui: a mudança de ${entity} precisa de revisão`,
    ancestor:before,target:held,source:incoming,
   });
   if(chosen.get(id)==='source'){
    const namespace={...(working.components[key]??{})};
    if(incoming===null)delete namespace[entity];else namespace[entity]=cloneJson(incoming);
    working.components={...working.components,[key]:namespace};
    work=true;
   }
  }
 }
 // 4. The balance. Money, tick and revision are never summed across versions: the destination's own balance has to fit
 //    the whole change, and two operations that fit separately are refused together instead of applied half way.
 let candidate=working;
 if(cost>target.state.money)conflicts.push({id:'spend',kind:'spend',choices:[],message:`O conjunto custa ${cost} e esta versão tem ${target.state.money}`});
 else candidate={...working,money:target.state.money-cost};
 // The revision counts accepted changes: every region adoption already moved it, and the work composed around them is
 // one more change.
 const revision=working.revision+(work?1:0);
 return {candidate,conflicts,actions:selected,cost,records,bases,updates,changed:work||updates.length>0,revision};
}

export function previewMerge(ancestor:MergeVersion|null,target:MergeVersion,source:MergeVersion,selection:readonly string[]):MergePreview{
 const empty:MergePreview={
  kind:'merge',target,source,selection:[...selection],actions:[],captured:[],updates:[],conflicts:[],
  candidate:target.state,stats:statsOf(target.state,target.state),cost:0,moneyAfter:target.state.money,tick:target.state.tick,
  requires:[],origins:[originOf(target)],records:[],bases:[],
 };
 if(!ancestor)return {...empty,conflicts:[{id:'ancestor',kind:'ancestor',message:'Um merge precisa do ancestral comum das duas versões',choices:[]}]};
 const refused:MergeConflict[]=[];
 if(ancestor.head.worldId!==target.head.worldId||ancestor.head.worldId!==source.head.worldId)refused.push({id:'world',kind:'world',message:`As três versões precisam ser do mesmo mundo (${ancestor.head.worldId}, ${target.head.worldId}, ${source.head.worldId})`,choices:[]});
 if(ancestor.head.generation>target.head.generation||ancestor.head.generation>source.head.generation)refused.push({id:'ancestor-newer',kind:'ancestor',message:'O ancestral comum é mais novo que uma das versões',choices:[]});
 const mine=target.versions?.rules,theirs=source.versions?.rules,shared=ancestor.versions?.rules;
 if(mine&&theirs&&(mine.family!==theirs.family||mine.version!==theirs.version))refused.push({id:'rules',kind:'rules',message:`As versões seguem regras diferentes (${mine.family} v${mine.version} e ${theirs.family} v${theirs.version})`,choices:[]});
 if(shared&&mine&&(shared.family!==mine.family||shared.version!==mine.version))refused.push({id:'rules',kind:'rules',message:'O ancestral comum segue outras regras',choices:[]});
 if(refused.length)return {...empty,ancestor,conflicts:refused};
 const composition=composeMerge(ancestor,target,source,selection,new Map());
 return {
  ...empty,
  ancestor,
  actions:composition.actions,
  conflicts:composition.conflicts,
  candidate:{...composition.candidate,revision:composition.revision},
  stats:statsOf(target.state,{...composition.candidate,revision:composition.revision}),
  cost:composition.cost,
  moneyAfter:composition.candidate.money,
  tick:composition.candidate.tick,
  records:composition.records,
  bases:composition.bases,
  updates:composition.updates,
 };
}

export function previewBaseUpdate(target:MergeVersion,captured:readonly CapturedBase[]):MergePreview{
 const conflicts:MergeConflict[]=[],updates:ApprovedBaseUpdate[]=[],records:string[]=[],bases:WorldObject[]=[];
 const seen=new Set<string>();
 let state=target.state;
 for(const capture of captured){
  const region=capture.base.id,managed=target.state.chunks[region];
  let broken=false;
  const fail=(id:string,kind:'captured'|'revision',message:string)=>{broken=true;conflicts.push({id,kind,message,choices:[]});};
  if(capture.base.cells.length!==CHUNK*CHUNK)fail(`captured:${region}`,'captured',`A captura de ${region} não é uma região completa do perfil cidade`);
  const ground=capture.objects.find(entry=>sameRef(entry.ref,capture.revision.entity));
  if(!ground||!sameJson(ground.value,{kind:'base-chunk',base:capture.base as unknown as JsonValue}))fail(`captured:${region}`,'captured',`Os objetos de ${region} não correspondem à revisão que os cita`);
  if(!capture.objects.some(object=>record(object.value)&&object.value['kind']==='capture'&&sameJson(object.value['revision']??null,capture.revision as unknown as JsonValue)&&sameJson(object.value['claims']??null,capture.claims as unknown as JsonValue)))fail(`capture-record:${region}`,'captured',`A captura de ${region} viaja sem o registro da revisão que a explica`);
  if(!managed)fail(`captured:${region}`,'captured',`A região ${region} não está adotada nesta versão`);
  if(broken)continue;
  // The revision has to supersede the base this version rests on: a capture of another ground is not an update of this one.
  const held=target.bases?.find(entry=>entry.id===region)?.ref,supersedes=held?capture.revision.previous.some(ref=>sameRef(ref,held)):false;
  if(!held)fail(`revision:${region}`,'revision',`Esta versão não declara o endereço da base congelada de ${region}`);
  else if(!supersedes)fail(`revision:${region}`,'revision',`A revisão capturada de ${region} não sucede a base desta versão`);
  if(broken)continue;
  if(sameBase(managed!.base,capture.base)){fail(`captured:${region}`,'captured',`A captura de ${region} não muda nada: é a base que esta versão já tem`);continue;}
  const resolutions:CellResolution[]=[],diverged:string[]=[];
  for(const index of baseDisagreements(managed!,capture.base)){
   const id=`overlay:${region}#${index}`,at=placeOf(region,index);
   conflicts.push({
    id,kind:'overlay',at,choices:['target','source'],
    message:`A base nova de ${region} e a obra do jogador disputam a célula ${at.x},${at.y}`,
    target:(managed!.edits[String(index)]??managed!.base.cells[index]??null) as JsonValue|null,
    source:(capture.base.cells[index]??null) as JsonValue|null,
   });
   // The candidate keeps the player's work, which is what the spec asks of a preview nobody has decided yet.
   resolutions.push({at:coordAt(region,index),choose:'player'});
   diverged.push(`base-divergence:${region}#${index}`);
  }
  const update:ApprovedBaseUpdate={
   id:`base-update:${region}@${capture.revision.entity.hash.slice(0,12)}`,
   chunkId:region,
   base:capture.base,
   expect:{source:managed!.base.source,normalizerVersion:managed!.base.normalizerVersion},
   expectedRevision:target.state.revision+updates.length,
   resolutions,
  };
  updates.push(update);
  records.push(update.id,...diverged);
  for(const object of capture.objects)if(!seen.has(object.ref.hash)){seen.add(object.ref.hash);bases.push(object);}
  const applied=applyBaseUpdate(state,update);
  if(applied.status!=='applied')conflicts.push({id:`base:${region}`,kind:'revision',message:applied.reason??`A região ${region} não pôde adotar a base nova`,choices:[]});
  else state=applied.state;
 }
 return {
  kind:'base',target,captured:[...captured],selection:[],actions:[],updates,conflicts,
  candidate:state,stats:statsOf(target.state,state),cost:0,moneyAfter:state.money,tick:state.tick,
  requires:[],origins:[originOf(target)],records,bases,
 };
}

// A decision is only accepted for a conflict that asked for one, exactly once: a review that answers a question the
// preview did not ask, or answers it twice, is a caller error instead of a resolution.
function decide(preview:MergePreview,choices:readonly ConflictChoice[]):WorldResult<ReadonlyMap<string,MergeResolution>>{
 const decided=new Map<string,MergeResolution>();
 const asked=new Map(preview.conflicts.map(conflict=>[conflict.id,conflict]));
 for(const choice of choices){
  const conflict=asked.get(choice.conflict);
  if(!conflict)return failed('MALFORMED',`A decisão nomeia um conflito que a prévia não levanta: ${choice.conflict}`);
  if(!conflict.choices.length)return failed('MALFORMED',`O conflito ${choice.conflict} não é decidível`);
  if(decided.has(choice.conflict))return failed('MALFORMED',`O conflito ${choice.conflict} foi decidido duas vezes`);
  decided.set(choice.conflict,choice.choose);
 }
 for(const conflict of preview.conflicts){
  if(!conflict.choices.length)return failed(conflict.kind==='ancestor'?'MISSING_OBJECT':conflict.kind==='selection'?'MALFORMED':'CONFLICT',conflict.message);
  if(!decided.has(conflict.id))return failed('CONFLICT',`Falta decidir o conflito ${conflict.id}: ${conflict.message}`);
 }
 return ok(decided);
}

export function resolveMerge(preview:MergePreview,choices:readonly ConflictChoice[]):WorldResult<PreparedChange>{
 const decided=decide(preview,choices);
 if(!decided.ok)return decided;
 const chosen=decided.value;
 if(preview.kind==='base'){
  if(!preview.captured.length)return failed('MALFORMED','A prévia não tem nenhuma base para atualizar');
  let state=preview.target.state;
  const records:string[]=[];
  for(const update of preview.updates){
   const resolutions:CellResolution[]=update.resolutions.map(resolution=>{
    const decision=chosen.get(`overlay:${update.chunkId}#${cellIndex(resolution.at)}`)??'target';
    return {at:resolution.at,choose:decision==='source'?'base':'player'};
   });
   records.push(update.id);
   for(const resolution of resolutions)if(resolution.choose==='player')records.push(`base-divergence:${update.chunkId}#${cellIndex(resolution.at)}`);
   const applied=applyBaseUpdate(state,{...update,resolutions,expectedRevision:state.revision});
   if(applied.status!=='applied')return failed('CONFLICT',applied.reason??`A atualização de ${update.chunkId} foi recusada`);
   state=applied.state;
  }
  if(state===preview.target.state)return failed('MALFORMED','Nada a integrar: a atualização não muda esta versão');
  return ok({
   origins:[originOf(preview.target)],target:preview.target.head,selection:[],operations:[],bases:[...preview.bases],
   cost:0,moneyAfter:state.money,tick:state.tick,requires:[],state,records,
  });
 }
 if(!preview.ancestor||!preview.source)return failed('MALFORMED','A prévia não tem as duas versões de um merge');
 const composition=composeMerge(preview.ancestor,preview.target,preview.source,preview.selection,chosen);
 if(!composition.changed)return failed('MALFORMED','Nada a integrar: nenhuma operação selecionada e nenhuma base nova');
 return ok({
  origins:[originOf(preview.target)],target:preview.target.head,selection:[...preview.selection],operations:[],
  bases:composition.bases,cost:composition.cost,moneyAfter:composition.candidate.money,tick:composition.candidate.tick,
  requires:[],state:composition.candidate,records:composition.records,
 });
}

// --- undo (spec §5.2 "Desfazer") --------------------------------------------------------------------------------
// Undoing published work produces a compensating operation in a new version, priced by the rules of today: a power
// plant that already fed the city is demolished at the current price of a demolition, the income it paid is not
// refunded, and the version that built it stays in the shared history. A commit whose ids do not name an operation, a
// demolition whose ground is gone and a base adoption are all refused instead of guessed.
const BUILD=/^build:([a-z]+)@(\d+):(\d+)#(\d+)$/;
export function prepareCompensation(target:MergeVersion,commit:CommitRecord):WorldResult<PreparedChange>{
 const operations:ChangeOperation[]=[],records:string[]=[],requires:Precondition[]=[];
 let cost=0;
 for(const entry of commit.accepted){
  if(entry.startsWith('base-divergence:'))continue;
  const build=BUILD.exec(entry);
  if(!build){
   if(/^tick@/.test(entry))continue;
   if(/^demolish@/.test(entry))return failed('CONFLICT',`A versão registra ${entry}: o que foi demolido não volta por uma operação compensatória`);
   if(/^opaque@/.test(entry))return failed('CONFLICT',`A versão registra ${entry} sem intenção: não há como compensá-la`);
   if(/^(base-update|base-adopt):/.test(entry))return failed('CONFLICT',`A versão registra ${entry}: voltar a outra base é abrir uma versão anterior, não uma compensação`);
   if(/^component:/.test(entry))return failed('CONFLICT',`A versão registra ${entry}: o valor anterior do componente não está no commit`);
   return failed('MALFORMED',`A versão registra ${entry}, que não nomeia uma operação compensável`);
  }
  const region=`${build[2]}:${build[3]}`,index=Number(build[4]),at=placeOf(region,index),managed=target.state.chunks[region];
  if(!managed)return failed('MISSING_OBJECT',`A região ${region} não está nesta versão`);
  const cell=getCell(target.state,{x:at.x,y:at.y});
  if(!cell)return failed('MISSING_OBJECT',`A célula ${at.x},${at.y} não está nesta versão`);
  const recordedTool=build[1] as Tool;
  if(!CITY_PROFILE.tools.includes(recordedTool))return failed('MALFORMED',`A versão registra uma ferramenta desconhecida: ${build[1]}`);
  const holds=toolOf(cell)===recordedTool;
  if(!holds)return failed('CONFLICT',`A ${build[1]} registrada em ${at.x},${at.y} já não está nesta versão`);
  const left:Cell={terrain:cell.terrain};
  operations.push({
   id:`demolish@${region}#${index}`,
   intent:{kind:'demolish'},
   places:[at],
   reads:SIDES.filter(field=>field==='road'||field==='roadClass'||field==='building').map(field=>({scope:'cell',at,field})),
   writes:SIDES.filter(field=>cell[field]!==left[field]).map(field=>({scope:'cell',at,field})),
   requires:[{kind:'cell-occupied',at}],
   basedOn:[{chunkId:region,source:managed.base.source,normalizerVersion:managed.base.normalizerVersion}],
   dependsOn:[],
   before:[cell as unknown as JsonValue],
   after:[left as unknown as JsonValue],
  });
  requires.push({kind:'cell-occupied',at});
  records.push(`compensation:${entry}`);
  cost+=CITY_PROFILE.costs.demolish;
 }
 if(!operations.length)return failed('MALFORMED','A versão não registra operações que possam ser compensadas');
 if(cost>target.state.money)return failed('CONFLICT',`A compensação custa ${cost} e esta versão tem ${target.state.money}`);
 return ok({
  origins:[originOf(target)],target:target.head,selection:operations.map(operation=>operation.id),operations,
  bases:[],cost,moneyAfter:target.state.money-cost,tick:target.state.tick,requires,records,
 });
}
