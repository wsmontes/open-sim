import {policyOf,stepSimulation,withPolicy} from './simulation';
import type {Action,BaseChunk,Command,CommandResult,GameState} from './model';
import {BORROW_MAX,COST,FORMAT_VERSION,RULES_VERSION,SERVICES_MAX,SERVICES_MIN,TAX_MAX,TAX_MIN,isRoadTool} from './model';
import {adopt,getCell,placement} from './world';
import {assertJsonSafe,cloneJson,isComponentKey,isEntityId} from './protocol';
import {cellIndex,chunkId,validCell} from './coordinates';
export function createGame(worldId:string,seed:number,initial:BaseChunk):GameState {
 return {formatVersion:FORMAT_VERSION as 1,rulesVersion:RULES_VERSION as 3,worldId,seed,revision:0,tick:0,money:20000,chunks:{[initial.id]:adopt(initial)},actors:{},components:{}};
}
export function applyCommand(state:GameState,c:Command,available:readonly BaseChunk[]):CommandResult {
 const reject=(reason:string):CommandResult=>({state,status:'rejected',reason});
 if(c.version!==1||c.worldId!==state.worldId||!/^[-\w]{1,80}$/.test(c.actorId)||['__proto__','constructor','prototype'].includes(c.actorId)||!Number.isSafeInteger(c.sequence)||c.sequence<1) return reject('Comando inválido');
 const last=state.actors[c.actorId]??0;
 if(c.sequence<=last)return{state,status:'duplicate'};
 if(c.sequence!==last+1||c.expectedRevision!==state.revision)return reject('A partida mudou. Tente novamente.');
 const a:Action=c.action;
 if(!a||!['build','demolish','tick','component','policy'].includes(a.type))return reject('Ação inválida');
 let next:GameState={...state,chunks:{...state.chunks},actors:{...state.actors}};
 if(a.type==='tick')return {status:'applied',state:{...stepSimulation(state),revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}}};
 if(a.type==='component'){
  if(!isComponentKey(a.key))return reject('Namespace inválido');
  if(!isEntityId(a.entity))return reject('Identificador inválido');
  try{assertJsonSafe(a.value,'Valor do componente');}catch(error){return reject((error as Error).message);}
  const namespace={...next.components[a.key]};
  if(a.value===null)delete namespace[a.entity];else namespace[a.entity]=cloneJson(a.value);
  next={...next,components:{...next.components,[a.key]:namespace}};
  return {status:'applied',state:{...next,revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}}};
 }
 if(a.type==='policy'){
  const policy=policyOf(state);
  const tax=a.tax===undefined?policy.tax:Math.round(a.tax);
  const services=a.services===undefined?policy.services:Math.round(a.services);
  const borrow=a.borrow===undefined?0:a.borrow;
  if(!Number.isFinite(tax)||tax<TAX_MIN||tax>TAX_MAX)return reject('Imposto fora do intervalo');
  if(!Number.isFinite(services)||services<SERVICES_MIN||services>SERVICES_MAX)return reject('Serviços fora do intervalo');
  if(!Number.isFinite(borrow)||borrow<0||borrow>BORROW_MAX||Math.round(borrow)!==borrow)return reject('Empréstimo inválido');
  if(tax===policy.tax&&services===policy.services&&borrow===0)return reject('Nada a mudar');
  // A loan is money now against money later: the balance rises with the debt, and the month that follows charges the
  // interest on it. Both are written in one step, so two clients replaying these commands agree on both.
  const changed=withPolicy({...next,money:next.money+borrow},{...policy,tax,services,debt:policy.debt+borrow});
  return {status:'applied',state:{...changed,revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}}};
 }
 if(!Array.isArray(a.cells)||!a.cells.length||a.cells.length>1024||a.cells.some(p=>!p||!validCell(p)))return reject('Seleção inválida');
 if(a.type==='build'&&!Object.hasOwn(COST,a.tool))return reject('Ferramenta inválida');
 const unique=[...new Map(a.cells.map(p=>[`${p.x}:${p.y}`,p])).values()];
 let cost=0;
 for(const p of unique){
  const id=chunkId(p); if(!next.chunks[id]){const base=available.find(b=>b.id===id);if(!base)return reject('Espere o mapa carregar');next.chunks[id]=adopt(base);}
  const old=getCell(next,p)!;const chunk=next.chunks[id];
  if(a.type==='build'){
   if(old.terrain==='water')return reject('Não é possível construir na água');
   if(isRoadTool(a.tool)&&old.road)continue;
   if(old.building||old.road)return reject('Demolir primeiro para liberar o terreno');
   cost+=COST[a.tool];
   next.chunks[id]={...chunk,edits:{...chunk.edits,[cellIndex(p)]:placement(a.tool,old.terrain)}};
  }else{
   if(!old.building&&!old.road)continue;
   cost+=COST.demolish;next.chunks[id]={...chunk,edits:{...chunk.edits,[cellIndex(p)]:{terrain:old.terrain}}};
  }
 }
 if(cost>state.money)return reject('Dinheiro insuficiente');
 next={...next,money:state.money-cost,revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}};
 return {state:next,status:'applied'};
}
