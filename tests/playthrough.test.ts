import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {createFixtureMap} from '../src/adapters/map/fixture';
import {runPlaythrough} from '../src/surfaces/text/playthrough';
import type {Playthrough} from '../src/surfaces/text/playthrough';
import {parseCommand} from '../src/surfaces/text/parse';
import {renderText} from '../src/surfaces/text/render';
import {createPlayHost,createCoopPlayHost} from '../tools/play-host';

// The game played as a player plays it (spec 2026-10-01 §7): every file in tests/playthroughs is a session written down
// — what was typed, how long the player waited, what they expected to see — and runs on the same client the browser
// uses, through the text surface, with a manual clock and a synthetic map. No browser, no network, no real seconds.
const folder = join(import.meta.dirname, 'playthroughs');
const scripts = readdirSync(folder).filter(name => name.endsWith('.json')).sort();

// A playthrough with a named player (`as`) is cooperative: it needs two clients over one shared in-memory transport
// and registry, which is the coop host. A single-player script uses the plain host, unchanged.
const cooperative = (script: Playthrough): boolean => script.steps.some(step => 'as' in step && !!step.as);
const hostFor = (script: Playthrough) => (cooperative(script) ? createCoopPlayHost() : createPlayHost());

test('there are playthroughs to run', () => {
 expect(scripts.length).toBeGreaterThanOrEqual(4);
});

for (const name of scripts) {
 test(`playthrough: ${name}`, async () => {
  const script = JSON.parse(readFileSync(join(folder, name), 'utf8')) as Playthrough;
  const first = await runPlaythrough(script, hostFor(script));
  expect(first.failure, first.failure ?? '').toBeNull();
  expect(first.ok).toBe(true);
  // The same session played again from scratch is the same city, step by step and in the end.
  const second = await runPlaythrough(script, hostFor(script));
  expect(second.steps.map(step => step.transcript)).toEqual(first.steps.map(step => step.transcript));
  expect(second.semanticHash).toBe(first.semanticHash);
 });
}

test('a save the game cannot read is reported and left alone until the player asks to replace it', async () => {
 const saves = createMemoryStore({'open-sim': '{"version":99,"state":"de outro jogo"}'});
 const host = createPlayHost({saves});
 const report = await runPlaythrough({version: 1, title: 'save ilegível', steps: [
  {expect: {'ready': true, 'save.status': 'error', 'save.blocked': true}},
  {say: 'rua 2,3 6,3'},
  {say: 'salvar'},
  {expect: {'result.ok': true, 'save.blocked': true}},
 ]}, host);
 expect(report.failure).toBeNull();
 expect(saves.slots.get('open-sim')).toBe('{"version":99,"state":"de outro jogo"}');
 const replaced = await runPlaythrough({version: 1, title: 'substituir', steps: [
  {say: 'rua 2,3 6,3'},
  {say: 'sobrescrever'},
  {expect: {'save.status': 'saved'}},
 ]}, host);
 expect(replaced.failure).toBeNull();
 expect(saves.slots.get('open-sim')).toContain('"version":1');
});

test('a region that fails to load is shown as failed, and building on it is refused without spending', async () => {
 const host = createPlayHost({maps: createFixtureMap({failing: new Set(['1:0'])})});
 const opened = await host.open();
 await opened.client.start();
 await opened.client.idle();
 const result = await opened.client.do({do: 'commit', cells: [{x: 40, y: 3}]});
 await opened.client.idle();
 expect(result.ok).toBe(false);
 expect(opened.client.view().stats.money).toBe(20000);
 opened.client.stop();
});

test('the text surface reads what the player types into the same intentions a canvas gesture produces', () => {
 const origin = {x: 3200, y: 6400};
 const road = parseCommand('rua 2, 3 5,3', origin);
 expect(road).toEqual({intents: [{do: 'tool', tool: 'road'}, {do: 'commit', cells: [{x: 3202, y: 6403}, {x: 3203, y: 6403}, {x: 3204, y: 6403}, {x: 3205, y: 6403}]}]});
 const zone = parseCommand('comércio 0,0 1,1', origin);
 expect('intents' in zone && zone.intents[1]).toEqual({do: 'commit', cells: [{x: 3200, y: 6400}, {x: 3201, y: 6400}, {x: 3200, y: 6401}, {x: 3201, y: 6401}]});
 expect(parseCommand('espera 1.5m', origin)).toEqual({intents: [], wait: 90_000});
 expect(parseCommand('json {"do":"speed","speed":2}', origin)).toEqual({intents: [{do: 'speed', speed: 2}]});
 expect(parseCommand('voar 1,1', origin)).toEqual({error: 'Não entendi "voar". Digite "ajuda".'});
});

test('the map the terminal prints is the city: roads, water, woods, houses and the preview', async () => {
 const host = createPlayHost();
 const opened = await host.open();
 await opened.client.start();
 await opened.client.do({do: 'tool', tool: 'park'});
 await opened.client.do({do: 'stroke', cells: [{x: 10, y: 10}, {x: 11, y: 10}]});
 const lines = renderText(opened.client.view(), {origin: opened.origin, center: {x: 16, y: 5}, width: 32, height: 12});
 const row = (y: number) => lines.find(line => line.startsWith(String(y).padStart(4, ' ') + ' '))!.slice(5);
 expect(row(0)).toBe('----------------------------~~--');
 expect(row(1).slice(0, 8)).toBe('..RRRRR.');
 expect(row(3).slice(22, 32)).toBe('""""""~~""');
 expect(row(10).slice(9, 13)).toBe('.++.');
 expect(lines[1]).toContain('Custo: 60');
 opened.client.stop();
});
