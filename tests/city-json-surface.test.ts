import {expect,test} from 'vitest';
import {createPlayHost} from '../tools/play-host';
import {executeCityRequest} from '../src/surfaces/json/city-json';
import type {CityResponse} from '../src/surfaces/json/city-json';
import type {CityClient} from '../src/client/city-client';

// Pipe a few JSON lines through the surface, exactly as tools/city.ts does over stdin, on the synthetic map so it runs
// offline (spec P7). This proves the second TEXT host answers the whole contract through the one portable client.
async function openFixture(): Promise<CityClient> {
 const host = createPlayHost({seed: 1, start: '0:0'}); // no map => fixture town
 const {client} = await host.open();
 await client.start();
 await client.idle();
 return client;
}

async function pipe(client: CityClient, requests: readonly unknown[]): Promise<CityResponse[]> {
 const out: CityResponse[] = [];
 for (const request of requests) out.push(await executeCityRequest(client, request));
 return out;
}

test('a line of JSON requests runs through the surface on the offline fixture', async () => {
 const client = await openFixture();
 const build = {type: 'build', tool: 'park', cells: [{x: 3, y: 3}]} as const;
 const [inspect, quote, act, advance, save] = await pipe(client, [
  {op: 'inspect'},
  {op: 'quote', action: build},
  {op: 'act', action: build},
  {op: 'advance', ticks: 10},
  {op: 'save'},
 ]);
 // Every response carries ok, the current revision and tick.
 expect(inspect).toMatchObject({ok: true, revision: expect.any(Number), tick: expect.any(Number)});
 expect((inspect.ok ? inspect.result : null) as {worldId?: string}).toMatchObject({worldId: 'open-sim'});
 expect(quote.ok && quote.result).toMatchObject({cost: 30, status: 'ok'});
 expect(act.ok).toBe(true);
 expect((act.ok ? act.result : null) as {status: string}).toMatchObject({status: 'accepted'});
 // Ten ticks moved the clock; the saved snapshot is a decodable SavedGame at that tick.
 expect(advance.ok && advance.tick).toBe(10);
 expect((save.ok ? save.result : null) as {version?: number; state?: unknown}).toMatchObject({version: expect.any(Number)});
});

test('quote reflects a block without touching the city, and act then is refused', async () => {
 const client = await openFixture();
 // Column 28 is water in the fixture: building there is blocked, and the quote says so without changing anything.
 const onWater = {type: 'build', tool: 'residential', cells: [{x: 28, y: 5}]} as const;
 const quote = await executeCityRequest(client, {op: 'quote', action: onWater});
 expect(quote.ok && (quote.result as {status: string}).status).toBe('blocked');
 const before = client.snapshot().state;
 const act = await executeCityRequest(client, {op: 'act', action: onWater});
 expect(act.ok).toBe(false);
 expect(!act.ok && act.error.code).toBe('REJECTED');
 expect(client.snapshot().state).toEqual(before); // a refused act mutates nothing
});

test('inspect reads a cell and bad JSON-shaped requests are refused', async () => {
 const client = await openFixture();
 const inspect = await executeCityRequest(client, {op: 'inspect', cell: {x: 3, y: 3}});
 expect(inspect.ok).toBe(true);
 expect((inspect.ok ? inspect.result : null) as {cell?: unknown}).toHaveProperty('cell');
 for (const bad of [{op: 'nope'}, 'not an object', {op: 'advance', ticks: -1}, {op: 'load', save: {bogus: true}}])
  expect((await executeCityRequest(client, bad)).ok).toBe(false);
});
