import {expect,test} from 'vitest';
import {createPlayHost} from '../tools/play-host';
import {createCityClient} from '../src/client/city-client';
import {createManualTime} from '../src/client/time';
import {createFixtureMap} from '../src/adapters/map/fixture';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {createSession} from '../src/session/local-session';
import {createGameSessionView} from '../src/presentation/multiplayer';
import {quoteAction} from '../src/core/quote';

// The version machine and the two futures, exercised through the same client the browser drives (spec stages C and D).
// No DOM, no network, no real seconds: a memory-backed repository, a synthetic map and a manual clock.

async function open() {
 const host = createPlayHost();
 const opened = await host.open();
 await opened.client.start();
 await opened.client.idle();
 return opened;
}

test('a fresh city opens as generation 1 of main, and a build becomes the next checkpoint', async () => {
 const {client} = await open();
 const start = client.view().history;
 expect(start?.branchId).toBe('main');
 expect(start?.entries.at(-1)?.label).toBe('Início');
 await client.do({do: 'tool', tool: 'road'});
 await client.do({do: 'commit', cells: [{x: 2, y: 3}, {x: 3, y: 3}]});
 await client.idle();
 expect(client.view().history?.entries[0]?.generation).toBe(2);
 client.stop();
});

test('creating a version opens a new branch and leaves main where it is', async () => {
 const {client} = await open();
 await client.do({do: 'createVersion', name: 'experimento'});
 await client.idle();
 const view = client.view();
 expect(view.branches?.ids).toContain('experimento');
 expect(view.branches?.ids).toContain('main');
 expect(view.history?.branchId).toBe('experimento');
 client.stop();
});

test('comparing a version with its parent counts the player changes', async () => {
 const {client} = await open();
 await client.do({do: 'tool', tool: 'road'});
 await client.do({do: 'commit', cells: [{x: 2, y: 3}, {x: 3, y: 3}, {x: 4, y: 3}]});
 await client.idle();
 await client.do({do: 'createVersion', name: 'exp'});
 await client.idle();
 await client.do({do: 'tool', tool: 'residential'});
 await client.do({do: 'commit', cells: [{x: 5, y: 5}]});
 await client.idle();
 await client.do({do: 'compare', prefix: 'anterior'});
 await client.idle();
 // One cell differs between #2 and #3: the house the player built.
 expect(client.view().history?.compare?.summary).toContain('Jogador: 1');
 client.stop();
});

test('comparing with an unknown hash prefix is refused with a message, nothing changes', async () => {
 const {client} = await open();
 await client.do({do: 'compare', prefix: 'nao-existe'});
 await client.idle();
 expect(client.view().history?.compare).toBeNull();
 expect(client.view().history?.message).toContain('não encontrada');
 client.stop();
});

test('export produces bytes; importing a stale package into the same branch is refused as CONFLICT', async () => {
 const {client} = await open();
 await client.do({do: 'tool', tool: 'road'});
 await client.do({do: 'commit', cells: [{x: 2, y: 3}, {x: 3, y: 3}]});
 await client.idle();
 await client.do({do: 'export'});
 const bundle = client.view().export;
 expect(bundle?.bytes.byteLength).toBeGreaterThan(0);
 // Advance main so its head differs from the exported package.
 await client.do({do: 'tool', tool: 'residential'});
 await client.do({do: 'commit', cells: [{x: 6, y: 6}]});
 await client.idle();
 await client.do({do: 'import', bytes: bundle!.bytes});
 await client.idle();
 const view = client.view();
 expect(view.history?.message).toContain('nada foi alterado');
 // The branch stayed where it was.
 expect(view.history?.branchId).toBe('main');
 expect(view.history?.entries[0]?.generation).toBe(3);
 client.stop();
});

test('two futures of the same place are comparable, with parque the cheaper decision', async () => {
 const {client} = await open();
 await client.do({do: 'compareFutures'});
 await client.idle();
 const comparison = client.view().scenarios?.comparison;
 expect(comparison?.comparable).toBe(true);
 expect(comparison?.summary).toContain('Comparável');
 const scenarios = client.view().scenarios;
 expect(scenarios?.a?.decisions[0]).toBe('parque');
 expect(scenarios?.b?.decisions[0]).toBe('industria');
 client.stop();
});

test('without a repository the client still plays but reports no versions and refuses the version intents', async () => {
 // A host that composed no repository: the client is created without a versions port.
 const maps = createFixtureMap(), saves = createMemoryStore(), time = createManualTime();
 const local = createSession({maps, saves, worldId: 'open-sim', seed: 1});
 const router = createGameSessionView({worldId: 'open-sim', branchId: 'main', local, quote: (action, state) => quoteAction(state, action, []), now: () => new Date(time.now()).toISOString(), monotonic: () => time.now()});
 const client = createCityClient({local, router, time, initialChunk: '0:0', place: 'Cidade de teste', attribution: maps.attribution});
 await client.start();
 await client.idle();
 expect(client.versions).toBeNull();
 expect(client.view().history).toBeNull();
 expect(client.view().scenarios).toBeNull();
 // The city still plays: a build is accepted even with no history to record it in.
 await client.do({do: 'tool', tool: 'road'});
 const built = await client.do({do: 'commit', cells: [{x: 2, y: 3}]});
 expect(built.ok).toBe(true);
 // A version intent on a host without a repository is refused with a message, not a throw.
 const refused = await client.do({do: 'createVersion', name: 'x'});
 expect(refused.ok).toBe(false);
 client.stop();
});
