import {createOsmSource} from '../adapters/osm/provider';
import {createIndexedDbStore} from '../adapters/storage/indexed-db';
import {createSession} from '../session/local-session';
import type {ChunkStatus} from '../session/ports';
import type {Action,BaseChunk,CellCoord,CityStats,GameState,ViewState} from '../core/model';
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
const WORLD_ID='open-sim',SEED=1,SAVE_DEBOUNCE=500,LOAD_DEBOUNCE=200,BUFFER_SCALE=.5,START='Vancouver',MAX_LAT=85.05112878,OVERVIEW_BUDGET=512,DETAIL_BUDGET=120;
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
const hud=createHud(hudRoot,{onTool,onSpeed,onPlace,onRetryMap,onOverwriteSave,onOverview,onZoomStep,onNorth});
const clock=createTickClock(()=>{session.dispatch({type:'tick'});});
const requested=new Set<string>();
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
 requestAnimationFrame(draw);
}
void start();
