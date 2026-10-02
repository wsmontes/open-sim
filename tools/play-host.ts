// The Node host of the game (spec 2026-10-01 §6): the same client the browser uses, composed with a map, a save store
// and a manual clock. `tools/play.ts` puts a terminal in front of it; `tests/playthrough.test.ts` puts a script.
import {createCityClient} from '../src/client/city-client';
import type {CityClient} from '../src/client/city-client';
import {createManualTime} from '../src/client/time';
import {actionLabel} from '../src/client/versions';
import {chunkOrigin} from '../src/core/coordinates';
import type {Action,CellCoord,GameState} from '../src/core/model';
import {durableJson} from '../src/core/protocol';
import {quoteAction} from '../src/core/quote';
import {createFixtureMap} from '../src/adapters/map/fixture';
import {createFixtureFacts} from '../src/client/facts';
import type {FactsPort} from '../src/client/facts';
import {sha256Hex,bytesHasher} from '../src/adapters/hash/content';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import type {WorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {createWorldRepository} from '../src/session/world-repository';
import {createSession} from '../src/session/local-session';
import type {MapSource,SaveStore} from '../src/session/ports';
import {createGameSessionView} from '../src/presentation/multiplayer';
import {createKernel} from '../src/world/kernel';
import {createMemorySessionPorts} from '../src/adapters/session/memory';
import type {Opened,PlaythroughHost} from '../src/surfaces/text/playthrough';

export const WORLD_ID = 'open-sim', BRANCH_ID = 'main';

export type PlayHostOptions = {maps?: MapSource; saves?: SaveStore; seed?: number; start?: string; place?: string; facts?: FactsPort; worlds?: WorldMemoryStorage};

// The identity of a city, not of its bytes: the durable projection the conformance package compares (world-v2 §3.1).
export async function semanticHash(state: GameState): Promise<string> {
 const extensions = Object.keys(state.components).sort().map(key => ({key, version: 1, durable: true}));
 return sha256Hex(durableJson(state, extensions));
}

export function createPlayHost(options: PlayHostOptions = {}): PlaythroughHost & {saves: SaveStore; maps: MapSource; worlds: WorldMemoryStorage; last(): CityClient | null} {
 const maps = options.maps ?? createFixtureMap(), saves = options.saves ?? createMemoryStore();
 const facts = options.facts ?? createFixtureFacts();
 const start = options.start ?? '0:0';
 const codec = createJcsCodec(), hasher = bytesHasher();
 // The versions live in memory and survive a reopen on this host, as a device's own history does across reloads.
 const worlds = options.worlds ?? createWorldMemoryStorage();
 const repository = createWorldRepository({storage: worlds, codec, hasher});
 let current: CityClient | null = null;
 return {
  maps,
  saves,
  worlds,
  last: () => current,
  semanticHash,
  async open(): Promise<Opened> {
   const time = createManualTime();
   const local = createSession({maps, saves, worldId: WORLD_ID, seed: options.seed ?? 1});
   // A player action becomes a checkpoint through the client's version machine; ticks never do. The router applies
   // locally first and then hands the accepted state to this callback, which the client's controller records.
   const router = createGameSessionView({
    worldId: WORLD_ID,
    branchId: BRANCH_ID,
    local,
    quote: (action, state) => quoteAction(state, action, []),
    commit: (action, state) => current?.versions?.checkpoint(state, actionLabel(action, action.type === 'build' || action.type === 'demolish' ? (action as Extract<Action, {cells: CellCoord[]}>).cells : [])) ?? Promise.resolve(null),
    now: () => new Date(time.now()).toISOString(),
    monotonic: () => time.now(),
   });
   current = createCityClient({
    local, router, time, initialChunk: start, place: options.place ?? 'Cidade de teste', facts, attribution: maps.attribution,
    versions: {repository, codec, hasher, worldId: WORLD_ID, branchId: BRANCH_ID}, openVersionsOnStart: true,
   });
   return {client: current, time, origin: chunkOrigin(start)};
  },
 };
}

// A cooperative host for a two-player playthrough (spec 2026-10-01 §7, stage E): both clients share one world storage,
// one kernel registry and one in-memory session fabric, so one can host a branch and the other join it by the invite
// text with no network. Each player keeps its own save slot, local session and manual clock, as two separate devices
// would; the shared storage is the honest shape of two clients in one process (see src/adapters/session/memory.ts).
export function createCoopPlayHost(options: PlayHostOptions = {}): PlaythroughHost & {maps: MapSource; worlds: WorldMemoryStorage} {
 const maps = options.maps ?? createFixtureMap();
 const facts = options.facts ?? createFixtureFacts();
 const start = options.start ?? '0:0';
 const codec = createJcsCodec(), hasher = bytesHasher();
 // One world storage and one repository, shared by every player and by the session fabric: a branch one player forks
 // and the commits a host confirms land where every other player reads them.
 const worlds = options.worlds ?? createWorldMemoryStorage();
 const repository = createWorldRepository({storage: worlds, codec, hasher});
 const kernel = createKernel();
 // The session's adapters, shared: `openHost` registers a host on this fabric and `join` finds it by the invite's
 // session id. `settle` drains the fabric's transport so a replica sees what the host just confirmed.
 const ports = createMemorySessionPorts({repository, storage: worlds, codec, hasher, maps, now: () => new Date(sharedWall()).toISOString(), kernel});
 // The wall clock the fabric stamps the session with: the host player's manual clock, so the session scope and the
 // ISO instants stay deterministic. Set when the host player opens.
 let sharedWall = () => Date.now();
 const clients = new Map<string, CityClient>();
 const openClient = (name: string): Opened => {
  const time = createManualTime();
  if (name === HOST_PLAYER) sharedWall = () => time.wall();
  // Each player a distinct save slot, so one device's save is never the other's; the shared world storage is where
  // the collaboration actually lives.
  const slot = `open-sim-${name || 'host'}`;
  const saves = createMemoryStore();
  const local = createSession({maps, saves, worldId: WORLD_ID, seed: options.seed ?? 1, slot});
  let self: CityClient | null = null;
  const router = createGameSessionView({
   worldId: WORLD_ID,
   branchId: BRANCH_ID,
   local,
   quote: (action, state) => quoteAction(state, action, []),
   commit: (action, state) => self?.versions?.checkpoint(state, actionLabel(action, action.type === 'build' || action.type === 'demolish' ? (action as Extract<Action, {cells: CellCoord[]}>).cells : [])) ?? Promise.resolve(null),
   registry: kernel,
   self: name || 'anfitriao',
   now: () => new Date(time.now()).toISOString(),
   monotonic: () => time.now(),
  });
  self = createCityClient({
   local, router, time, initialChunk: start, place: options.place ?? 'Cidade de teste', facts, attribution: maps.attribution,
   versions: {repository, codec, hasher, worldId: WORLD_ID, branchId: BRANCH_ID}, openVersionsOnStart: true,
   session: ports,
  });
  clients.set(name, self);
  return {client: self, time, origin: chunkOrigin(start)};
 };
 return {
  maps,
  worlds,
  semanticHash,
  open: async () => openClient(HOST_PLAYER),
  openPlayer: async (name: string) => openClient(name),
  settle: () => ports.settle(),
 };
}

// The default player (a step with no `as`) is the host of a cooperative playthrough.
const HOST_PLAYER = '';

