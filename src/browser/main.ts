import {createOsmSource} from '../adapters/osm/provider';
import {createIndexedDbStore} from '../adapters/storage/indexed-db';
import {createIndexedDbWorldStorage} from '../adapters/storage/world-indexed-db';
import {createJcsCodec} from '../adapters/codec/jcs';
import {bytesHasher} from '../adapters/hash/content';
import {createSession} from '../session/local-session';
import {importLegacy} from '../session/world-bundle';
import {createWorldRepository} from '../session/world-repository';
import type {WorldVersion} from '../session/world-repository';
import type {ChunkStatus} from '../session/ports';
import type {Action,BaseChunk,CellCoord,CityStats,GameState,Tool,ViewState} from '../core/model';
import {SAVE_VERSION} from '../core/snapshot';
import {decodeBundle,encodeBundle} from '../world/codec';
import type {Head} from '../world/model';
import {createWorldHistory,downloadBundle,readBundleFile} from '../presentation/world-history';
import {chunkId,toCell} from '../core/coordinates';
import {quoteAction} from '../core/quote';
import {summarize} from '../core/simulation';
import type {Camera,Viewport} from '../presentation/camera';
import {centerOn,clampZoom,closestChunks,normalizeAngle,pick,rotateTo,visibleChunks,zoomTo,MIN_ZOOM} from '../presentation/camera';
import type {WorldView} from '../presentation/canvas-renderer';
import {render} from '../presentation/canvas-renderer';
import {createTickClock} from '../presentation/clock';
import type {Speed} from '../presentation/clock';
import {createHud} from '../presentation/hud';
import type {SelectedTool} from '../presentation/hud';
import {attachInput} from '../presentation/input';
const WORLD_ID='open-sim',BRANCH_ID='main',SEED=1,SAVE_DEBOUNCE=500,LOAD_DEBOUNCE=200,BUFFER_SCALE=.5,START='Vancouver',MAX_LAT=85.05112878,OVERVIEW_BUDGET=512,DETAIL_BUDGET=120;
// The terms the frozen base travels under (spec R12): a world exported from here says where its data came from.
const WORLD_TERMS=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const TOOL_LABELS:Record<Tool,string>={road:'Rua',residential:'Residencial',commercial:'Comércio',industrial:'Indústria',park:'Parque',power:'Usina'};
const PLACES:Record<string,{lat:number;lon:number}>={Vancouver:{lat:49.2827,lon:-123.1207},'São Paulo':{lat:-23.5505,lon:-46.6333},Lisboa:{lat:38.7223,lon:-9.1393}};
const EMPTY_STATS:CityStats={money:0,population:0,jobs:0,energySupply:0,energyUsed:0,happiness:0,income:0,managed:0};
// One pending run per window: a burst coalesces into a single run that reads the newest state when it
// fires, so a periodic tick arriving every `wait` ms can never starve the save or the map load.
function createDebounce(task:()=>void,wait:number):()=>void {
 let armed=false;
 return ()=>{
  if(armed)return;
  armed=true;
  setTimeout(()=>{armed=false;task();},wait);
 };
}
 const messageOf=()=>navigator.onLine===false?'Sem conexão. Tente novamente.':'Falha ao carregar o mapa. Tente novamente.';
const element=<T extends HTMLElement>(selector:string):T=>{
 const found=document.querySelector<T>(selector);
 if(!found)throw new Error(`Marcação da página incompleta: ${selector}`);
 return found;
};
const canvas=element<HTMLCanvasElement>('#game');
const hudRoot=element<HTMLElement>('#hud');
const ctx=canvas.getContext('2d');
if(!ctx)throw new Error('Canvas 2D indisponível neste navegador.');
const costEl=hudRoot.querySelector<HTMLElement>('#cost-preview');
const placeError=hudRoot.querySelector<HTMLElement>('#place-error');
const placeForm=hudRoot.querySelector<HTMLFormElement>('#place-form');
const placeLat=hudRoot.querySelector<HTMLInputElement>('#place-lat');
const placeLon=hudRoot.querySelector<HTMLInputElement>('#place-lon');
const maps=createOsmSource();
const session=createSession({maps,saves:createIndexedDbStore(),worldId:WORLD_ID,seed:SEED});
const codec=createJcsCodec(),hasher=bytesHasher();
const worlds=createWorldRepository({storage:createIndexedDbWorldStorage(),codec,hasher});
// The panel exists before the hud so the hud picks it up as one more card the player can drag and collapse.
const history=createWorldHistory(hudRoot,{onCreateVersion,onExport,onImport,onBranch});
const hud=createHud(hudRoot,{onTool,onSpeed,onPlace,onRetryMap,onOverwriteSave,onOverview,onZoomStep,onNorth});
const clock=createTickClock(()=>{session.dispatch({type:'tick'});});
const requested=new Set<string>();
// The live branch the game commits to, the version the panel is showing, and the queue that keeps one publication at
// a time: two actions arriving together must not both compare the same head.
let worldHead:Head|null=null,shownHead:Head|null=null,branchHeads:Head[]=[],shownVersions:WorldVersion[]=[],worldMessage='',worldBusy=false;
let worldQueue:Promise<void>=Promise.resolve();
let camera:Camera={x:0,y:0,zoom:1,rotation:0};
let speed:Speed=0,tool:SelectedTool='explore',place=START,hover:CellCoord|null=null,stroke:readonly CellCoord[]|null=null;
let preview:readonly CellCoord[]=[],affordable=true,costMessage='',loadMessage='',notice='',revision=0,active=false;
let chunks:ReadonlyMap<string,ChunkStatus>=new Map();
const viewport=():Viewport=>({width:canvas.width,height:canvas.height});
const currentView=():ViewState=>({x:camera.x,y:camera.y,zoom:camera.zoom,speed,place,rotation:camera.rotation});
const stateOf=():GameState|null=>{try{return session.getState();}catch{return null;}};
let statsState:GameState|null=null,cachedStats:CityStats=EMPTY_STATS;
// Every accepted command and every tick replaces the state object, so identity is enough to know when summarizing
// again is worth it — the HUD refreshes on each pointer move while panning.
const statsOf=():CityStats=>{
 const state=stateOf();
 if(!state)return EMPTY_STATS;
 if(state!==statsState){statsState=state;cachedStats=summarize(state);}
 return cachedStats;
};
// Only detailed regions count: the economy must never quote or adopt a coarse approximation of a place.
const availableBases=():BaseChunk[]=>{
 const state=stateOf(),bases:BaseChunk[]=[];
 for(const id of new Set([...Object.keys(state?.chunks??{}),...requested])){
  const status=session.getChunk(id);
  if(status?.status==='ready'&&status.level==='detail')bases.push(status.base);
 }
 return bases;
};
const refreshChunks=()=>{
 const next=new Map<string,ChunkStatus>();
 for(const id of requested){
  const status=session.getChunk(id);
  if(status)next.set(id,status);
 }
 chunks=next;
};
const actionFor=(cells:readonly CellCoord[]):Action|null=>tool==='explore'?null:tool==='demolish'?{type:'demolish',cells:[...cells]}:{type:'build',tool,cells:[...cells]};
const refreshPreview=()=>{
 preview=tool==='explore'?[]:stroke??(hover?[hover]:[]);
 const state=stateOf(),action=preview.length?actionFor(preview):null;
 const quote=state&&action?quoteAction(state,action,availableBases()):null;
 affordable=!quote||quote.status==='ok';
 costMessage=!quote?'':quote.status==='ok'?`Custo: ${quote.cost}`:`Bloqueado: ${quote.reason}`;
 if(costEl)costEl.textContent=costMessage;
};
const updateHud=()=>{
 const save=session.getSaveStatus();
 hud.update({stats:statsOf(),tool,speed,place,attribution:maps.attribution,mapMessage:loadMessage,notice,saveStatus:save,canOverwriteSave:save.blocked,rotation:camera.rotation});
};
const loadVisible=async()=>{
 const visible=visibleChunks(camera,viewport()),statusOf=(id:string)=>session.getChunk(id);
 // The client says what it can see; the session then forgets everything else it is allowed to forget, so a long
 // exploration does not grow memory without bound. Managed regions are protected by the durable state, not by this.
 session.retainVisible(visible);
 requested.clear();
 for(const id of visible)requested.add(id);
 const unknown=visible.filter(id=>{const status=statusOf(id);return !status||status.status==='error';});
 const coarse=closestChunks(unknown,camera,viewport(),OVERVIEW_BUDGET);
 const detailed=closestChunks(visible.filter(id=>{const status=statusOf(id);return !status||status.status==='error'||(status.status==='ready'&&status.level!=='detail');}),camera,viewport(),DETAIL_BUDGET);
 if(!coarse.length&&!detailed.length)return;
 for(const id of new Set([...coarse,...detailed]))requested.add(id);
 loadMessage='Carregando mapa…';
 refreshChunks();updateHud();
 try{
  // A wide view can hold hundreds of regions. The coarse tile of an entire city costs one request and a few
  // milliseconds, so the screen is painted at once and the detailed tiles then replace it region by region.
  if(coarse.length)await session.loadVisible(coarse,'overview');
  if(detailed.length)await session.loadVisible(detailed);
  loadMessage='';
 }catch{
  loadMessage=messageOf();
  refreshChunks();refreshPreview();updateHud();
  return; // a failed batch is retried by the player, not by an endless automatic loop
 }
 refreshChunks();refreshPreview();updateHud();
 if(unknown.length>coarse.length||visible.length>detailed.length)scheduleLoad();
};
// Building inside an approximation is refused by the session; answering with the detailed regions makes the next
// attempt work instead of leaving the player without an explanation.
const loadDetailFor=(cells:readonly CellCoord[])=>{
 const ids=[...new Set(cells.map(chunkId))].filter(id=>{const status=session.getChunk(id);return !status||status.status!=='ready'||status.level!=='detail';});
 if(!ids.length)return;
 for(const id of ids)requested.add(id);
 void session.loadVisible(ids).then(()=>{refreshChunks();refreshPreview();updateHud();});
};
const scheduleLoad=createDebounce(()=>{void loadVisible();},LOAD_DEBOUNCE);
const saveNow=()=>{void session.save(currentView());};
const scheduleSave=createDebounce(saveNow,SAVE_DEBOUNCE);
const setCamera=(next:Camera)=>{
 camera={...next,zoom:clampZoom(next.zoom),rotation:normalizeAngle(next.rotation)};
 hover=null;
 refreshPreview();refreshChunks();updateHud();
 scheduleLoad();scheduleSave();
};
const moveTo=(lat:number,lon:number,label:string)=>{
 place=label;
 camera=centerOn(toCell(lat,lon),camera,viewport());
 hover=null;
 refreshPreview();refreshChunks();
 scheduleLoad();scheduleSave();updateHud();
};
function onTool(next:SelectedTool){tool=next;stroke=null;refreshPreview();updateHud();}
function onSpeed(next:Speed){speed=next;clock.setSpeed(next);scheduleSave();updateHud();}
function onPlace(name:string){const target=PLACES[name];if(target)moveTo(target.lat,target.lon,name);}
function onRetryMap(){if(active){void loadVisible();return;}void start();}
function onOverwriteSave(){session.enableSaving();saveNow();}
function describeWorldError(error:unknown):string{
 const message=(error as {message?:unknown}|null)?.message;
 return typeof message==='string'&&message?message:'Falha ao falar com o armazenamento das versões.';
}
function updateHistoryPanel():void{
 const live=worldHead?.branchId===shownHead?.branchId;
 history.update({
  worldId:WORLD_ID,
  branchId:shownHead?.branchId??BRANCH_ID,
  status:worldBusy?'Salvando versão…':shownHead?(live?'Salvo neste dispositivo':'Versão salva neste dispositivo'):'Sem versão salva neste dispositivo',
  entries:shownVersions.map(version=>({generation:version.head.generation,hash:version.head.commit.hash,label:version.accepted.length?version.accepted.join(' · '):'Início',current:version.head.commit.hash===shownHead?.commit.hash})),
  message:worldMessage,
 });
 history.branches(branchHeads.map(head=>head.branchId),shownHead?.branchId??BRANCH_ID);
}
async function refreshHistory():Promise<void>{
 const known=await worlds.branches(WORLD_ID);
 if(!known.ok){worldMessage=known.error.message;return;}
 branchHeads=known.value;
 const selected=shownHead;
 if(selected&&!branchHeads.some(head=>head.branchId===selected.branchId))shownHead=worldHead;
 const versions=shownHead?await worlds.history(shownHead):null;
 if(versions&&!versions.ok)worldMessage=versions.error.message;
 shownVersions=versions&&versions.ok?versions.value:[];
}
function queueWorld(task:()=>Promise<void>):void{
 worldBusy=true;
 updateHistoryPanel();
 worldQueue=worldQueue.then(task).catch(error=>{worldMessage=describeWorldError(error);}).then(()=>{
  worldBusy=false;
  updateHistoryPanel();
 });
}
// The first version of this city is the state the player already has: a legacy save becomes generation 1 of `main`,
// and the origin of the package says that no earlier history was invented for it.
async function openWorld():Promise<void>{
 const known=await worlds.branches(WORLD_ID);
 if(!known.ok){worldMessage=known.error.message;updateHistoryPanel();return;}
 const existing=known.value.find(head=>head.branchId===BRANCH_ID)??null;
 if(existing)worldHead=existing;
 else{
  const imported=await importLegacy({version:SAVE_VERSION,state:session.getState(),view:currentView()},hasher,codec,WORLD_TERMS);
  if(!imported.ok){worldMessage=imported.error.message;updateHistoryPanel();return;}
  const created=await worlds.create(imported.value);
  if(!created.ok){worldMessage=created.error.message;updateHistoryPanel();return;}
  worldHead=created.value;
 }
 shownHead=worldHead;
 await refreshHistory();
 updateHistoryPanel();
}
// Player actions become checkpoints; ticks do not, so the history stays a list of decisions instead of a list of
// seconds. A change that repeats the current snapshot is not recorded at all by the repository.
function checkpoint(state:GameState,label:string):void{
 queueWorld(async()=>{
  const expected=worldHead;
  if(!expected)return;
  const result=await worlds.commit(expected,{id:`local-${state.revision}`,state,operations:[label],objects:[],author:'local-player'});
  if(!result.ok){
   if(result.error.code!=='CONFLICT')worldMessage=result.error.message;
   return;
  }
  worldHead=result.value;
  shownHead=result.value;
  await refreshHistory();
 });
}
function actionLabel(action:Action,cells:readonly CellCoord[]):string{
 if(action.type==='demolish')return `Demoliu ${cells.length} célula(s)`;
 if(action.type==='build')return `${TOOL_LABELS[action.tool]} em ${cells.length} célula(s)`;
 return 'Ação';
}
function slugBranch(name:string):string{
 return name.trim().replace(/[^\p{L}\p{N}_.-]+/gu,'-').replace(/^[-.]+|[-.]+$/g,'').slice(0,40)||'versao';
}
// Creating a version leaves the game where it is: the new branch is a resting point of the same world, and its own
// slot in this device never replaces the one the player is playing.
function onCreateVersion(name:string):void{
 queueWorld(async()=>{
  const expected=worldHead;
  if(!expected){worldMessage='Nenhuma versão aberta nesta partida.';return;}
  const known=await worlds.branches(WORLD_ID);
  const taken=new Set((known.ok?known.value:[]).map(head=>head.branchId));
  const base=slugBranch(name);
  let branchId=base;
  for(let next=2;taken.has(branchId);next+=1)branchId=`${base}-${next}`;
  const created=await worlds.fork(expected,{worldId:WORLD_ID,branchId});
  if(!created.ok){worldMessage=created.error.message;return;}
  worldMessage=`Versão criada: ${branchId}`;
  shownHead=created.value;
  await refreshHistory();
 });
}
function onExport():void{
 queueWorld(async()=>{
  const target=shownHead??worldHead;
  if(!target){worldMessage='Nenhuma versão para exportar.';return;}
  const bundle=await worlds.export(target);
  if(!bundle.ok){worldMessage=bundle.error.message;return;}
  const bytes=encodeBundle(bundle.value,codec);
  downloadBundle(`${target.worldId}-${target.branchId}-${target.commit.hash.slice(0,7)}.json`,bytes,document);
  worldMessage=bundle.value.completeness.complete?`Versão exportada: ${bytes.byteLength} bytes`:`Versão exportada incompleta: faltam ${bundle.value.completeness.missing.length} objetos`;
 });
}
function onImport(file:File):void{
 queueWorld(async()=>{
  const bytes=await readBundleFile(file);
  const decoded=decodeBundle(bytes);
  if(!decoded.ok){worldMessage=`Pacote recusado: ${decoded.error.message}`;return;}
  const address=decoded.value.definition;
  const created=await worlds.create(decoded.value);
  if(!created.ok){
   worldMessage=created.error.code==='CONFLICT'?`Já existe uma versão em ${address.worldId}/${address.branchId}; nada foi alterado.`:`Pacote recusado: ${created.error.message}`;
   return;
  }
  worldMessage=`Versão importada: ${created.value.worldId}/${created.value.branchId}`;
  if(created.value.worldId===WORLD_ID)shownHead=created.value;
  await refreshHistory();
 });
}
function onBranch(branchId:string):void{
 const chosen=branchHeads.find(head=>head.branchId===branchId);
 if(!chosen)return;
 shownHead=chosen;
 queueWorld(async()=>{await refreshHistory();});
}
function onOverview(){setCamera(zoomTo(camera,viewport(),MIN_ZOOM));}
function onZoomStep(direction:1|-1){setCamera(zoomTo(camera,viewport(),camera.zoom*(direction>0?1.25:.8)));}
function onNorth(){setCamera(rotateTo(camera,viewport(),0));}
function commit(cells:readonly CellCoord[]){
 stroke=null;
 const action=actionFor(cells);
 if(!action)return;
 const result=session.dispatch(action);
 notice=result.status==='rejected'?(result.reason??'Ação recusada'):'';
 if(result.status==='rejected'&&result.reason?.includes('Espere o mapa carregar'))loadDetailFor(cells);
 if(result.status==='applied')checkpoint(result.state,actionLabel(action,cells));
 refreshPreview();refreshChunks();updateHud();
}
// The drawing buffer is half the CSS size (times the pixel ratio) and CSS stretches it back, keeping the chunky look.
const resize=()=>{
 const scale=BUFFER_SCALE*Math.max(1,window.devicePixelRatio||1);
 const width=Math.max(1,Math.round(canvas.clientWidth*scale)),height=Math.max(1,Math.round(canvas.clientHeight*scale));
 if(width===canvas.width&&height===canvas.height)return;
 const center=pick({x:canvas.width/2,y:canvas.height/2},camera);
 canvas.width=width;canvas.height=height;
 camera=centerOn(center,camera,viewport());
 refreshChunks();scheduleLoad();
};
const draw=()=>{
 const {width,height}=viewport();
 render(ctx,{camera,viewport:{width,height},state:session.getState(),chunks,tool,hover,preview,previewAffordable:affordable,seed:SEED});
 requestAnimationFrame(draw);
};
async function start(){
 resize();
 const home=PLACES[START],startCell=toCell(home.lat,home.lon);
 requested.add(chunkId(startCell));
 camera=centerOn(startCell,{x:0,y:0,zoom:1,rotation:0},viewport());
 try{
  await session.initialize(chunkId(startCell));
 }catch{
  loadMessage=messageOf();
  refreshChunks();updateHud();
  return;
 }
 active=true;
 const restored=session.restoredView;
 if(restored){
  camera={x:restored.x,y:restored.y,zoom:clampZoom(restored.zoom),rotation:normalizeAngle(restored.rotation??0)};
  speed=restored.speed;place=restored.place;
 }
 revision=session.getState().revision;
 clock.setHidden(document.hidden);clock.setSpeed(speed);
 session.subscribe(()=>{
  const state=session.getState();
  if(state.revision!==revision){revision=state.revision;scheduleSave();}
  refreshChunks();updateHud();
 });
 new ResizeObserver(()=>resize()).observe(canvas);
 window.addEventListener('resize',()=>resize());
 attachInput(canvas,{camera:()=>camera,tool:()=>tool},{
  onHover(cell){hover=cell;refreshPreview();},
  onPreview(cells){stroke=cells.length?cells:null;refreshPreview();},
  onCommit:commit,
  onCamera:setCamera,
  onCancel(){tool='explore';stroke=null;refreshPreview();updateHud();},
 });
 placeForm?.addEventListener('submit',event=>{
  event.preventDefault();
  const raw={lat:placeLat?.value.trim()??'',lon:placeLon?.value.trim()??''},lat=Number(raw.lat),lon=Number(raw.lon);
  if(!raw.lat||!raw.lon||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>MAX_LAT||Math.abs(lon)>180){
   if(placeError){placeError.textContent='Informe latitude entre -85,0511 e 85,0511 e longitude entre -180 e 180.';placeError.hidden=false;}
   return;
  }
  if(placeError)placeError.hidden=true;
  moveTo(lat,lon,`${lat.toFixed(4)}, ${lon.toFixed(4)}`);
 });
 document.addEventListener('visibilitychange',()=>{
  clock.setHidden(document.hidden);
  if(document.hidden)saveNow();
 });
 window.addEventListener('pagehide',()=>saveNow());
 await loadVisible();
 updateHud();
 // A device that cannot keep the history must not stop the game from opening: the failure stays in the panel and the
 // player keeps playing the state the session already restored.
 await openWorld().catch(error=>{worldMessage=describeWorldError(error);updateHistoryPanel();});
 requestAnimationFrame(draw);
}
void start();
