import type {Action,BaseChunk,Command,CommandResult,GameState,SavedGame,ViewState} from '../core/model';
import type {MapLevel} from './ports';
import {applyCommand,createGame} from '../core/commands';
import {describeChange} from '../world/changes';
import type {ChangeSet} from '../world/changes';
import {SAVE_VERSION,decodeSave} from '../core/snapshot';
import type {ChunkStatus,MapSource,SaveStore} from './ports';
// Fields the codec preserved but this client does not implement, kept exactly as they arrived.
function unknownFields(source: Record<string,unknown>, known: readonly string[]): Record<string,unknown> {
 const kept: Record<string,unknown> = {};
 for (const key of Object.keys(source)) if (!known.includes(key)) kept[key] = source[key];
 return kept;
}
// Beyond what is visible and what is managed, this many recently used regions stay cached.
const RECENT_BUDGET = 256;
export type SaveStatus = {status:'idle'|'saving'|'saved'|'error'; message?:string; blocked:boolean};
export type LocalSession = {
 readonly restoredView: ViewState|null;
 initialize(initialChunkId: string): Promise<void>;
 loadVisible(ids: readonly string[], level?: MapLevel): Promise<void>;
 retainVisible(ids: readonly string[]): void;
 dispatch(action: Action): CommandResult;
 // What the last accepted command did, in the world's own terms: intention, fields read and written, preconditions and
 // dependencies. A rejected or repeated command changes nothing, so the record keeps describing the last real change.
 lastChange(): ChangeSet|null;
 save(view: ViewState): Promise<void>;
 snapshot(view?:ViewState):SavedGame;
 restore(save:unknown):void;
 getState(): GameState;
 getChunk(id: string): ChunkStatus|undefined;
 getSaveStatus(): SaveStatus;
 enableSaving(): void;
 subscribe(listener: () => void): () => void;
};
export function createSession(config: {maps:MapSource; saves:SaveStore; worldId:string; seed:number; slot?:string; actorId?:string}): LocalSession {
 const {maps,saves,worldId,seed,slot='open-sim',actorId='local-player'} = config;
 const chunks = new Map<string,ChunkStatus>(), listeners = new Set<()=>void>();
 // Exploration must not grow forever: the client says which regions it can see right now, managed regions are
 // protected by the durable state itself, and only the most recent budget of the others is kept.
 const visible = new Set<string>(), tickets = new Map<string,number>();
 let issued = 0;
 let state: GameState|null = null, restored: ViewState|null = null, saveStatus: SaveStatus = {status:'idle',blocked:false};
 let change: ChangeSet|null = null;
 // Metadata written by another client (an envelope field, a view field) travels through this session untouched: the
 // save it writes keeps carrying it, because a client that drops it silently would erase another profile's data.
 let envelopeExtras: Record<string,unknown> = {}, viewExtras: Record<string,unknown> = {};
 let boot: Promise<void>|null = null, writing = false, queued: {data:SavedGame; waiters:Array<()=>void>}|null = null;
 const notify = () => {for (const listener of [...listeners]) listener();};
 const failure = (error: unknown) => {const message = (error as {message?:unknown}|null)?.message;return typeof message === 'string' && message ? message : 'Falha desconhecida';};
 // Most recently used last, so eviction can walk the map backwards.
 function remember(id: string, status: ChunkStatus): void {
  chunks.delete(id);
  chunks.set(id,status);
 }
 function evict(): void {
  const protectedIds = new Set<string>(visible);
  if (state) for (const id of Object.keys(state.chunks)) protectedIds.add(id);
  let budget = RECENT_BUDGET;
  for (const id of [...chunks.keys()].reverse()) {
   if (protectedIds.has(id)) continue;
   if (budget > 0) {budget -= 1;continue;}
   tickets.delete(id);   // an answer still in flight for a dropped region must not bring it back
   chunks.delete(id);
  }
 }
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
    viewExtras = unknownFields(saved.view as unknown as Record<string,unknown>, ['x','y','zoom','speed','place','rotation','center']);
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
   let announcedLoading=false;
   for (const id of ids) {
    const known = chunks.get(id);
    // Already good enough: an overview region still upgrades when the caller asks for detail, never the other way.
    if (known && known.status !== 'error' && (known.status === 'loading' || (known.status === 'ready' && known.upgrading) || level === 'overview' || known.level === 'detail')) continue;
    const ticket = ++issued;
    tickets.set(id,ticket);
    remember(id,known?.status==='ready'?{status:'ready',base:known.base,level:known.level,upgrading:level}:{status:'loading',level});announcedLoading=true;
    pending.push(maps.loadChunk(id,level).then(base=>{
     if (tickets.get(id) !== ticket) return;   // the region was dropped or asked for again: this answer is history
     tickets.delete(id);
     remember(id,{status:'ready',base,level}); notify();
    }, error=>{
     if (tickets.get(id) !== ticket) return;
     tickets.delete(id);
     remember(id,known?.status==='ready'?{status:'ready',base:known.base,level:known.level,upgradeError:failure(error)}:{status:'error',message:failure(error)}); notify();
     throw error;
    }));
   }
   // "These regions started loading" is one state transition for the UI, not N transitions. Arrivals remain
   // progressive below, so the map can still paint each region as soon as its data is ready.
   if(announcedLoading)notify();
   await Promise.all(pending);
   evict();
  },
  retainVisible(ids: readonly string[]) {
   visible.clear();
   for (const id of ids) {
    visible.add(id);
    const known = chunks.get(id);
    if (known) remember(id,known);
   }
   // Visibility is cache policy, not game/session state. Callers already refresh their viewport after changing it;
   // notifying every listener here turns a pan into an avoidable UI cascade.
   evict();
  },
  dispatch(action: Action): CommandResult {
   if (!state) throw new Error('Sessão não iniciada');
   const command: Command = {version:1, worldId, actorId, sequence:(state.actors[actorId] ?? 0) + 1, expectedRevision:state.revision, action};
   const available: BaseChunk[] = [];
   // An approximation is good enough to look at and never good enough to freeze into the economy: an intervention
   // in an overview region is refused, and the client answers by loading that region at detail level.
   for (const chunk of chunks.values()) if (chunk.status === 'ready' && chunk.level === 'detail') available.push(chunk.base);
   const result = applyCommand(state,command,available);
   if (result.status === 'applied') {
    // The intention is recorded where it still means something: a save written later cannot reconstruct it, and a
    // proposal that travels without it would be an opaque cell replacement.
    change = describeChange(state,command,result.state);
    state = result.state;
    notify();
   }
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
  snapshot(view?:ViewState){
   if(!state)throw new Error('Sessão não iniciada');
   return {...envelopeExtras,version:SAVE_VERSION,state,view:{...viewExtras,...(view??restored??{x:0,y:0,zoom:1,speed:0,place:'Terminal',rotation:0})}} as SavedGame;
  },
  restore(value:unknown){
   const saved=decodeSave(value);
   if(saved.state.worldId!==worldId)throw new Error('Mundo diferente');
   state=saved.state;restored=saved.view;change=null;chunks.clear();tickets.clear();
   envelopeExtras=unknownFields(saved as unknown as Record<string,unknown>,['version','state','view']);
   viewExtras=unknownFields(saved.view as unknown as Record<string,unknown>,['x','y','zoom','speed','place','rotation','center']);
   for(const [id,managed] of Object.entries(state.chunks))chunks.set(id,{status:'ready',base:managed.base,level:'detail'});
   notify();
  },
  getState(): GameState {if (!state) throw new Error('Sessão não iniciada');return state;},
  lastChange(): ChangeSet|null {return change;},
  getChunk(id: string) {return chunks.get(id);},
  getSaveStatus(): SaveStatus {return {...saveStatus};},
  enableSaving() {saveStatus = {status:'idle',blocked:false};},
  subscribe(listener: () => void) {listeners.add(listener);return () => {listeners.delete(listener);};},
 };
}
