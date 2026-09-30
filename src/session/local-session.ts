import type {Action,BaseChunk,Command,CommandResult,GameState,SavedGame,ViewState} from '../core/model';
import type {MapLevel} from './ports';
import {applyCommand,createGame} from '../core/commands';
import {SAVE_VERSION,decodeSave} from '../core/snapshot';
import type {ChunkStatus,MapSource,SaveStore} from './ports';
// Fields the codec preserved but this client does not implement, kept exactly as they arrived.
function unknownFields(source: Record<string,unknown>, known: readonly string[]): Record<string,unknown> {
 const kept: Record<string,unknown> = {};
 for (const key of Object.keys(source)) if (!known.includes(key)) kept[key] = source[key];
 return kept;
}
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
 // Metadata written by another client (an envelope field, a view field) travels through this session untouched: the
 // save it writes keeps carrying it, because a client that drops it silently would erase another profile's data.
 let envelopeExtras: Record<string,unknown> = {}, viewExtras: Record<string,unknown> = {};
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
    envelopeExtras = unknownFields(saved as unknown as Record<string,unknown>, ['version','state','view']);
    viewExtras = unknownFields(saved.view as unknown as Record<string,unknown>, ['x','y','zoom','speed','place','rotation']);
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
   const data = {...envelopeExtras, version:SAVE_VERSION, state, view:{...viewExtras, ...view}} as SavedGame;
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
