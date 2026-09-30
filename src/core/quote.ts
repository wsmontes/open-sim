import type {Action,BaseChunk,GameState,ManagedChunk} from './model';
import {COST} from './model';
import {cellIndex,chunkId,validCell} from './coordinates';
import {adopt} from './world';
export type Quote = {status:'ok'|'blocked';cost:number;reason?:string};
// Mirrors applyCommand: same order of checks, same dedupe, same partial adoption of available bases.
export function quoteAction(state:GameState,action:Action,available:readonly BaseChunk[]):Quote {
 const blocked=(cost:number,reason:string):Quote=>({status:'blocked',cost,reason});
 if(action.type==='tick')return {status:'ok',cost:0};
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
   if(action.tool==='road'&&old.road)continue;
   if(old.building||old.road)return blocked(cost,'Demolir primeiro para liberar o terreno');
   cost+=COST[action.tool];
   chunks[id]={...chunk,edits:{...chunk.edits,[i]:action.tool==='road'?{terrain:old.terrain,road:true,origin:'player'}:{terrain:old.terrain,building:action.tool,stage:action.tool==='park'||action.tool==='power'?1:0,origin:'player'}}};
  }else{
   if(!old.building&&!old.road)continue;
   cost+=COST.demolish;chunks[id]={...chunk,edits:{...chunk.edits,[i]:{terrain:old.terrain}}};
  }
 }
 return cost>state.money?blocked(cost,'Dinheiro insuficiente'):{status:'ok',cost};
}
