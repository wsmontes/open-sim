import {createOsmSource} from '../adapters/osm/provider';
import {createIndexedDbTileCache} from '../adapters/osm/tile-cache';
import {createIndexedDbChunkCache} from '../adapters/osm/chunk-cache';
import {createWikidataDirectory} from '../adapters/reality/wikidata';
import {createIbgeDirectory} from '../adapters/reality/ibge';
import type {CityFacts} from '../adapters/reality/wikidata';
import {createIndexedDbStore} from '../adapters/storage/indexed-db';
import {createIndexedDbWorldStorage} from '../adapters/storage/world-indexed-db';
import {createJcsCodec} from '../adapters/codec/jcs';
import {bytesHasher} from '../adapters/hash/content';
import {ed25519Verifier,generateSessionKeyPair,localIdentityProvider,signEd25519} from '../adapters/crypto/session-keys';
import {createManualSignaling} from '../adapters/network/manual-signaling';
import {createWebRtcPeers} from '../adapters/network/webrtc';
import type {WebRtcPeers} from '../adapters/network/webrtc';
import {createSession} from '../session/local-session';
import type {SaveStatus} from '../session/local-session';
import {createHostSession} from '../session/host-session';
import type {HostSession} from '../session/host-session';
import type {SessionListener,SessionTransport} from '../session/multiplayer-ports';
import {importLegacy} from '../session/world-bundle';
import {createWorldRepository} from '../session/world-repository';
import type {WorldVersion} from '../session/world-repository';
import type {ChunkStatus} from '../session/ports';
import type {Action,BaseChunk,CellCoord,CityStats,GameState,Tool,ViewState} from '../core/model';
import {SAVE_VERSION} from '../core/snapshot';
import {decodeBundle,encodeBundle} from '../world/codec';
import {MAX_DEPTH} from '../world/model';
import type {Head} from '../world/model';
import {parseStrictJson} from '../world/codec';
import {createKernel} from '../world/kernel';
import {grantBytes} from '../world/permissions';
import type {Grant} from '../world/permissions';
import {createGameSessionView,createMultiplayerPanel,hostSessionLink,presenceFrame,readPrincipal,sessionText} from '../presentation/multiplayer';
import type {GameSessionView,PresenceStatement} from '../presentation/multiplayer';
import {createWorldHistory,downloadBundle,readBundleFile} from '../presentation/world-history';
import {diffWorlds} from '../presentation/world-diff';
import {createWorldComposition,describeScenarios,emptyComposition} from '../presentation/world-composition';
import {CHUNK,chunkId,chunkOrigin,coordAt,toCell} from '../core/coordinates';
import {applyCommand} from '../core/commands';
import {getCell} from '../core/world';
import {durableJson} from '../core/protocol';
import type {ExtensionDeclaration} from '../core/protocol';
import type {JsonValue,ObjectRef} from '../world/model';
import {compareScenarios,layerWrites,runScenario} from '../world/composition';
import type {Composition,ScenarioRun} from '../world/composition';
import {quoteAction} from '../core/quote';
import {describeCell,summarize} from '../core/simulation';
import {EMPTY_ECONOMY} from '../core/model';
import type {Camera,Viewport} from '../presentation/camera';
import {GLIDE_PER_SECOND,approach,arrived,centerOn,clampZoom,closestChunks,isCoarse,normalizeAngle,pick,project,rotateTo,settleZoom,snapZoom,visibleChunks,zoomTo,MIN_ZOOM} from '../presentation/camera';
import type {WorldView} from '../presentation/canvas-renderer';
import {render} from '../presentation/canvas-renderer';
import {createTickClock} from '../presentation/clock';
import {createFrameScheduler} from '../presentation/frame-scheduler';
import type {Speed} from '../presentation/clock';
import {createHud} from '../presentation/hud';
import {createInspector} from '../presentation/inspector';
import {createSourceInspector} from '../presentation/source-inspector';
import {layoutFor} from '../presentation/layout';
import type {SelectedTool} from '../presentation/hud';
import {attachInput} from '../presentation/input';
const WORLD_ID='open-sim',BRANCH_ID='main',SEED=1,SAVE_DEBOUNCE=500,LOAD_DEBOUNCE=200,BUFFER_SCALE=.5,START='Vancouver',MAX_LAT=85.05112878,OVERVIEW_BUDGET=512,DETAIL_BUDGET=120,FUTURE_TICKS=60;
const PERF_DEBUG=new URLSearchParams(location.search).has('debug'),PERF_ZERO=performance.now();
const PERF_MARKS:Record<string,number>={script:0};
let perfNode:HTMLPreElement|null=null;
const publishPerf=()=>{
 if(!PERF_DEBUG)return;
 if(!perfNode){perfNode=document.createElement('pre');perfNode.id='open-sim-perf';perfNode.hidden=true;document.body.append(perfNode);}
 perfNode.textContent=JSON.stringify(PERF_MARKS);
};
const perfMark=(name:string)=>{if(!(name in PERF_MARKS)){PERF_MARKS[name]=Math.round((performance.now()-PERF_ZERO)*10)/10;publishPerf();}};
if(PERF_DEBUG){(window as unknown as {openSimPerf?:()=>Readonly<Record<string,number>>}).openSimPerf=()=>({...PERF_MARKS});queueMicrotask(publishPerf);}
// The terms the frozen base travels under (spec R12): a world exported from here says where its data came from.
const WORLD_TERMS=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const TOOL_LABELS:Record<Tool,string>={road:'Rua',avenue:'Avenida',highway:'Estrada',residential:'Residencial',commercial:'Comércio',industrial:'Indústria',park:'Parque',power:'Usina'};
// The places the client ships with, each carrying the population Wikidata states for it — read on 2026-09-30 from the
// QID beside it, and only the values that were actually read: a number nobody fetched is absent, never remembered.
// A curated starting point is not a claim of permanence, which is why the live lookup below refreshes it.
const PLACES:Record<string,{lat:number;lon:number;facts:CityFacts}>={
 Vancouver:{lat:49.2827,lon:-123.1207,facts:{id:'Q24639',label:'Vancouver',population:662248,populationYear:2021,source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q24639',license:'CC0'}}},
 'São Paulo':{lat:-23.5505,lon:-46.6333,facts:{id:'Q174',label:'São Paulo',country:'Brasil',population:11904961,populationYear:2025,source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q174',license:'CC0'}}},
 Lisboa:{lat:38.7223,lon:-9.1393,facts:{id:'Q597',label:'Lisboa',population:545796,populationYear:2021,source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q597',license:'CC0'}}},
};
// What the real city is, next to what the player built. The two are different orders of magnitude on purpose: the
// game is a neighbourhood inside a real place, and saying so is more interesting than pretending the simulation
// accounts for eleven million people.
const cityDirectory=createWikidataDirectory();
let cityFacts:CityFacts|null=null,pendingCityFacts:CityFacts|null=null;
let sourcePanel:ReturnType<typeof createSourceInspector>|null=null;
const slugOf=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'cidade';
const rowOf=(element:HTMLElement|null,value:string|null)=>{
 if(!element)return;
 const row=element.parentElement;
 if(row)row.hidden=value===null;
 element.textContent=value??'';
};
const updateCityScale=()=>{
 if(!cityScaleEl)return;
 const current=sessions.state();
 if(!current||!cityFacts?.population){cityScaleEl.textContent='';cityScaleEl.hidden=true;return;}
 const built=current.components['city.census'];
 const fact=(built?Object.values(built)[0]:null) as Record<string,unknown>|null;
 const simPopulation=summarize(current).population;
 cityScaleEl.hidden=false;
 cityScaleEl.textContent=fact?`Sua cidade reúne ${simPopulation.toLocaleString('pt-BR')} moradores simulados; a cidade real tem ${cityFacts.population.toLocaleString('pt-BR')} — o que você constrói é um bairro dentro dela.`:'';
};
const updateSourcePanel=()=>{
 if(!sourcePanel)return;
 const rows=[
  {label:'Mapa e geometria',value:'OpenStreetMap · Shortbread v1'},
  {label:'Termos do mapa',value:'ODbL · © OpenStreetMap contributors'},
 ];
 if(cityFacts){
  rows.push({label:'Demografia',value:cityFacts.source.dataset});
  rows.push({label:'Termos da demografia',value:cityFacts.source.license});
  rows.push({label:'Endereço da demografia',value:cityFacts.source.url});
 }
 sourcePanel.update({
  title:cityFacts?`Fontes · ${cityFacts.label}`:'Fontes desta cidade',
  rows,
  notes:[
   'Mapa, demografia e simulação são camadas diferentes: uma fonte real nunca vira automaticamente uma decisão do jogador.',
   'Quando há uma fonte estatística oficial compatível, ela substitui o valor enciclopédico; números de fontes diferentes não são misturados por média.',
  ],
  message:cityFacts?'':'A fonte demográfica aparece quando o lugar sob a câmera é identificado.',
 });
};
const showCityFacts=(facts:CityFacts|null)=>{
 cityFacts=facts;
 if(cityFactsEl)cityFactsEl.hidden=!facts;
 rowOf(cityPopulationEl,facts?.population!==undefined?`${facts.population.toLocaleString('pt-BR')}${facts.populationYear?` · ${facts.populationYear}`:''}`:null);
 rowOf(cityCountryEl,facts?.country??null);
 rowOf(cityAreaEl,facts?.areaKm2!==undefined?`${facts.areaKm2.toLocaleString('pt-BR')} km²`:null);
 // Density and the municipal product are what the country's statistics office adds: how tightly people live, and what
 // the place produces. Both are shown as stated, with the year they belong to.
 rowOf(cityDensityEl,facts?.densityPerKm2!==undefined?`${Math.round(facts.densityPerKm2).toLocaleString('pt-BR')} hab/km²`:null);
 rowOf(cityGdpEl,facts?.gdpThousandsBrl!==undefined?`R$ ${(facts.gdpThousandsBrl/1_000_000).toLocaleString('pt-BR',{maximumFractionDigits:1})} bi${facts.gdpYear?` · ${facts.gdpYear}`:''}`:null);
 if(citySourceEl)citySourceEl.textContent=facts?`${facts.source.dataset} · ${facts.source.license} · ${facts.source.url}`:'';
 updateCityScale();
 updateSourcePanel();
};
// The census travels into the world as a component of the city profile, so a shared session sees the same figure the
// screen shows instead of each client asking again. A directory response may arrive while the first save/map chunk is
// still opening; keep only the newest fact and publish it when the local state exists.
const flushCityFacts=()=>{
 const facts=pendingCityFacts;
 if(!facts||!sessions.state())return;
 pendingCityFacts=null;
 void sessions.submitAction({type:'component',key:'city.census',entity:slugOf(facts.label),value:{population:facts.population??null,year:facts.populationYear??null,country:facts.country??null,dataset:facts.source.dataset,url:facts.source.url}})
  .then(receipt=>{if(receipt.status==='failed'&&receipt.code==='NOT_FOUND')pendingCityFacts??=facts;})
  .catch(()=>{pendingCityFacts??=facts;});
};
const publishCityFacts=(facts:CityFacts)=>{pendingCityFacts=facts;flushCityFacts();};
// The city's own statistics office answers for the country it covers. When Wikidata hands over a municipal code, the
// census figure takes the place of the encyclopedic one and brings the density and the municipal product with it — two
// sources are never averaged, because an average of two censuses of different boundaries is a number nobody published.
// The year travels with every figure, and the credit names both sources.
const municipalDirectory=createIbgeDirectory();
const lookUpCity=async(lat:number,lon:number,name?:string)=>{
 const live=name?await cityDirectory.named(name,'pt'):null;
 const found=live??await cityDirectory.near(lat,lon,25);
 if(!found)return;
 const municipal=found.municipalCode?await municipalDirectory.byMunicipalCode(found.municipalCode):null;
 const facts=!municipal?found:{
  ...found,
  ...(municipal.population!==undefined?{population:municipal.population,populationYear:municipal.populationYear}:{}),
  ...(municipal.areaKm2!==undefined?{areaKm2:municipal.areaKm2}:{}),
  ...(municipal.densityPerKm2!==undefined?{densityPerKm2:municipal.densityPerKm2}:{}),
  ...(municipal.gdpThousandsBrl!==undefined?{gdpThousandsBrl:municipal.gdpThousandsBrl,gdpYear:municipal.gdpYear}:{}),
  source:{...municipal.source,license:`${municipal.source.license} · também ${found.source.dataset} (${found.source.license})`},
 };
 showCityFacts(facts);
 publishCityFacts(facts);
};
const EMPTY_STATS:CityStats={money:0,population:0,jobs:0,energySupply:0,energyUsed:0,happiness:0,income:0,managed:0,economy:EMPTY_ECONOMY};
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
const cityFactsEl=hudRoot.querySelector<HTMLElement>('#city-facts');
const cityPopulationEl=hudRoot.querySelector<HTMLElement>('#city-population');
const cityCountryEl=hudRoot.querySelector<HTMLElement>('#city-country');
const cityAreaEl=hudRoot.querySelector<HTMLElement>('#city-area');
const cityScaleEl=hudRoot.querySelector<HTMLElement>('#city-scale');
const citySourceEl=hudRoot.querySelector<HTMLElement>('#city-source');
const cityDensityEl=hudRoot.querySelector<HTMLElement>('#city-density');
const cityGdpEl=hudRoot.querySelector<HTMLElement>('#city-gdp');
const tileCacheInfo=hudRoot.querySelector<HTMLElement>('#tile-cache');
const placeError=hudRoot.querySelector<HTMLElement>('#place-error');
const placeForm=hudRoot.querySelector<HTMLFormElement>('#place-form');
const placeLat=hudRoot.querySelector<HTMLInputElement>('#place-lat');
const placeLon=hudRoot.querySelector<HTMLInputElement>('#place-lon');
// The map service sends vector tiles once and the device keeps them: one tile covers 64 regions, so a revisit — this
// session or the next one — costs no request at all.
const tileCache=createIndexedDbTileCache(),chunkCache=createIndexedDbChunkCache();
const maps=createOsmSource({cache:tileCache,chunks:chunkCache});
const session=createSession({maps,saves:createIndexedDbStore(),worldId:WORLD_ID,seed:SEED});
const codec=createJcsCodec(),hasher=bytesHasher();
const worlds=createWorldRepository({storage:createIndexedDbWorldStorage(),codec,hasher});
// The panel exists before the hud so the hud picks it up as one more card the player can drag and collapse.
const history=createWorldHistory(hudRoot,{onCreateVersion,onExport,onImport,onBranch,onCompare,onRegion});
// The scenarios panel is one more card, created before the hud so the hud picks it up as a draggable panel like the
// others (src/presentation/hud.ts).
const scenarios=createWorldComposition(hudRoot,{onCompare:compareFutures,onRegion});
scenarios.update(emptyComposition('Compare dois futuros do lugar sob a câmera.'));
// --- the cooperative session (spec §6.3, §7; plan Tarefa 9) -----------------------------------------------------
// A session opens on its own branch, forked from the version the player is looking at: what a friend builds lands
// there, so an invite never overwrites the personal save and leaving the session is not a regression of the personal
// game. Only one participant orders that branch, and this is where the client says which one it is.
const verifier=ed25519Verifier();
const registry=createKernel();
const SPEND_LIMIT=1_000_000;
type LiveSession={host:HostSession;peers:WebRtcPeers;transport:SessionTransport;branchId:string;sessionId:string};
let live:LiveSession|null=null;
// The panel exists before the hud so the hud picks it up as one more card the player can drag and collapse.
// A flow that fails has to say so: a rejection dropped by a click handler is a session that never opened and a panel
// that lies about it, so every async flow reports what happened.
function guarded(flow:()=>Promise<void>):void{
 void flow().catch(error=>{sessions.notify(describeWorldError(error));updateHud();});
}
const multiplayer=createMultiplayerPanel(hudRoot,{onCreate:()=>guarded(createCooperativeSession),onJoin:text=>guarded(()=>joinCooperativeSession(text)),onInvite:shareInvite,onLeave:()=>guarded(()=>closeCooperativeSession()),onContinueLocal:()=>guarded(()=>closeCooperativeSession('A partida continua na versão pessoal; a versão compartilhada ficou na ramificação da sessão.')),onPause:()=>{sessions.pause();updateHud();},onTransfer:text=>guarded(()=>transferBranch(text))});
// The source screen belongs to the same shell as history, scenarios and people. It reports only sources this client
// actually uses; transit and weather are not invented just because the protocol can represent them.
sourcePanel=createSourceInspector(hudRoot);
updateSourcePanel();
const hud=createHud(hudRoot,{onTool,onSpeed,onPlace,onRetryMap,onOverwriteSave,onOverview,onZoomStep,onNorth,onPolicy});
const clock=createTickClock(()=>{void sessions.tick();});
const requested=new Set<string>();
// The live branch the game commits to, the version the panel is showing, and the queue that keeps one publication at
// a time: two actions arriving together must not both compare the same head.
let worldHead:Head|null=null,shownHead:Head|null=null,branchHeads:Head[]=[],shownVersions:WorldVersion[]=[],worldMessage='',worldBusy=false;
// The last comparison the player asked for. It lives next to the panel because it describes two restored versions, not
// the live branch: a new checkpoint or branch makes it stale and it is cleared with the next history refresh.
let compareSummary='',compareRegions:readonly {id:string;label:string}[]=[];
let worldQueue:Promise<void>=Promise.resolve();
let camera:Camera={x:0,y:0,zoom:1,rotation:0};
let speed:Speed=0,tool:SelectedTool='explore',place=START,hover:CellCoord|null=null,stroke:readonly CellCoord[]|null=null;
let preview:readonly CellCoord[]=[],affordable=true,costMessage='',loadMessage='',notice='',revision=0,active=false;
let chunks:ReadonlyMap<string,ChunkStatus>=new Map();
let invalidateFrame=()=>{};
// The view reads the live branch through `head`, so it is created once the game's own state exists: a session view
// that ran before those declarations would read a name that is not initialized yet.
const sessions=createGameSessionView({
 worldId:WORLD_ID,
 branchId:BRANCH_ID,
 local:session,
 head:()=>worldHead,
 commit:(action,state)=>checkpoint(state,actionLabel(action,action.type==='build'||action.type==='demolish'?action.cells:[])),
 quote:(action,state)=>quoteAction(state,action,availableBases()),
 registry,
 ephemeral:{send:sendPresence},
 self:'local-device',
 now:()=>new Date().toISOString(),
 monotonic:()=>Date.now(),
});
const viewport=():Viewport=>({width:canvas.width,height:canvas.height});
const currentView=():ViewState=>({x:camera.x,y:camera.y,zoom:camera.zoom,speed,place,rotation:camera.rotation});
const stateOf=():GameState|null=>{
 // While a session owns the branch, the city on screen is the version the session confirmed on this device: the
 // personal session is not the authority for that branch.
 if(sessions.mode()!=='local')return sessions.state();
 try{return session.getState();}catch{return null;}
};
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
// The device cache is invisible unless it is told: how many tiles are kept and how many bytes they take. It is the
// honest counterpart of the map loading — the player can see that a revisit is costing nothing.
const showCacheStats=()=>{
 if(!tileCacheInfo)return;
 void tileCache.stats().then(({tiles,bytes})=>{
  tileCacheInfo.textContent=tiles?`Mapa guardado: ${tiles.toLocaleString('pt-BR')} tiles · ${formatBytes(bytes)}`:'';
 }).catch(()=>{tileCacheInfo.textContent='';});
};
const formatBytes=(bytes:number)=>{
 if(bytes<1024)return `${bytes} B`;
 if(bytes<1024*1024)return `${Math.round(bytes/1024)} KB`;
 return `${(bytes/(1024*1024)).toFixed(1)} MB`;
};
const refreshPreview=()=>{
 preview=tool==='explore'?[]:stroke??(hover?[hover]:[]);
 const state=stateOf(),action=preview.length?actionFor(preview):null;
 const quote=state&&action?quoteAction(state,action,availableBases()):null;
 affordable=!quote||quote.status==='ok';
 costMessage=!quote?'':quote.status==='ok'?`Custo: ${quote.cost}`:`Bloqueado: ${quote.reason}`;
 if(costEl)costEl.textContent=costMessage;
 invalidateFrame();
};
const updateHud=()=>{
 sessions.setPersistence(deviceSave());
 const save=hudSave();
 hud.update({stats:statsOf(),tool,speed,place,attribution:maps.attribution,mapMessage:loadMessage,notice,saveStatus:save,canOverwriteSave:save.blocked,rotation:camera.rotation});
 multiplayer.update(sessions.describe());
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
 const detailCandidates=visible.filter(id=>{const status=statusOf(id);return !status||status.status==='error'||(status.status==='ready'&&status.level!=='detail');});
 // When the renderer is already effectively a mosaic, z14 buildings/lanes are invisible work. Near the threshold the
 // first detail batch is deliberately small; as the player zooms in the budget rises smoothly to its full value.
 const detailUseful=!isCoarse(camera)&&visible.length<=12;
 const detailLimit=Math.max(16,Math.min(DETAIL_BUDGET,Math.round(DETAIL_BUDGET*camera.zoom)));
 const detailed=detailUseful?closestChunks(detailCandidates,camera,viewport(),detailLimit):[];
 if(!coarse.length&&!detailed.length)return;
 for(const id of new Set([...coarse,...detailed]))requested.add(id);
 loadMessage='Carregando mapa…';
 refreshChunks();updateHud();invalidateFrame();
 try{
  // A wide view can hold hundreds of regions. The coarse tile of an entire city costs one request and a few
  // milliseconds, so the screen is painted at once and the detailed tiles then replace it region by region.
  if(coarse.length)await session.loadVisible(coarse,'overview');
  if(detailed.length)await session.loadVisible(detailed);
  loadMessage='';
  sessions.setSourceError(null);
 }catch{
  loadMessage=messageOf();
  sessions.setSourceError(loadMessage);
  refreshChunks();refreshPreview();updateHud();
  return; // a failed batch is retried by the player, not by an endless automatic loop
 }
 refreshChunks();refreshPreview();updateHud();
 showCacheStats();
 if(unknown.length>coarse.length||(detailUseful&&detailCandidates.length>detailed.length))scheduleEnrichment();
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
// Filling detail beyond the first useful batch is opportunistic. It must yield to input and drawing instead of starting
// another geometry pass every 200 ms while the player is trying to move around.
let enrichmentPending=false;
const scheduleEnrichment=()=>{
 if(enrichmentPending)return;
 enrichmentPending=true;
 const run=()=>{enrichmentPending=false;void loadVisible();};
 const idle=(window as Window & {requestIdleCallback?:(cb:()=>void,options?:{timeout:number})=>number}).requestIdleCallback;
 if(idle)idle(run,{timeout:1200});else setTimeout(run,600);
};
// The personal save never claims the work of a session: while the branch belongs to a session, the session's own
// durable confirmation is what says the device has the version.
const saveNow=()=>{if(sessions.mode()!=='local')return;void session.save(currentView());};
const scheduleSave=createDebounce(saveNow,SAVE_DEBOUNCE);
// The buffer is the CSS size times this, and the zoom ladder is built from it: a tile has to be a whole number of
// device pixels for a one pixel line to stay one pixel wide.
const deviceScale=()=>BUFFER_SCALE*Math.min(2,Math.max(1,window.devicePixelRatio||1));
const setCamera=(next:Camera,options:{snap?:boolean}={})=>{
 // Anything the player does with a pointer is direct manipulation and takes effect at once — and it cancels whatever
 // camera move was in flight, because the hand wins over the animation. The zoom is only rounded to a step when the
 // input arrived in steps: a pinch is continuous, and rounding it mid-gesture would move the scene by the difference
 // between the scale the fingers asked for and the one that was applied.
 glide=null;
 camera={...next,zoom:settleZoom(next.zoom,deviceScale(),options.snap===true),rotation:normalizeAngle(next.rotation)};
 hover=null;
 refreshPreview();refreshChunks();updateHud();
 scheduleLoad();scheduleSave();
};
// A button, a shortcut or a jump to another place is a camera move rather than a drag: it glides, so the player sees
// where the city went instead of being teleported.
let glide:Camera|null=null;
const glideTo=(next:Camera)=>{glide={...next,zoom:snapZoom(next.zoom,deviceScale()),rotation:normalizeAngle(next.rotation)};invalidateFrame();};
const moveTo=(lat:number,lon:number,label:string)=>{
 place=label;
 glideTo(centerOn(toCell(lat,lon),camera,viewport()));
 hover=null;
 refreshPreview();
 updateHud();
};
function onTool(next:SelectedTool){tool=next;stroke=null;refreshPreview();updateHud();}
function onSpeed(next:Speed){speed=next;clock.setSpeed(next);scheduleSave();updateHud();invalidateFrame();}
function onPlace(name:string){
 const target=PLACES[name];
 if(!target)return;
 moveTo(target.lat,target.lon,name);
 // The bundled figure is on screen before the network answers, and the live one replaces it when it does.
 showCityFacts(target.facts);
 publishCityFacts(target.facts);
 void lookUpCity(target.lat,target.lon,name);
}
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
  compareOptions:shownVersions.filter(version=>version.head.commit.hash!==shownHead?.commit.hash).map(version=>({hash:version.head.commit.hash,label:`#${version.head.generation} ${version.head.commit.hash.slice(0,7)} ${version.accepted.length?version.accepted.join(' · '):'Início'}`})),
  compare:compareSummary?{summary:compareSummary,regions:compareRegions}:null,
 });
 history.branches(branchHeads.map(head=>head.branchId),shownHead?.branchId??BRANCH_ID);
}
async function refreshHistory():Promise<void>{
 compareSummary='';compareRegions=[];
 const known=await worlds.branches(WORLD_ID);
 if(!known.ok){worldMessage=known.error.message;return;}
 branchHeads=known.value;
 const selected=shownHead;
 if(selected&&!branchHeads.some(head=>head.branchId===selected.branchId))shownHead=worldHead;
 const versions=shownHead?await worlds.history(shownHead):null;
 if(versions&&!versions.ok)worldMessage=versions.error.message;
 shownVersions=versions&&versions.ok?versions.value:[];
}
function queueWorld(task:()=>Promise<void>):Promise<void>{
 worldBusy=true;
 updateHistoryPanel();
 worldQueue=worldQueue.then(task).catch(error=>{worldMessage=describeWorldError(error);}).then(()=>{
  worldBusy=false;
  updateHistoryPanel();
 });
 return worldQueue;
}
// --- cooperative session flows (spec §6.3, §7.4) ---------------------------------------------------------------
// Frames addressed to this client's own peer stay on the device — that is where a client presents its identity to the
// session it hosts — and every other peer goes to the WebRTC transport. Without the local half, a host would need a
// network round trip to talk to itself before it could accept its own proposal.
function localFirst(transport:SessionTransport,self:string):SessionTransport{
 const listeners=new Set<SessionListener>();
 return {
  async send(peer,message){
   if(peer===self){for(const listener of [...listeners])listener(self,message);return;}
   await transport.send(peer,message);
  },
  subscribe(listener){
   listeners.add(listener);
   const stop=transport.subscribe(listener);
   return()=>{listeners.delete(listener);stop();};
  },
 };
}
// Presence has its own port and its own class of traffic (§7.3): disposable, never queued, never part of history and
// never carrying the camera. With nobody connected there is nobody to tell.
function sendPresence(statement:PresenceStatement):void{
 const current=live;
 if(!current)return;
 const session={worldId:WORLD_ID,branchId:current.branchId,sessionId:current.sessionId,epoch:1};
 for(const peer of current.peers.connected())void current.transport.send(peer,presenceFrame(session,statement,`presence.${Date.now().toString(36)}`)).catch(()=>undefined);
}
// The device's own report is the personal session's: only it writes this device's save slot. It is also what the
// session view reads, which is why the summary line below is a different function — a report that asked the view about
// itself would be a loop.
function deviceSave():SaveStatus{return session.getSaveStatus();}
// While a session owns the branch the personal session is not the one writing, and a "Salvo" that ignored a pending
// durable confirmation would be exactly the false claim §6.3 forbids. The session's own panel carries the full state.
function hudSave():SaveStatus{
 if(sessions.mode()==='local')return deviceSave();
 const status=sessions.status();
 if(status.kind==='storage-error')return {status:'error',blocked:false,message:status.detail};
 if(status.kind==='pending')return {status:'saving',blocked:false};
 if(status.kind==='paused'||status.kind==='source-error')return {status:'idle',blocked:false};
 return {status:'saved',blocked:false};
}
function sessionBranchId(taken:ReadonlySet<string>):string{
 let branchId='sessao-1';
 for(let next=2;taken.has(branchId);next+=1)branchId=`sessao-${next}`;
 return branchId;
}
async function createCooperativeSession():Promise<void>{
 if(sessions.mode()!=='local'){sessions.notify('Já existe uma sessão aberta nesta partida.');updateHud();return;}
 const base=shownHead??worldHead;
 if(!base){sessions.notify('Nenhuma versão aberta para compartilhar.');updateHud();return;}
 try{
  const known=await worlds.branches(WORLD_ID);
  const forked=await worlds.fork(base,{worldId:WORLD_ID,branchId:sessionBranchId(new Set((known.ok?known.value:[]).map(head=>head.branchId)))});
  if(!forked.ok)throw new Error(forked.error.message);
  const branchId=forked.value.branchId,sessionId=`${WORLD_ID}-${branchId}`,epoch=1,startedAt=new Date();
  const root=await generateSessionKeyPair(),keys=await generateSessionKeyPair();
  const principal={scheme:'local',id:root.publicKey};
  const bound=await localIdentityProvider({root,session:keys,codec}).bindSession({principal,scope:{worldId:WORLD_ID,branchId,sessionId,notBefore:startedAt.toISOString(),notAfter:new Date(startedAt.getTime()+12*3600_000).toISOString()}});
  if(!bound.ok)throw new Error(bound.error.message);
  // A local principal is its root key: what this device signs with is what this device is (src/adapters/crypto/session-keys.ts).
  const unsigned:Grant={kind:'grant',id:`proprietario-${sessionId}`,principal,worldId:WORLD_ID,branchId,actions:['build','demolish','component','tick','policy'],namespaces:[],spendLimit:SPEND_LIMIT,proof:{kind:'message',algorithm:'Ed25519',sessionKey:root.publicKey,signature:''}};
  const grant:Grant={...unsigned,proof:{kind:'message',algorithm:'Ed25519',sessionKey:root.publicKey,signature:await signEd25519(root,grantBytes(unsigned,codec))}};
  const scope={worldId:WORLD_ID,branchId,sessionId,epoch};
  const signer={key:keys.publicKey,sign:(bytes:Uint8Array)=>signEd25519(keys,bytes)};
  // The transport is the WebRTC one, dialed by the signaling adapter when a peer's signal arrives: with nobody bound
  // yet it carries nothing, and the invite a person copies is the §23 descriptor of the session.
  const peers=createWebRtcPeers({codec,actor:`local:${root.publicKey}`,session:scope,signer,signaling:createManualSignaling({codec,verifier,session:scope,bindings:{}}),hasher,relay:{stun:['stun:stun.l.google.com:19302']}});
  const transport=localFirst(peers.transport,'local-device');
  const host=createHostSession({repository:worlds,transport,peer:'local-device',head:forked.value,identity:bound.value,grants:[grant],rules:{family:'city',version:session.getState().rulesVersion},bases:maps,verifier,codec,hasher,now:()=>startedAt.toISOString(),sessionId,epoch,peers:[],capabilities:registry});
  live={host,peers,transport,branchId,sessionId};
  await sessions.attach(hostSessionLink(host,{worldId:WORLD_ID,branchId,sessionId,epoch,principal,sessionKey:keys.publicKey,signer,codec,costLimit:SPEND_LIMIT,transport,peer:'local-device',identity:bound.value,grants:[grant]}));
  clock.setRole('host');
  shownHead=forked.value;
  sessions.notify('Sessão aberta nesta versão: construa com os amigos e use Convidar para copiar o convite.');
  await refreshHistory();
 }catch(error){
  sessions.notify(describeWorldError(error));
 }
 updateHistoryPanel();updateHud();
}
function shareInvite():void{
 const descriptor=sessions.descriptor();
 if(!descriptor){sessions.notify('Crie a sessão antes de convidar.');updateHud();return;}
 const text=sessionText(descriptor,codec);
 sessions.setInvite(text);
 sessions.notify('Convite pronto: passe este texto para o amigo e cole o dele em Entrar.');
 void navigator.clipboard?.writeText(text).catch(()=>undefined);
 updateHud();
}
// A pasted invite names a session either by its URI or by the §23 document a person copied: both name the same object.
function inviteUri(text:string):string|null{
 if(text.startsWith('osim:session:'))return text.split(/\s/)[0]??null;
 const parsed=parseStrictJson(text,MAX_DEPTH);
 if(!parsed.ok)return null;
 const value=parsed.value;
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const id=(value as Record<string,JsonValue>)['id'];
 return typeof id==='string'&&id.startsWith('osim:session:')?id:null;
}
async function joinCooperativeSession(text:string):Promise<void>{
 if(sessions.mode()!=='local'){sessions.notify('Feche a sessão atual antes de entrar em outra.');updateHud();return;}
 const uri=inviteUri(text.trim());
 if(!uri){sessions.notify('O convite colado não nomeia uma sessão.');updateHud();return;}
 const found=await sessions.resolveSession(uri);
 sessions.notify(found.ok&&found.value
  ? `Sessão ${found.value.sessionId}: ${found.value.worldId}/${found.value.branchId}, época ${found.value.epoch}, ${found.value.participants.length} participante(s). O canal com o anfitrião espera o sinal assinado (Tarefa 8).`
  : `Convite recusado: ${found.ok?'descritor ausente':found.error.message}`);
 updateHud();
}
// §7.5: transferring the branch is an explicit act — the player names the successor and the client pauses the epoch it
// orders, publishes the capability of the next one and puts it in the field the player hands over. Approving the new
// epoch stays the owner's own signature, and nothing here signs on the player's behalf.
async function transferBranch(text:string):Promise<void>{
 const successor=readPrincipal(text);
 if(!successor){sessions.notify('Escreva no campo o ator do sucessor com esquema, como nostr:npub1… ou local:<chave>.');updateHud();return;}
 await sessions.handover(successor);
 updateHud();
}
// Leaving revokes the collaboration: the link goes, presence stops, the invite is dropped, and the personal version is
// what is on screen again. The session's branch keeps the work that was confirmed, in the Versões panel.
async function closeCooperativeSession(reason?:string):Promise<void>{
 const closing=live;
 if(!closing)return;
 live=null;
 closing.peers.close();
 clock.setRole('local');
 clock.setSpeed(speed);
 shownHead=worldHead;
 await sessions.leave(reason??`Sessão encerrada. A versão compartilhada ficou em ${closing.branchId}; a partida segue na versão pessoal.`);
 saveNow();
 await refreshHistory();
 updateHistoryPanel();updateHud();
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
async function checkpoint(state:GameState,label:string):Promise<Head|null>{
 let published:Head|null=null;
 await queueWorld(async()=>{
  const expected=worldHead;
  if(!expected)return;
  // The version records the typed operations the command produced, not only the sentence the panel shows: a comparison
  // or a compensation later reads the intention instead of guessing it from the overlay.
  const operations=[label,...(session.lastChange()?.operations.map(operation=>operation.id)??[])];
  const result=await worlds.commit(expected,{id:`local-${state.revision}`,state,operations,objects:[],author:'local-player'});
  if(!result.ok){
   if(result.error.code!=='CONFLICT')worldMessage=result.error.message;
   return;
  }
  worldHead=result.value;
  shownHead=result.value;
  published=result.value;
  await refreshHistory();
 });
 return published;
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
// Comparing two versions of the same branch: both are restored from this device, the older one is the base, and what
// the panel shows separates data the provider published from work the player did, with the cost of redoing that work.
function onCompare(commitHash:string):void{
 queueWorld(async()=>{
  const left=shownHead??worldHead;
  if(!left){worldMessage='Nenhuma versão aberta para comparar.';return;}
  const right=shownVersions.find(version=>version.head.commit.hash===commitHash)?.head;
  if(!right){worldMessage='Versão não encontrada no histórico.';return;}
  const restored=[await worlds.checkout(left),await worlds.checkout(right)];
  const failedRestore=restored.find(result=>!result.ok);
  if(failedRestore&&!failedRestore.ok){worldMessage=failedRestore.error.message;return;}
  const points=restored.flatMap(result=>result.ok?[result.value]:[]);
  const [first,second]=points;
  if(!first||!second)return;
  const older=first.head.generation<=second.head.generation?first:second;
  const newer=older===first?second:first;
  const diff=diffWorlds(older,newer);
  const counts=diff.counts;
  const regions=diff.regions.slice(0,12).map(region=>({id:region.chunkId,label:`${region.chunkId} · ${region.real} real, ${region.player} jogador`}));
  compareSummary=`#${older.head.generation} → #${newer.head.generation} · Real: ${counts.real} · Jogador: ${counts.player} (custo ~${diff.estimate.cost}) · Simulação: ${counts.simulation} · Metadados: ${counts.metadata}${diff.regions.length?'':' · Sem diferenças'}`;
  compareRegions=regions;
 });
}
// A difference is only visible if the player can see the place it is in: the region button centres the camera on the
// region the comparison pointed at.
function onRegion(chunkId:string):void{
 const origin=chunkOrigin(chunkId);
 setCamera(centerOn({x:origin.x+CHUNK/2,y:origin.y+CHUNK/2},camera,viewport()));
}
// A project a scenario proposes goes through the profile's own rules and the regions this device already holds, so a
// scenario can never build what the player could not build.
function appliedProject(state:GameState,action:Action):GameState{
 const result=applyCommand(state,{version:1,worldId:state.worldId,actorId:'scenario',sequence:(state.actors['scenario']??0)+1,expectedRevision:state.revision,action},availableBases());
 if(result.status!=='applied')throw new Error(result.reason??'O projeto do cenário foi recusado');
 return result.state;
}
// Five free cells of land in one row of a managed region: two streets, a house, the plant that pays for the growth and
// the cell where the two futures disagree. The row nearest the camera is the block the player is looking at.
function freeBlock(state:GameState,region:string,focus:CellCoord):readonly CellCoord[]|null{
 let best:readonly CellCoord[]|null=null,bestDistance=Infinity;
 for(let index=0;index+4<CHUNK*CHUNK;index++){
  if(index%CHUNK>CHUNK-5)continue;
  const row=[0,1,2,3,4].map(step=>coordAt(region,index+step));
  if(!row.every(cell=>{const found=getCell(state,cell);return !!found&&found.terrain==='land'&&!found.road&&!found.building;}))continue;
  const distance=Math.abs(row[0]!.x-focus.x)+Math.abs(row[0]!.y-focus.y);
  if(distance<bestDistance){bestDistance=distance;best=row;}
 }
 return best;
}
// The commit of a layer is the content address of the state it produced — the same address the repository gives that
// snapshot (src/session/world-repository.ts) — so a scenario pins exactly the future it ran.
const commitOf=async(state:GameState):Promise<ObjectRef>=>hasher.ref(codec.encode({kind:'city-state',state:state as unknown as JsonValue}));
// Two futures of the place under the camera: one frozen ground, two projects, the same interval and the same declared
// inputs. This is the profile running two decisions, not a forecast of the real city.
async function compareFutures():Promise<void>{
 const state=stateOf();
 if(!state){scenarios.update(emptyComposition('Sem cidade aberta para comparar.'));return;}
 const focus=pick({x:canvas.width/2,y:canvas.height/2},camera),region=chunkId(focus);
 if(!state.chunks[region]){scenarios.update(emptyComposition(`O trecho ${region} ainda não é administrado; carregue o mapa e tente de novo.`));return;}
 const block=freeBlock(state,region,focus);
 if(!block){scenarios.update(emptyComposition(`Não há cinco células de terra livres no trecho ${region}.`));return;}
 const [street,street2,house,target,plant]=block;
 const project=(tool:Tool):GameState=>{
  let next=appliedProject(state,{type:'build',tool:'road',cells:[street,street2]});
  next=appliedProject(next,{type:'build',tool:'residential',cells:[house]});
  next=appliedProject(next,{type:'build',tool:'power',cells:[plant]});
  return appliedProject(next,{type:'build',tool,cells:[target]});
 };
 // The ground is the player's own city: the composition declares every namespace it composes and pins the frozen
 // regions by content, so both futures rest on exactly these bytes. Moving the camera or changing the art is not a
 // dimension, and neither changes this identity.
 const extensions:ExtensionDeclaration[]=Object.keys(state.components).sort().map(key=>({key,version:1,durable:true}));
 const ground=durableJson(state,extensions);
 const baseCommit=await commitOf(state);
 // Both futures fork at the same instant: two scenarios of the same place are two frames derived from one, and a
 // millisecond of difference would make the comparison refuse to explain itself.
 const forkAt=new Date().toISOString();
 const bases=await Promise.all(Object.keys(state.chunks).sort().map(async id=>({id,ref:await hasher.ref(codec.encode({kind:'base-chunk',base:state.chunks[id]!.base as unknown as JsonValue}))})));
 const future=async(id:string,tool:Tool,premise:string):Promise<ScenarioRun>=>{
  const projected=project(tool);
  const commit=await commitOf(projected);
  const writes=layerWrites(state,projected);
  if(!writes.ok)throw new Error(writes.error.message);
  const composition:Composition={
   worldId:state.worldId,branchId:`cenario-${id}`,actor:'did:key:local-player',rules:{family:'city',version:1},
   base:{commit:baseCommit,identity:ground,bases},
   layers:[{commit,contract:{id,source:`jogador local · futuro ${id}`,priority:10,effect:'durable',rules:{family:'city',version:1},reads:[],writes:writes.value,dependsOn:[],areas:[region],capabilities:[]}}],
   parameters:{},
   // §11: a scenario is a derived timeline, and both futures derive from the same frame at the same instant.
   temporal:{timeline:`osim:timeline:cenario-${id}`,parent:'osim:timeline:local',forkAt,rate:1},
   extensions,
  };
  // The same interval and the same external inputs on both sides. A recorded observation that moved the economy would
  // need a versioned rule, which is Task 15; until then an input is compared, not applied.
  const run=runScenario(composition,{states:{[baseCommit.hash]:state,[commit.hash]:projected}},{id,interval:{fromTick:state.tick,toTick:state.tick+FUTURE_TICKS},inputs:[],premises:[premise]});
  if(!run.ok)throw new Error(run.error.message);
  return run.value;
 };
 try{
  const [parque,industria]=await Promise.all([future('parque','park','projeto de parque no bloco livre'),future('industria','industrial','projeto industrial no bloco livre')]);
  scenarios.update(describeScenarios(parque,industria,compareScenarios(parque,industria)));
 }catch(error){
  scenarios.update(emptyComposition(describeWorldError(error)));
 }
}
// A lever goes through the same door as a building: the session decides, and a refusal is reported instead of applied.
// The panel then redraws from the world, so what the player sees is always the state that was actually accepted.
function onPolicy(policy:{tax?:number;services?:number;borrow?:number}):void{
 void sessions.submitAction({type:'policy',...policy}).then(receipt=>{
  const refused=sessions.refusal();
  notice=refused?`${refused.reason}`:'';
  refreshChunks();updateHud();
  if(sessions.mode()!=='local'&&(receipt.status==='accepted'||receipt.status==='duplicate'))void refreshHistory();
 });
}
function onOverview(){glideTo(zoomTo(camera,viewport(),MIN_ZOOM));}
function onZoomStep(direction:1|-1){glideTo(zoomTo(camera,viewport(),camera.zoom*(direction>0?1.25:.8)));}
function onNorth(){glideTo(rotateTo(camera,viewport(),0));}
// One entry point for what the player asks: the personal session when the branch is this device's, the live session
// when it is not. A refusal restores the selection and the preview with the fresh numbers the version brought
// (§7.4 step 3) instead of throwing the player's work away.
function commit(cells:readonly CellCoord[]){
 stroke=null;
 const action=actionFor(cells);
 if(!action)return;
 void sessions.submitAction(action).then(receipt=>{
  const refused=sessions.refusal();
  if(refused){
   stroke=refused.cells.length?refused.cells:null;
   notice=refused.preview?`${refused.reason} · ${refused.preview.money} neste dispositivo · custo ${refused.preview.cost}`:refused.reason;
   if(refused.reason.includes('Espere o mapa carregar'))loadDetailFor(cells);
  }else notice='';
  refreshPreview();refreshChunks();updateHud();
  // A session persists its own versions; the personal session already refreshed the history in its checkpoint.
  if(sessions.mode()!=='local'&&(receipt.status==='accepted'||receipt.status==='duplicate'))void refreshHistory();
 });
}
// The drawing buffer is half the CSS size (times the pixel ratio) and CSS stretches it back, keeping the chunky look.
const resize=()=>{
 const scale=deviceScale();
 const width=Math.max(1,Math.round(canvas.clientWidth*scale)),height=Math.max(1,Math.round(canvas.clientHeight*scale));
 if(width===canvas.width&&height===canvas.height)return;
 const center=pick({x:canvas.width/2,y:canvas.height/2},camera);
 canvas.width=width;canvas.height=height;
 camera=centerOn(center,camera,viewport());
 refreshChunks();invalidateFrame();
 if(active)scheduleLoad();
};
// The shell asks the browser how much room it has, and asks again whenever that changes: a phone rotated, a split view
// dragged, a window resized. A browser is never asked what kind of device it is — only how much room there is and
// whether the pointer is a finger.
const inspector=createInspector(hudRoot);
const applyLayout=()=>{
 const coarse=window.matchMedia?.('(pointer: coarse)').matches??false;
 hud.setMode(layoutFor(window.innerWidth,window.innerHeight,coarse));
};
applyLayout();
window.addEventListener('resize',applyLayout);
window.visualViewport?.addEventListener('resize',applyLayout);
window.screen?.orientation?.addEventListener?.('change',applyLayout);
// The traffic's clock: wall time scaled by the game speed, so the streets move while the city runs, move twice as
// fast at 2x and stand still while it is paused. It is presentation only — no tick reads it, no command carries it.
let motion=0;
// The card the player opened describes one cell. The moment the city slides under it, it is answering about a place
// that is no longer where it was, so any camera move — drag, wheel, keyboard or a glide to another city — takes it away.
let cardCamera:{x:number;y:number;zoom:number}|null=null;
const draw=(now:number,seconds:number)=>{
 perfMark('first-frame');
 const {width,height}=viewport();
 if(cardCamera&&(cardCamera.x!==camera.x||cardCamera.y!==camera.y||cardCamera.zoom!==camera.zoom))inspector.show(null);
 cardCamera={x:camera.x,y:camera.y,zoom:camera.zoom};
 if(speed!==0)motion+=seconds*speed;
 // A camera move in flight: the map slides and the tiles it is heading for are asked for as it goes, so the city is
 // there when the camera arrives. Saving waits for the move to end — one save per move, not one per frame.
 if(glide){
  camera=approach(camera,glide,1-Math.exp(-GLIDE_PER_SECOND*seconds));
  if(arrived(camera,glide)){const settled=glide;glide=null;setCamera(settled);}
  // The tiles the camera is heading for are asked for as it goes. Nothing else about the frame needs the interface
  // rewritten, and rewriting every number of the city sixty times a second is work nobody can see.
  else refreshChunks();
 }
 render(ctx,{camera,viewport:{width,height},state:session.getState(),chunks,tool,hover,preview,previewAffordable:affordable,seed:SEED,motion});
 return {moving:glide!==null,ambient:speed!==0};
};
const frames=createFrameScheduler({draw});
invalidateFrame=frames.invalidate;
if(PERF_DEBUG)(window as unknown as {openSimFrames?:()=>ReturnType<typeof frames.stats>}).openSimFrames=()=>frames.stats();
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
 perfMark('session-ready');
 const restored=session.restoredView;
 if(restored){
  camera={x:restored.x,y:restored.y,zoom:clampZoom(restored.zoom),rotation:normalizeAngle(restored.rotation??0)};
  speed=restored.speed;place=restored.place;
 }
 // The transient viewport starts where the restored camera actually is, never at the bundled fallback city. Managed
 // chunks from the save are therefore eligible for the very first frame and the background loader targets the right
 // neighbourhood immediately.
 const restoredVisible=visibleChunks(camera,viewport());
 session.retainVisible(restoredVisible);
 requested.clear();
 for(const id of restoredVisible)requested.add(id);
 revision=session.getState().revision;
 clock.setHidden(document.hidden);clock.setSpeed(speed);
 sessions.setHostVisible(!document.hidden);
 let sessionUiPending=false;
 session.subscribe(()=>{
  const state=session.getState();
  if(state.revision!==revision){revision=state.revision;scheduleSave();}
  invalidateFrame();
  if(sessionUiPending)return;
  sessionUiPending=true;
  requestAnimationFrame(()=>{sessionUiPending=false;refreshChunks();updateHud();});
 });
 flushCityFacts();
 updateCityScale();
 new ResizeObserver(()=>resize()).observe(canvas);
 window.addEventListener('resize',()=>resize());
// Which gesture a tool expects. A street, a plant and a demolition are lines the player lays down; a zone is a
// rectangle, because that is how the genre builds a neighbourhood and drawing it cell by cell is busywork.
const BOX_TOOLS=new Set<SelectedTool>(['residential','commercial','industrial','park']);
attachInput(canvas,{camera:()=>camera,tool:()=>tool,strokeShape:()=>BOX_TOOLS.has(tool)?'box':'line'},{
  onHover(cell){hover=cell;refreshPreview();},
  onPreview(cells){stroke=cells.length?cells:null;refreshPreview();},
  onCommit:commit,
  onCamera:setCamera,
  onTool,
  onTap(cell){
   // What the player touched, described by the core so the card cannot disagree with the city it describes.
   const state=stateOf();
   const reading=state?describeCell(state,cell):null;
   if(!reading){inspector.show(null);return;}
   const scale=deviceScale(),point=project(cell,camera);
   inspector.show({cell,reading,at:{x:point.x/scale,y:point.y/scale}});
  },
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
 // Anywhere the player goes, the city they are standing in is asked for by coordinates.
 void lookUpCity(lat,lon);
 });
 document.addEventListener('visibilitychange',()=>{
  clock.setHidden(document.hidden);
  // A browser in a background tab is not a promise: while the host is hidden the session reports itself as paused.
  sessions.setHostVisible(!document.hidden);
  updateHud();
  if(document.hidden)saveNow();else invalidateFrame();
 });
 window.addEventListener('pagehide',()=>saveNow());
 // First paint is the restored local state. Merely queueing network/storage work in the same task can still delay the
 // browser's actual paint on a phone, so background work starts only after one rendered frame has returned to the UA.
 refreshChunks();
 updateHud();
 invalidateFrame();
 requestAnimationFrame(()=>{
  setTimeout(()=>{
   perfMark('background-start');
   void loadVisible().then(()=>{perfMark('map-visible-ready');refreshChunks();updateHud();}).catch(()=>{});
   // History/version materialization is useful but never gameplay-critical. Give input and map restoration first use
   // of idle time; the timeout guarantees the panel eventually becomes ready even on a continuously busy tab.
   const history=()=>void openWorld().then(()=>{perfMark('history-ready');updateHud();}).catch(error=>{worldMessage=describeWorldError(error);updateHistoryPanel();});
   const idle=(window as Window & {requestIdleCallback?:(cb:()=>void,options?:{timeout:number})=>number}).requestIdleCallback;
   if(idle)idle(history,{timeout:2500});else setTimeout(history,800);
  },0);
 });
}
void start();
