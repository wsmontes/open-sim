import type {WorldView} from '../surfaces/canvas/canvas-renderer';
import type {Cell,GameState,ManagedChunk} from '../core/model';
import {CHUNK,WORLD,coordAt,chunkId,cellIndex,wrapX} from '../core/coordinates';
import {isPowered} from '../core/simulation';
type CompactScene={state:GameState;playerPower:ReadonlyMap<string,boolean>};
const cached=new WeakMap<object,{chunkKey:string;scene:CompactScene}>();
const identities=new WeakMap<object,number>();let nextIdentity=0;
export function sceneIdentity(value:object){let id=identities.get(value);if(id===undefined){id=++nextIdentity;identities.set(value,id);}return id;}
const chunkKeys=new WeakMap<object,string>();
export function sceneChunkKey(view:WorldView){let key=chunkKeys.get(view.chunks);if(key===undefined){key=[...view.chunks].map(([id,status])=>`${id}:${sceneIdentity(status)}`).sort().join('|');chunkKeys.set(view.chunks,key);}return key;}
export function compactSceneState(view:WorldView):CompactScene{
 const chunkKey=sceneChunkKey(view),known=cached.get(view.state.chunks);if(known?.chunkKey===chunkKey)return known.scene;
 const chunks:Record<string,ManagedChunk>={},playerPower=new Map<string,boolean>();
 const ensure=(id:string)=>chunks[id]??= {base:{id,source:'presentation',normalizerVersion:1,cells:new Array<Cell>(CHUNK*CHUNK)},edits:{},baseEnergy:0,balanceAdjustment:0};
 for(const [id,chunk] of Object.entries(view.state.chunks))for(const [index,cell] of Object.entries(chunk.edits)){
  if(cell.origin==='imported')continue;ensure(id).edits[index]=cell;const coord=coordAt(id,Number(index));
  if(cell.building&&cell.building!=='park')playerPower.set(`${coord.x}:${coord.y}`,isPowered(view.state,coord));
  if(cell.road)for(const [dx,dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]){const p={x:wrapX(coord.x+dx),y:coord.y+dy};if(p.y<0||p.y>=WORLD)continue;const neighbourId=chunkId(p),managed=view.state.chunks[neighbourId],i=cellIndex(p),loaded=view.chunks.get(neighbourId),neighbour=managed?(managed.edits[i]??managed.base.cells[i]):loaded?.status==='ready'?loaded.base.cells[i]:null;if(neighbour)ensure(neighbourId).base.cells[i]=neighbour;}
 }
 const result={state:{...view.state,chunks,actors:{},components:{}},playerPower};cached.set(view.state.chunks,{chunkKey,scene:result});return result;
}
