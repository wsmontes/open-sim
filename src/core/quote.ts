import {validCalibration} from './municipal-calibration';
import type {Action,BaseChunk,GameState,ManagedChunk} from './model';
import {BORROW_MAX,COST,SERVICES_MAX,SERVICES_MIN,TAX_MAX,TAX_MIN,isRoadTool} from './model';
import {cellIndex,chunkId,validCell} from './coordinates';
import {adopt,placement} from './world';
import {assertJsonSafe,isComponentKey,isEntityId} from './protocol';
import {policyOf} from './simulation';
export type Quote = {status:'ok'|'blocked';cost:number;reason?:string};
// Mirrors applyCommand: same order of checks, same dedupe, same partial adoption of available bases.
export function quoteAction(state:GameState,action:Action,available:readonly BaseChunk[]):Quote {
 const blocked=(cost:number,reason:string):Quote=>({status:'blocked',cost,reason});
 if(action.type==='tick')return {status:'ok',cost:0};
 if(action.type==='component'){
  if(!isComponentKey(action.key))return blocked(0,'Namespace inválido');
  if(!isEntityId(action.entity))return blocked(0,'Identificador inválido');
  try{assertJsonSafe(action.value,'Valor do componente');}catch(error){return blocked(0,(error as Error).message);}
  return {status:'ok',cost:0};
 }
 if(action.type==='municipal-calibration'){
  if(action.calibration!==null&&!validCalibration(action.calibration))return blocked(0,'Calibração municipal inválida');
  try{assertJsonSafe(action.calibration,'Calibração municipal');}catch{return blocked(0,'Calibração municipal inválida');}
  return {status:'ok',cost:0};
 }
 if(action.type==='policy'){
  // Moving a lever is free, and a loan is the treasury taking money in rather than paying it out: the quote is zero
  // either way. The same range checks as `applyCommand`, so the preview never offers something the command refuses.
  const policy=policyOf(state);
  const tax=action.tax===undefined?policy.tax:Math.round(action.tax);
  const services=action.services===undefined?policy.services:Math.round(action.services);
  const borrow=action.borrow===undefined?0:action.borrow;
  if(!Number.isFinite(tax)||tax<TAX_MIN||tax>TAX_MAX)return blocked(0,'Imposto fora do intervalo');
  if(!Number.isFinite(services)||services<SERVICES_MIN||services>SERVICES_MAX)return blocked(0,'Serviços fora do intervalo');
  if(!Number.isFinite(borrow)||borrow<0||borrow>BORROW_MAX||Math.round(borrow)!==borrow)return blocked(0,'Empréstimo inválido');
  if(tax===policy.tax&&services===policy.services&&borrow===0)return blocked(0,'Nada a mudar');
  return {status:'ok',cost:0};
 }
 if(!Array.isArray(action.cells)||!action.cells.length||action.cells.length>1024||action.cells.some(p=>!p||!validCell(p)))return blocked(0,'Seleção inválida');
 if(action.type==='build'&&!Object.hasOwn(COST,action.tool))return blocked(0,'Ferramenta inválida');
 const chunks:Record<string,ManagedChunk>={...state.chunks};
 let cost=0;
 for(const p of new Map(action.cells.map(p=>[`${p.x}:${p.y}`,p])).values()){
  const id=chunkId(p);
  if(!chunks[id]){const base=available.find(b=>b.id===id);if(!base)return blocked(cost,'Espere o mapa carregar');chunks[id]=adopt(base);}
  const chunk=chunks[id],i=cellIndex(p),old=chunk.edits[i]??chunk.base.cells[i];
  if(action.type==='build'){
   if(old.terrain==='water')return blocked(cost,'Não é possível construir na água');
   if(isRoadTool(action.tool)&&old.road)continue;
   if(old.building||old.road)return blocked(cost,'Demolir primeiro para liberar o terreno');
   cost+=COST[action.tool];
   chunks[id]={...chunk,edits:{...chunk.edits,[i]:placement(action.tool,old.terrain)}};
  }else{
   if(!old.building&&!old.road)continue;
   cost+=COST.demolish;chunks[id]={...chunk,edits:{...chunk.edits,[i]:{terrain:old.terrain}}};
  }
 }
 return cost>state.money?blocked(cost,'Dinheiro insuficiente'):{status:'ok',cost};
}
