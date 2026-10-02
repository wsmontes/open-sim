// The city profile: which tools exist, what they cost, which terrain they accept, which fields depend on which, and
// how an operation is quoted and replayed. The economy itself stays in `src/core` — this file declares the profile and
// calls those rules instead of re-implementing them, so a project proposed from another version is priced by the
// destination's own rules and balance (spec §5.3: never bring a fork's cash as revenue).
import type {Action,BaseChunk,Cell,Command,GameState,Tool} from '../core/model';
import {COST} from '../core/model';
import {applyCommand} from '../core/commands';
import type {Quote} from '../core/quote';
import {quoteAction} from '../core/quote';
import {adopt,getCell} from '../core/world';
import type {WorldError,WorldResult} from './model';
import {failed,ok,sameRef} from './model';
import type {BaseReference,CarriedBase,CellField,ChangeOperation,ChangeSet,Precondition,PreparedChange,ProjectTarget} from './changes';
import {PROJECT_ACTOR,carriedBases} from './changes';

export type FieldDependency={field:CellField;dependsOn:readonly CellField[]};
export type CityProfile={
 id:string;
 version:number;
 tools:readonly Tool[];
 costs:Record<Tool|'demolish',number>;
 terrains:readonly Cell['terrain'][];
 fields:readonly CellField[];
 dependencies:readonly FieldDependency[];
 quote(state:GameState,action:Action,available:readonly BaseChunk[]):Quote;
};
export const CITY_PROFILE:CityProfile={
 id:'city',
 version:1,
 tools:['road','avenue','highway','residential','commercial','industrial','park','power'],
 costs:COST,
 terrains:['land','water','green'],
 fields:['terrain','road','roadClass','building','stage','origin'],
 // A field only means something on top of what it depends on: the class belongs to a road, a building needs its
 // terrain decided and the street below it clear, and a stage belongs to a building.
 dependencies:[
  {field:'road',dependsOn:['terrain']},
  {field:'roadClass',dependsOn:['road']},
  {field:'building',dependsOn:['terrain','road']},
  {field:'stage',dependsOn:['building']},
  {field:'origin',dependsOn:[]},
 ],
 quote:(state,action,available)=>quoteAction(state,action,available),
};

function actionOf(operation:ChangeOperation):Action|null{
 const cells=operation.places.map(place=>({x:place.x,y:place.y}));
 const intent=operation.intent;
 if(intent.kind==='build')return {type:'build',tool:intent.tool,cells};
 if(intent.kind==='demolish')return {type:'demolish',cells};
 if(intent.kind==='component')return {type:'component',key:intent.key,entity:intent.entity,value:operation.after[0]??null};
 if(intent.kind==='policy')return {type:'policy',...(intent.tax!==undefined?{tax:intent.tax}:{}),...(intent.services!==undefined?{services:intent.services}:{}),...(intent.borrow!==undefined?{borrow:intent.borrow}:{})};
 return null;
}
// The frozen base a change rests on has to be the one the destination already has, or one it can adopt from the
// proposal. A region the destination never adopted is not a reason to invent terrain; it is a missing object unless the
// proposal carried that exact base.
function baseProblem(target:ProjectTarget,carried:readonly CarriedBase[],reference:BaseReference):WorldError|null{
 const carriedBase=carried.find(entry=>entry.chunkId===reference.chunkId);
 const known=target.state.chunks[reference.chunkId];
 if(known){
  if(known.base.source!==reference.source||known.base.normalizerVersion!==reference.normalizerVersion)return {code:'CONFLICT',message:`O destino tem outra base na região ${reference.chunkId}`};
  const frozen=target.bases?.find(entry=>entry.id===reference.chunkId);
  if(carriedBase&&frozen&&!sameRef(frozen.ref,carriedBase.ref))return {code:'CONFLICT',message:`A região ${reference.chunkId} do destino repousa em outra base congelada`};
  return null;
 }
 if(!carriedBase)return {code:'MISSING_OBJECT',message:`A região ${reference.chunkId} não existe no destino e a proposta não trouxe a base`};
 if(carriedBase.source!==reference.source||carriedBase.normalizerVersion!==reference.normalizerVersion)return {code:'CONFLICT',message:`A base que a proposta traz para ${reference.chunkId} não corresponde à referência`};
 return null;
}
function cellProblem(state:GameState,requirement:Precondition):WorldError|null{
 if(requirement.kind==='chunk-base')return null;
 const at=requirement.at,cell=getCell(state,{x:at.x,y:at.y});
 if(!cell)return {code:'MISSING_OBJECT',message:`A região ${at.chunkId} não existe no destino`};
 if(requirement.kind==='cell-clear'&&(cell.building||cell.road))return {code:'CONFLICT',message:`A célula ${at.x},${at.y} do destino já está ocupada`};
 if(requirement.kind==='cell-occupied'&&!cell.building&&!cell.road)return {code:'CONFLICT',message:`A célula ${at.x},${at.y} do destino está livre`};
 if(requirement.kind==='cell-terrain'&&cell.terrain!==requirement.terrain)return {code:'CONFLICT',message:`A célula ${at.x},${at.y} do destino tem outro terreno`};
 return null;
}

// A preview is a decision about the destination: revalidate every precondition against its state, quote every selected
// operation with its own rules and balance, and only then say what the project would cost. A selection that does not
// exist, a tick or an opaque edit, a stale cell and a balance that cannot pay are all refusals — never a partial
// application later. `author` on the proposal is deliberately not read here.
export function prepareProject(target:ProjectTarget,changes:ChangeSet,selection:readonly string[]):WorldResult<PreparedChange>{
 if(!selection.length)return failed('MALFORMED','Nenhuma operação selecionada');
 const byId=new Map(changes.operations.map(operation=>[operation.id,operation]));
 const chosen:ChangeOperation[]=[];
 for(const id of selection){
  const operation=byId.get(id);
  if(!operation)return failed('MALFORMED',`Operação desconhecida na seleção: ${id}`);
  chosen.push(operation);
 }
 const carried=carriedBases(changes);
 // The state the project would land on: regions the destination already adopted as they are, plus the frozen bases the
 // proposal carried, adopted with no overlay. A precondition is about that state, never about a region the destination
 // does not have while the proposal brought exactly the base it needs.
 const projected:GameState={...target.state,chunks:{...Object.fromEntries(carried.map(entry=>[entry.chunkId,adopt(entry.base)])),...target.state.chunks}};
 for(const operation of chosen){
  if(operation.intent.kind==='tick')return failed('CONFLICT',`Ticks de outra versão não entram como projeto (${operation.id})`);
  if(operation.intent.kind==='opaque')return failed('CONFLICT',`A operação ${operation.id} não registra intenção e precisa de revisão antes de ser adotada`);
  for(const reference of operation.basedOn){
   const problem=baseProblem(target,carried,reference);
   if(problem)return failed(problem.code,problem.message);
  }
  for(const requirement of operation.requires){
   const problem=cellProblem(projected,requirement);
   if(problem)return failed(problem.code,problem.message);
  }
 }
 const available=[...Object.keys(projected.chunks).sort().map(id=>projected.chunks[id]!.base)];
 let cost=0,preview=projected;
 for(const operation of chosen){
  const action=actionOf(operation);
  if(!action)return failed('MALFORMED',`A operação ${operation.id} não pode ser precificada`);
  const quote=CITY_PROFILE.quote(preview,action,available);
  if(quote.status==='blocked'){
   const message=quote.reason==='Dinheiro insuficiente'?`O conjunto custa ${cost+quote.cost} e esta versão tem ${target.state.money}`:quote.reason??`A operação ${operation.id} foi recusada na prévia`;
   return failed(message.includes('Espere o mapa carregar')?'MISSING_OBJECT':'CONFLICT',message);
  }
  cost+=quote.cost;
  // The preview follows the exact command path the integration will use. This matters for policy/borrowing and for
  // dependent operations: a second action sees the state left by the first instead of being quoted against a fiction.
  const command:Command={version:1,worldId:preview.worldId,actorId:PROJECT_ACTOR,sequence:(preview.actors[PROJECT_ACTOR]??0)+1,expectedRevision:preview.revision,action};
  const applied=applyCommand(preview,command,available);
  if(applied.status!=='applied')return failed('CONFLICT',`A operação ${operation.id} foi recusada na prévia: ${applied.reason??applied.status}`);
  preview=applied.state;
 }
 return ok({
  origins:changes.origins,target:target.head,selection:[...selection],operations:chosen,bases:changes.bases,
  cost,moneyAfter:preview.money,tick:target.state.tick,
  requires:chosen.flatMap(operation=>operation.requires),
 });
}

// Replaying a project is the destination's own action under its own actor: the sequence and the revision come from the
// destination state, and the declared author of the file never becomes an actor. Each selected operation goes through
// the ordinary command path, so the economy, the terrain rules and the adoption of a carried base are the same ones a
// local player gets; a refusal anywhere returns the destination untouched.
export function integrateProject(target:GameState,prepared:PreparedChange,available:readonly BaseChunk[]=[]):WorldResult<GameState>{
 // A composed change already names the state it produces: two versions the caller holds are compared cell by cell, not
 // replayed through somebody else's actions. The state still has to belong to the same world, so a prepared change can
 // never move a version into another identity.
 if(prepared.state)return prepared.state.worldId===target.worldId?ok(prepared.state):failed('MALFORMED','O estado da prévia é de outro mundo');
 const pool=[...available,...carriedBases(prepared).map(entry=>entry.base)];
 let state=target;
 for(const operation of prepared.operations){
  const action=actionOf(operation);
  if(!action)return failed('MALFORMED',`A operação ${operation.id} não pode ser reexecutada`);
  const command:Command={version:1,worldId:state.worldId,actorId:PROJECT_ACTOR,sequence:(state.actors[PROJECT_ACTOR]??0)+1,expectedRevision:state.revision,action};
  const result=applyCommand(state,command,pool);
  if(result.status!=='applied')return failed('CONFLICT',`A operação ${operation.id} foi recusada: ${result.reason??result.status}`);
  state=result.state;
 }
 return ok(state);
}
