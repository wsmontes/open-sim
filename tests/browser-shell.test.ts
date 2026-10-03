// @vitest-environment jsdom
//
// The browser front-end, proved for a real user without a real browser (spec 2026-10-01 §6, §9). This harness loads
// the REAL index.html into the jsdom document, stubs only what jsdom lacks (a recording 2D context, ResizeObserver,
// a manually driven requestAnimationFrame, matchMedia, a fake IndexedDB), and then imports src/browser/main.ts — the
// exact host the browser ships. Its outward ports (map, saves, world storage, facts, clock, session fabric) arrive
// through the test seam main.ts reads only under Vitest (`window.__openSimTestPorts`), so no network, no OSM and no
// wall clock are needed and the run is deterministic. From there the test acts like a player: it clicks the dock,
// drags on the canvas, advances the manual clock, taps a cell, uses the keyboard, opens the sheets and drives every
// panel, asserting the city reacts. Every defect this surfaced was fixed in the product code, noted below.
import 'fake-indexeddb/auto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {afterEach, expect, test, vi} from 'vitest';
import {createFixtureMap} from '../src/adapters/map/fixture';
import {createFixtureFacts, PLACES} from '../src/client/facts';
import {createManualTime} from '../src/client/time';
import type {ManualTime} from '../src/client/time';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {createMemorySessionPorts} from '../src/adapters/session/memory';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldRepository} from '../src/session/world-repository';
import {project} from '../src/presentation/camera';
import {chunkId, toCell, chunkOrigin} from '../src/core/coordinates';
import type {CellCoord} from '../src/core/model';
import type {SaveStore} from '../src/session/ports';
import type {OpenSimTestPorts} from '../src/browser/main';
import type {CityClient} from '../src/client/city-client';
import type {Hud} from '../src/surfaces/canvas/hud';
import {createPlayHost, semanticHash} from '../tools/play-host';
import {runPlaythrough, type Playthrough} from '../src/surfaces/text/playthrough';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(resolve(HERE, '..', 'index.html'), 'utf8');

// --- the stubs jsdom lacks ------------------------------------------------------------------------------------
// A 2D context that records what the renderer drew, so the test can prove the canvas was painted without pixels.
type DrawCall = {op: string; args: unknown[]};
type RecordingContext = {calls: DrawCall[]} & Record<string, unknown>;
function recordingContext(): RecordingContext {
 const calls: DrawCall[] = [];
 const state: Record<string, unknown> = {
  canvas: null,
  fillStyle: '#000',
  strokeStyle: '#000',
  globalAlpha: 1,
  lineWidth: 1,
  font: '10px sans-serif',
  textAlign: 'left',
  textBaseline: 'alphabetic',
  imageSmoothingEnabled: true,
 };
 const methods = [
  'save', 'restore', 'translate', 'scale', 'rotate', 'setTransform', 'resetTransform', 'transform',
  'beginPath', 'closePath', 'moveTo', 'lineTo', 'rect', 'arc', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo',
  'fill', 'stroke', 'clip', 'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText',
  'drawImage', 'putImageData', 'setLineDash',
 ];
 const ctx = new Proxy(state as RecordingContext, {
  get(target, key: string) {
   if (key === 'calls') return calls;
   if (methods.includes(key)) {
    return (...args: unknown[]) => {
     calls.push({op: key, args});
     if (key === 'measureText') return {width: 0};
     return undefined;
    };
   }
   if (key === 'measureText') return () => ({width: 0});
   if (key === 'getImageData') return () => ({data: new Uint8ClampedArray(4), width: 1, height: 1});
   if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern')
    return () => ({addColorStop() {}});
   return target[key];
  },
  set(target, key: string, value) {
   target[key] = value;
   return true;
  },
 });
 return ctx;
}

// A manually driven requestAnimationFrame: the host schedules frames, the test flushes them when it wants one, so the
// glide animation and the "one rendered frame then background work" dance are deterministic.
let frameQueue: FrameRequestCallback[] = [];
let frameTime = 0;
function flushFrames(times = 1): void {
 for (let i = 0; i < times; i += 1) {
  const batch = frameQueue;
  frameQueue = [];
  frameTime += 16;
  for (const cb of batch) cb(frameTime);
 }
}

let objectUrls = 0;

function installStubs(): void {
 // Every canvas hands back the same recording context, keyed on the element so each canvas keeps its own calls.
 const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>();
 (HTMLCanvasElement.prototype as unknown as {getContext: unknown}).getContext = function (this: HTMLCanvasElement) {
  let ctx = contexts.get(this);
  if (!ctx) {
   ctx = recordingContext();
   (ctx as Record<string, unknown>).canvas = this;
   contexts.set(this, ctx);
  }
  return ctx;
 };
 (globalThis as unknown as {__canvasContexts: WeakMap<HTMLCanvasElement, RecordingContext>}).__canvasContexts = contexts;

 class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
 }
 (globalThis as unknown as {ResizeObserver: unknown}).ResizeObserver = TestResizeObserver;
 (window as unknown as {ResizeObserver: unknown}).ResizeObserver = TestResizeObserver;

 window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
  frameQueue.push(cb);
  return frameQueue.length;
 }) as typeof window.requestAnimationFrame;
 window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
 (globalThis as unknown as {requestAnimationFrame: unknown}).requestAnimationFrame = window.requestAnimationFrame;

 if (!window.matchMedia)
  window.matchMedia = ((query: string) => ({
   matches: false,
   media: query,
   onchange: null,
   addEventListener() {},
   removeEventListener() {},
   addListener() {},
   removeListener() {},
   dispatchEvent() {
    return false;
   },
  })) as typeof window.matchMedia;

 // The export/recording download paths make object URLs; jsdom/vitest's own createObjectURL throws on a Blob here, so
 // the harness installs a working stub unconditionally.
 (URL as unknown as {createObjectURL: unknown}).createObjectURL = () => `blob:test/${(objectUrls += 1)}`;
 (URL as unknown as {revokeObjectURL: unknown}).revokeObjectURL = () => {};

 // A canvas measured by its CSS box: jsdom reports 0 for clientWidth/clientHeight, which would collapse the buffer.
 Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {configurable: true, get: () => 960});
 Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {configurable: true, get: () => 600});
}

// A pointer event jsdom can dispatch: it has no PointerEvent constructor, so a MouseEvent carries the pointer fields
// the input surface reads (pointerId, button, clientX/Y, ctrlKey). setPointerCapture is already guarded in input.ts.
function pointer(type: string, init: {clientX?: number; clientY?: number; button?: number; pointerId?: number; ctrlKey?: boolean} = {}): PointerEvent {
 const event = new window.MouseEvent(type, {
  bubbles: true,
  cancelable: true,
  clientX: init.clientX ?? 0,
  clientY: init.clientY ?? 0,
  button: init.button ?? 0,
  ctrlKey: init.ctrlKey ?? false,
 });
 Object.defineProperty(event, 'pointerId', {value: init.pointerId ?? 1});
 Object.defineProperty(event, 'pointerType', {value: 'mouse'});
 return event as unknown as PointerEvent;
}

// --- the harness ----------------------------------------------------------------------------------------------
type Harness = {
 client: CityClient;
 hud: Hud;
 time: ManualTime;
 saves: SaveStore & {slots: Map<string, string>};
 doc: Document;
 ports: OpenSimTestPorts;
 canvasPoint(cell: CellCoord): {clientX: number; clientY: number};
 landCell(): CellCoord;
 reset(): void;
};

const WORLD_ID = 'open-sim';
const START_CHUNK = chunkId(toCell(PLACES.Vancouver!.lat, PLACES.Vancouver!.lon));
const START_ORIGIN = chunkOrigin(START_CHUNK);

// Build the document from the real index.html: keep only the body markup, so jsdom does not try to fetch the module
// script — the harness imports main.ts itself.
function mountIndexHtml(doc: Document): void {
 const bodyMatch = INDEX_HTML.match(/<body>([\s\S]*?)<\/body>/i);
 if (!bodyMatch) throw new Error('index.html has no <body>');
 const body = bodyMatch[1]!.replace(/<script[\s\S]*?<\/script>/gi, '');
 doc.body.innerHTML = body;
}

async function boot(options: {saves?: SaveStore & {slots: Map<string, string>}; failing?: ReadonlySet<string>; failTimes?: number; record?: boolean} = {}): Promise<Harness> {
 installStubs();
 const doc = document;
 mountIndexHtml(doc);
 // The recorder path is gated on ?record=1 (read at module eval). pushState sets the live location before import.
 window.history.pushState({}, '', options.record ? '/?record=1' : '/');

 const codec = createJcsCodec();
 const hasher = bytesHasher();
 const worlds = createWorldMemoryStorage();
 const time = createManualTime();
 const maps = createFixtureMap({failing: options.failing, failTimes: options.failTimes});
 const facts = createFixtureFacts();
 const saves = options.saves ?? createMemoryStore();
 // The cooperative session fabric in memory: the browser path can open a host with no WebRTC (spec stage E).
 const repository = createWorldRepository({storage: worlds, codec, hasher});
 const session = createMemorySessionPorts({
  repository,
  storage: worlds,
  codec,
  hasher,
  maps,
  now: () => new Date(time.wall()).toISOString(),
 });
 const ports: OpenSimTestPorts = {maps, facts, saves, worlds, time, session};
 (window as unknown as {__openSimTestPorts: OpenSimTestPorts}).__openSimTestPorts = ports;

 // Import the real host fresh each test, so its module-level composition re-runs against this document and these ports.
 vi.resetModules();
 await import('../src/browser/main');
 const handle = (window as unknown as {__openSimTestClient?: {client: CityClient; hud: Hud; ready: Promise<void>}}).__openSimTestClient;
 if (!handle) throw new Error('o host de teste não publicou o handle');
 await handle.ready;
 // One frame so the first-frame/background work runs; then let the manual clock settle the facts/map/history work.
 flushFrames(2);
 await time.advance(1);
 flushFrames(1);

 const canvasPoint = (cell: CellCoord) => {
  // In jsdom getBoundingClientRect() is all zeros, so buffer pixels equal client pixels (input.ts falls back to a
  // 1:1 scale). project() gives the buffer point of a cell under the live camera.
  const p = project(cell, handle!.client.view().camera);
  return {clientX: p.x, clientY: p.y};
 };
 // A plain-land cell near the camera centre: the fixture town is water at x∈[28,29], an imported road on local y=0,
 // imported houses on local y=1 (x 2..6), a wood at x≥22 y 2..6; everything else is free land.
 const landCell = (): CellCoord => ({x: START_ORIGIN.x + 10, y: START_ORIGIN.y + 10});

 return {
  client: handle.client,
  hud: handle.hud,
  time: time as ManualTime,
  saves,
  doc,
  ports,
  canvasPoint,
  landCell,
  reset() {
   delete (window as unknown as {__openSimTestClient?: unknown}).__openSimTestClient;
   delete (window as unknown as {__openSimTestPorts?: unknown}).__openSimTestPorts;
  },
 };
}

function recorded(canvas: HTMLCanvasElement): RecordingContext {
 const contexts = (globalThis as unknown as {__canvasContexts: WeakMap<HTMLCanvasElement, RecordingContext>}).__canvasContexts;
 return contexts.get(canvas)!;
}

function el<T extends HTMLElement>(doc: Document, selector: string): T {
 const found = doc.querySelector<T>(selector);
 if (!found) throw new Error(`sem elemento ${selector}`);
 return found;
}

// A drag on the canvas: down at the first cell, move through the rest, up at the last — the gesture that lays a stroke.
async function dragStroke(h: Harness, canvas: HTMLCanvasElement, cells: readonly CellCoord[]): Promise<void> {
 const pts = cells.map(c => h.canvasPoint(c));
 canvas.dispatchEvent(pointer('pointerdown', {...pts[0]!, button: 0, pointerId: 1}));
 for (const pt of pts.slice(1)) canvas.dispatchEvent(pointer('pointermove', {...pt, pointerId: 1}));
 // pointerup is bound on window in input.ts.
 window.dispatchEvent(pointer('pointerup', {...pts[pts.length - 1]!, button: 0, pointerId: 1}));
 await h.client.idle();
}

async function key(doc: Document, k: string, init: KeyboardEventInit = {}): Promise<void> {
 window.dispatchEvent(new window.KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true, ...init}));
}

afterEach(() => {
 delete (window as unknown as {__openSimTestClient?: unknown}).__openSimTestClient;
 delete (window as unknown as {__openSimTestPorts?: unknown}).__openSimTestPorts;
 frameQueue = [];
 document.body.innerHTML = '';
 vi.restoreAllMocks();
});

// ----------------------------------------------------------------------------------------------------------------
test('session-ready: the real index.html boots the host and the city exists', async () => {
 const h = await boot();
 expect(h.client.view().ready).toBe(true);
 expect(h.client.view().state).not.toBeNull();
 // The HUD wrote the restored vitals: a money readout the player can read.
 expect(el(h.doc, '#hud-money').textContent).toBe(h.client.view().stats.money.toLocaleString('pt-BR'));
 expect(el(h.doc, '#hud-place').textContent).toBe('Vancouver');
 expect(el(h.doc, '#hud-population').textContent).toBe('662.248 · 2021');
 expect(el(h.doc, '#city-population').textContent).toBe('662.248 · 2021');
 expect(el(h.doc, '#economy-population').textContent).toBe(h.client.view().stats.population.toLocaleString('pt-BR'));
});

test('travel updates real demography in the top bar and places panel together',async()=>{
 const h=await boot();
 el<HTMLButtonElement>(h.doc,'[data-place="Lisboa"]').click();
 await h.client.idle();
 flushFrames(2);
 expect(el(h.doc,'#hud-place').textContent).toBe('Lisboa');
 expect(el(h.doc,'#hud-population').textContent).toBe('545.796 · 2021');
 expect(el(h.doc,'#city-population').textContent).toBe('545.796 · 2021');
});

test('tool dock: clicking every data-tool selects it in the HUD and changes the client tool', async () => {
 const h = await boot();
 const buttons = [...h.doc.querySelectorAll<HTMLButtonElement>('#hud-tools [data-tool]')];
 expect(buttons.length).toBe(10);
 for (const button of buttons) {
  const tool = button.dataset.tool!;
  button.click();
  await h.client.idle();
  flushFrames(1);
  expect(h.client.view().tool).toBe(tool);
  expect(button.classList.contains('selected')).toBe(true);
  expect(button.getAttribute('aria-pressed')).toBe('true');
 }
});

test('canvas hover shows the cost preview, a road drag spends the previewed cost and paints', async () => {
 const h = await boot();
 const canvas = el<HTMLCanvasElement>(h.doc, '#game');
 el<HTMLButtonElement>(h.doc, '#hud-tools [data-tool="road"]').click();
 await h.client.idle();

 const a = h.landCell();
 const strip: CellCoord[] = [a, {x: a.x + 1, y: a.y}, {x: a.x + 2, y: a.y}];

 // Hover one cell: the cost preview reaches the always-visible pulse line (#cost-preview, added to index.html).
 canvas.dispatchEvent(pointer('pointermove', h.canvasPoint(a)));
 await h.client.idle();
 flushFrames(1);
 const preview = h.client.view().preview;
 expect(preview.cost).toBeGreaterThan(0);
 expect(el(h.doc, '#cost-preview').textContent).toBe(preview.message);

 const before = h.client.view().stats.money;
 const paintedBefore = recorded(canvas).calls.length;
 // Build the stroke with pointer down + moves (the preview now covers the whole strip), read the previewed cost, then
 // release: the money drops by exactly what the preview showed.
 const pts = strip.map(c => h.canvasPoint(c));
 canvas.dispatchEvent(pointer('pointerdown', {...pts[0]!, button: 0, pointerId: 1}));
 for (const pt of pts.slice(1)) canvas.dispatchEvent(pointer('pointermove', {...pt, pointerId: 1}));
 await h.client.idle();
 const quoted = h.client.view().preview.cost ?? 0;
 expect(quoted).toBeGreaterThan(0);
 window.dispatchEvent(pointer('pointerup', {...pts[pts.length - 1]!, button: 0, pointerId: 1}));
 await h.client.idle();
 flushFrames(1);
 const after = h.client.view().stats.money;
 expect(after).toBe(before - quoted);
 expect(recorded(canvas).calls.length).toBeGreaterThan(paintedBefore);
});

test('zone drag (residential box) and a power plant both build and spend', async () => {
 const h = await boot();
 const canvas = el<HTMLCanvasElement>(h.doc, '#game');
 const base = h.landCell();

 // A residential zone is a rectangle: a drag from one corner to the opposite one.
 el<HTMLButtonElement>(h.doc, '#hud-tools [data-tool="residential"]').click();
 await h.client.idle();
 const box: CellCoord[] = [base, {x: base.x + 1, y: base.y + 1}];
 let before = h.client.view().stats.money;
 await dragStroke(h, canvas, box);
 expect(h.client.view().stats.money).toBeLessThan(before);

 // A power plant is a single tap-build.
 el<HTMLButtonElement>(h.doc, '#hud-tools [data-tool="power"]').click();
 await h.client.idle();
 before = h.client.view().stats.money;
 const plant: CellCoord = {x: base.x + 5, y: base.y + 5};
 await dragStroke(h, canvas, [plant]);
 expect(h.client.view().stats.money).toBeLessThan(before);
 expect(h.client.view().stats.energySupply).toBeGreaterThanOrEqual(64);
});

test('speed buttons advance ticks at the right rate and population grows', async () => {
 const h = await boot();
 const canvas = el<HTMLCanvasElement>(h.doc, '#game');
 const base = h.landCell();

 // A little city: a road, houses beside it and a plant, so growth has somewhere to happen.
 const build = async (tool: string, cells: CellCoord[]) => {
  el<HTMLButtonElement>(h.doc, `#hud-tools [data-tool="${tool}"]`).click();
  await h.client.idle();
  await dragStroke(h, canvas, cells);
 };
 await build('road', [base, {x: base.x + 6, y: base.y}]);
 await build('residential', [{x: base.x, y: base.y + 1}, {x: base.x + 4, y: base.y + 1}]);
 // Published rules 4: connect the plant to the road instead of leaving an empty gap.
 await build('power', [{x: base.x + 7, y: base.y}]);

 // Speed 1 at the dock: one tick per 1000 ms of wall time.
 el<HTMLButtonElement>(h.doc, '#hud-speed [data-speed="1"]').click();
 await h.client.idle();
 flushFrames(1);
 expect(h.client.view().speed).toBe(1);
 expect(el<HTMLButtonElement>(h.doc, '#hud-speed [data-speed="1"]').classList.contains('selected')).toBe(true);
 const tick0 = h.client.view().state!.tick;
 await h.time.advance(10_000);
 flushFrames(1);
 expect(h.client.view().state!.tick).toBe(tick0 + 10);

 // Speed 2: the next ten seconds are twenty ticks.
 el<HTMLButtonElement>(h.doc, '#hud-speed [data-speed="2"]').click();
 await h.client.idle();
 const tick1 = h.client.view().state!.tick;
 await h.time.advance(10_000);
 flushFrames(1);
 expect(h.client.view().state!.tick).toBe(tick1 + 20);

 el<HTMLButtonElement>(h.doc, '#hud-speed [data-speed="3"]').click();
 await h.client.idle();
 const tick2=h.client.view().state!.tick;
 await h.time.advance(9_990);flushFrames(1);
 expect(h.client.view().state!.tick).toBe(tick2+30);
 el<HTMLButtonElement>(h.doc, '#hud-speed [data-speed="2"]').click();await h.client.idle();
 // Enough logical time for growth: the fixture starts with imported houses, so population moves upward.
 await h.time.advance(60_000);
 flushFrames(1);
 expect(h.client.view().stats.population).toBeGreaterThan(20);

 // Pause: the dock's 0 stops the clock.
 el<HTMLButtonElement>(h.doc, '#hud-speed [data-speed="0"]').click();
 await h.client.idle();
 const frozen = h.client.view().state!.tick;
 await h.time.advance(30_000);
 expect(h.client.view().state!.tick).toBe(frozen);
});

test('tapping a cell shows the inspector card', async () => {
 const h = await boot();
 const canvas = el<HTMLCanvasElement>(h.doc, '#game');
 // The imported houses sit on local row 1 of the start chunk; tap one and the card describes it.
 const house: CellCoord = {x: START_ORIGIN.x + 3, y: START_ORIGIN.y + 1};
 const pt = h.canvasPoint(house);
 canvas.dispatchEvent(pointer('pointerdown', {...pt, button: 0, pointerId: 2}));
 window.dispatchEvent(pointer('pointerup', {...pt, button: 0, pointerId: 2}));
 await h.client.idle();
 flushFrames(1);
 const card = el(h.doc, '#hud-inspector');
 expect(card.hidden).toBe(false);
 expect(card.querySelector('h3')?.textContent ?? '').toContain('Moradia');
 expect(h.client.view().card).not.toBeNull();
});

test('keyboard: number keys select tools, Esc cancels, arrows/QE move/rotate, +/- zoom', async () => {
 const h = await boot();
 const canvas = el<HTMLCanvasElement>(h.doc, '#game');

 await key(h.doc, '2');
 await h.client.idle();
 expect(h.client.view().tool).toBe('road');
 await key(h.doc, '8');
 await h.client.idle();
 expect(h.client.view().tool).toBe('park');

 // Esc cancels a stroke in progress.
 const a = h.landCell();
 canvas.dispatchEvent(pointer('pointerdown', {...h.canvasPoint(a), button: 0, pointerId: 3}));
 canvas.dispatchEvent(pointer('pointermove', {...h.canvasPoint({x: a.x + 1, y: a.y}), pointerId: 3}));
 await key(h.doc, 'Escape');
 expect(h.client.view().stroke).toBeNull();
 window.dispatchEvent(pointer('pointercancel', {...h.canvasPoint(a), pointerId: 3}));

 // Arrows pan the camera; the camera settles so the move is observable at once.
 const before = {...h.client.view().camera};
 await key(h.doc, 'ArrowRight');
 await h.client.idle();
 flushFrames(2);
 const afterPan = h.client.view().camera;
 expect(afterPan.x !== before.x || afterPan.y !== before.y).toBe(true);

 // Q/E rotate the ground.
 const rot0 = h.client.view().camera.rotation;
 await key(h.doc, 'e');
 await h.client.idle();
 flushFrames(2);
 expect(h.client.view().camera.rotation).not.toBe(rot0);

 // The zoom buttons are the +/- the view cluster offers; the client snaps to the crisp ladder.
 const zoom0 = h.client.view().camera.zoom;
 el<HTMLButtonElement>(h.doc, '#hud-zoom-in').click();
 await h.client.idle();
 flushFrames(2);
 expect(h.client.view().camera.zoom).not.toBe(zoom0);

 // The other two buttons of the cluster turn the view: what Q/E do from the keyboard, the cluster offers a thumb.
 const rot1 = h.client.view().camera.rotation;
 el<HTMLButtonElement>(h.doc, '#hud-rotate-right').click();
 await h.client.idle();
 flushFrames(2);
 expect(h.client.view().camera.rotation).not.toBe(rot1);
 el<HTMLButtonElement>(h.doc, '#hud-rotate-left').click();
 await h.client.idle();
 flushFrames(2);
 expect(h.client.view().camera.rotation).toBeCloseTo(rot1, 4);
});

test('place buttons and the lat/lon form, including an invalid coordinate error', async () => {
 const h = await boot();
 // Open the Lugares sheet from the more-menu so the form is in play.
 el<HTMLButtonElement>(h.doc, '#hud-more [data-sheet="lugares"]').click();

 el<HTMLButtonElement>(h.doc, '[data-place="São Paulo"]').click();
 await h.client.idle();
 flushFrames(2);
 await h.time.advance(1);
 expect(h.client.view().place).toBe('São Paulo');

 const form = el<HTMLFormElement>(h.doc, '#place-form');
 const lat = el<HTMLInputElement>(h.doc, '#place-lat');
 const lon = el<HTMLInputElement>(h.doc, '#place-lon');

 // A valid coordinate: the form is accepted and the error stays hidden.
 lat.value = '38.7223';
 lon.value = '-9.1393';
 form.dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
 await h.client.idle();
 expect(el(h.doc, '#place-error').hidden).toBe(true);

 // An off-map latitude: the client refuses it and the form shows the message.
 lat.value = '950';
 lon.value = '0';
 form.dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
 await h.client.idle();
 const error = el(h.doc, '#place-error');
 expect(error.hidden).toBe(false);
 expect(error.textContent).toContain('latitude');
});

test('every sheet opens from the more-menu and shows', async () => {
 const h = await boot();
 const sheets = ['prefeitura', 'lugares', 'historia', 'planejamento', 'pessoas', 'fontes'];
 for (const sheet of sheets) {
  const item = el<HTMLButtonElement>(h.doc, `#hud-more [data-sheet="${sheet}"]`);
  item.click();
  expect(h.hud.sheet()).toBe(sheet);
  expect(h.doc.documentElement.ownerDocument.querySelector('#hud')?.getAttribute('data-sheet')).toBe(sheet);
  // The panel for this sheet is in the document.
  expect(h.doc.querySelector(`[data-panel][data-sheet="${sheet}"]`)).not.toBeNull();
 }
});

test('economy: tax and services sliders and the borrow button change the city', async () => {
 const h = await boot();
 el<HTMLButtonElement>(h.doc, '#hud-more [data-sheet="prefeitura"]').click();

 const tax = el<HTMLInputElement>(h.doc, '#economy-tax');
 tax.value = '15';
 tax.dispatchEvent(new window.Event('change', {bubbles: true}));
 await h.client.idle();
 expect(h.client.view().stats.economy.taxPercent).toBe(15);

 const services = el<HTMLInputElement>(h.doc, '#economy-services');
 services.value = '120';
 services.dispatchEvent(new window.Event('change', {bubbles: true}));
 await h.client.idle();
 expect(h.client.view().stats.economy.servicesPercent).toBe(120);

 const debt0 = h.client.view().stats.economy.debt;
 const money0 = h.client.view().stats.money;
 el<HTMLButtonElement>(h.doc, '#economy-borrow').click();
 await h.client.idle();
 expect(h.client.view().stats.economy.debt).toBeGreaterThan(debt0);
 expect(h.client.view().stats.money).toBeGreaterThan(money0);
});

test('history: create a version, compare, and export (download stubbed)', async () => {
 const h = await boot();
 // History materializes on idle; the client opens it off the background path. Advance until the panel has a head.
 await h.client.do({do: 'openWorld'});
 flushFrames(1);
 await h.time.advance(3000);
 el<HTMLButtonElement>(h.doc, '#hud-more [data-sheet="historia"]').click();

 // Build something so a checkpoint has content, then name a version.
 const canvas = el<HTMLCanvasElement>(h.doc, '#game');
 el<HTMLButtonElement>(h.doc, '#hud-tools [data-tool="road"]').click();
 await h.client.idle();
 await dragStroke(h, canvas, [h.landCell(), {x: h.landCell().x + 3, y: h.landCell().y}]);
 await h.client.idle();

 const nameInput = el<HTMLInputElement>(h.doc, '#history-name');
 nameInput.value = 'parque central';
 el<HTMLButtonElement>(h.doc, '#panel-history .history-actions button').click(); // "Criar versão"
 await h.client.idle();
 flushFrames(1);
 const view = h.client.view();
 expect(view.history).not.toBeNull();
 expect((view.history?.entries.length ?? 0)).toBeGreaterThan(0);

 // Export: the client produces the bytes, the host downloads them. Spy on the anchor click.
 const click = vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
 const exportButton = [...h.doc.querySelectorAll<HTMLButtonElement>('#panel-history .history-actions button')].find(b => b.textContent === 'Exportar')!;
 exportButton.click();
 await h.client.idle();
 flushFrames(1);
 expect(h.client.view().export).not.toBeNull();
 expect(click).toHaveBeenCalled();
});

test('scenarios: compare two futures of the place', async () => {
 const h = await boot();
 await h.client.do({do: 'openWorld'});
 flushFrames(1);
 await h.time.advance(2000);
 el<HTMLButtonElement>(h.doc, '#hud-more [data-sheet="planejamento"]').click();
 el<HTMLButtonElement>(h.doc, '#panel-composition .composition-compare').click();
 await h.client.idle();
 flushFrames(1);
 await h.time.advance(2000);
 flushFrames(1);
 const scenarios = h.client.view().scenarios;
 expect(scenarios).not.toBeNull();
 // Either two futures were produced, or the panel says why — never a silent empty.
 const panelMessage = el(h.doc, '#composition-message').textContent ?? '';
 expect(scenarios!.a !== null || panelMessage.length > 0).toBe(true);
});

test('multiplayer: creating a session over the in-memory fabric opens a branch', async () => {
 const h = await boot();
 await h.client.do({do: 'openWorld'});
 flushFrames(1);
 await h.time.advance(2000);
 el<HTMLButtonElement>(h.doc, '#hud-more [data-sheet="pessoas"]').click();
 el<HTMLButtonElement>(h.doc, '#multiplayer-create').click();
 // The session controller forks a branch and hosts; let its async flow settle.
 for (let i = 0; i < 5; i += 1) {
  await h.client.idle();
  await Promise.resolve();
 }
 flushFrames(1);
 expect(h.client.session).not.toBeNull();
 // The host mode is reflected in the session view the panel renders.
 const where = el(h.doc, '#multiplayer-where').textContent ?? '';
 expect(where).toContain(WORLD_ID);
});

test('overwrite-save: an unreadable stored save is not overwritten until the player asks', async () => {
 // A corrupt save in the slot: the session starts blocked, in memory, and the HUD offers to overwrite.
 const saves = createMemoryStore({'open-sim': 'isto não é um save válido'});
 const h = await boot({saves});
 const view = h.client.view();
 expect(view.save.blocked).toBe(true);
 const overwrite = el<HTMLButtonElement>(h.doc, '#save-overwrite');
 expect(overwrite.hidden).toBe(false);
 // The corrupt bytes are still there — the game did not silently replace them.
 expect(saves.slots.get('open-sim')).toBe('isto não é um save válido');

 overwrite.click();
 await h.client.idle();
 // Build something so a save is scheduled, then let the debounce fire.
 const canvas = el<HTMLCanvasElement>(h.doc, '#game');
 el<HTMLButtonElement>(h.doc, '#hud-tools [data-tool="road"]').click();
 await h.client.idle();
 await dragStroke(h, canvas, [h.landCell(), {x: h.landCell().x + 2, y: h.landCell().y}]);
 await h.time.advance(600);
 await h.client.idle();
 expect(h.client.view().save.blocked).toBe(false);
 // The slot now holds a readable save (valid JSON), not the corrupt string.
 const stored = saves.slots.get('open-sim')!;
 expect(() => JSON.parse(stored)).not.toThrow();
});

test('retry map: a region that failed loads after the player retries', async () => {
 // A region visible from the start camera fails once, then loads — the "Tentar novamente" path. The chunk left of
 // the start chunk is in view at the opening zoom, so no camera move is needed to make the load pass touch it.
 const [cx, cy] = START_CHUNK.split(':').map(Number) as [number, number];
 const FAILING = `${cx - 1}:${cy}`;
 const h = await boot({failing: new Set([FAILING]), failTimes: 1});

 // The opening background pass asked for the visible regions; the failing one is in error and the HUD says so.
 await h.client.do({do: 'retryMap'}); // ensure one load pass ran against the live camera
 await h.time.advance(300);
 await h.client.idle();
 flushFrames(1);
 const message = el(h.doc, '#map-message');
 const retry = el<HTMLButtonElement>(h.doc, '#map-retry');
 expect(h.client.view().chunk(FAILING)?.status).toBe('error');
 expect(message.hidden).toBe(false);
 expect(retry.hidden).toBe(false);

 // Retry: the region loads this time and the message clears.
 retry.click();
 await h.client.idle();
 await h.time.advance(300);
 await h.client.idle();
 flushFrames(1);
 expect(h.client.view().chunk(FAILING)?.status).toBe('ready');
 expect(el(h.doc, '#map-message').hidden).toBe(true);
});

test('?record=1: the recorder captures the player session and it replays to the same semantic hash', async () => {
 const h = await boot({record: true});
 const canvas = el<HTMLCanvasElement>(h.doc, '#game');
 const recorder = (window as unknown as {openSimRecording?: () => Playthrough}).openSimRecording;
 expect(typeof recorder).toBe('function');

 // Act like a player: build a road, open housing beside it, run the clock a while, build one more road. The waits
 // between intents are what the recorder times from the host's TimePort, so the replay reproduces the same ticks.
 const base = h.landCell();
 const build = async (tool: string, cells: CellCoord[]) => {
  el<HTMLButtonElement>(h.doc, `#hud-tools [data-tool="${tool}"]`).click();
  await h.client.idle();
  await dragStroke(h, canvas, cells);
 };
 await build('road', [base, {x: base.x + 5, y: base.y}]);
 await build('residential', [{x: base.x, y: base.y + 1}, {x: base.x + 3, y: base.y + 1}]);
 await build('power', [{x: base.x + 7, y: base.y}]);
 el<HTMLButtonElement>(h.doc, '#hud-speed [data-speed="1"]').click();
 await h.client.idle();
 await h.time.advance(8000); // 8 ticks at speed 1
 flushFrames(1);
 // One more intent after the wait, so the recorder stores the {wait:8000} gap before it.
 await build('park', [{x: base.x + 1, y: base.y + 3}]);

 const liveState = h.client.view().state!;
 const liveHash = await semanticHash(liveState);
 const recording = recorder!();
 expect(recording.steps.length).toBeGreaterThan(0);
 // Hover is ephemeral (spec P5) and must never be recorded.
 expect(recording.steps.some(s => 'do' in s && (s.do as {do?: string}).do === 'hover')).toBe(false);
 // A {wait} the clock could turn into ticks was captured.
 expect(recording.steps.some(s => 'wait' in s && (s as {wait: number}).wait >= 8000)).toBe(true);

 // Replay the recording through tools/play-host's runner on the same fixture map, facts and start region the browser
 // used, and the durable city it reaches has the same semantic hash — the game is the same off any surface (spec §9).
 const replayHost = createPlayHost({
  maps: createFixtureMap(),
  facts: createFixtureFacts(),
  start: START_CHUNK,
  place: 'Vancouver',
  worlds: createWorldMemoryStorage(),
 });
 const report = await runPlaythrough(recording, replayHost);
 expect(report.failure).toBeNull();
 expect(report.semanticHash).toBe(liveHash);
});

test('night preference repaints a paused city and persists independently from its save',async()=>{
 localStorage.removeItem('open-sim.visual-light');const h=await boot();flushFrames(2);
 const canvas=el<HTMLCanvasElement>(h.doc,'#game'),ctx=recorded(canvas),before=ctx.calls.length;
 el<HTMLButtonElement>(h.doc,'#hud-light').click();flushFrames(2);
 expect(h.client.view().speed).toBe(0);expect(ctx.calls.length).toBeGreaterThan(before);
 expect(localStorage.getItem('open-sim.visual-light')).toBe('night');
 expect(el(h.doc,'#hud-light').getAttribute('aria-pressed')).toBe('true');
 expect(el(h.doc,'#hud').classList.contains('night-city')).toBe(true);
 localStorage.removeItem('open-sim.visual-light');
});
