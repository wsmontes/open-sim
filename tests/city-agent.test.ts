import {expect,test} from 'vitest';
import {createPlayHost} from '../tools/play-host';
import {executeCityRequest} from '../src/surfaces/json/city-json';
import type {CityClient} from '../src/client/city-client';
import {blank} from './fixtures/world';

// The JSON surface is a second TEXT host of the same portable client the browser and the terminal use: the agent's
// request/response contract (inspect/quote/act/advance/save/load) now runs through `client.do`/`client.quote` and the
// view, never a bypass of the client. These are the city-agent assertions, kept whole, pointed at the new surface.
async function city(): Promise<CityClient> {
 const host = createPlayHost({
  maps: {loadChunk: async id => blank(id), attribution: {text: 'test', url: ''}},
  worldId: 'agent',
  seed: 1,
  start: '0:0',
 });
 const {client} = await host.open();
 await client.start();
 await client.idle();
 return client;
}

test('agents quote, build, advance, save and restore the same city state', async () => {
 const client = await city(), action = {type: 'build', tool: 'park', cells: [{x: 1, y: 1}]} as const;
 const q = await executeCityRequest(client, {op: 'quote', action});
 expect(q.ok && q.result).toMatchObject({cost: 30, status: 'ok'});
 expect((await executeCityRequest(client, {op: 'act', action})).ok).toBe(true);
 await executeCityRequest(client, {op: 'advance', ticks: 5});
 const before = client.snapshot().state;
 const save = await executeCityRequest(client, {op: 'save'});
 expect(save.ok).toBe(true);
 await executeCityRequest(client, {op: 'advance', ticks: 1});
 expect((await executeCityRequest(client, {op: 'load', save: save.ok ? save.result : null})).ok).toBe(true);
 // The restored city is the one that was saved, not the one a tick later.
 expect(client.snapshot().state).toEqual(before);
});

test('malformed requests and unbounded advancement never mutate', async () => {
 const client = await city(), before = client.snapshot().state;
 for (const request of [null, {op: 'advance', ticks: 10001}, {op: 'quote', action: {type: 'unknown'}}, {op: 'act', action: {type: 'build', cells: []}}, {op: 'inspect', cell: {x: Number.NaN, y: 1}}])
  expect((await executeCityRequest(client, request)).ok).toBe(false);
 expect(client.snapshot().state).toEqual(before);
});

test('terminal round trips preserve browser viewpoint and unknown metadata', async () => {
 const client = await city(), first = await executeCityRequest(client, {op: 'save'});
 if (!first.ok) throw new Error('save');
 const saved = first.result as {view: Record<string, unknown>; extra?: unknown};
 saved.view.center = {x: 10.25, y: 20.75};
 saved.view.extra = {hello: 2};
 (saved as unknown as Record<string, unknown>).extra = {hello: 1};
 await executeCityRequest(client, {op: 'load', save: saved});
 const next = await executeCityRequest(client, {op: 'save'});
 const result = (next.ok ? next.result : null) as {view: Record<string, unknown>; extra?: unknown} | null;
 // The viewpoint model recomputes the legacy x/y from the centre and the screen; the centre itself, and every
 // interoperable field this client does not implement (view.extra and the envelope's extra), survive the round trip.
 expect(result?.view.center).toEqual({x: 10.25, y: 20.75});
 expect(result?.view.extra).toEqual({hello: 2});
 expect(result?.extra).toEqual({hello: 1});
});
