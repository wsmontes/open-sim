import {createOsmSource} from '../adapters/osm/provider';
import {createIndexedDbStore} from '../adapters/storage/indexed-db';
import {createSession} from '../session/local-session';
import type {ChunkStatus} from '../session/ports';
import type {Action,BaseChunk,CellCoord,CityStats,GameState,ViewState} from '../core/model';
import {chunkId,toCell} from '../core/coordinates';
import {quoteAction} from '../core/quote';
import {summarize} from '../core/simulation';
import type {Camera,Viewport} from '../presentation/camera';
import {centerOn,clampZoom,closestChunks,pick,visibleChunks,zoomTo,MIN_ZOOM} from '../presentation/camera';
import type {WorldView} from '../presentation/canvas-renderer';
import {render} from '../presentation/canvas-renderer';
import {createTickClock} from '../presentation/clock';
import type {Speed} from '../presentation/clock';
import {createHud} from '../presentation/hud';
import type {SelectedTool} from '../presentation/hud';
import {attachInput} from '../presentation/input';
const WORLD_ID='open-sim',SEED=1,SAVE_DEBOUNCE=500,LOAD_DEBOUNCE=200,BUFFER_SCALE=.5,START='Vancouver',MAX_LAT=85.05112878,LOAD_BUDGET=48;
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
const hud=createHud(hudRoot,{onTool,onSpeed,onPlace,onRetryMap,onOverwriteSave,onOverview});
const clock=createTickClock(()=>{session.dispatch({type:'tick'});});
const requested=new Set<string>();
let camera:Camera={x:0,y:0,zoom:1};
let speed:Speed=0,tool:SelectedTool='explore',place=START,hover:CellCoord|null=null,stroke:readonly CellCoord[]|null=null;
let preview:readonly CellCoord[]=[],affordable=true,costMessage='',loadMessage='',notice='',revision=0,active=false;
let chunks:ReadonlyMap<string,ChunkStatus>=new Map();
const viewport=():Viewport=>({width:canvas.width,height:canvas.height});
const currentView=():ViewState=>({x:camera.x,y:camera.y,zoom:camera.zoom,speed,place});
const stateOf=():GameState|null=>{try{return session.getState();}catch{return null;}};
const statsOf=():CityStats=>{const state=stateOf();return state?summarize(state):EMPTY_STATS;};
const availableBases=():BaseChunk[]=>{
 const state=stateOf(),bases:BaseChunk[]=[];
 for(const id of new Set([...Object.keys(state?.chunks??{}),...requested])){
  const status=session.getChunk(id);
  if(status?.status==='ready')bases.push(status.base);
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
 hud.update({stats:statsOf(),tool,speed,place,attribution:maps.attribution,mapMessage:loadMessage,notice,saveStatus:save,canOverwriteSave:save.blocked});
};
const loadVisible=async()=>{
 const missing=visibleChunks(camera,viewport()).filter(id=>{const status=session.getChunk(id);return !status||status.status==='error';});
 if(!missing.length)return;
 // A wide view can hold hundreds of regions: fetch the ones nearest the viewport centre first and let the rest
 // arrive in later passes, so a zoomed-out city never becomes a bulk download of the tile service.
 const batch=closestChunks(missing,camera,viewport(),LOAD_BUDGET);
 for(const id of batch)requested.add(id);
 loadMessage='Carregando mapa…';
 refreshChunks();updateHud();
 try{
  await session.loadVisible(batch);
  loadMessage='';
 }catch{
  loadMessage=messageOf();
  refreshChunks();refreshPreview();updateHud();
  return; // a failed batch is retried by the player, not by an endless automatic loop
 }
 refreshChunks();refreshPreview();updateHud();
 if(missing.length>batch.length)scheduleLoad();
};
const scheduleLoad=createDebounce(()=>{void loadVisible();},LOAD_DEBOUNCE);
const saveNow=()=>{void session.save(currentView());};
const scheduleSave=createDebounce(saveNow,SAVE_DEBOUNCE);
const setCamera=(next:Camera)=>{
 camera={...next,zoom:clampZoom(next.zoom)};
 hover=null;
 refreshPreview();refreshChunks();
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
function commit(cells:readonly CellCoord[]){
 stroke=null;
 const action=actionFor(cells);
 if(!action)return;
 const result=session.dispatch(action);
 notice=result.status==='rejected'?(result.reason??'Ação recusada'):'';
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
 camera=centerOn(startCell,{x:0,y:0,zoom:1},viewport());
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
  camera={x:restored.x,y:restored.y,zoom:clampZoom(restored.zoom)};
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
 attachInput(canvas,()=>camera,{
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
