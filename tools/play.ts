// Play the city in a terminal, or run a playthrough (spec 2026-10-01 §6).
//
//   npx tsx tools/play.ts                         interactive, synthetic map, nothing saved to disk
//   npx tsx tools/play.ts --save partida.json     interactive, the save lives in a file and survives
//   npx tsx tools/play.ts --script roteiro.json   runs a playthrough and prints its report
//   npx tsx tools/play.ts --osm --place Vancouver real OpenStreetMap tiles (needs network)
//
// Time is manual here too: the city only moves when you say "espera 10s", so nothing happens behind your back while
// you read the map.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {stdin,stdout} from 'node:process';
import {chunkId,chunkOrigin,toCell} from '../src/core/coordinates';
import type {SavedGame} from '../src/core/model';
import {encodeSave} from '../src/core/snapshot';
import {createOsmSource} from '../src/adapters/osm/provider';
import {createMainMapDecoder} from '../src/adapters/osm/map-decoder';
import type {SaveStore} from '../src/session/ports';
import {HELP,parseCommand} from '../src/surfaces/text/parse';
import {LEGEND,factsLines,prefeituraLines,renderText,scenariosLines,versionsLines} from '../src/surfaces/text/render';
import {runPlaythrough} from '../src/surfaces/text/playthrough';
import type {Playthrough} from '../src/surfaces/text/playthrough';
import {createPlayHost,createCoopPlayHost} from './play-host';

const PLACES: Record<string, {lat: number; lon: number}> = {
 Vancouver: {lat: 49.2827, lon: -123.1207},
 'São Paulo': {lat: -23.5505, lon: -46.6333},
 Lisboa: {lat: 38.7223, lon: -9.1393},
};

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };

function fileStore(path: string): SaveStore {
 return {
  async read() { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as unknown : null; },
  async write(_slot: string, data: SavedGame) { writeFileSync(path, encodeSave(data)); },
 };
}

const placeName = option('--place') ?? (flag('--osm') ? 'Vancouver' : undefined);
const place = placeName ? PLACES[placeName] : undefined;
if (placeName && !place) { console.error(`Lugar desconhecido: ${placeName}. Conhecidos: ${Object.keys(PLACES).join(', ')}`); process.exit(1); }
const start = place ? chunkId(toCell(place.lat, place.lon)) : '0:0';
const savePath = option('--save');
const host = createPlayHost({
 maps: flag('--osm') ? createOsmSource({decoder: createMainMapDecoder()}) : undefined,
 saves: savePath ? fileStore(savePath) : undefined,
 start,
 place: placeName,
});

const script = option('--script');
if (script) {
 // Windows editors write a byte-order mark at the start of UTF-8 files; it is not part of the JSON.
 const playthrough = JSON.parse(readFileSync(script, 'utf8').replace(/^\uFEFF/, '')) as Playthrough;
 // A playthrough with a named player (`as`) is cooperative: it needs two clients over one shared in-memory transport
 // and registry, which the coop host provides. A single-player script keeps the plain host composed above.
 const cooperative = playthrough.steps.some(step => 'as' in step && !!(step as {as?: string}).as);
 const scriptHost = cooperative
  ? createCoopPlayHost({maps: flag('--osm') ? createOsmSource({decoder: createMainMapDecoder()}) : undefined, start, place: placeName})
  : host;
 const report = await runPlaythrough(playthrough, scriptHost);
 for (const step of report.steps) console.log(`${step.failure ? '✗' : '✓'} ${String(step.index + 1).padStart(3)} ${JSON.stringify(step.step)}${step.failure ? `\n      ${step.failure}` : ''}`);
 console.log(`\n${report.ok ? 'OK' : 'FALHOU'} · ${report.title} · hash semântico ${report.semanticHash}`);
 if (report.failure) console.log(report.failure);
 process.exit(report.ok ? 0 : 1);
}

const {client, time} = await host.open();
await client.start();
await client.idle();
// The window follows the camera (the cell under its centre) unless the player pins one with "mapa x,y". Coordinates
// are relative to the region under the camera, so what is typed matches what is on the map after an "ir".
let pinned: {x: number; y: number} | null = null;
const regionOrigin = () => chunkOrigin(chunkId(client.view().center));
const frame = () => ({origin: regionOrigin(), center: pinned ?? undefined, width: 32, height: 20});
const show = () => console.log(renderText(client.view(), frame()).join('\n'));
console.log('Open Sim no terminal. Digite "ajuda" para ver os comandos.\n');
show();
const prompt = createInterface({input: stdin, output: stdout, terminal: stdin.isTTY});
const ask = () => { stdout.write('\n> '); };
ask();
// The line iterator keeps lines that arrive before they are asked for, which is what a piped transcript does.
for await (const line of prompt) {
 if (!stdin.isTTY) console.log(line);
 const parsed = parseCommand(line, regionOrigin());
 if ('error' in parsed) { console.log(parsed.error); ask(); continue; }
 if (parsed.quit) break;
 if (parsed.show === 'help') { console.log(HELP.join('\n')); ask(); continue; }
 if (parsed.show === 'legend') { console.log(LEGEND); ask(); continue; }
 if (parsed.show === 'facts') { console.log(factsLines(client.view()).join('\n')); ask(); continue; }
 if (parsed.show === 'prefeitura') { console.log(prefeituraLines(client.view()).join('\n')); ask(); continue; }
 // Exportar/importar are the host's file I/O: the client produces the bytes, the terminal writes them to disk, and
 // reads a package back before handing it to the client.
 if (parsed.exportFile) {
  await client.do({do: 'export'});
  const bundle = client.view().export;
  if (bundle) { writeFileSync(parsed.exportFile, bundle.bytes); console.log(`Versão exportada em ${parsed.exportFile} (${bundle.bytes.byteLength} bytes).`); }
  else console.log('Nenhuma versão para exportar.');
  show(); ask(); continue;
 }
 if (parsed.importFile) {
  if (!existsSync(parsed.importFile)) { console.log(`Arquivo não encontrado: ${parsed.importFile}`); ask(); continue; }
  await client.do({do: 'import', bytes: new Uint8Array(readFileSync(parsed.importFile))});
  await client.idle();
  console.log(client.view().history?.message ?? '');
  show(); ask(); continue;
 }
 if (parsed.center) pinned = parsed.center;
 for (const intent of parsed.intents) {
  const result = await client.do(intent);
  await client.idle();
  if (!result.ok && result.message) console.log(`→ ${result.message}`);
 }
 if (parsed.wait) { await time.advance(parsed.wait); await client.idle(); }
 // After a version or futures command, print the panel the player asked to see.
 if (parsed.show === 'versions') console.log(versionsLines(client.view()).join('\n'));
 if (parsed.show === 'scenarios') console.log(scenariosLines(client.view()).join('\n'));
 show();
 ask();
}
client.saveNow();
await client.idle();
client.stop();
prompt.close();
