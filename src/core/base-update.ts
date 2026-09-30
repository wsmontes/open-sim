// Reconciling the frozen region under a player's overlay (docs/superpowers/specs/2026-09-29-federated-world-design.md
// §5.4). Pure core: the caller supplies the reviewed decision, the captured region and the revision it was reviewed
// against; nothing here reads a clock, a network or a random source, and the region's economy is never rewritten.
// What an update is not allowed to do is structural: the capacity and the balance of a version come from `adopt` over
// the ground it now rests on, an overlay keeps the cell the player decided, and no income is paid for data that
// arrived now — `money` and `tick` are carried through untouched.
import type {BaseChunk,Cell,CellCoord,CommandResult,GameState,ManagedChunk} from './model';
import {CHUNK,cellIndex,chunkId} from './coordinates';
import {adopt} from './world';

// Which side of a disagreement the review kept: `player` keeps the cell the player decided, `base` takes the cell the
// new capture brought.
export type BaseChoice='player'|'base';
export type CellResolution={at:CellCoord;choose:BaseChoice};
export type ApprovedBaseUpdate={
 id:string;
 chunkId:string;
 base:BaseChunk;
 expect:{source:string;normalizerVersion:number};
 expectedRevision:number;
 resolutions:readonly CellResolution[];
};

const FIELDS:readonly (keyof Cell)[]=['terrain','road','building','stage','origin'];
const sameCell=(a:Cell,b:Cell):boolean=>FIELDS.every(field=>a[field]===b[field]);

// The cells where the new region and the player's overlay claim the same cell: the ground moved there and the overlay
// is not what the ground now says. Everywhere else the region's own change and the overlay are independent, so the
// update composes without a decision.
export function baseDisagreements(managed:ManagedChunk,base:BaseChunk):number[]{
 const found:number[]=[];
 for(const key of Object.keys(managed.edits)){
  const index=Number(key),edited=managed.edits[key]!,frozen=base.cells[index],was=managed.base.cells[index];
  if(!edited||!frozen||!was)continue;
  if(sameCell(edited,frozen)||sameCell(frozen,was))continue;
  found.push(index);
 }
 return found.sort((a,b)=>a-b);
}

// Applying an approved update: the captured region replaces the frozen ground, the resolutions decide the cells the two
// sides claimed, and the capacity and the balance are recalculated from the region plus the overlay that survived. A
// review that does not decide every disagreement is refused, so nothing is ever resolved in silence, and a resolution
// for a cell the two sides never disputed is refused too because keeping it would delete work nobody reviewed.
export function applyBaseUpdate(state:GameState,update:ApprovedBaseUpdate):CommandResult{
 const reject=(reason:string):CommandResult=>({state,status:'rejected',reason});
 if(update.expectedRevision!==state.revision)return reject('A versão mudou desde a revisão desta atualização de base');
 if(update.chunkId!==update.base.id||update.base.cells.length!==CHUNK*CHUNK)return reject(`A região capturada ${update.base.id} não é uma região completa do perfil cidade`);
 const managed=state.chunks[update.chunkId];
 if(!managed)return reject(`A região ${update.chunkId} não está adotada nesta versão`);
 if(managed.base.source!==update.expect.source||managed.base.normalizerVersion!==update.expect.normalizerVersion)return reject(`A região ${update.chunkId} repousa em outra base`);
 const disputed=new Set(baseDisagreements(managed,update.base)),chosen=new Map<number,BaseChoice>();
 for(const resolution of update.resolutions){
  if(chunkId(resolution.at)!==update.chunkId)return reject(`A resolução de ${resolution.at.x},${resolution.at.y} é de outra região`);
  const index=cellIndex(resolution.at);
  if(!disputed.has(index))return reject(`A célula ${resolution.at.x},${resolution.at.y} não está em conflito com a base nova`);
  if(chosen.has(index))return reject(`A célula ${resolution.at.x},${resolution.at.y} foi resolvida duas vezes`);
  chosen.set(index,resolution.choose);
 }
 for(const index of disputed)if(!chosen.has(index))return reject(`A atualização não decidiu a célula em conflito de índice ${index}`);
 const edits:Record<string,Cell>={};
 for(const key of Object.keys(managed.edits)){
  const index=Number(key),edited=managed.edits[key]!;
  if(chosen.get(index)==='base')continue;
  // An edit the new ground already states is the same fact twice: the overlay does not have to repeat it.
  if(!sameCell(edited,update.base.cells[index]!))edits[key]=edited;
 }
 const adopted=adopt(update.base);
 const next:ManagedChunk={...adopted,edits};
 return {status:'applied',state:{...state,revision:state.revision+1,chunks:{...state.chunks,[update.chunkId]:next}}};
}
