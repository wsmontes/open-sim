import type {LocalSession} from './local-session';
import type {Action,BaseChunk,CellCoord,SavedGame} from '../core/model';
import {quoteAction} from '../core/quote';
import {decodeSave} from '../core/snapshot';
import {summarize} from '../core/simulation';
import {getCell} from '../core/world';
import {chunkId,validCell} from '../core/coordinates';
export type CityAgentRequest={op:'inspect';cell?:CellCoord}|{op:'quote'|'act';action:Action}|{op:'advance';ticks:number}|{op:'save'}|{op:'load';save:SavedGame};
export type CityAgentResponse={ok:true;revision:number;tick:number;result:unknown}|{ok:false;revision:number;tick:number;error:{code:'INVALID_REQUEST'|'REJECTED';message:string}};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export async function executeCityRequest(session:LocalSession,raw:unknown):Promise<CityAgentResponse>{
 const failure=(message:string,code:'INVALID_REQUEST'|'REJECTED'='INVALID_REQUEST'):CityAgentResponse=>({ok:false,revision:session.getState().revision,tick:session.getState().tick,error:{code,message}});
 try{
  if(!record(raw)||typeof raw.op!=='string')return failure('Pedido inválido');
  const state=session.getState();let result:unknown;
  const available=(action:Action):BaseChunk[]=>{
   const ids=new Set(Object.keys(state.chunks));
   if(action.type==='build'||action.type==='demolish')for(const cell of action.cells??[])if(cell&&validCell(cell))ids.add(chunkId(cell));
   return [...ids].flatMap(id=>{const status=session.getChunk(id);return status?.status==='ready'&&status.level==='detail'?[status.base]:[];});
  };
  switch(raw.op){
   case 'inspect':{
    if(raw.cell!==undefined&&(!record(raw.cell)||!validCell(raw.cell as CellCoord)))return failure('Célula inválida');
    result={stats:summarize(state),worldId:state.worldId,...(raw.cell?{cell:getCell(state,raw.cell as CellCoord)}:{})};break;
   }
   case 'quote':case 'act':{
    if(!record(raw.action)||!['build','demolish','policy','component','tick'].includes(String(raw.action.type)))return failure('Ação inválida');
    const action=raw.action as Action,quote=quoteAction(state,action,available(action));
    if(raw.op==='quote'){result=quote;break;}
    if(quote.status==='blocked')return failure(quote.reason??'Ação recusada','REJECTED');
    const applied=session.dispatch(action);if(applied.status==='rejected')return failure(applied.reason??'Ação recusada','REJECTED');
    result={status:applied.status,stats:summarize(applied.state)};break;
   }
   case 'advance':{
    if(!Number.isSafeInteger(raw.ticks)||(raw.ticks as number)<0||(raw.ticks as number)>10000)return failure('Ticks devem estar entre 0 e 10000');
    for(let i=0;i<(raw.ticks as number);i++)session.dispatch({type:'tick'});
    result=summarize(session.getState());break;
   }
   case 'save':result=session.snapshot();break;
   case 'load':{
    const saved=decodeSave(raw.save);session.restore(saved);result={status:'loaded'};break;
   }
   default:return failure('Operação desconhecida');
  }
  return{ok:true,revision:session.getState().revision,tick:session.getState().tick,result};
 }catch(error){return failure(error instanceof Error?error.message:String(error));}
}
