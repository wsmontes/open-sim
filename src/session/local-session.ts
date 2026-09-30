import type {Action,BaseChunk,Command,CommandResult,GameState,SavedGame,ViewState} from '../core/model';
import type {MapLevel} from './ports';
import {applyCommand,createGame} from '../core/commands';
import {SAVE_VERSION,decodeSave} from '../core/snapshot';
import type {ChunkStatus,MapSource,SaveStore} from './ports';
export type SaveStatus = {status:'idle'|'saving'|'saved'|'error'; message?:string; blocked:boolean};
export type LocalSession = {
 readonly restoredView: ViewState|null;
 initialize(initialChunkId: string): Promise<void>;
 loadVisible(ids: readonly string[], level?: MapLevel): Promise<void>;
 dispatch(action: Action): CommandResult;
 save(view: ViewState): Promise<void>;
 getState(): GameState;
 getChunk(id: string): ChunkStatus|undefined;
 getSaveStatus(): SaveStatus;
 enableSaving(): void;
 subscribe(listener: () => void): () => void;
};
export function createSession(config: {maps:MapSource; saves:SaveStore; worldId:string; seed:number; slot?:string; actorId?:string}): LocalSession {
 const {maps,saves,worldId,seed,slot='open-sim',actorId='local-player'} = config;
 const chunks = new Map<string,ChunkStatus>(), listeners = new Set<()=>void>();
 let state: GameState|null = null, restored: ViewState|null = null, saveStatus: SaveStatus = {status:'idle',blocked:false};
 let boot: Promise<void>|null = null, writing = false, queued: {data:SavedGame; waiters:Array<()=>void>}|null = null;
 const notify = () => {for (const listener of [...listeners]) listener();};
 const failure = (error: unknown) => {const message = (error as {message?:unknown}|null)?.message;return typeof message === 'string' && message ? message : 'Falha desconhecida';};
 function flush() {
  if (writing || !queued) return;
  const job = queued; queued = null; writing = true; saveStatus = {status:'saving',blocked:false};
  let pending: Promise<void>;
  try {pending = saves.write(slot,job.data);} catch (error) {pending = Promise.reject(error);}
  pending
   .then(()=>{saveStatus = {status:'saved',blocked:false};}, error=>{saveStatus = {status:'error',message:failure(error),blocked:false};})
   .then(()=>{writing = false;for (const waiter of job.waiters) waiter();flush();});
 }
 async function start(initialChunkId: string) {
  let stored: unknown = null;
  try {
   stored = await saves.read(slot);
  } catch (error) {
   // Unreadable storage must not stop the game: play in memory, keep the slot untouched and say why writing is off.
   saveStatus = {status:'error',message:failure(error),blocked:true};
  }
  if (stored !== null && stored !== undefined) {
   try {
    const saved = decodeSave(stored);
    state = saved.state; restored = saved.view; saveStatus = {status:'idle',blocked:false};
    for (const [id,managed] of Object.entries(saved.state.chunks)) chunks.set(id,{status:'ready',base:managed.base,level:'detail'});
    notify(); return;
   } catch (error) {saveStatus = {status:'error',message:failure(error),blocked:true};}
  }
  const base = await maps.loadChunk(initialChunkId);
  chunks.set(initialChunkId,{status:'ready',base,level:'detail'});
  state = createGame(worldId,seed,base); restored = null;
  notify();
 }
 return {
  get restoredView() {return restored;},
  initialize(initialChunkId: string) {if (!boot) boot = start(initialChunkId);return boot;},
  async loadVisible(ids: readonly string[], level: MapLevel = 'detail') {
   const pending: Array<Promise<void>> = [];
   for (const id of ids) {
    const known = chunks.get(id);
    // Already good enough: an overview region still upgrades when the caller asks for detail, never the other way.
    if (known && known.status !== 'error' && (known.status === 'loading' || level === 'overview' || known.level === 'detail')) continue;
    chunks.set(id,{status:'loading',level}); notify();
    pending.push(maps.loadChunk(id,level).then(base=>{chunks.set(id,{status:'ready',base,level});notify();}, error=>{chunks.set(id,{status:'error',message:failure(error)});notify();throw error;}));
   }
   await Promise.all(pending);
  },
  dispatch(action: Action): CommandResult {
   if (!state) throw new Error('Sessão não iniciada');
   const command: Command = {version:1, worldId, actorId, sequence:(state.actors[actorId] ?? 0) + 1, expectedRevision:state.revision, action};
   const available: BaseChunk[] = [];
   // An approximation is good enough to look at and never good enough to freeze into the economy: an intervention
   // in an overview region is refused, and the client answers by loading that region at detail level.
   for (const chunk of chunks.values()) if (chunk.status === 'ready' && chunk.level === 'detail') available.push(chunk.base);
   const result = applyCommand(state,command,available);
   if (result.status === 'applied') {state = result.state;notify();}
   return result;
  },
  save(view: ViewState): Promise<void> {
   if (!state || saveStatus.blocked) return Promise.resolve();
   const data: SavedGame = {version:SAVE_VERSION, state, view};
   return new Promise<void>(resolve=>{
    const waiter = () => resolve();
    if (queued) {queued.data = data;queued.waiters.push(waiter);}
    else queued = {data,waiters:[waiter]};
    flush();
   });
  },
  getState(): GameState {if (!state) throw new Error('Sessão não iniciada');return state;},
  getChunk(id: string) {return chunks.get(id);},
  getSaveStatus(): SaveStatus {return {...saveStatus};},
  enableSaving() {saveStatus = {status:'idle',blocked:false};},
  subscribe(listener: () => void) {listeners.add(listener);return () => {listeners.delete(listener);};},
 };
}
