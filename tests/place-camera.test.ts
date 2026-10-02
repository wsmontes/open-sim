import {expect,test} from 'vitest';
import {createPlayHost} from '../tools/play-host';
import {createFixtureMap} from '../src/adapters/map/fixture';
import {createCityClient} from '../src/client/city-client';
import {createManualTime} from '../src/client/time';
import {createFixtureFacts,goToCoord,placeByName,PLACES} from '../src/client/facts';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {createSession} from '../src/session/local-session';
import {createGameSessionView} from '../src/presentation/multiplayer';
import {quoteAction} from '../src/core/quote';
import {chunkId,toCell} from '../src/core/coordinates';

// Stage B of the portable-client spec: place and camera inside the client, reachable from the text surface and
// provable without a browser (manual time, synthetic map, fixed facts).

test('a map region that fails to load shows the failure message, and "tentar de novo" loads it on the retry', async () => {
 // The west-wrap neighbour of the start region is the one the first visible pass asks for; failing it once rehearses
 // the failure and lets the retry succeed.
 const maps = createFixtureMap({failing: new Set(['131071:0']), failTimes: 1});
 const host = createPlayHost({maps});
 const opened = await host.open();
 await opened.client.start();
 await opened.client.idle();
 expect(opened.client.view().map.message).toBe('Falha ao carregar o mapa. Tente novamente.');
 await opened.client.do({do: 'retryMap'});
 await opened.client.idle();
 expect(opened.client.view().map.message).toBe('');
 opened.client.stop();
});

test('a coordinate off the map is refused with its message and does not move the camera', async () => {
 const host = createPlayHost();
 const opened = await host.open();
 await opened.client.start();
 await opened.client.idle();
 const before = opened.client.view().place;
 const result = await opened.client.do({do: 'goTo', lat: 999, lon: 999});
 expect(result.ok).toBe(false);
 expect(result.message).toContain('latitude entre -85,0511 e 85,0511');
 expect(opened.client.view().place).toBe(before);
 expect(opened.client.view().notice).toContain('latitude entre -85,0511 e 85,0511');
 opened.client.stop();
});

test('goToCoord validates bounds the way the browser place form does', () => {
 expect(goToCoord(-23.55, -46.63)).toEqual({cell: toCell(-23.55, -46.63), label: '-23.5500, -46.6300'});
 expect(goToCoord(90, 0)).toEqual({error: 'Informe latitude entre -85,0511 e 85,0511 e longitude entre -180 e 180.'});
 expect(goToCoord(0, 200)).toEqual({error: 'Informe latitude entre -85,0511 e 85,0511 e longitude entre -180 e 180.'});
});

test('a bundled place carries its facts and resolves without accents', () => {
 expect(placeByName('sao paulo')?.name).toBe('São Paulo');
 expect(placeByName('LISBOA')?.facts.label).toBe('Lisboa');
 expect(placeByName('Atlantis')).toBeNull();
 expect(Object.keys(PLACES)).toEqual(['Vancouver', 'São Paulo', 'Lisboa']);
});

test('going to a place shows its facts and publishes the census that unlocks the scale sentence', async () => {
 const host = createPlayHost();
 const opened = await host.open();
 await opened.client.start();
 await opened.client.idle();
 await opened.client.do({do: 'place', name: 'Lisboa'});
 await opened.client.idle();
 const view = opened.client.view();
 expect(view.place).toBe('Lisboa');
 expect(view.facts?.label).toBe('Lisboa');
 expect(view.scale).toContain('bairro dentro dela');
 opened.client.stop();
});

test('the fixture FactsPort answers only for the bundled places, by name or nearest coordinate', async () => {
 const facts = createFixtureFacts();
 expect((await facts.named('Vancouver'))?.label).toBe('Vancouver');
 expect(await facts.named('Narnia')).toBeNull();
 expect((await facts.near(49.28, -123.12))?.label).toBe('Vancouver');
 expect(await facts.near(0, 0)).toBeNull();
});

test('pan, zoom, overview and north move the camera; the center follows it', async () => {
 const host = createPlayHost();
 const opened = await host.open();
 await opened.client.start();
 await opened.client.idle();
 const start = opened.client.view();
 await opened.client.do({do: 'pan', dx: 5, dy: 3});
 const panned = opened.client.view();
 expect(panned.center.x).toBe(start.center.x + 5);
 expect(panned.center.y).toBe(start.center.y + 3);
 await opened.client.do({do: 'overview'});
 expect(opened.client.view().camera.zoom).toBe(0.05);
 await opened.client.do({do: 'zoom', direction: 1});
 expect(opened.client.view().camera.zoom).toBeGreaterThan(0.05);
 await opened.client.do({do: 'rotate', radians: 1});
 expect(opened.client.view().camera.rotation).toBeCloseTo(1, 5);
 await opened.client.do({do: 'north'});
 expect(opened.client.view().camera.rotation).toBe(0);
 opened.client.stop();
});

// An animating surface sets a glide target and lands only as `step` advances; a non-animating one is already there.
test('an animating client glides to the camera target over frames, and lands exactly on it', async () => {
 const time = createManualTime();
 const local = createSession({maps: createFixtureMap(), saves: createMemoryStore(), worldId: 'open-sim', seed: 1});
 const router = createGameSessionView({worldId: 'open-sim', branchId: 'main', local, quote: (a, s) => quoteAction(s, a, []), now: () => new Date(time.now()).toISOString(), monotonic: () => time.now()});
 const client = createCityClient({local, router, time, initialChunk: '0:0', animated: true, facts: createFixtureFacts()});
 await client.start();
 await client.idle();
 const from = client.view().camera;
 await client.do({do: 'place', name: 'Lisboa'});
 // The move is in flight, not yet landed: an animating surface has not stepped.
 expect(client.view().glide).not.toBeNull();
 const target = client.view().glide!;
 expect(client.view().camera.x).toBe(from.x);
 // Drive the glide to completion; it must land exactly on the target the client computed.
 for (let i = 0; i < 1000 && client.step(1 / 60); i += 1) { /* advance frames */ }
 expect(client.view().glide).toBeNull();
 expect(client.view().camera).toEqual(target);
 client.stop();
});

test('a non-animating client lands at the camera target immediately, with no glide', async () => {
 const host = createPlayHost();
 const opened = await host.open();
 await opened.client.start();
 await opened.client.idle();
 await opened.client.do({do: 'place', name: 'Vancouver'});
 const view = opened.client.view();
 expect(view.glide).toBeNull();
 expect(chunkId(view.center)).toBe(chunkId(toCell(PLACES['Vancouver']!.lat, PLACES['Vancouver']!.lon)));
 opened.client.stop();
});
