// Versions, history, comparison, export/import and two futures of a place — the player's time machine — moved out of
// the browser host and into the portable client (spec 2026-10-01 §5, stages C and D). It reads no DOM and no clock:
// a `WorldRepository` keeps the versions, a codec and a hasher address their bytes, and wall-clock ISO strings for a
// fork come through the `TimePort` (`isoOf`), never `Date` directly. The surface asks it to create a version, branch,
// compare or run two futures and reads back a plain-data model; the host decides whether an export is a download or a
// file and reads the bytes an import needs.
import type {Action,BaseChunk,CellCoord,GameState,Tool,ViewState} from '../core/model';
import {CHUNK,chunkId,chunkOrigin,coordAt} from '../core/coordinates';
import {applyCommand} from '../core/commands';
import {getCell} from '../core/world';
import {durableJson} from '../core/protocol';
import type {ExtensionDeclaration} from '../core/protocol';
import type {ContentHasher,WorldCodec} from '../world/ports';
import type {DatasetTerm,Head,JsonValue,ObjectRef} from '../world/model';
import {decodeBundle,encodeBundle} from '../world/codec';
import {compareScenarios,layerWrites,runScenario} from '../world/composition';
import type {Composition,ScenarioRun} from '../world/composition';
import {importLegacy} from '../session/world-bundle';
import type {WorldRepository,WorldVersion} from '../session/world-repository';
import {diffWorlds} from '../presentation/world-diff';
import {TOOL_LABELS} from '../presentation/tools';
import {describeScenarios,emptyComposition} from '../presentation/world-composition-model';
import type {CompositionInfo} from '../presentation/world-composition-model';
import type {CompareInfo,HistoryBranches,HistoryInfo} from '../presentation/world-history-model';
import {isoOf} from './time';
import type {TimePort} from './time';

// A version records the sentence the player read and the typed operations it produced (build:road@0:0#98…); the list
// shows the sentence. The operations stay in the version for comparisons, they are just not something to read.
const OPERATION_ID = /^[a-z]+:[a-z-]+@/;
const labelOf = (accepted: readonly string[]): string => accepted.filter(entry => !OPERATION_ID.test(entry)).join(' · ') || 'Início';

// How far ahead a future simulates the place, in ticks. The same horizon the browser preview used.
const FUTURE_TICKS = 60;

// What the versions controller needs from the game around it, kept as a narrow port so it never reaches for the
// LocalSession or the ActionRouter directly.
export type VersionsEnv = {
 repository: WorldRepository;
 codec: WorldCodec;
 hasher: ContentHasher;
 time: TimePort;
 worldId: string;
 branchId: string;
 terms: readonly DatasetTerm[];
 // The durable state on screen (the personal version, or the one a session confirmed), or null before it exists.
 state(): GameState | null;
 // The view the player's save would carry, so a legacy save becomes generation 1 with the camera it had.
 view(): ViewState;
 // The typed operations the last accepted command produced, for a checkpoint's recorded intention.
 lastOperations(): readonly string[];
 // The detailed regions this device already holds, so a scenario can never build what the player could not build.
 availableBases(): BaseChunk[];
 // The cell the camera is centred on, so "two futures" are of the place the player is looking at.
 focus(): CellCoord;
 // Called whenever the history model changed, so the surface can redraw its panel.
 changed(): void;
};

export type VersionsController = {
 // The first version of this city: a legacy save becomes generation 1 of the main branch, or an existing head opens.
 open(): Promise<void>;
 // A player action became a checkpoint. Ticks do not checkpoint, so the history stays a list of decisions.
 checkpoint(state: GameState, label: string): Promise<Head | null>;
 createVersion(name: string): Promise<void>;
 selectBranch(branchId: string): Promise<void>;
 compare(commitHashPrefix: string): Promise<void>;
 // Export returns the bytes and a name; the surface writes a file or triggers a download.
 export(): Promise<{name: string; bytes: Uint8Array} | null>;
 // Import adopts bytes a host read; a conflicting branch is refused as CONFLICT without changing anything.
 import(bytes: Uint8Array): Promise<void>;
 compareFutures(): Promise<void>;
 history(): HistoryInfo;
 branches(): HistoryBranches;
 scenarios(): CompositionInfo;
 // The region a comparison or a scenario pointed at, as the cell a surface should centre the camera on.
 regionCell(id: string): CellCoord;
 // The branch head the game commits to, so a session view can fork from the version on screen.
 head(): Head | null;
 shown(): Head | null;
 setShown(head: Head | null): void;
 // Re-read the branches and the shown branch's checkpoints. A host that forked a branch outside the controller (the
 // cooperative session) calls this so the panel catches up.
 refresh(): Promise<void>;
};

function describeError(error: unknown): string {
 const message = (error as {message?: unknown} | null)?.message;
 return typeof message === 'string' && message ? message : 'Falha ao falar com o armazenamento das versões.';
}
function actionLabel(action: Action, cells: readonly CellCoord[]): string {
 if (action.type === 'demolish') return `Demoliu ${cells.length} célula(s)`;
 if (action.type === 'build') return `${TOOL_LABELS[action.tool]} em ${cells.length} célula(s)`;
 return 'Ação';
}
function slugBranch(name: string): string {
 return name.trim().replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'versao';
}

export function createVersions(env: VersionsEnv): VersionsController {
 const {repository, codec, hasher, worldId, branchId} = env;
 // The live branch the game commits to, the version the panel is showing, the branches the device holds, the
 // checkpoints of the shown branch, the message under the panel, and whether a flow is in flight.
 let worldHead: Head | null = null, shownHead: Head | null = null, branchHeads: Head[] = [];
 let shownVersions: WorldVersion[] = [], worldMessage = '', worldBusy = false;
 // The last comparison the player asked for; a new checkpoint or branch makes it stale and the next refresh clears it.
 let compareSummary = '', compareRegions: readonly {id: string; label: string}[] = [];
 // Two futures of the place under the camera, as a plain-data model the surfaces draw.
 let scenarios: CompositionInfo = emptyComposition('Compare dois futuros do lugar sob a câmera.');
 // One publication at a time: two actions arriving together must not both compare the same head.
 let queue: Promise<void> = Promise.resolve();

 const refreshHistory = async (): Promise<void> => {
  compareSummary = ''; compareRegions = [];
  const known = await repository.branches(worldId);
  if (!known.ok) { worldMessage = known.error.message; return; }
  branchHeads = known.value;
  const selected = shownHead;
  if (selected && !branchHeads.some(head => head.branchId === selected.branchId)) shownHead = worldHead;
  const versions = shownHead ? await repository.history(shownHead) : null;
  if (versions && !versions.ok) worldMessage = versions.error.message;
  shownVersions = versions && versions.ok ? versions.value : [];
 };
 const queueWorld = (task: () => Promise<void>): Promise<void> => {
  worldBusy = true;
  env.changed();
  queue = queue.then(task).catch(error => { worldMessage = describeError(error); }).then(() => { worldBusy = false; env.changed(); });
  return queue;
 };

 // --- the version graph (stage C) -------------------------------------------------------------------------------
 const open = async (): Promise<void> => {
  const known = await repository.branches(worldId);
  if (!known.ok) { worldMessage = known.error.message; env.changed(); return; }
  const existing = known.value.find(head => head.branchId === branchId) ?? null;
  if (existing) worldHead = existing;
  else {
   const state = env.state();
   if (!state) { worldMessage = 'Sem cidade aberta para versionar.'; env.changed(); return; }
   const imported = await importLegacy({version: 1, state, view: env.view()}, hasher, codec, env.terms);
   if (!imported.ok) { worldMessage = imported.error.message; env.changed(); return; }
   const created = await repository.create(imported.value);
   if (!created.ok) { worldMessage = created.error.message; env.changed(); return; }
   worldHead = created.value;
  }
  shownHead = worldHead;
  await refreshHistory();
  env.changed();
 };

 const checkpoint = async (state: GameState, label: string): Promise<Head | null> => {
  let published: Head | null = null;
  await queueWorld(async () => {
   const expected = worldHead;
   if (!expected) return;
   // The version records the typed operations the command produced, not only the panel's sentence, so a later
   // comparison reads the intention instead of guessing it from the overlay.
   const operations = [label, ...env.lastOperations()];
   const result = await repository.commit(expected, {id: `local-${state.revision}`, state, operations, objects: [], author: 'local-player'});
   if (!result.ok) { if (result.error.code !== 'CONFLICT') worldMessage = result.error.message; return; }
   worldHead = result.value; shownHead = result.value; published = result.value;
   await refreshHistory();
  });
  return published;
 };

 const createVersion = (name: string): Promise<void> => queueWorld(async () => {
  const expected = worldHead;
  if (!expected) { worldMessage = 'Nenhuma versão aberta nesta partida.'; return; }
  const known = await repository.branches(worldId);
  const taken = new Set((known.ok ? known.value : []).map(head => head.branchId));
  const base = slugBranch(name);
  let next = base;
  for (let n = 2; taken.has(next); n += 1) next = `${base}-${n}`;
  const created = await repository.fork(expected, {worldId, branchId: next});
  if (!created.ok) { worldMessage = created.error.message; return; }
  worldMessage = `Versão criada: ${next}`;
  shownHead = created.value;
  await refreshHistory();
 });

 const selectBranch = (chosen: string): Promise<void> => {
  const found = branchHeads.find(head => head.branchId === chosen);
  if (!found) return Promise.resolve();
  shownHead = found;
  return queueWorld(refreshHistory);
 };

 // Comparing two versions of the same branch: both restored from the device, the older is the base, and the panel
 // separates data the provider published from work the player did, with the cost of redoing that work.
 const compare = (commitPrefix: string): Promise<void> => queueWorld(async () => {
  const left = shownHead ?? worldHead;
  if (!left) { worldMessage = 'Nenhuma versão aberta para comparar.'; return; }
  // "anterior" (or an empty prefix) compares with the immediate parent, so a surface need not know the hash; any
  // other prefix selects a checkpoint of this branch by the start of its commit hash.
  const parent = commitPrefix === '' || commitPrefix === 'anterior';
  const right = parent ? shownVersions.find(version => version.head.commit.hash !== left.commit.hash)?.head
   : shownVersions.find(version => version.head.commit.hash.startsWith(commitPrefix))?.head;
  if (!right) { worldMessage = 'Versão não encontrada no histórico.'; return; }
  const restored = [await repository.checkout(left), await repository.checkout(right)];
  const failedRestore = restored.find(result => !result.ok);
  if (failedRestore && !failedRestore.ok) { worldMessage = failedRestore.error.message; return; }
  const points = restored.flatMap(result => result.ok ? [result.value] : []);
  const [first, second] = points;
  if (!first || !second) return;
  const older = first.head.generation <= second.head.generation ? first : second;
  const newer = older === first ? second : first;
  const diff = diffWorlds(older, newer);
  const counts = diff.counts;
  compareRegions = diff.regions.slice(0, 12).map(region => ({id: region.chunkId, label: `${region.chunkId} · ${region.real} real, ${region.player} jogador`}));
  compareSummary = `#${older.head.generation} → #${newer.head.generation} · Real: ${counts.real} · Jogador: ${counts.player} (custo ~${diff.estimate.cost}) · Simulação: ${counts.simulation} · Metadados: ${counts.metadata}${diff.regions.length ? '' : ' · Sem diferenças'}`;
 });

 let exported: {name: string; bytes: Uint8Array} | null = null;
 const exportVersion = async (): Promise<{name: string; bytes: Uint8Array} | null> => {
  exported = null;
  await queueWorld(async () => {
   const target = shownHead ?? worldHead;
   if (!target) { worldMessage = 'Nenhuma versão para exportar.'; return; }
   const bundle = await repository.export(target);
   if (!bundle.ok) { worldMessage = bundle.error.message; return; }
   const bytes = encodeBundle(bundle.value, codec);
   exported = {name: `${target.worldId}-${target.branchId}-${target.commit.hash.slice(0, 7)}.json`, bytes};
   worldMessage = bundle.value.completeness.complete ? `Versão exportada: ${bytes.byteLength} bytes` : `Versão exportada incompleta: faltam ${bundle.value.completeness.missing.length} objetos`;
  });
  return exported;
 };

 const importVersion = (bytes: Uint8Array): Promise<void> => queueWorld(async () => {
  const decoded = decodeBundle(bytes);
  if (!decoded.ok) { worldMessage = `Pacote recusado: ${decoded.error.message}`; return; }
  const address = decoded.value.definition;
  const created = await repository.create(decoded.value);
  if (!created.ok) {
   worldMessage = created.error.code === 'CONFLICT' ? `Já existe uma versão em ${address.worldId}/${address.branchId}; nada foi alterado.` : `Pacote recusado: ${created.error.message}`;
   return;
  }
  worldMessage = `Versão importada: ${created.value.worldId}/${created.value.branchId}`;
  if (created.value.worldId === worldId) shownHead = created.value;
  await refreshHistory();
 });

 // --- two futures of the same place (stage D) -------------------------------------------------------------------
 // A project a scenario proposes goes through the profile's own rules and the regions this device already holds, so a
 // scenario can never build what the player could not build.
 const appliedProject = (state: GameState, action: Action): GameState => {
  const result = applyCommand(state, {version: 1, worldId: state.worldId, actorId: 'scenario', sequence: (state.actors['scenario'] ?? 0) + 1, expectedRevision: state.revision, action}, env.availableBases());
  if (result.status !== 'applied') throw new Error(result.reason ?? 'O projeto do cenário foi recusado');
  return result.state;
 };
 // Five free cells of land in one row of a managed region: two streets, a house, the plant that pays for the growth
 // and the cell where the two futures disagree. The row nearest the camera is the block the player is looking at.
 const freeBlock = (state: GameState, region: string, focus: CellCoord): readonly CellCoord[] | null => {
  let best: readonly CellCoord[] | null = null, bestDistance = Infinity;
  for (let index = 0; index + 4 < CHUNK * CHUNK; index++) {
   if (index % CHUNK > CHUNK - 5) continue;
   const row = [0, 1, 2, 3, 4].map(step => coordAt(region, index + step));
   if (!row.every(cell => { const found = getCell(state, cell); return !!found && found.terrain === 'land' && !found.road && !found.building; })) continue;
   const distance = Math.abs(row[0]!.x - focus.x) + Math.abs(row[0]!.y - focus.y);
   if (distance < bestDistance) { bestDistance = distance; best = row; }
  }
  return best;
 };
 // The commit of a layer is the content address of the state it produced — the same address the repository gives that
 // snapshot — so a scenario pins exactly the future it ran.
 const commitOf = async (state: GameState): Promise<ObjectRef> => hasher.ref(codec.encode({kind: 'city-state', state: state as unknown as JsonValue}));

 const compareFutures = async (): Promise<void> => {
  const state = env.state();
  if (!state) { scenarios = emptyComposition('Sem cidade aberta para comparar.'); env.changed(); return; }
  const focus = env.focus(), region = chunkId(focus);
  if (!state.chunks[region]) { scenarios = emptyComposition(`O trecho ${region} ainda não é administrado; carregue o mapa e tente de novo.`); env.changed(); return; }
  const block = freeBlock(state, region, focus);
  if (!block) { scenarios = emptyComposition(`Não há cinco células de terra livres no trecho ${region}.`); env.changed(); return; }
  const [street, street2, house, target, plant] = block;
  const project = (tool: Tool): GameState => {
   let next = appliedProject(state, {type: 'build', tool: 'road', cells: [street!, street2!]});
   next = appliedProject(next, {type: 'build', tool: 'residential', cells: [house!]});
   next = appliedProject(next, {type: 'build', tool: 'power', cells: [plant!]});
   return appliedProject(next, {type: 'build', tool, cells: [target!]});
  };
  // The ground is the player's own city: the composition declares every namespace it composes and pins the frozen
  // regions by content, so both futures rest on exactly these bytes.
  const extensions: ExtensionDeclaration[] = Object.keys(state.components).sort().map(key => ({key, version: 1, durable: true}));
  const ground = durableJson(state, extensions);
  const baseCommit = await commitOf(state);
  // Both futures fork at the same instant (a wall-clock ISO string from the TimePort, never `Date` here): a
  // millisecond of difference would make the comparison refuse to explain itself.
  const forkAt = isoOf(env.time);
  const bases = await Promise.all(Object.keys(state.chunks).sort().map(async id => ({id, ref: await hasher.ref(codec.encode({kind: 'base-chunk', base: state.chunks[id]!.base as unknown as JsonValue}))})));
  const future = async (id: string, tool: Tool, premise: string): Promise<ScenarioRun> => {
   const projected = project(tool);
   const commit = await commitOf(projected);
   const writes = layerWrites(state, projected);
   if (!writes.ok) throw new Error(writes.error.message);
   const composition: Composition = {
    worldId: state.worldId, branchId: `cenario-${id}`, actor: 'did:key:local-player', rules: {family: 'city', version: state.rulesVersion},
    base: {commit: baseCommit, identity: ground, bases},
    layers: [{commit, contract: {id, source: `jogador local · futuro ${id}`, priority: 10, effect: 'durable', rules: {family: 'city', version: state.rulesVersion}, reads: [], writes: writes.value, dependsOn: [], areas: [region], capabilities: []}}],
    parameters: {},
    temporal: {timeline: `osim:timeline:cenario-${id}`, parent: 'osim:timeline:local', forkAt, rate: 1},
    extensions,
   };
   const run = runScenario(composition, {states: {[baseCommit.hash]: state, [commit.hash]: projected}}, {id, interval: {fromTick: state.tick, toTick: state.tick + FUTURE_TICKS}, inputs: [], premises: [premise]});
   if (!run.ok) throw new Error(run.error.message);
   return run.value;
  };
  try {
   const [parque, industria] = await Promise.all([future('parque', 'park', 'projeto de parque no bloco livre'), future('industria', 'industrial', 'projeto industrial no bloco livre')]);
   scenarios = describeScenarios(parque, industria, compareScenarios(parque, industria));
  } catch (error) {
   scenarios = emptyComposition(describeError(error));
  }
  env.changed();
 };

 const regionCell = (id: string): CellCoord => { const origin = chunkOrigin(id); return {x: origin.x + CHUNK / 2, y: origin.y + CHUNK / 2}; };

 const historyModel = (): HistoryInfo => {
  const live = worldHead?.branchId === shownHead?.branchId;
  const compare: CompareInfo | null = compareSummary ? {summary: compareSummary, regions: compareRegions} : null;
  return {
   worldId,
   branchId: shownHead?.branchId ?? branchId,
   status: worldBusy ? 'Salvando versão…' : shownHead ? (live ? 'Salvo neste dispositivo' : 'Versão salva neste dispositivo') : 'Sem versão salva neste dispositivo',
   entries: shownVersions.map(version => ({generation: version.head.generation, hash: version.head.commit.hash, label: labelOf(version.accepted), current: version.head.commit.hash === shownHead?.commit.hash})),
   message: worldMessage,
   compareOptions: shownVersions.filter(version => version.head.commit.hash !== shownHead?.commit.hash).map(version => ({hash: version.head.commit.hash, label: `#${version.head.generation} ${version.head.commit.hash.slice(0, 7)} ${labelOf(version.accepted)}`})),
   compare,
  };
 };

 return {
  open,
  checkpoint,
  createVersion,
  selectBranch,
  compare,
  export: exportVersion,
  import: importVersion,
  compareFutures,
  history: historyModel,
  branches: () => ({ids: branchHeads.map(head => head.branchId), selected: shownHead?.branchId ?? branchId}),
  scenarios: () => scenarios,
  regionCell,
  head: () => worldHead,
  shown: () => shownHead,
  setShown: head => { shownHead = head; },
  refresh: () => queueWorld(refreshHistory),
 };
}

// `actionLabel` is the checkpoint sentence a surface or the client uses when it commits an action through the client's
// router; exported so the host does not re-derive it.
export {actionLabel};
