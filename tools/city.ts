// The city as a machine plays it (spec 2026-10-01 §6): a second TEXT host of the same portable client the browser and
// the terminal use, speaking JSON lines instead of keystrokes. One request per line on stdin, one JSON response per
// line on stdout, over `src/surfaces/json`. No rule, price or availability lives here — the host only reads a file,
// composes the client with a map/save/clock and pipes stdin through the surface.
//
//   npm run city -- saved-city.json [output-city.json]   real OpenStreetMap map; a save loads offline
//   npm run city -- --fixture [saved-city.json [out.json]] synthetic map, so the agent runs with no network
//
// Node I/O (files, stdin/stdout) lives only here; the surface and the client never touch them.
import {readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {chunkId,toCell} from '../src/core/coordinates';
import {decodeSave} from '../src/core/snapshot';
import {canonicalJson} from '../src/core/protocol';
import {createOsmSource} from '../src/adapters/osm/provider';
import {createMainMapDecoder} from '../src/adapters/osm/map-decoder';
import {createFixtureMap} from '../src/adapters/map/fixture';
import {createMemoryStore} from '../src/adapters/storage/memory';
import type {MapSource} from '../src/session/ports';
import {createPlayHost} from './play-host';
import {executeCityRequest} from '../src/surfaces/json/city-json';

const args = process.argv.slice(2);
const fixture = args.includes('--fixture');
const files = args.filter(arg => arg !== '--fixture');
const [input, output] = files;

// A save loads offline; without one the real map needs the network (the fixture needs neither). The default location
// is downtown Vancouver, the same seed the browser opens with.
const saved = input ? decodeSave(readFileSync(input, 'utf8')) : null;
const maps: MapSource & {destroy?: () => void} = fixture ? createFixtureMap() : createOsmSource({decoder: createMainMapDecoder()});
const start = saved ? Object.keys(saved.state.chunks)[0] ?? chunkId(toCell(49.2827, -123.1207)) : chunkId(toCell(49.2827, -123.1207));
// The save, if any, lives in a memory store the client restores from; the client is composed exactly as tools/play.ts
// composes it, so the agent and the terminal are two surfaces over one host.
const saves = createMemoryStore(saved ? {'open-sim': canonicalJson(saved)} : {});
const host = createPlayHost({maps, saves, worldId: saved?.state.worldId ?? 'open-sim', seed: saved?.state.seed ?? 1, start});
const {client} = await host.open();
await client.start();
await client.idle();

const lines = createInterface({input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY});
for await (const line of lines) {
 if (!line.trim()) continue;
 let raw: unknown;
 try { raw = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ok: false, error: {code: 'INVALID_JSON', message: 'JSON inválido'}})}\n`); continue; }
 const response = await executeCityRequest(client, raw);
 process.stdout.write(`${canonicalJson(response)}\n`);
 // A save op may also be written to a file, the agent's way of checkpointing a long session to disk.
 if (output && response.ok && record(raw) && raw.op === 'save') writeFileSync(output, canonicalJson(response.result));
}
client.stop();
maps.destroy?.();

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object'; }
