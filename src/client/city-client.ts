// The city as a player meets it, independent of any surface (spec 2026-10-01 §5). It holds what is the player's and
// not the world's — the tool in hand, the stroke being drawn, the preview, the speed, the card that is open — accepts
// intentions, routes the ones that change the world to the session, and publishes one view every surface draws from.
//
// It reads no clock and touches no screen: time arrives through `TimePort`, and the only way out is `view()`.
import type {Action,BaseChunk,Cell,CellCoord,CityStats,GameState,SavedGame,ViewState} from '../core/model';
import {EMPTY_ECONOMY} from '../core/model';
import {CHUNK,WORLD,chunkId,cellIndex,chunkOrigin} from '../core/coordinates';
import {createMapStreaming} from '../session/map-streaming';
import {cameraFor,viewpointOf} from '../presentation/viewpoint';
import {quoteAction} from '../core/quote';
import type {Quote} from '../core/quote';
import {describeCell,summarize} from '../core/simulation';
import type {CellReading} from '../core/simulation';
import type {LocalSession,SaveStatus} from '../session/local-session';
import type {ChunkStatus} from '../session/ports';
import type {Camera,Viewport} from '../presentation/camera';
import {approach,arrived,nextZoomStep,centerOn,closestChunks,isCoarse,normalizeAngle,pick,rotateTo,settleZoom,visibleChunks,zoomTo,GLIDE_PER_SECOND} from '../presentation/camera';
import {createTickClock} from '../presentation/clock';
import type {ClockRole,Speed} from '../presentation/clock';
import type {SelectedTool} from '../presentation/tools';
import {toCell,toGeo} from '../core/coordinates';
import type {Intent,IntentResult} from './intents';
import {debounce} from './time';
import type {TimePort} from './time';
import type {CityFacts,FactsPort} from './facts';
import {PLACES,goToCoord,placeByName} from './facts';
import {createVersions} from './versions';
import type {VersionsController} from './versions';
import {createSessionController} from './session';
import type {SessionController, SessionPorts, SessionRouter} from './session';
import type {CompositionInfo} from '../presentation/world-composition-model';
import type {HistoryBranches,HistoryInfo} from '../presentation/world-history-model';
import type {ContentHasher,WorldCodec} from '../world/ports';
import type {DatasetTerm} from '../world/model';
import type {WorldRepository} from '../session/world-repository';

// The door every world-changing action goes through. `GameSessionView` (src/presentation/multiplayer.ts) is the one
// the game uses: it applies locally while the branch is this device's and hands the action to the live session when
// it is not. Declared structurally here so the client depends on the contract, not on the panel module beside it.
export type ActionRouter = {
 mode(): 'local' | 'host' | 'replica';
 state(): GameState | null;
 submitAction(action: Action): Promise<{status: string}>;
 refusal(): {cells: readonly CellCoord[]; reason: string; preview: {money: number; cost: number} | null} | null;
 tick(): Promise<unknown>;
 status(): {kind: string; detail: string};
 setPersistence(report: SaveStatus): void;
 // While a session owns the branch, the client tells it when the map provider is failing (optional on hosts that
 // do not surface a source error, like the plain test router).
 setSourceError?(message: string | null): void;
} & Partial<SessionRouter>;

export type CityClientConfig = {
 local: LocalSession;
 router: ActionRouter;
 time: TimePort;
 // The region the game starts in when there is no save to restore.
 initialChunk: string;
 // Where a fresh game puts the camera and what it calls the place, before the surface reports otherwise.
 camera?: Camera;
 place?: string;
 // The real-city demography source. Without it the game simply has no figures — never invented ones.
 facts?: FactsPort;
 // A surface that animates the camera (the canvas) sets this and drives `step(seconds)` each frame; a surface that
 // does not (text, tests) leaves it off and every camera move lands at once.
 animated?: boolean;
 // The device-pixel scale the zoom ladder is built from, so a snapped zoom is a tile of a whole number of pixels and
 // a one-pixel line stays one pixel wide. The browser injects its own; text and tests use 1.
 zoomScale?: () => number;
 // How much room the surface starts with, in buffer pixels; the camera math and the visible-region loading need it.
 viewport?: Viewport;
 // The map provider's credit, shown in the view's `map.attribution`. The host knows which source it composed.
 attribution?: {text: string; url: string};
 // Called after the world accepted or refused something the player asked: the browser refreshes its history panel.
 afterAction?: (receipt: {status: string}) => void;
 // The version machine (stages C and D): the repository that keeps the versions, the codec and hasher that address
 // their bytes, the terms a frozen base travels under, and the branch names. Without it the game has no history —
 // the city still plays, it just cannot be versioned, compared or exported (a host that composed no repository).
 versions?: {repository: WorldRepository; codec: WorldCodec; hasher: ContentHasher; terms?: readonly DatasetTerm[]; worldId?: string; branchId?: string};
 // Materialize the version history as part of `start()`. The browser leaves this off and defers it to idle time to
 // protect its opening marks (spec P9); the terminal and the test host turn it on so a checkpoint has a head at once.
 openVersionsOnStart?: boolean;
 // The cooperative session's adapters (stage E): crypto keys, transport and signaling, composed by the host (WebRTC +
 // manual signaling in the browser, in-memory in Node/tests). Without it the city still plays alone — opening a
 // session is simply refused with a message. The router passed above must be a full GameSessionView for this to work.
 session?: SessionPorts;
};

export type ClientPreview = {cells: readonly CellCoord[]; cost: number | null; affordable: boolean; message: string};
export type ClientView = {
 ready: boolean;
 // The state on screen: the personal game, or the version a live session confirmed on this device.
 state: GameState | null;
 stats: CityStats;
 tool: SelectedTool;
 speed: Speed;
 place: string;
 camera: Camera;
 viewport: Viewport;
 // Where the camera is heading while a move is in flight, or null when it has arrived.
 glide: Camera | null;
 hover: CellCoord | null;
 stroke: readonly CellCoord[] | null;
 preview: ClientPreview;
 notice: string;
 save: SaveStatus;
 card: {cell: CellCoord; reading: CellReading} | null;
 // The real city under the camera, and the one-line reminder that the game is a neighbourhood inside it.
 facts: CityFacts | null;
 factsAt?: {lat: number; lon: number} | null;
 scale: string;
 // The map: a loading or failure line, and the source's attribution.
 map: {message: string; attribution: {text: string; url: string}};
 // The cell under the viewport centre, so a surface can follow the camera without the projection math.
 center: CellCoord;
 // The regions the client has asked for and their status, for a surface that paints the map (the canvas renderer).
 chunks: ReadonlyMap<string, ChunkStatus>;
 // What a surface needs to draw a cell: the managed state first, then whatever region the session has loaded.
 cellAt(cell: CellCoord): Cell | null;
 chunk(id: string): ChunkStatus | undefined;
 // The version machine's models (stages C and D), or null when no repository was composed. The history and branches
 // the panel renders, the two futures of the place under the camera, and the bytes of the last export the host writes.
 history: HistoryInfo | null;
 branches: HistoryBranches | null;
 scenarios: CompositionInfo | null;
 export: {name: string; bytes: Uint8Array} | null;
};

export type CityClient = {
 start(): Promise<void>;
 do(intent: Intent): Promise<IntentResult>;
 view(): ClientView;
 subscribe(listener: () => void): () => void;
 // Resolves once nothing the client started is still running: the save, the tick, the answer to an intention.
 idle(): Promise<void>;
 // One frame of the camera moving, for a surface that animates it. Returns true while a move is still in flight.
 step(seconds: number): boolean;
 // Price an action without changing anything, with the same rules the preview and the economy use (the version's
 // managed regions plus the detailed regions the client has asked for). A machine surface quotes before it acts.
 quote(action: Action): Quote;
 // The device's save as bytes-ready data, and the inverse: restore a validated save over this client's session. A
 // host writes the snapshot to a file; a surface round-trips it. Both keep unknown interoperable metadata (snapshot.ts).
 snapshot(): SavedGame;
 restore(save: unknown): void;
 setHidden(hidden: boolean): void;
 setRole(role: ClockRole): void;
 viewState(): ViewState;
 saveNow(): void;
 refresh(): void;
 // The version machine, for a host that drives it directly: the session view's `commit` checkpoints through it, and
 // a cooperative session forks from `head()`/`shown()`. Null when no repository was composed.
 versions: VersionsController | null;
 // The cooperative session controller, for a host that drives it directly (the browser panel's buttons map to it).
 // Null when no session ports were composed. The text surface reaches it through the `openSession`/`join`/… intents.
 session: SessionController | null;
 // Re-read the live session's confirmed state (a replica catches up to what the host confirmed after the transport
 // delivered it). A host/test drives this after draining the shared transport; a lone game never needs it.
 syncSession(): Promise<void>;
 stop(): void;
};

const EMPTY_STATS: CityStats = {money: 0, population: 0, jobs: 0, energySupply: 0, energyUsed: 0, happiness: 0, income: 0, managed: 0, economy: EMPTY_ECONOMY};
const NO_PREVIEW: ClientPreview = {cells: [], cost: null, affordable: true, message: ''};
const SAVE_DEBOUNCE_MS = 500;
// Quiet time before a map load runs: a pan is one fetch, not dozens. The save's own debounce is separate.
const LOAD_DEBOUNCE_MS = 200;
// How many regions one load pass may ask for: coarse ones for a wide view, detailed ones scaled by the zoom.
const OVERVIEW_REGION_BUDGET = 512;
const DETAIL_REGION_BUDGET = 120;
const DEFAULT_CAMERA: Camera = {x: 0, y: 0, zoom: 1, rotation: 0};
// A surface that never reports its size still needs a box to project the camera into; the browser overrides it at boot.
const DEFAULT_VIEWPORT: Viewport = {width: 1024, height: 640};
const NO_FACTS: ClientView['facts'] = null;

export function createCityClient(config: CityClientConfig): CityClient {
 const {local, router, time} = config;
 const facts: FactsPort | null = config.facts ?? null;
 const animated = config.animated ?? false;
 const zoomScale = config.zoomScale ?? (() => 1);
 const attribution = config.attribution ?? {text: '', url: ''};
 const listeners = new Set<() => void>();
 const work = new Set<Promise<unknown>>();
 let ready = false, tool: SelectedTool = 'explore', speed: Speed = 0, place = config.place ?? '';
 let camera: Camera = config.camera ?? DEFAULT_CAMERA, hover: CellCoord | null = null, stroke: readonly CellCoord[] | null = null;
 let preview: ClientPreview = NO_PREVIEW, notice = '', card: {cell: CellCoord; reading: CellReading} | null = null;
 let revision = -1, cached: ClientView | null = null, statsState: GameState | null = null, stats = EMPTY_STATS;
 // Place and camera (stage B): the viewport the surface reports, the glide target, the regions asked for, the map's
 // own message, and the real-city facts with the census the client has published to the world.
 let viewport: Viewport = config.viewport ?? DEFAULT_VIEWPORT;
 let factsAt: {lat: number; lon: number} | null = null;
 let glide: Camera | null = null, loadMessage = '', cityFacts: CityFacts | null = NO_FACTS, pendingCensus: CityFacts | null = null;
 // The bytes of the last export, held for the host to write; cleared is simply null until an export runs.
 let exportBytes: {name: string; bytes: Uint8Array} | null = null;
 const requested = new Set<string>();
 let unsubscribe: () => void = () => {};

 const track = <T>(promise: Promise<T>): Promise<T> => {
  work.add(promise);
  void promise.finally(() => work.delete(promise)).catch(() => undefined);
  return promise;
 };
 const changed = () => { cached = null; for (const listener of [...listeners]) listener(); };
 const stateOf = (): GameState | null => {
  if (router.mode() !== 'local') return router.state();
  try { return local.getState(); } catch { return null; }
 };
 const statsOf = (state: GameState | null): CityStats => {
  if (!state) return EMPTY_STATS;
  if (state !== statsState) { statsState = state; stats = summarize(state); }
  return stats;
 };
 const actionFor = (cells: readonly CellCoord[]): Action | null =>
  tool === 'explore' ? null : tool === 'demolish' ? {type: 'demolish', cells: [...cells]} : {type: 'build', tool, cells: [...cells]};
 // A quote looks only at the regions the cells fall in that the version does not manage yet, and only at detail:
 // the economy never prices a coarse approximation of a place.
 const basesFor = (state: GameState, cells: readonly CellCoord[]): BaseChunk[] => {
  const bases: BaseChunk[] = [];
  for (const id of new Set(cells.map(chunkId))) {
   if (state.chunks[id]) continue;
   const status = local.getChunk(id);
   if (status?.status === 'ready' && status.level === 'detail') bases.push(status.base);
  }
  return bases;
 };
 const refreshPreview = () => {
  const cells = tool === 'explore' ? [] : stroke ?? (hover ? [hover] : []);
  const state = stateOf(), action = cells.length ? actionFor(cells) : null;
  if (!state || !action) { preview = cells.length ? {...NO_PREVIEW, cells} : NO_PREVIEW; return; }
  const quote = quoteAction(state, action, basesFor(state, cells));
  preview = quote.status === 'ok'
   ? {cells, cost: quote.cost, affordable: true, message: `Custo: ${quote.cost}`}
   : {cells, cost: quote.cost, affordable: false, message: `Bloqueado: ${quote.reason}`};
 };
 // The centre (a world point) is what survives a change of projection or screen; x/y stay for older readers.
 const viewState = (): ViewState => ({x: camera.x, y: camera.y, zoom: camera.zoom, speed, place, rotation: camera.rotation, center: viewpointOf(camera, viewport).center});
 // Land the camera, speed and place on whatever the session just restored (a reopen or a `load`): a save from before
 // the centre was recorded is put back over its first managed region, its old x/y belonging to an older projection.
 const adoptRestored = () => {
  const restored = local.restoredView;
  if (restored) {
   const legacy = Object.keys(local.getState().chunks)[0] ?? config.initialChunk, origin = chunkOrigin(legacy);
   camera = cameraFor({center: restored.center ?? {x: origin.x + CHUNK / 2, y: origin.y + CHUNK / 2}, zoom: restored.zoom, rotation: normalizeAngle(restored.rotation ?? 0)}, viewport);
   speed = restored.speed;
   place = restored.place;
  } else {
   // A fresh game opens centred on the region it starts in, not at the origin of a planet-wide grid.
   camera = centerOn(chunkOrigin(config.initialChunk), {...camera, x: 0, y: 0}, viewport);
  }
 };
 // The personal save never claims the work of a session: while a session owns the branch, its own durable
 // confirmation is what says the device has the version.
 const saveNow = () => { if (ready && router.mode() === 'local') void track(local.save(viewState())); };
 const scheduleSave = debounce(time, SAVE_DEBOUNCE_MS, saveNow);
 const clock = createTickClock(() => { void track(router.tick()); }, (ms, fn) => time.every(ms, fn));
 // While a session owns the branch, the summary line follows the session's durable state instead of the personal save.
 const saveStatus = (): SaveStatus => {
  const device = local.getSaveStatus();
  if (router.mode() === 'local') return device;
  const status = router.status();
  if (status.kind === 'storage-error') return {status: 'error', blocked: false, message: status.detail};
  if (status.kind === 'pending') return {status: 'saving', blocked: false};
  if (status.kind === 'paused' || status.kind === 'source-error') return {status: 'idle', blocked: false};
  return {status: 'saved', blocked: false};
 };
 // A region that is only loaded as an approximation refuses construction; answering with its detail is what makes the
 // next attempt work instead of leaving the player without an explanation.
 const loadDetailFor = (cells: readonly CellCoord[]) => {
  const ids = [...new Set(cells.map(chunkId))].filter(id => { const status = local.getChunk(id); return !status || status.status !== 'ready' || status.level !== 'detail'; });
  if (ids.length) void track(local.loadVisible(ids).then(() => { refreshPreview(); changed(); }, () => undefined));
 };
 const cellAt = (cell: CellCoord): Cell | null => {
  const state = stateOf(), id = chunkId(cell), managed = state?.chunks[id], index = cellIndex(cell);
  if (managed) return managed.edits[index] ?? managed.base.cells[index] ?? null;
  const status = local.getChunk(id);
  return status?.status === 'ready' ? status.base.cells[index] ?? null : null;
 };

 // --- place and camera (stage B) --------------------------------------------------------------------------------
 // The cell under the viewport centre: what a surface draws around, and where a goTo/place lands the camera.
 const centerCell = (): CellCoord => pick({x: viewport.width / 2, y: viewport.height / 2}, camera);
 // --- the version machine (stages C and D) ----------------------------------------------------------------------
 // Only detailed regions count: the economy must never quote or adopt a coarse approximation of a place. The regions
 // the client asked for plus whatever the version manages, read at detail, are what a scenario may build on.
 const availableBases = (): BaseChunk[] => {
  const state = stateOf(), bases: BaseChunk[] = [];
  for (const id of new Set([...Object.keys(state?.chunks ?? {}), ...requested])) {
   const status = local.getChunk(id);
   if (status?.status === 'ready' && status.level === 'detail') bases.push(status.base);
  }
  return bases;
 };
 const versions: VersionsController | null = config.versions ? createVersions({
  repository: config.versions.repository,
  codec: config.versions.codec,
  hasher: config.versions.hasher,
  time,
  worldId: config.versions.worldId ?? 'open-sim',
  branchId: config.versions.branchId ?? 'main',
  terms: config.versions.terms ?? [],
  state: () => stateOf(),
  view: () => viewState(),
  lastOperations: () => local.lastChange()?.operations.map(operation => operation.id) ?? [],
  availableBases,
  focus: () => centerCell(),
  changed: () => changed(),
 }) : null;
 // The cooperative session (stage E): a pure controller over the router, the version machine and the clock role. The
 // adapters (keys, transport, signaling) are the host's, injected as `config.session`. Without them, or without a
 // version repository to fork from, opening a session is simply refused with a message by the controller.
 const sessionRepo = config.versions?.repository ?? null;
 const sessionWorldId = config.versions?.worldId ?? 'open-sim';
 const session: SessionController | null = config.session ? createSessionController({
  worldId: sessionWorldId,
  branchId: config.versions?.branchId ?? 'main',
  router: router as unknown as SessionRouter,
  versions,
  setRole: role => clock.setRole(role),
  rulesVersion: () => stateOf()?.rulesVersion ?? 0,
  branchIds: async () => {
   if (!sessionRepo) return [];
   const known = await sessionRepo.branches(sessionWorldId);
   return known.ok ? known.value.map(head => head.branchId) : [];
  },
  fork: async (base, branchId) => {
   if (!sessionRepo) throw new Error('Sem repositório de versões para ramificar a sessão.');
   const forked = await sessionRepo.fork(base, {worldId: sessionWorldId, branchId});
   if (!forked.ok) throw new Error(forked.error.message);
   return forked.value;
  },
  ports: config.session,
  changed: () => changed(),
 }) : null;
 const mapFailureText = (): string => 'Falha ao carregar o mapa. Tente novamente.';
 // One zoom step either way, on the crisp ladder: the terminal's "zoom +/-", the browser's wheel notches and buttons.
 const stepZoom = (direction: 1 | -1): Camera => zoomTo(camera, viewport, nextZoomStep(glide?.zoom ?? camera.zoom, zoomScale(), direction));
 // A camera move either lands at once (a surface that does not animate, or `settle` for direct manipulation) or
 // becomes the glide target `step` chases. `settle` keeps the surface's exact zoom (a pinch is continuous and
 // rounding it mid-gesture would slide the scene); a glide target lands on the crisp ladder.
 const moveCamera = (next: Camera, label?: string, quiet = false, settle = false) => {
  const land = settle && animated;
  const zoom=land?next.zoom:settleZoom(next.zoom,zoomScale(),true);
  const target:Camera={...(zoom===next.zoom?next:zoomTo(next,viewport,zoom)),rotation:normalizeAngle(next.rotation)};
  if (label !== undefined) place = label;
  hover = null;
  if (animated && !settle) { glide = target; }
  else { camera = target; glide = null; }
  if (!quiet) scheduleSave();
  loadSoon();
 };
 // The real-city facts for a place, fetched off the hot path and published to the world as the city census so a shared
 // session reads the figure the screen shows. The bundled fact (if any) is on screen before the network answers.
 const slugOf = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'cidade';
 const flushCensus = () => {
  const next = pendingCensus;
  if (!next || !stateOf()) return;
  pendingCensus = null;
  void track(router.submitAction({type: 'component', key: 'city.census', entity: slugOf(next.label), value: {population: next.population ?? null, year: next.populationYear ?? null, country: next.country ?? null, dataset: next.source.dataset, url: next.source.url}})
   .then(receipt => { if ((receipt as {code?: string}).code === 'NOT_FOUND') pendingCensus ??= next; }, () => { pendingCensus ??= next; }));
 };
 const showFacts = (next: CityFacts | null, publish: boolean, at?: {lat: number; lon: number}) => { cityFacts = next; factsAt = next ? at ?? null : null; if(!next)pendingCensus=null; if (publish && next) { pendingCensus = next; flushCensus(); } };
 // Only the newest lookup may change the facts or publish a census: a slow answer about the previous city must not
 // overwrite the one the player just went to.
 let lookups = 0;
 const lookUp = (lat: number, lon: number, name?: string) => {
  if (!facts) return;
  const ticket = (lookups += 1);
  void track((name ? facts.named(name) : Promise.resolve(null)).then(live => live ?? facts.near(lat, lon)).then(found => { if (found && ticket === lookups) { showFacts(found, true, {lat, lon}); changed(); } }, () => undefined));
 };
 // The reminder that the game is a neighbourhood inside the real place: shown only once the census is in the world, so
 // the sentence never claims the simulation accounts for the real millions before the figure has been published.
 const scaleText = (state: GameState | null): string => {
  if (!state || !cityFacts?.population) return '';
  const built = state.components['city.census'];
  if (!built || !Object.keys(built).length) return '';
  const simPopulation = statsOf(state).population;
  return `Sua cidade reúne ${simPopulation.toLocaleString('pt-BR')} moradores simulados; a cidade real tem ${cityFacts.population.toLocaleString('pt-BR')} — o que você constrói é um bairro dentro dela.`;
 };

 // Loading streams from the viewport centre outwards (src/session/map-streaming.ts): every visible region as an
 // overview first, the nearest ones in detail, a few at a time, and after the camera rests a small ring of neighbours
 // is prepared too. The session is told what is visible so a long exploration does not grow memory without bound, and
 // a region that failed waits for the player's retry instead of an endless automatic loop.
 let streamFailed = false;
 const stream = createMapStreaming({
  concurrency: 4,
  available: (id, level) => { const status = local.getChunk(id); return status?.status === 'ready' && (status.level === 'detail' || level === 'overview'); },
  load: async (ids, level) => { await local.loadVisible(ids, level); refreshPreview(); changed(); },
  onError: () => { streamFailed = true; loadMessage = mapFailureText(); router.setSourceError?.(loadMessage); changed(); },
 });
 let cancelNearby: () => void = () => {};
 const NEARBY_DELAY_MS = 800, NEARBY_CENTRES = 12;
 const loadVisible = async (): Promise<void> => {
  const visible = visibleChunks(camera, viewport);
  if(camera.zoom<.035){cancelNearby();requested.clear();local.retainVisible([]);stream.updateDemand({visible:[],detail:[],nearby:[]});loadMessage='';changed();return;}
  local.retainVisible(visible);
  requested.clear();
  for (const id of visible) requested.add(id);
  const demand = {
   visible: closestChunks(visible, camera, viewport, OVERVIEW_REGION_BUDGET),
   detail: isCoarse(camera) ? [] : closestChunks(visible, camera, viewport, DETAIL_REGION_BUDGET),
   nearby: [] as string[],
  };
  const missing = demand.visible.some(id => { const status = local.getChunk(id); return !status || status.status !== 'ready'; });
  if (missing && !streamFailed) { loadMessage = 'Carregando mapa…'; changed(); }
  stream.updateDemand(demand);
  // Preparing the neighbours yields to gestures: it only starts once the camera has rested for a moment.
  cancelNearby();
  cancelNearby = time.after(NEARBY_DELAY_MS, () => {
   const nearby = new Set<string>();
   for (const id of closestChunks(visible, camera, viewport, NEARBY_CENTRES)) {
    const origin = chunkOrigin(id);
    for (const dx of [-CHUNK, 0, CHUNK]) for (const dy of [-CHUNK, 0, CHUNK]) if (origin.y + dy >= 0 && origin.y + dy < WORLD) nearby.add(chunkId({x: origin.x + dx, y: origin.y + dy}));
   }
   stream.updateDemand({...demand, nearby: [...nearby]});
  });
  await stream.idle();
  if (!streamFailed) { loadMessage = ''; router.setSourceError?.(null); }
  refreshPreview();
  changed();
 };
 const retryLoad = () => { streamFailed = false; loadMessage = ''; stream.retry(); return loadVisible(); };
 const scheduleLoad = debounce(time, LOAD_DEBOUNCE_MS, () => { void track(loadVisible()); });
 // A non-animating surface lands at once and expects the map to answer at once, so its idle() can wait for it; an
 // animating one coalesces the loads of a glide into one debounced pass instead of one per reported frame.
 const loadSoon = () => { if (animated) scheduleLoad(); else void track(loadVisible()); };

 async function submit(action: Action, cells: readonly CellCoord[]): Promise<IntentResult> {
  const receipt = await router.submitAction(action);
  const refused = router.refusal();
  if (refused) {
   // A refusal keeps the player's selection and shows the fresh numbers instead of throwing the work away.
   stroke = refused.cells.length ? refused.cells : null;
   notice = refused.preview ? `${refused.reason} · ${refused.preview.money} neste dispositivo · custo ${refused.preview.cost}` : refused.reason;
   if (refused.reason.includes('Espere o mapa carregar')) loadDetailFor(cells);
  } else notice = '';
  refreshPreview();
  changed();
  config.afterAction?.(receipt);
  return {ok: !refused && (receipt.status === 'accepted' || receipt.status === 'duplicate'), message: refused?.reason ?? ''};
 }

 async function perform(intent: Intent): Promise<IntentResult> {
  switch (intent.do) {
   case 'tool': tool = intent.tool; stroke = null; break;
   case 'hover': hover = intent.cell; break;
   case 'stroke': stroke = intent.cells.length ? intent.cells : null; break;
   case 'cancel': tool = 'explore'; stroke = null; break;
   case 'speed': speed = intent.speed; clock.setSpeed(speed); scheduleSave(); break;
   case 'inspect': {
    const state = stateOf(), reading = intent.cell && state ? describeCell(state, intent.cell) : null;
    card = intent.cell && reading ? {cell: intent.cell, reading} : null;
    changed();
    return {ok: !!card || !intent.cell, message: intent.cell && !card ? 'Nada carregado nessa célula' : ''};
   }
   case 'camera': moveCamera(intent.camera, intent.place, intent.quiet, intent.settle); break;
   case 'viewport': {
    // A surface reports its size: keep the cell that was under the centre there, so a resize orbits the view.
    const next = {width: Math.max(1, Math.round(intent.width)), height: Math.max(1, Math.round(intent.height))};
    if (next.width !== viewport.width || next.height !== viewport.height) {
     const keep = centerCell();
     viewport = next;
     camera = centerOn(keep, camera, viewport);
     if (glide) glide = centerOn(keep, glide, viewport);
     if (!intent.quiet) scheduleSave();
     loadSoon();
    }
    break;
   }
   case 'pan': moveCamera(centerOn({x: centerCell().x + Math.round(intent.dx), y: centerCell().y + Math.round(intent.dy)}, camera, viewport)); break;
   case 'zoom': moveCamera(stepZoom(intent.direction)); break;
   case 'rotate': moveCamera(rotateTo(camera, viewport, intent.radians)); break;
   case 'north': moveCamera(rotateTo(camera, viewport, 0)); break;
   case 'overview': moveCamera(zoomTo(camera, viewport, .05)); break;
   case 'center': moveCamera(centerOn(intent.cell, camera, viewport), intent.place); break;
   case 'place': {
    const target = placeByName(intent.name);
    if (!target) return {ok: false, message: `Lugar desconhecido: ${intent.name}. Conhecidos: ${Object.values(PLACES).map(p => p.name).join(', ')}`};
    moveCamera(centerOn(toCell(target.lat, target.lon), camera, viewport), target.name);
    showFacts(target.facts, true, {lat: target.lat, lon: target.lon}); // the bundled figure is on screen before the network answers
    lookUp(target.lat, target.lon, target.name);
    break;
   }
   case 'goTo': {
    const resolved = goToCoord(intent.lat, intent.lon);
    if ('error' in resolved) { notice = resolved.error; changed(); return {ok: false, message: resolved.error}; }
    moveCamera(centerOn(resolved.cell, camera, viewport), resolved.label);
    showFacts(null,false);
    lookUp(intent.lat, intent.lon);
    break;
   }
   case 'retryMap': void track(retryLoad()); break;
   case 'facts': { const geo = toGeo(centerCell()); lookUp(geo.lat, geo.lon); break; }
   // --- versions, history, comparison (stage C) and two futures (stage D) ----------------------------------------
   case 'openWorld': if (versions) await versions.open(); return {ok: !!versions, message: versions ? '' : 'Sem repositório de versões neste host'};
   case 'createVersion': if (versions) await versions.createVersion(intent.name); return {ok: !!versions, message: versions ? '' : 'Sem repositório de versões neste host'};
   case 'selectBranch': if (versions) await versions.selectBranch(intent.branchId); return {ok: !!versions, message: ''};
   case 'compare': if (versions) await versions.compare(intent.prefix); return {ok: !!versions, message: ''};
   case 'export': {
    if (!versions) return {ok: false, message: 'Sem repositório de versões neste host'};
    const result = await versions.export();
    exportBytes = result;
    changed();
    return {ok: !!result, message: result ? '' : 'Nenhuma versão para exportar'};
   }
   case 'import':
    if (!versions) return {ok: false, message: 'Sem repositório de versões neste host'};
    await versions.import(intent.bytes);
    changed();
    return {ok: true, message: ''};
   case 'region': moveCamera(centerOn(versions ? versions.regionCell(intent.chunkId) : centerCell(), camera, viewport)); break;
   case 'compareFutures': if (versions) await versions.compareFutures(); return {ok: !!versions, message: versions ? '' : 'Sem repositório de versões neste host'};
   // --- cooperative session (stage E) ----------------------------------------------------------------------------
   case 'openSession':
    if (!session) return {ok: false, message: 'Sem sessão cooperativa neste host'};
    await session.open();
    return {ok: router.mode?.() !== 'local', message: ''};
   case 'invite':
    if (!session) return {ok: false, message: 'Sem sessão cooperativa neste host'};
    session.invite();
    return {ok: !!router.descriptor?.(), message: ''};
   case 'join':
    if (!session) return {ok: false, message: 'Sem sessão cooperativa neste host'};
    await session.join(intent.text);
    return {ok: router.mode?.() !== 'local', message: router.message?.() ?? ''};
   case 'transfer':
    if (!session) return {ok: false, message: 'Sem sessão cooperativa neste host'};
    await session.transfer(intent.actor);
    return {ok: true, message: router.message?.() ?? ''};
   case 'pauseSession':
    if (!session) return {ok: false, message: 'Sem sessão cooperativa neste host'};
    session.pause();
    return {ok: true, message: router.message?.() ?? ''};
   case 'leaveSession':
    if (!session) return {ok: false, message: 'Sem sessão cooperativa neste host'};
    await session.leave();
    return {ok: true, message: ''};
   case 'save': saveNow(); break;
   case 'overwriteSave': local.enableSaving(); saveNow(); break;
   case 'tick': {
    // Whole logical ticks, through the same door the clock uses. Bounded by the caller; the client loops the router,
    // never the host, so the "no session.dispatch loop in the host" rule holds for every surface.
    const count = Number.isSafeInteger(intent.count) && intent.count > 0 ? intent.count : 0;
    for (let i = 0; i < count; i += 1) await router.tick();
    refreshPreview();
    changed();
    return {ok: true, message: ''};
   }
   case 'commit': {
    const cells = intent.cells ?? stroke ?? [];
    stroke = null;
    const action = actionFor(cells);
    if (!action || !cells.length) { refreshPreview(); changed(); return {ok: false, message: tool === 'explore' ? 'Escolha uma ferramenta antes de construir' : 'Nenhuma célula escolhida'}; }
    return submit(action, cells);
   }
   case 'policy': {
    const {do: _ignored, ...policy} = intent;
    const receipt = await router.submitAction({type: 'policy', ...policy});
    const refused = router.refusal();
    notice = refused ? refused.reason : '';
    changed();
    config.afterAction?.(receipt);
    return {ok: !refused, message: notice};
   }
  }
  refreshPreview();
  changed();
  return {ok: true, message: ''};
 }

 return {
  async start() {
   await track(local.initialize(config.initialChunk));
   adoptRestored();
   revision = local.getState().revision;
   ready = true;
   unsubscribe = local.subscribe(() => {
    const state = local.getState();
    if (state.revision !== revision) { revision = state.revision; scheduleSave(); }
    refreshPreview();
    changed();
   });
   clock.setSpeed(speed);
   // The bundled facts of the restored place are a zero-I/O warm start; the live lookup refreshes them. Keep the
   // census pending until the first load so publishing it follows the ordinary revision/save path.
   const warmPlace = placeByName(place), warm = warmPlace?.facts ?? null;
   if (warm && warmPlace) { cityFacts = warm; factsAt = {lat: warmPlace.lat, lon: warmPlace.lon}; pendingCensus = warm; }
   refreshPreview();
   changed();
   // The first visible-region pass. A non-animating host runs it at once (its idle() then waits for it); the browser
   // defers it behind its first frame through the debounce, so the restored state paints before the map loads.
   loadSoon();
   flushCensus();
   // A host that wants its history ready at once (terminal, tests) materializes it here; the browser defers it.
   if (config.openVersionsOnStart && versions) await versions.open();
  },
  do: intent => track(perform(intent)),
  step(seconds) {
   // One frame of the camera gliding toward its target. The approach is exponential, so it never overshoots; the
   // tiles it is heading for are asked for as it goes (debounced), and on arrival it snaps to the exact target.
   if (!glide) return false;
   camera = approach(camera, glide, 1 - Math.exp(-GLIDE_PER_SECOND * Math.max(0, seconds)));
   if (arrived(camera, glide)) { camera = glide; glide = null; scheduleSave(); }
   scheduleLoad();
   changed();
   return glide !== null;
  },
  // The same bases the preview and the version machine price against: the economy never quotes a coarse approximation.
  quote(action) { const state = stateOf(); return state ? quoteAction(state, action, availableBases()) : {status: 'blocked', cost: 0, reason: 'Sessão não iniciada'}; },
  snapshot() { return local.snapshot(viewState()); },
  restore(save) {
   local.restore(save);
   adoptRestored();
   revision = local.getState().revision;
   refreshPreview();
   changed();
  },
  view() {
   if (cached) return cached;
   router.setPersistence(local.getSaveStatus());
   const state = stateOf();
   // The regions the renderer paints: the ones the client has asked for, with whatever status the session holds.
   const chunks = new Map<string, ChunkStatus>();
   for (const id of requested) { const status = local.getChunk(id); if (status) chunks.set(id, status); }
   cached = {ready, state, stats: statsOf(state), tool, speed, place, camera, viewport, glide, hover, stroke, preview, notice, save: saveStatus(), card,
    facts: cityFacts, factsAt, scale: scaleText(state), map: {message: loadMessage, attribution}, center: centerCell(), chunks, cellAt, chunk: id => local.getChunk(id),
    history: versions ? versions.history() : null, branches: versions ? versions.branches() : null, scenarios: versions ? versions.scenarios() : null, export: exportBytes};
   return cached;
  },
  subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async idle() { while (work.size) await Promise.allSettled([...work]); },
  setHidden(hidden) { clock.setHidden(hidden); if (hidden) saveNow(); },
  setRole(role) { clock.setRole(role); if (role === 'local') clock.setSpeed(speed); },
  viewState,
  saveNow,
  refresh() { refreshPreview(); changed(); },
  versions,
  session,
  async syncSession() { if (router.mode() !== 'local' && router.refresh) { await track(router.refresh()); refreshPreview(); changed(); } },
  stop() { clock.stop(); unsubscribe(); listeners.clear(); },
 };
}
