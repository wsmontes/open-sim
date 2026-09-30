import {stepSimulation} from './simulation';
import type {Action,BaseChunk,Command,CommandResult,GameState} from './model';
import {COST} from './model';
import {adopt,getCell} from './world';
import {cellIndex,chunkId,validCell} from './coordinates';
export function createGame(worldId:string,seed:number,initial:BaseChunk):GameState {
 return {formatVersion:1,rulesVersion:1,worldId,seed,revision:0,tick:0,money:20000,chunks:{[initial.id]:adopt(initial)},actors:{}};
}
export function applyCommand(state:GameState,c:Command,available:readonly BaseChunk[]):CommandResult {
 const reject=(reason:string):CommandResult=>({state,status:'rejected',reason});
 if(c.version!==1||c.worldId!==state.worldId||!/^[-\w]{1,80}$/.test(c.actorId)||['__proto__','constructor','prototype'].includes(c.actorId)||!Number.isSafeInteger(c.sequence)||c.sequence<1) return reject('Comando inválido');
 const last=state.actors[c.actorId]??0;
 if(c.sequence<=last)return{state,status:'duplicate'};
 if(c.sequence!==last+1||c.expectedRevision!==state.revision)return reject('A partida mudou. Tente novamente.');
 const a:Action=c.action;
 if(!a||!['build','demolish','tick'].includes(a.type))return reject('Ação inválida');
 let next:GameState={...state,chunks:{...state.chunks},actors:{...state.actors}};
 if(a.type==='tick')return {status:'applied',state:{...stepSimulation(state),revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}}};
 if(!Array.isArray(a.cells)||!a.cells.length||a.cells.length>1024||a.cells.some(p=>!p||!validCell(p)))return reject('Seleção inválida');
 if(a.type==='build'&&!Object.hasOwn(COST,a.tool))return reject('Ferramenta inválida');
 const unique=[...new Map(a.cells.map(p=>[`${p.x}:${p.y}`,p])).values()];
 let cost=0;
 for(const p of unique){
  const id=chunkId(p); if(!next.chunks[id]){const base=available.find(b=>b.id===id);if(!base)return reject('Espere o mapa carregar');next.chunks[id]=adopt(base);}
  const old=getCell(next,p)!;const chunk=next.chunks[id];
  if(a.type==='build'){
   if(old.terrain==='water')return reject('Não é possível construir na água');
   if(a.tool==='road'&&old.road)continue;
   if(old.building||old.road)return reject('Demolir primeiro para liberar o terreno');
   cost+=COST[a.tool];
   next.chunks[id]={...chunk,edits:{...chunk.edits,[cellIndex(p)]:a.tool==='road'?{terrain:old.terrain,road:true,origin:'player'}:{terrain:old.terrain,building:a.tool,stage:a.tool==='park'||a.tool==='power'?1:0,origin:'player'}}};
  }else{
   if(!old.building&&!old.road)continue;
   cost+=COST.demolish;next.chunks[id]={...chunk,edits:{...chunk.edits,[cellIndex(p)]:{terrain:old.terrain}}};
  }
 }
 if(cost>state.money)return reject('Dinheiro insuficiente');
 next={...next,money:state.money-cost,revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}};
 return {state:next,status:'applied'};
}
