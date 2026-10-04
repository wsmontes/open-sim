/// <reference types="vite/client" />
import {createSemanticUpdateGate} from '../presentation/semantic-update-gate';
import {createCameraUpdateGate} from '../presentation/camera-update-gate';
import {createPerformanceSamples} from '../presentation/performance-samples';
import {municipalCalibrationPreview} from '../presentation/words';
import {containsLocalArea} from '../presentation/municipal-coverage';
import vancouverLocalAreas from '../adapters/reality/data/vancouver-local-areas.json';
import {createMobilityPanel} from '../surfaces/canvas/mobility-panel';
import type {TransitContent} from '../core/transit-data';
import {createAviationEngine} from '../presentation/aviation';
import {readAirportCapture} from '../adapters/reality/airports';
import cyvrCapture from '../adapters/reality/data/cyvr.json';
import {createFerryClock} from '../client/ferry-clock';
import {scheduledFerryFrames} from '../presentation/ferry-schedule';
import {readFerrySchedule} from '../adapters/reality/bc-ferries';
import bcFerryCapture from '../adapters/reality/data/bc-ferries.json';
import {createMaritimeEngine} from '../presentation/maritime-engine';
import {readMaritimeCapture} from '../adapters/reality/maritime';
import vancouverMaritimeCapture from '../adapters/reality/data/vancouver-maritime.json';
import {createGeographicStream} from './geographic-stream';
import {createTerrainStream} from './terrain-stream';
import {createMobilityStream} from './mobility-stream';
import {motionSeconds} from '../presentation/clock';
import {createSurfaceSupport} from '../presentation/terrain-surface';
import {createTerrainSource} from '../adapters/map/terrain-source';
import terrainManifest from '../adapters/map/data/vancouver-terrain/manifest.json';
import type {TerrainManifest} from '../presentation/terrain-model';
import {pickSurface,} from '../surfaces/canvas/terrain-renderer';
import {aircraftDrawCommands} from '../surfaces/canvas/aircraft-draw';
import {vesselDrawCommands} from '../surfaces/canvas/vessel-draw';
import {mobilityDrawCommands,} from '../surfaces/canvas/mobility-draw';
import {buildingCacheStats} from '../surfaces/canvas/architecture-renderer';
import {geographicFocus,mapScale,GLOBE_ZOOM} from '../presentation/geographic-map';
import {attachOfflineRegion} from './offline-controller';
import {viewpointOf} from '../presentation/viewpoint';
import {createOsmSource} from '../adapters/osm/provider';
import type {OsmSource} from '../adapters/osm/provider';
import {createIndexedDbTileCache} from '../adapters/osm/tile-cache';
import {createIndexedDbChunkCache} from '../adapters/osm/chunk-cache';
import {createWikidataDirectory} from '../adapters/reality/wikidata';
import financeCapture from '../adapters/reality/data/vancouver-finance-2026.json';
import {readVancouverFinance,enrichVancouverFacts} from '../adapters/reality/vancouver';
import demographicCapture from '../adapters/reality/data/vancouver-demography.json';
import {readStatCanCapture,mergeDemographics} from '../adapters/reality/statcan';
import {readBcStatsCapture} from '../adapters/reality/bc-stats';
import {demographicLines} from '../presentation/demographics';
import {createIbgeDirectory} from '../adapters/reality/ibge';
import {createIndexedDbStore} from '../adapters/storage/indexed-db';
import {createIndexedDbWorldStorage} from '../adapters/storage/world-indexed-db';
import {createJcsCodec} from '../adapters/codec/jcs';
import {bytesHasher} from '../adapters/hash/content';
import {ed25519Verifier} from '../adapters/crypto/session-keys';
import {createWebRtcSessionPorts} from '../adapters/session/webrtc';
import {createSession} from '../session/local-session';
import {createWorldRepository} from '../session/world-repository';
import type {BaseChunk, GameState, ViewState} from '../core/model';
import {createKernel} from '../world/kernel';
import {createGameSessionView} from '../presentation/multiplayer';
import {createMultiplayerPanel} from '../surfaces/canvas/multiplayer-panel';
import {createWorldHistory,downloadBundle,readBundleFile} from '../surfaces/canvas/world-history';
import {createWorldComposition} from '../surfaces/canvas/world-composition';
import {emptyComposition} from '../presentation/world-composition-model';
import {chunkId,toCell,toGeo,coordAt} from '../core/coordinates';
import {effectiveCells} from '../core/world';
import {createMobilityController} from '../client/mobility-controller';
import {parseVancouverSchools} from '../adapters/reality/vancouver-schools';
import type {SchoolSite} from '../core/traffic-data';
import type {TrafficSignalSite} from '../core/traffic-data';
import {quoteAction} from '../core/quote';
import type {Camera} from '../presentation/camera';
import {normalizeAngle,project,settleZoom,zoomTo,MIN_ZOOM,centerOn,ROTATE_STEP} from '../presentation/camera';
import type {WorldView} from '../surfaces/canvas/canvas-renderer';
import {render} from '../surfaces/canvas/canvas-renderer';
import {createFrameScheduler} from '../presentation/frame-scheduler';
import type {Speed} from '../presentation/clock';
import {createHud} from '../surfaces/canvas/hud';
import {createInspector} from '../surfaces/canvas/inspector';
import {createSourceInspector} from '../surfaces/canvas/source-inspector';
import {layoutFor} from '../presentation/layout';
import type {SelectedTool} from '../surfaces/canvas/hud';
import {attachInput} from '../surfaces/canvas/input';
import {strokeShapeOf} from '../presentation/tools';
import {createCityClient} from '../client/city-client';
import {actionLabel} from '../client/versions';
import type {CityFacts, FactsPort} from '../client/facts';
import {PLACES} from '../client/facts';
import {CITY_IDENTITIES,SOURCE_CATALOG,selectSources} from '../client/source-selection';
import {systemTime} from '../adapters/time/system';
import type {MapSource} from '../session/ports';
import type {SaveStore} from '../session/ports';
import type {WorldStorage} from '../session/world-ports';
import type {TimePort} from '../client/time';
import type {SessionPorts} from '../client/session';
// --- test seam (spec 2026-10-01 §5.1; stage "browser-shell") -----------------------------------------------------
// A jsdom harness proves this host the way a real user drives it, but jsdom has no OSM, no IndexedDB and no wall
// clock. So, and ONLY under Vitest (`import.meta.env.MODE==='test'`, which Vite sets for the test build and never for
// `dev`/`build`), the host reads its outward ports from `window.__openSimTestPorts` instead of composing the live
// adapters: a fixture map, an in-memory save store and world storage, a fixed facts table, a manual clock and an
// in-memory session fabric. Everything downstream — the client, the surfaces, the HUD, the panels — is the exact same
// code the browser ships. In production the property is never read and the branch below is dead.
export type OpenSimTestPorts = {
 maps?: MapSource;
 saves?: SaveStore;
 worlds?: WorldStorage;
 facts?: FactsPort;
 time?: TimePort;
 session?: SessionPorts;
};
const testPorts: OpenSimTestPorts | null =
 import.meta.env.MODE === 'test'
  ? ((window as unknown as {__openSimTestPorts?: OpenSimTestPorts}).__openSimTestPorts ?? null)
  : null;
const WORLD_ID = 'open-sim',
 BRANCH_ID = 'main',
 SEED = 1,
 START = 'Vancouver';
// The drawing buffer is half the CSS size (times the pixel ratio), which is the game's chunky look.
const BUFFER_SCALE = 1;
// How far ahead a project preview simulates the city, in ticks.
const _PREVIEW_FUTURE_TICKS = 60;
const PERF_DEBUG = new URLSearchParams(location.search).has('debug'),
 PERF_ZERO = performance.now();
const PERF_MARKS: Record<string, number> = {script: 0};
let perfNode: HTMLPreElement | null = null;
const publishPerf = () => {
 if (!PERF_DEBUG) return;
 if (!perfNode) {
  perfNode = document.createElement('pre');
  perfNode.id = 'open-sim-perf';
  perfNode.hidden = true;
  document.body.append(perfNode);
 }
 perfNode.textContent = JSON.stringify(PERF_MARKS);
};
const perfMark = (name: string) => {
 if (!(name in PERF_MARKS)) {
  PERF_MARKS[name] = Math.round((performance.now() - PERF_ZERO) * 10) / 10;
  publishPerf();
 }
};
if (PERF_DEBUG) {
 (window as unknown as {openSimPerf?: () => Readonly<Record<string, number>>}).openSimPerf = () => ({...PERF_MARKS});
 queueMicrotask(publishPerf);
}
// The terms the frozen base travels under (spec R12): a world exported from here says where its data came from.
const WORLD_TERMS = [
 {source: 'OpenStreetMap · Shortbread v1', attribution: '© OpenStreetMap contributors', license: 'ODbL'},
];
// The real-city demography the client reads through its FactsPort (spec §5.1). Composing the two directories is the
// host's job; the client only asks `named`/`near` and renders what comes back. Wikidata answers for the world, and
// when it hands over a municipal code the country's own statistics office (IBGE) replaces the encyclopedic census and
// brings density and the municipal product — two sources are never averaged, because an average of two censuses of
// different boundaries is a number nobody published. The year travels with every figure and the credit names both.
const cityDirectory = createWikidataDirectory();
const municipalDirectory = createIbgeDirectory();
const mergeMunicipal = async (found: CityFacts | null): Promise<CityFacts | null> => {
 if (!found) return null;
 const identity = CITY_IDENTITIES[found.id];
 if(identity)found={...found,identity,countryCode:identity.countryCode};
 if(identity?.qid==='Q24639'){found=mergeDemographics(found,[...readStatCanCapture(demographicCapture.statcan,identity),...readBcStatsCapture(demographicCapture.bcStats,identity)]);found=enrichVancouverFacts(found,readVancouverFinance(financeCapture));}
 if (identity && !selectSources(identity,SOURCE_CATALOG).some(source=>source.id==='ibge')) return found;
 const municipal = found.municipalCode ? await municipalDirectory.byMunicipalCode(found.municipalCode) : null;
 if (!municipal) return found;
 const measureSource={...municipal.source,territoryId:found.id,retrievedAt:new Date().toISOString(),method:'reported' as const};
 return {
  ...found,
  measures:{...found.measures,
   ...(municipal.population===undefined?{}:{population:{value:municipal.population,unit:'people' as const,source:{...measureSource,observedYear:municipal.populationYear}}}),
   ...(municipal.areaKm2===undefined?{}:{areaKm2:{value:municipal.areaKm2,unit:'km2' as const,source:measureSource}}),
  },
  ...(municipal.population !== undefined
   ? {population: municipal.population, populationYear: municipal.populationYear}
   : {}),
  ...(municipal.areaKm2 !== undefined ? {areaKm2: municipal.areaKm2} : {}),
  ...(municipal.densityPerKm2 !== undefined ? {densityPerKm2: municipal.densityPerKm2} : {}),
  ...(municipal.gdpThousandsBrl !== undefined
   ? {gdpThousandsBrl: municipal.gdpThousandsBrl, gdpYear: municipal.gdpYear}
   : {}),
  source: {
   ...municipal.source,
   license: `${municipal.source.license} · também ${found.source.dataset} (${found.source.license})`,
  },
 };
};
const facts: FactsPort = testPorts?.facts ?? {
 async named(name) {
  return mergeMunicipal(await cityDirectory.named(name, 'pt'));
 },
 async near(lat, lon) {
  return mergeMunicipal(await cityDirectory.near(lat, lon, 25));
 },
};
let displayedCityFacts:CityFacts|null=null;
let sourcePanel: ReturnType<typeof createSourceInspector> | null = null;
const rowOf = (element: HTMLElement | null, value: string | null) => {
 if (!element) return;
 const row = element.parentElement;
 if (row) row.hidden = value === null;
 element.textContent = value ?? '';
};
// The facts panel, the scale line and the sources screen are all read off the client view: the client decides what the
// real city is and whether the scale sentence may be shown, the DOM only writes it where the player reads it.
const renderFacts = (cityFacts: CityFacts | null, scale: string) => {
 if (cityFactsEl) cityFactsEl.hidden = !cityFacts;
 const demographicsEl=document.getElementById('city-demographics');
 if(demographicsEl){demographicsEl.replaceChildren();for(const line of cityFacts?demographicLines(cityFacts):[]){const p=document.createElement('p');p.textContent=line;demographicsEl.append(p);}}
 rowOf(
  cityPopulationEl,
  cityFacts?.population !== undefined
   ? `${cityFacts.population.toLocaleString('pt-BR')}${cityFacts.populationYear ? ` · ${cityFacts.populationYear}` : ''}`
   : null,
 );
 rowOf(cityCountryEl, cityFacts?.country ?? null);
 rowOf(cityAreaEl, cityFacts?.areaKm2 !== undefined ? `${cityFacts.areaKm2.toLocaleString('pt-BR')} km²` : null);
 rowOf(
  cityDensityEl,
  cityFacts?.densityPerKm2 !== undefined
   ? `${Math.round(cityFacts.densityPerKm2).toLocaleString('pt-BR')} hab/km²`
   : null,
 );
 rowOf(
  cityGdpEl,
  cityFacts?.gdpThousandsBrl !== undefined
   ? `R$ ${(cityFacts.gdpThousandsBrl / 1_000_000).toLocaleString('pt-BR', {maximumFractionDigits: 1})} bi${cityFacts.gdpYear ? ` · ${cityFacts.gdpYear}` : ''}`
   : null,
 );
 const displayedPopulationSource=cityFacts?.measures?.population?.source??cityFacts?.source;
 if (citySourceEl)
  citySourceEl.textContent = displayedPopulationSource
   ? `${displayedPopulationSource.dataset} · ${displayedPopulationSource.license??'licença não declarada'} · ${displayedPopulationSource.url}`
   : '';
 if (cityScaleEl) {
  cityScaleEl.hidden = !scale;
  cityScaleEl.textContent = scale;
 }
 if (sourcePanel) {
  const rows = [
   {label: 'Mapa e geometria', value: 'OpenStreetMap · Shortbread v1'},
   {label: 'Termos do mapa', value: 'ODbL · © OpenStreetMap contributors'},
  ];
  if (cityFacts) {
   const populationSource=cityFacts.measures?.population?.source??cityFacts.source;
   rows.push({label: 'População · fonte e ano', value: `${populationSource.dataset} · ${cityFacts.populationYear??'ano não informado'}`});
   rows.push({label: 'Termos da demografia', value: populationSource.license??'não declarados'});
   rows.push({label: 'Endereço da demografia', value: populationSource.url});
   if(cityFacts.finance)rows.push({label:'Orçamento aprovado',value:`${cityFacts.finance.fiscalYear} · CAD · ${cityFacts.finance.operating.source.url}`});
  }
  sourcePanel.update({
   title: cityFacts ? `Fontes · ${cityFacts.label}` : 'Fontes desta cidade',
   rows,
   notes: [
    'Mapa, demografia e simulação são camadas diferentes: uma fonte real nunca vira automaticamente uma decisão do jogador.',
    'Os contornos dos edifícios e ruas vêm do OpenStreetMap. Alturas e fachadas são ilustrativas quando a fonte não informa esses detalhes.',
    'Continentes do globo: Natural Earth, domínio público.',
    'Quando há uma fonte estatística oficial compatível, ela substitui o valor enciclopédico; números de fontes diferentes não são misturados por média.',
   ],
   message: cityFacts ? '' : 'A fonte demográfica aparece quando o lugar sob a câmera é identificado.',
  });
 }
};
const element = <T extends HTMLElement>(selector: string): T => {
 const found = document.querySelector<T>(selector);
 if (!found) throw new Error(`Marcação da página incompleta: ${selector}`);
 return found;
};
const canvas = element<HTMLCanvasElement>('#game');
const hudRoot = element<HTMLElement>('#hud');
let cityLight:'day'|'night'='day';
try{if(localStorage.getItem('open-sim.visual-light')==='night')cityLight='night';}catch{}
const lightButton=hudRoot.querySelector<HTMLButtonElement>('#hud-light');
const updateLight=()=>{if(lightButton){lightButton.textContent=cityLight==='day'?'Noite':'Dia';lightButton.setAttribute('aria-label',cityLight==='day'?'Ativar modo noturno':'Ativar modo diurno');lightButton.setAttribute('aria-pressed',String(cityLight==='night'));}hudRoot.classList.toggle('night-city',cityLight==='night');};
updateLight();
lightButton?.addEventListener('click',()=>{cityLight=cityLight==='day'?'night':'day';updateLight();try{localStorage.setItem('open-sim.visual-light',cityLight);}catch{}invalidateFrame();});
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D indisponível neste navegador.');
const costEl = hudRoot.querySelector<HTMLElement>('#cost-preview');
const cityFactsEl = hudRoot.querySelector<HTMLElement>('#city-facts');
const cityPopulationEl = hudRoot.querySelector<HTMLElement>('#city-population');
const cityCountryEl = hudRoot.querySelector<HTMLElement>('#city-country');
const cityAreaEl = hudRoot.querySelector<HTMLElement>('#city-area');
const cityScaleEl = hudRoot.querySelector<HTMLElement>('#city-scale');
const citySourceEl = hudRoot.querySelector<HTMLElement>('#city-source');
const cityDensityEl = hudRoot.querySelector<HTMLElement>('#city-density');
const cityGdpEl = hudRoot.querySelector<HTMLElement>('#city-gdp');
const tileCacheInfo = hudRoot.querySelector<HTMLElement>('#tile-cache');
const placeError = hudRoot.querySelector<HTMLElement>('#place-error');
const placeForm = hudRoot.querySelector<HTMLFormElement>('#place-form');
const placeLat = hudRoot.querySelector<HTMLInputElement>('#place-lat');
const placeLon = hudRoot.querySelector<HTMLInputElement>('#place-lon');
// The map service sends vector tiles once and the device keeps them: one tile covers 64 regions, so a revisit — this
// session or the next one — costs no request at all. Under the test seam the whole provider is replaced by a fixture
// map, so no tile cache is built: the fixture has no bytes to keep.
const tileCache = testPorts ? null : createIndexedDbTileCache({maxBytes: 256 * 1024 * 1024}),
 chunkCache = testPorts ? null : createIndexedDbChunkCache();
const maps = testPorts?.maps ?? createOsmSource({cache: tileCache!, chunks: chunkCache!});
// Saving a region for offline play is a browser act (a download with progress and a stop button); where it is centred
// is the client's camera. The fixture map has no `prepareRegion`, so the offline control simply is not wired in tests.
if ('prepareRegion' in maps)
 attachOfflineRegion(hudRoot, maps as OsmSource, () => {
  const view = client.view();
  return viewpointOf(view.camera, view.viewport).center;
 });
const session = createSession({
 maps,
 saves: testPorts?.saves ?? createIndexedDbStore(),
 worldId: WORLD_ID,
 seed: SEED,
});
const codec = createJcsCodec(),
 hasher = bytesHasher();
const worlds = createWorldRepository({
 storage: testPorts?.worlds ?? createIndexedDbWorldStorage(),
 codec,
 hasher,
});
// The panels exist before the hud so it picks them up as cards the player can drag and collapse. Their actions are
// just intentions the client decides: the browser no longer owns the version graph, the comparison or the futures.
const history = createWorldHistory(hudRoot, {
 onCreateVersion: name => {
  void client.do({do: 'createVersion', name}).then(updateHud);
 },
 onExport: () => {
  void exportVersion();
 },
 onImport: file => {
  void readBundleFile(file)
   .then(bytes => client.do({do: 'import', bytes}))
   .then(updateHud);
 },
 onBranch: branchId => {
  void client.do({do: 'selectBranch', branchId}).then(updateHud);
 },
 onCompare: prefix => {
  void client.do({do: 'compare', prefix}).then(updateHud);
 },
 onRegion,
});
const scenarios = createWorldComposition(hudRoot, {
 onCompare: () => {
  void client.do({do: 'compareFutures'}).then(updateHud);
 },
 onRegion,
});
scenarios.update(emptyComposition('Compare dois futuros do lugar sob a câmera.'));
// --- the cooperative session (spec §6.3, §7; plan Tarefa 9) -----------------------------------------------------
// A session opens on its own branch, forked from the version the player is looking at: what a friend builds lands
// there, so an invite never overwrites the personal save and leaving the session is not a regression of the personal
// game. The whole flow — fork, host, invite, join, transfer, pause, leave, and switching the tick clock's role — now
// lives in the portable client (src/client/session.ts); the browser only composes the adapters it needs (WebRTC peers,
// manual signaling, crypto keys) as a SessionPorts object and translates the panel's buttons into intentions.
const verifier = ed25519Verifier();
const registry = createKernel();
// The panel exists before the hud so the hud picks it up as one more card the player can drag and collapse.
// A flow that fails has to say so: a rejection dropped by a click handler is a session that never opened and a panel
// that lies about it, so every async flow reports what happened.
function guarded(flow: () => Promise<void>): void {
 void flow()
  .then(() => updateHud())
  .catch(error => {
   sessions.notify(describeWorldError(error));
   updateHud();
  });
}
const multiplayer = createMultiplayerPanel(hudRoot, {
 onCreate: () => guarded(async () => void (await client.do({do: 'openSession'}))),
 onJoin: text => guarded(async () => void (await client.do({do: 'join', text}))),
 onInvite: () => guarded(async () => { await client.do({do: 'invite'}); void navigator.clipboard?.writeText(sessions.invite()).catch(() => undefined); }),
 onLeave: () => guarded(async () => void (await client.do({do: 'leaveSession'}))),
 onContinueLocal: () => guarded(async () => void (await client.do({do: 'leaveSession'}))),
 onPause: () => guarded(async () => void (await client.do({do: 'pauseSession'}))),
 onTransfer: text => guarded(async () => void (await client.do({do: 'transfer', actor: text}))),
});
// The source screen belongs to the same shell as history, scenarios and people. It reports only sources this client
// actually uses; transit and weather are not invented just because the protocol can represent them.
sourcePanel = createSourceInspector(hudRoot);
renderFacts(null, '');
const hud = createHud(hudRoot, {
 onTool,
 onSpeed,
 onPlace,
 onRetryMap,
 onOverwriteSave,
 onOverview,
 onZoomStep,
 onRotateStep,
 onNorth,
 onPolicy,
});
// Place, camera, the visible regions, the map message and now the whole version machine are the portable client's
// (src/client/city-client.ts); this file keeps what is the browser's: the glide animation loop that calls
// client.step, the canvas and the panels.
let active = false;
let invalidateFrame = () => {};
const geography = 'loadVisualTile' in maps ? createGeographicStream((z,x,y)=>(maps as OsmSource).loadVisualTile(z,x,y),()=>invalidateFrame()) : null;
const terrainSource=createTerrainSource(async(url,signal)=>{const response=await fetch(url,{signal});if(!response.ok)throw new Error('Terrain unavailable');return new Uint8Array(await response.arrayBuffer());},terrainManifest as TerrainManifest);
const terrain=createTerrainStream(terrainManifest as TerrainManifest,terrainSource.load,()=>invalidateFrame());
const mobilityStream=geography?createMobilityStream((z,x,y)=>(maps as OsmSource).loadVisualTile(z,x,y),SEED,()=>invalidateFrame()):null;
const mobility=mobilityStream?.controller??createMobilityController(SEED);
let mobilityEnabled=true;
const maritime=geography?createMaritimeEngine(readMaritimeCapture(vancouverMaritimeCapture),SEED):null;
maritime?.setScenario(new Date().toISOString());
const aviation=geography?createAviationEngine(readAirportCapture(cyvrCapture),SEED):null;
const marineCapture=readMaritimeCapture(vancouverMaritimeCapture),ferrySchedule=readFerrySchedule(bcFerryCapture,marineCapture.routes),ferryClock=createFerryClock(()=>new Date().toISOString());
// The transit, signal and school captures are Vancouver's, and the mobility network is built from whatever the camera is
// looking at: without this gate, panning to Lisboa would fill Lisbon's streets with Vancouver's buses and its corners
// with Vancouver's signals. Coverage is the same local-planning guard the facts use, so a city and its traffic agree on
// where the city ends, and leaving it tears the captures down instead of leaving them behind.
let mobilityCity:null|'vancouver'=null,mobilityCaptures:{transit:TransitContent;signals:readonly TrafficSignalSite[];schools:readonly SchoolSite[]}|null=null;
const syncMobilityCity=(inCoverage:boolean)=>{
 if(!geography)return;
 const wanted=inCoverage?'vancouver':null;
 if(wanted===mobilityCity)return;
 mobilityCity=wanted;
 if(!wanted){mobility.setCity(null);invalidateFrame();return;}
 mobility.setCity('CA-BC');
 // setCity tears the streets down, and the stream only speaks when its tile selection changes: hand it back what it
 // already has, or the city would come back empty and stay empty until the camera moved.
 mobilityStream?.republish();
 const apply=()=>{if(mobilityCity!=='vancouver'||!mobilityCaptures)return;mobility.setTransit(mobilityCaptures.transit);mobility.setSignalSites(mobilityCaptures.signals);mobility.setCivicSites(mobilityCaptures.schools);invalidateFrame();};
 if(mobilityCaptures){apply();return;}
 void Promise.all([
  import('../adapters/reality/data/vancouver-transit-mobility.json'),
  import('../adapters/reality/data/vancouver-signals.json'),
  import('../adapters/reality/data/vancouver-schools.json'),
 ]).then(([transit,signals,schools])=>{
  mobilityCaptures={transit:transit.default as TransitContent,signals:signals.default as readonly TrafficSignalSite[],schools:parseVancouverSchools(schools.default)};
  apply();
 });
};
const mobilityPanelRoot=hudRoot.querySelector<HTMLElement>('#panel-source [data-panel-body]');
// The clock in the panel is Vancouver's, and so is the route list under it: the panel says what city these controls
// describe, and stops claiming Vancouver where the coverage does not reach.
const mobilityPanel=mobilityPanelRoot?createMobilityPanel(mobilityPanelRoot,{onMovement:enabled=>{mobilityEnabled=enabled;lastView=null;invalidateFrame();},onScenario:instant=>{ferryClock.setScenario(instant);if(instant)mobility.setScenario(instant);lastView=null;invalidateFrame();}}):null;
mobility.setSurface((point,edge)=>{
 const surface=terrain.scene();if(edge.bridge)return createSurfaceSupport(surface.sample).foundation(edge.path)??surface.sample(toGeo(point))?.elevationM??null;
 return surface.sample(toGeo(point))?.elevationM??null;
});
// The view reads the live branch through `head`, so it is created once the game's own state exists: a session view
// that ran before those declarations would read a name that is not initialized yet.
const sessions = createGameSessionView({
 worldId: WORLD_ID,
 branchId: BRANCH_ID,
 local: session,
 head: () => client.versions?.head() ?? null,
 commit: (action, state) =>
  client.versions?.checkpoint(
   state,
   actionLabel(action, action.type === 'build' || action.type === 'demolish' ? action.cells : []),
  ) ?? Promise.resolve(null),
 quote: (action, state) => quoteAction(state, action, availableBases()),
 registry,
 self: 'local-device',
 now: () => new Date().toISOString(),
 monotonic: () => Date.now(),
});
const stateOf = (): GameState | null => {
 // While a session owns the branch, the city on screen is the version the session confirmed on this device: the
 // personal session is not the authority for that branch.
 if (sessions.mode() !== 'local') return sessions.state();
 try {
  return session.getState();
 } catch {
  return null;
 }
};
// The game itself: the same client the terminal and the playthroughs drive (spec 2026-10-01 §5). Place, camera, the
// real-city facts and the whole version machine now live inside it; the browser only animates the glide, renders the
// view and draws the panels from the models the view carries.
const START_CELL = toCell(PLACES[START]!.lat, PLACES[START]!.lon);
// The host's wall clock, shared so the optional intent recorder (?record=1) can measure the gaps between intents from
// the same TimePort the client reads, never a bare Date. The test seam hands in a manual clock so a harness advances
// thirty seconds of city in no real time.
const time = testPorts?.time ?? systemTime();
const client = createCityClient({
 local: session,
 router: sessions,
 time,
 initialChunk: chunkId(START_CELL),
 place: START,
 facts,
 animated: true,
 zoomScale: () => deviceScale(),
 viewport: {width: canvas.width || 1024, height: canvas.height || 640},
 attribution: maps.attribution,
 // The version machine: the repository, codec, hasher and the terms a frozen base travels under. The browser keeps
 // materializing the history off the opening path (its own `openWorld` after the first frame), so it does not ask the
 // client to open it at start.
 versions: {repository: worlds, codec, hasher, terms: WORLD_TERMS, worldId: WORLD_ID, branchId: BRANCH_ID},
 // The cooperative session's adapters (stage E): WebRTC peers, manual signaling and crypto keys, behind the
 // SessionPorts contract. The client's session controller forks the branch and orders the role; this only dials.
 // The test seam swaps in an in-memory fabric (jsdom has no WebRTC), so the harness opens a real session with no net.
 session: testPorts?.session ?? createWebRtcSessionPorts({repository: worlds, codec, hasher, maps, verifier, capabilities: registry, self: 'local-device'}),
 afterAction: () => updateHud(),
});
// Recording (spec 2026-10-01 §6): with ?record=1 every intent the player sends is appended to an in-memory
// playthrough — a {do:…} step, and a {wait:ms} before it for the real time that passed since the last one, measured
// from the same TimePort the client reads. A defect found while playing becomes a replayable test. It is off the
// normal UI: a defect never changes what a player who did not ask to record sees. The recording is read with
// window.openSimRecording() and saved with a small button added below the HUD.
const RECORDING = new URLSearchParams(location.search).has('record');
if (RECORDING) {
 type RecStep = {do: unknown} | {wait: number};
 const steps: RecStep[] = [];
 let lastWall = time.wall();
 const recorded = client.do.bind(client);
 // Wrap do(): a hover fires on every pointer move, so it would bury the recording in noise and is pure client state
 // (spec P5) — the recorder keeps the durable and camera intents a replay needs and drops hover.
 client.do = (intent => {
  if ((intent as {do?: string}).do !== 'hover') {
   const now = time.wall(), gap = Math.round(now - lastWall);
   if (gap > 0) steps.push({wait: gap});
   lastWall = now;
   steps.push({do: intent});
  }
  return recorded(intent);
 }) as typeof client.do;
 const recording = () => ({version: 1 as const, title: `Gravação ${new Date().toISOString()}`, seed: SEED, steps});
 (window as unknown as {openSimRecording?: () => unknown}).openSimRecording = recording;
 // A plain button under the HUD, created only when recording: it downloads the playthrough as JSON, ready to drop into
 // tests/playthroughs/. It carries no game meaning, so it lives outside the panels the player normally reads.
 const save = document.createElement('button');
 save.type = 'button';
 save.id = 'open-sim-recording';
 save.textContent = 'Baixar gravação';
 save.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999';
 save.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(recording(), null, 1)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gravacao.json';
  link.click();
  URL.revokeObjectURL(url);
 });
 document.body.append(save);
}
const tell = (intent: Parameters<typeof client.do>[0]) => {
 void client.do(intent);
};
const _currentView = (): ViewState => client.viewState();
// Only detailed regions count: the economy must never quote or adopt a coarse approximation of a place. The regions
// the client has asked for are read from its view, so the browser no longer keeps its own `requested` set.
const availableBases = (): BaseChunk[] => {
 const view = client.view(),
  state = view.state,
  bases: BaseChunk[] = [];
 for (const id of new Set([...Object.keys(state?.chunks ?? {}), ...view.chunks.keys()])) {
  const status = session.getChunk(id);
  if (status?.status === 'ready' && status.level === 'detail') bases.push(status.base);
 }
 return bases;
};
// The device cache is invisible unless it is told: how many tiles are kept and how many bytes they take. It is the
// honest counterpart of the map loading — the player can see that a revisit is costing nothing.
let lastCacheProbe=-Infinity;
const showCacheStats = () => {
 if(performance.now()-lastCacheProbe<1000)return;
 lastCacheProbe=performance.now();
 if (!tileCacheInfo) return;
 if (!tileCache) return; // no device cache under the test seam: the fixture keeps no tiles.
 void tileCache
  .stats()
  .then(({tiles, bytes}) => {
   tileCacheInfo.textContent = tiles
    ? `Mapa guardado: ${tiles.toLocaleString('pt-BR')} tiles · ${formatBytes(bytes)}`
    : '';
  })
  .catch(() => {
   tileCacheInfo.textContent = '';
  });
};
const formatBytes = (bytes: number) => {
 if (bytes < 1024) return `${bytes} B`;
 if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
 return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
// The preview and the cost are the client's; the browser only writes them where the player reads them.
const hudUpdateGate=createSemanticUpdateGate(200);let hudCriticalStamp='';
const updateHud = () => {
 const handForHud=client.view(),critical=[handForHud.state?.revision,handForHud.speed,handForHud.tool,handForHud.place,handForHud.notice,JSON.stringify(handForHud.save),handForHud.map.message,handForHud.facts?.id,handForHud.preview.affordable].join(':');
 const hudKey=[critical,handForHud.camera.x,handForHud.camera.y,handForHud.camera.zoom,handForHud.camera.rotation,handForHud.viewport.width,handForHud.viewport.height,geography?.scene().revision].join(':');
 if(!hudUpdateGate.shouldUpdate(hudKey,performance.now(),critical!==hudCriticalStamp))return;hudCriticalStamp=critical;
 const hudStart=performance.now();
 // The device's own save report is the personal session's; the session view reads it, and a live session's own
 // durable confirmation is what then speaks for the branch (the client's view already follows that rule).
 sessions.setPersistence(session.getSaveStatus());
 const view = client.view();
 const focus=geographicFocus(view.camera,view.viewport),scale=mapScale(view.camera,view.viewport);
 const nearby=Object.values(PLACES).find(p=>Math.hypot((p.lon-focus.lon)*Math.cos(focus.lat*Math.PI/180),p.lat-focus.lat)<.15);
 // A lookup belongs to its requested location. Moving elsewhere hides it until new facts arrive.
 const anchored=view.factsAt && Math.hypot((view.factsAt.lon-focus.lon)*Math.cos(focus.lat*Math.PI/180),view.factsAt.lat-focus.lat)<.01?view.facts:null;
 let visibleFacts=geography?(view.camera.zoom<GLOBE_ZOOM?null:anchored??nearby?.facts??null):view.facts;
 if(geography&&visibleFacts?.id==='Q24639'&&!containsLocalArea(vancouverLocalAreas.areas,focus))visibleFacts=null;
 // The same coverage decides what the streets carry: the Vancouver captures apply inside it and are torn down outside.
 const inVancouverCoverage=geography?containsLocalArea(vancouverLocalAreas.areas,focus):false;
 syncMobilityCity(inVancouverCoverage);
 mobilityPanel?.setCoverage(inVancouverCoverage);
 if(visibleFacts?.id==='Q24639'){const identity=CITY_IDENTITIES.Q24639;visibleFacts=enrichVancouverFacts(mergeDemographics({...visibleFacts,identity,countryCode:'CA'},[...readStatCanCapture(demographicCapture.statcan,identity),...readBcStatsCapture(demographicCapture.bcStats,identity)]),readVancouverFinance(financeCapture));}
 displayedCityFacts=visibleFacts;
 const municipalPreview=hudRoot.querySelector<HTMLElement>('#economy-municipal-preview');if(municipalPreview)municipalPreview.textContent=municipalCalibrationPreview(visibleFacts);
 const calibration=view.stats.economy.calibration;
 const calibrationText=hudRoot.querySelector<HTMLElement>('#economy-calibration');if(calibrationText)calibrationText.textContent=calibration?`Referência ativa: ${calibration.territoryId} · ${calibration.fiscalYear} · ${calibration.gameUnitsPerCad} unidades/CAD`:'Referência municipal desativada.';
 const calibrationButton=hudRoot.querySelector<HTMLButtonElement>('#economy-calibrate');if(calibrationButton)calibrationButton.disabled=!visibleFacts?.finance||!visibleFacts.population;
 const where=geography?(view.camera.zoom<GLOBE_ZOOM?'Terra':visibleFacts?.label??`${focus.lat.toFixed(3)}°, ${focus.lon.toFixed(3)}°`):view.place;
 const scaleLabel=hudRoot.querySelector<HTMLElement>('#map-scale-label'),scaleBar=hudRoot.querySelector<HTMLElement>('#map-scale-bar'),mapMode=hudRoot.querySelector<HTMLElement>('#map-mode');
 if(scaleLabel)scaleLabel.textContent=scale.label;
 if(scaleBar)scaleBar.style.width=`${Math.round(scale.pixels/deviceScale())}px`;
 if(mapMode)mapMode.textContent=scale.mode;
 const coordinates=hudRoot.querySelector<HTMLElement>('#map-coordinates');if(coordinates)coordinates.textContent=`${Math.abs(focus.lat).toFixed(3)}° ${focus.lat>=0?'N':'S'} · ${Math.abs(focus.lon).toFixed(3)}° ${focus.lon>=0?'L':'O'}`;
 hudRoot.classList.toggle('world-view',view.camera.zoom<.035);
 hudRoot.classList.toggle('planet-view',view.camera.zoom<GLOBE_ZOOM);
 const visual=geography?.scene();
 const mapMessage=geography?(visual?.error?'Parte do mapa não carregou. Tente novamente.':visual?.loading?'Carregando mapa…':''):view.map.message;
 if (costEl) costEl.textContent = view.preview.message;
 const help=hudRoot.querySelector<HTMLElement>('#map-help');if(help)help.textContent=view.tool==='explore'?'Arraste para explorar · Roda para zoom · Q / E ou dois dedos para girar':view.tool==='demolish'?'Demolir: arraste sobre os lotes · Confira o custo antes de soltar':`${({road:'Rua',avenue:'Avenida',highway:'Estrada',residential:'Moradia',commercial:'Comércio',industrial:'Indústria',park:'Parque',power:'Usina'} as Record<string,string>)[view.tool]}: arraste para marcar · Solte para construir`;
 hud.update({
  stats: view.stats,
  facts: visibleFacts,
  tool: view.tool,
  speed: view.speed,
  place: where,
  attribution: view.camera.zoom<GLOBE_ZOOM?{text:'Natural Earth · domínio público',url:'https://www.naturalearthdata.com/about/terms-of-use/'}:view.map.attribution,
  mapMessage,
  notice: view.notice,
  saveStatus: view.save,
  canOverwriteSave: view.save.blocked,
  rotation: view.camera.rotation,
 });
 renderFacts(visibleFacts,visibleFacts?.id===view.facts?.id?view.scale:'');
 showCacheStats();
 multiplayer.update(sessions.describe());
 // The version and scenarios panels are read straight off the client's view: the browser owns no version state.
 if (view.history) {
  history.update(view.history);
  if (view.branches) history.branches(view.branches.ids, view.branches.selected);
 }
 if (view.scenarios) scenarios.update(view.scenarios);
 if(PERF_DEBUG)framePhases.hud=performance.now()-hudStart;
};
const saveNow = () => client.saveNow();
// The buffer is the CSS size times this, and the zoom ladder is built from it: a tile has to be a whole number of
// device pixels for a one pixel line to stay one pixel wide. The client is given this so it snaps zoom the same way.
const deviceScale = () => BUFFER_SCALE * Math.min(2, Math.max(1, window.devicePixelRatio || 1));
// Direct pointer manipulation lands at once and cancels any glide in flight (the hand wins over the animation). The
// surface already measured the exact camera; the client stores it and loads the regions it uncovered.
const setCamera = (next: Camera, options: {snap?: boolean} = {}) => {
 const settled = {
  ...next,
  zoom: settleZoom(next.zoom, deviceScale(), options.snap === true),
  rotation: normalizeAngle(next.rotation),
 };
 tell({do: 'camera', camera: settled, settle: true});
};
function onTool(next: SelectedTool) {
 tell({do: 'tool', tool: next});
}
function onSpeed(next: Speed) {
 tell({do: 'speed', speed: next});
 invalidateFrame();
}
function onPlace(name: string) {
 tell({do: 'place', name});
 if(geography){const target=PLACES[name],v=client.view();if(target)tell({do:'camera',camera:centerOn(toCell(target.lat,target.lon),{...v.camera,zoom:.35},v.viewport),place:name,settle:true});}
}
function onRetryMap() {
 geography?.retry();
 mobilityStream?.retry();
 if (active) {
  tell({do: 'retryMap'});
  return;
 }
 void start();
}
function onOverwriteSave() {
 tell({do: 'overwriteSave'});
}
function describeWorldError(error: unknown): string {
 const message = (error as {message?: unknown} | null)?.message;
 return typeof message === 'string' && message ? message : 'Falha ao falar com o armazenamento das versões.';
}
// Export is a client decision (it produces the bytes) and a host act (it writes them): the client puts the package in
// its view, the browser downloads it. The surface decides download vs file write (spec stage C).
async function exportVersion(): Promise<void> {
 await client.do({do: 'export'});
 const bundle = client.view().export;
 if (bundle) downloadBundle(bundle.name, bundle.bytes, document);
 updateHud();
}
// A difference is only visible if the player can see the place it is in: the region button centres the camera there.
function onRegion(chunkId: string): void {
 tell({do: 'region', chunkId});
}
// The cooperative session flows (fork, host, invite, join, transfer, pause, leave, role switching and the presence
// model) now live in the portable client (src/client/session.ts); the browser composes the WebRTC SessionPorts above
// and translates the panel buttons into intentions. The in-process presence fan-out moved out with the peers; a
// future stage reconnects it through the ports when the replica channel (Task 8) is driven here.
// The first version of this city is the state the player already has, and the two futures of a place are both the
// client's now (src/client/versions.ts); the browser only asks for them through intentions.
// A lever goes through the same door as a building: the client hands it to the session and shows the refusal.
function onPolicy(policy: {tax?: number; services?: number; borrow?: number}): void {
 tell({do: 'policy', ...policy});
}
hudRoot.querySelector('#economy-calibrate')?.addEventListener('click',()=>{
 const f=displayedCityFacts;if(!f?.finance||!f.population)return;const budget=f.finance;
 tell({do:'municipal-calibration',calibration:{version:1,territoryId:budget.territoryId,fiscalYear:budget.fiscalYear,annualOperatingCad:budget.operating.value,population:f.population,gameUnitsPerCad:.01,source:budget.operating.source}});
});
hudRoot.querySelector('#economy-calibration-off')?.addEventListener('click',()=>tell({do:'municipal-calibration',calibration:null}));
function onOverview() {
 if(geography){const v=client.view();tell({do:'camera',camera:zoomTo(v.camera,v.viewport,.025),settle:true});}else tell({do: 'overview'});
}
function onZoomStep(direction: 1 | -1) {
 tell({do: 'zoom', direction});
}
// The button and Q/E are the same command: turn by one step from wherever the view is now. The client owns the camera,
// so the surface only says which way.
function onRotateStep(direction: 1 | -1) {
 const view = client.view();
 tell({do: 'rotate', radians: view.camera.rotation + direction * ROTATE_STEP});
}
hudRoot.querySelector('#hud-world')?.addEventListener('click',()=>{const v=client.view();tell({do:'camera',camera:zoomTo(v.camera,v.viewport,MIN_ZOOM),settle:true});});
hudRoot.querySelector('#hud-city')?.addEventListener('click',()=>{const v=client.view();tell({do:'camera',camera:zoomTo(v.camera,v.viewport,.35),settle:true});});
function onNorth() {
 tell({do: 'north'});
}
// Render at device resolution so footprint edges remain legible at intermediate zooms.
const resize = () => {
 const scale = deviceScale();
 const width = Math.max(1, Math.round(canvas.clientWidth * scale)),
  height = Math.max(1, Math.round(canvas.clientHeight * scale));
 if (width === canvas.width && height === canvas.height) return;
 canvas.width = width;
 canvas.height = height;
 // The client keeps what was under the centre centred, loads what the new size uncovered, and does not treat a
 // resize as a player's move (quiet). The drawing buffer is the room the camera is projected into.
 tell({do: 'viewport', width, height, quiet: true});
 invalidateFrame();
};
// The shell asks the browser how much room it has, and asks again whenever that changes: a phone rotated, a split view
// dragged, a window resized. A browser is never asked what kind of device it is — only how much room there is and
// whether the pointer is a finger.
const inspector = createInspector(hudRoot);
const applyLayout = () => {
 const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
 hud.setMode(layoutFor(window.innerWidth, window.innerHeight, coarse));
};
applyLayout();
window.addEventListener('resize', applyLayout);
window.visualViewport?.addEventListener('resize', applyLayout);
window.screen?.orientation?.addEventListener?.('change', applyLayout);
// The traffic's clock: wall time scaled by the game speed, so the streets move while the city runs, move twice as
// fast at 2x and stand still while it is paused. It is presentation only — no tick reads it, no command carries it.
let motion = 0;
let motionMs=0,renderMs=0;
const cameraUpdates=createCameraUpdateGate();
const perfSamples=createPerformanceSamples(),framePhases:Record<string,number>={};
let framePresented=false;
const phase=(name:string,start:number)=>{if(PERF_DEBUG)framePhases[name]=performance.now()-start;};
// The card the player opened describes one cell. The moment the city slides under it, it is answering about a place
// that is no longer where it was, so any camera move — drag, wheel, keyboard or a glide to another city — takes it away.
let hudCameraStamp='';
let cardCamera: {x: number; y: number; zoom: number} | null = null;
const draw = (now: number, seconds: number) => {
 framePresented=false;for(const key of Object.keys(framePhases))delete framePhases[key];
 // Nothing to draw until the city exists: a plain haze instead of a frame over a session that has not opened.
 if (!client.view().state) {
  ctx.fillStyle = '#7c8794';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return {moving: false, ambient: false};
 }
 perfMark('first-frame');
 // One frame of any camera glide happens inside the client; the browser only reads where it ended up.
 const moving = client.step(seconds);
 const hand = client.view();
 const camera = hand.camera;

 const {width, height} = hand.viewport;
 const streamStart=performance.now();
 if(cameraUpdates.changed(camera,hand.viewport)){geography?.update(camera,hand.viewport);terrain.update(camera,hand.viewport);mobilityStream?.update(camera,hand.viewport);}
 phase('streams',streamStart);
 if(!geography){
  const cells=[...hand.chunks].flatMap(([id,status])=>{const managed=hand.state?.chunks[id],base=status.status==='ready'?status.base:null;const available=managed?effectiveCells(managed):base?.cells;return available?available.flatMap((cell,i)=>cell.road?[{coord:coordAt(id,i),cell}]:[]):[];});
  mobility.setCells(cells,`${hand.state?.revision}:${[...hand.chunks.keys()].join('|')}`);mobility.setDemand({vehicles:50,pedestrians:24,truckShare:.08,hour:12});
 }
 const simulationStart=performance.now();
 ferryClock.setPaused(hand.speed===0||!mobilityEnabled);
 const civilInstant=ferryClock.instant();
 maritime?.setScenario(civilInstant);
 mobility.setScenario(civilInstant);
 const ferryFrames=geography?scheduledFerryFrames(ferrySchedule,marineCapture.routes,civilInstant):[];
 maritime?.setReservedCapacity(ferryFrames.length);
 maritime?.advance(motionSeconds(seconds,mobilityEnabled?hand.speed:0));
 aviation?.advance(motionSeconds(seconds,mobilityEnabled?hand.speed:0));
 const motionStart=performance.now();mobility.advance(motionSeconds(seconds,mobilityEnabled?hand.speed:0));motionMs=performance.now()-motionStart;
 phase('simulation',simulationStart);
 if(geography){
  const stamp=[camera.x,camera.y,camera.zoom,camera.rotation,geography.scene().revision].join(':');
  if(stamp!==hudCameraStamp){hudCameraStamp=stamp;updateHud();}
 }
 if (cardCamera && (cardCamera.x !== camera.x || cardCamera.y !== camera.y || cardCamera.zoom !== camera.zoom))
  inspector.show(null);
 cardCamera = {x: camera.x, y: camera.y, zoom: camera.zoom};
 if (hand.speed !== 0&&mobilityEnabled) motion += seconds * hand.speed;
 const snapshotStart=performance.now();
 const view: WorldView = {
  light:cityLight,
  geography: geography?.scene(),
  terrain:terrain.scene(),
  mobility:mobility.frame(),
  signals:mobility.signals(),
  vessels:maritime?[...ferryFrames,...maritime.frame()]:undefined,
  aircraft:aviation?.frame(),
  pixelRatio:deviceScale(),
  camera,
  viewport: {width, height},
  state: hand.state ?? session.getState(),
  chunks: hand.chunks,
  tool: hand.tool,
  hover: hand.hover,
  preview: hand.preview.cells,
  previewAffordable: hand.preview.affordable,
  seed: SEED,
  motion,
 };
 // While the city runs, the ambient clock asks for a frame thirty times a second, but the picture only changes when
 // something it is drawn from changes: the moving traffic, where streets show it, or a tick, a tile or the camera. An
 // identical frame is not drawn again — the canvas still holds it.
 phase('snapshots',snapshotStart);renderMs=0;
 if (!sameFrame(lastView, view)) {
  const renderStart=performance.now();render(ctx, view);renderMs=performance.now()-renderStart;
  framePresented=true;phase('render',renderStart);
  lastView = view;
 }
 return {moving, ambient: hand.speed !== 0,presented:framePresented};
};
let lastView: WorldView | null = null;
const hasVisibleMotion=(view:WorldView)=>mobilityDrawCommands(ctx,view).length>0||vesselDrawCommands(ctx,view).length>0||aircraftDrawCommands(ctx,view).aircraft.length>0;
const sameFrame = (a: WorldView | null, b: WorldView): boolean =>
 !!a &&
 a.light === b.light &&
 a.geography?.revision === b.geography?.revision &&
 a.terrain?.revision === b.terrain?.revision &&
 a.mobility?.length===b.mobility?.length &&
 a.vessels?.length===b.vessels?.length &&
 a.aircraft?.length===b.aircraft?.length &&
 a.camera.x === b.camera.x &&
 a.camera.y === b.camera.y &&
 a.camera.zoom === b.camera.zoom &&
 a.camera.rotation === b.camera.rotation &&
 a.viewport.width === b.viewport.width &&
 a.viewport.height === b.viewport.height &&
 a.state === b.state &&
 a.chunks === b.chunks &&
 a.tool === b.tool &&
 a.preview === b.preview &&
 a.previewAffordable === b.previewAffordable &&
 a.hover?.x === b.hover?.x &&
 a.hover?.y === b.hover?.y &&
 (a.motion === b.motion || !hasVisibleMotion(b));
const frames = createFrameScheduler({draw,onSample:sample=>{if(PERF_DEBUG)perfSamples.record({...sample,phases:framePhases});}});
invalidateFrame = frames.invalidate;
if (PERF_DEBUG) {
 const diagnostics=document.createElement('pre');diagnostics.id='open-sim-frame-stats';diagnostics.hidden=true;document.body.append(diagnostics);
 window.setInterval(()=>{if(document.hidden)return;const agents=lastView?.mobility??[];diagnostics.textContent=JSON.stringify({motionMs,renderMs,frames:frames.stats(),samples:perfSamples.snapshot(),buildings:buildingCacheStats(),terrain:terrain.status(),mobility:{agents:agents.length,kinds:Object.fromEntries(['car','truck','pedestrian','bus','police','school-bus'].map(kind=>[kind,agents.filter(agent=>agent.kind===kind).length])),networkJob:mobilityStream?.status(),nodes:mobility.network().nodes.size,edges:mobility.network().edges.size}});},1000);
 const debugWindow = window as unknown as {
  openSimFrames?: () => ReturnType<typeof frames.stats>;
  openSimDebug?: () => unknown;
 };
 debugWindow.openSimFrames = () => frames.stats();
 debugWindow.openSimDebug = () => {
  const current = stateOf();
  const chunks = client.view().chunks;
  return {
   marks: {...PERF_MARKS},
   frames: frames.stats(),
   map: 'decodeStats' in maps ? (maps as OsmSource).decodeStats() : null,
   visible: {requested: chunks.size, ready: [...chunks.values()].filter(status => status.status === 'ready').length},
   state: current
    ? {revision: current.revision, tick: current.tick, managed: Object.keys(current.chunks).length}
    : null,
  };
 };
}
async function start() {
 resize();
 try {
  // The client opens the personal session and restores the player's hand: tool, speed, place, the saved camera and
  // the bundled facts; it also centres a fresh game on its starting region.
  await client.start();
  if(geography&&!session.restoredView){const v=client.view();tell({do:'camera',camera:centerOn(START_CELL,{...v.camera,zoom:.35,rotation:Math.PI/4},v.viewport),settle:true});}
 } catch {
  updateHud();
  return;
 }
 active = true;
 perfMark('session-ready');
 client.setHidden(document.hidden);
 sessions.setHostVisible(!document.hidden);
 // The client already saves on every new revision; the browser only has to redraw, at most once per frame.
 let uiPending = false;
 const redraw = () => {
  invalidateFrame();
  if (uiPending) return;
  uiPending = true;
  requestAnimationFrame(() => {
   uiPending = false;
   updateHud();
  });
 };
 session.subscribe(redraw);
 client.subscribe(redraw);
 new ResizeObserver(() => resize()).observe(canvas);
 window.addEventListener('resize', () => resize());
 // The canvas surface: a gesture becomes the same intentions a typed command or a playthrough produces.
 attachInput(
  canvas,
  {
   geographic: !!geography,
   pick:(point,camera)=>{const hit=lastView?pickSurface({...lastView,camera,terrain:terrain.scene()},point):null;return hit?{x:Math.round(hit.x),y:Math.round(hit.y)}:null;},
   camera: () => client.view().camera,
   zoomScale: deviceScale,
   tool: () => client.view().camera.zoom<.035?'explore':client.view().tool,
   strokeShape: () => strokeShapeOf(client.view().tool),
  },
  {
   onHover(cell) {
    if(client.view().camera.zoom<.035)cell=null;
    tell({do: 'hover', cell});
   },
   onPreview(cells) {
    tell({do: 'stroke', cells});
   },
   onCommit(cells) {
    tell({do: 'commit', cells});
   },
   onCamera: setCamera,
   onTool,
   onTap(cell) {
    if(geography&&client.view().camera.zoom<.035){const v=client.view();tell({do:'camera',camera:centerOn(cell,{...v.camera,zoom:.35},v.viewport),settle:true});return;}
    // What the player touched, described by the core through the client so the card cannot disagree with the city.
    void client.do({do: 'inspect', cell}).then(() => {
     const view = client.view();
     if (!view.card) {
      inspector.show(null);
      return;
     }
     const scale = deviceScale(),
      point = project(cell, view.camera);
     inspector.show({cell, reading: view.card.reading, at: {x: point.x / scale, y: point.y / scale}});
    });
   },
   onCancel() {
    tell({do: 'cancel'});
   },
  },
 );
 placeForm?.addEventListener('submit', event => {
  event.preventDefault();
  const raw = {lat: placeLat?.value.trim() ?? '', lon: placeLon?.value.trim() ?? ''},
   lat = Number(raw.lat),
   lon = Number(raw.lon);
  // The client validates the coordinate and refuses an off-map pair with its own message; the form shows that message.
  void client.do({do: 'goTo', lat, lon}).then(result => {
   if (placeError) {
    placeError.hidden = result.ok;
    if (!result.ok) placeError.textContent = result.message;
   }
  });
 });
 document.addEventListener('visibilitychange', () => {
  // Hiding stops the clock and saves; showing resumes without replaying the hidden time.
  client.setHidden(document.hidden);
  // A browser in a background tab is not a promise: while the host is hidden the session reports itself as paused.
  sessions.setHostVisible(!document.hidden);
  updateHud();
  if(document.hidden)frames.stop();else invalidateFrame();
 });
 window.addEventListener('pagehide', () => saveNow());
 // First paint is the restored local state. Merely queueing network/storage work in the same task can still delay the
 // browser's actual paint on a phone, so background work starts only after one rendered frame has returned to the UA.
 updateHud();
 invalidateFrame();
 requestAnimationFrame(() => {
  setTimeout(() => {
   perfMark('background-start');
   // Refresh demographic facts for the place the camera restored to, and make the visible region ready. Both run
   // inside the client now; the browser only asks for them and marks when they are done.
   void client.do({do: 'facts'}).catch(() => {});
   void client
    .do({do: 'retryMap'})
    .then(() => client.idle())
    .then(() => {
     perfMark('map-visible-ready');
     updateHud();
    })
    .catch(() => {});
   // History/version materialization is useful but never gameplay-critical. Give input and map restoration first use
   // of idle time; the timeout guarantees the panel eventually becomes ready even on a continuously busy tab. The
   // client owns the version graph now; the browser only asks it to open and marks when the panel is ready.
   const materialize = () =>
    void client
     .do({do: 'openWorld'})
     .then(() => {
      perfMark('history-ready');
      updateHud();
     })
     .catch(() => updateHud());
   const idle = (window as Window & {requestIdleCallback?: (cb: () => void, options?: {timeout: number}) => number})
    .requestIdleCallback;
   if (idle) idle(materialize, {timeout: 2500});
   else setTimeout(materialize, 800);
  }, 0);
 });
}
const started = start();
// Under the test seam only, publish a handle so the jsdom harness can await session-ready and read the live client,
// the hud and the host's time. It is the same client the player drives through the DOM; the handle only lets the
// harness assert what the DOM alone cannot (the client's tool, the manual clock). Never set in production.
if (testPorts)
 (window as unknown as {__openSimTestClient?: unknown}).__openSimTestClient = {
  client,
  hud,
  time,
  sessions,
  ready: started,
  availableBases,
 };
void started;

// The installed game opens without a network: the service worker keeps the shell and the assets this page loaded.
if(import.meta.env.PROD&&'serviceWorker' in navigator){
 void navigator.serviceWorker.register(new URL('sw.js',document.baseURI).href).then(async registration=>{
  await navigator.serviceWorker.ready;
  const urls=[...document.querySelectorAll<HTMLScriptElement>('script[src]')].map(node=>node.src);
  urls.push(...[...document.querySelectorAll<HTMLLinkElement>('link[href]')].map(node=>node.href));
  urls.push(...performance.getEntriesByType('resource').map(entry=>entry.name));
  (registration.active??navigator.serviceWorker.controller)?.postMessage({type:'cache-shell',urls});
 }).catch(()=>{});
}
