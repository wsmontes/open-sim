// The reference explorer (spec §6.1.7; §4 of docs/world-protocol.md). It opens a world the city exported or saved,
// materializes people out of the city's aggregate, records the version that holds them and exports the package again —
// using no code of the city interface, of the browser or of the presentation layer.
//
// It is a command line program, not a second application: everything it knows about the world comes from `src/world`
// and from the explorer profile, and everything it does to the world goes through the profile's own commands.
//
// Uso: npx tsx tools/explorer.ts <entrada> <saída> [opções]
//   --owner <uri>                        principal that reserves the people (default did:key:explorer)
//   --reservation <id>                   identifier of the next reservation (default explorador-1, -2, …)
//   --materialize <célula> <quantidade>  e.g. --materialize 0:0#0 4
//   --dematerialize <morador>             returns one materialized person to the aggregate
//   --write <namespace> <entidade> <json> e.g. --write x.explorer.character p-… '{"walking":true}'
import {readFileSync,writeFileSync} from 'node:fs';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {decodeSave} from '../src/core/snapshot';
import {applyExplorerWrites} from '../src/profiles/explorer/commands';
import {explorerPending,explorerState,runExplorer} from '../src/profiles/explorer/model';
import type {ExplorerAction} from '../src/profiles/explorer/model';
import {importLegacy} from '../src/session/world-bundle';
import {createWorldRepository} from '../src/session/world-repository';
import type {PreparedChange} from '../src/world/changes';
import {decodeBundle,encodeBundle,verifyBundle} from '../src/world/codec';
import {materializedCount,populationOf,totalOf} from '../src/world/materialization';
import type {WorldBundle} from '../src/world/model';

const codec = createJcsCodec(), hasher = bytesHasher();
const USAGE = 'Uso: npx tsx tools/explorer.ts <entrada> [<saída>] [--owner <uri>] [--reservation <id>] [--materialize <célula> <quantidade>] [--dematerialize <morador>] [--write <namespace> <entidade> <json>]';
function fail(message: string): never {
 process.stderr.write(`${message}\n`);
 return process.exit(1);
}
// A package is what the world travels as; a local save is the other honest entrance, and it enters with an origin that
// says it came from a save instead of pretending to have history (spec §5.5).
async function open(input: Uint8Array): Promise<WorldBundle> {
 const decoded = decodeBundle(input);
 if (decoded.ok) {
  const verified = await verifyBundle(decoded.value,hasher,codec);
  if (!verified.ok) fail(`Pacote inválido: ${verified.error.message}`);
  return verified.value;
 }
 let parsed: unknown;
 try {
  parsed = JSON.parse(new TextDecoder().decode(input));
 } catch {
  fail(`Não foi possível abrir a entrada: ${decoded.error.message}`);
 }
 let save;
 try {
  save = decodeSave(parsed);
 } catch (error) {
  fail(`Entrada ilegível: ${decoded.error.message} / ${error instanceof Error ? error.message : String(error)}`);
 }
 const imported = await importLegacy(save,hasher,codec);
 if (!imported.ok) fail(`Não foi possível importar o save: ${imported.error.message}`);
 return imported.value;
}

const [input,output,...rest] = process.argv.slice(2);
if (!input) fail(USAGE);
const actions: ExplorerAction[] = [];
let owner = 'did:key:explorer', reservation = 'explorador-1', reservations = 0;
for (let index = 0; index < rest.length; index += 1) {
 const flag = rest[index];
 if (flag === '--owner') {
  owner = rest[index+1] ?? fail('--owner precisa de um principal');
  index += 1;
  continue;
 }
 if (flag === '--reservation') {
  reservation = rest[index+1] ?? fail('--reservation precisa de um identificador');
  index += 1;
  continue;
 }
 if (flag === '--materialize') {
  const cell = rest[index+1], count = Number(rest[index+2]);
  if (!cell || !Number.isSafeInteger(count)) fail('--materialize precisa de uma célula do motor (0:0#0) e de uma quantidade');
  reservations += 1;
  actions.push({type:'materialize',id:reservations > 1 ? `${reservation}-${reservations}` : reservation,owner,cell,count});
  index += 2;
  continue;
 }
 if (flag === '--dematerialize') {
  const character = rest[index+1];
  if (!character) fail('--dematerialize precisa do identificador de um morador materializado');
  actions.push({type:'dematerialize',characters:[character]});
  index += 1;
  continue;
 }
 if (flag === '--write') {
  const key = rest[index+1], entity = rest[index+2], text = rest[index+3];
  if (!key || !entity || text === undefined) fail('--write precisa de um namespace, uma entidade e um valor JSON');
  let value: unknown;
  try {
   value = JSON.parse(text);
  } catch {
   fail(`--write ${key} ${entity}: o valor não é JSON`);
  }
  actions.push({type:'write',key,entity,value});
  index += 3;
  continue;
 }
 fail(`Opção desconhecida: ${String(flag)}\n${USAGE}`);
}

const bundle = await open(new Uint8Array(readFileSync(input)));
// Visiting is an action of its own: with nothing to change, the explorer reports what the world holds and leaves it.
if (!actions.length) {
 const state = explorerState(bundle);
 if (!state) fail('O pacote não carrega um estado de cidade que este perfil saiba abrir');
 const visited = populationOf(state);
 process.stdout.write([
  `Mundo ${bundle.definition.worldId}/${bundle.definition.branchId} · perfis ${bundle.definition.profiles.join(', ')}`,
  `Cabeça: ${bundle.head ? `${bundle.head.generation} (${bundle.head.commit.hash.slice(0,12)}…)` : 'sem versão própria'}`,
  `População: ${visited.aggregate} agregados + ${materializedCount(visited)} materializados = ${totalOf(visited)}`,
 ].join('\n')+'\n');
 process.exit(0);
}
if (!output) fail(`Falta o arquivo de saída.\n${USAGE}`);
const explored = runExplorer(bundle,actions);
if (!explored.ok) fail(`O explorador não pôde trabalhar neste mundo: ${explored.error.message}`);
const pending = explorerPending(explored.value);
if (!pending.ok) fail(`O explorador não decidiu nada que possa ser salvo: ${pending.error.message}`);
const repository = createWorldRepository({storage:createWorldMemoryStorage(),codec,hasher});
const created = await repository.create(explored.value);
if (!created.ok) fail(`Não foi possível abrir o mundo: ${created.error.message}`);
const point = await repository.checkout(created.value);
if (!point.ok) fail(`Não foi possível restaurar a versão: ${point.error.message}`);
const saved = applyExplorerWrites(point.value.state,pending.value.components);
if (!saved.ok) fail(`O perfil explorador não pôde escrever: ${saved.error.message}`);
const before = populationOf(point.value.state), after = populationOf(saved.value);
const prepared: PreparedChange = {
 origins:[{worldId:created.value.worldId,branchId:created.value.branchId}],
 target:created.value,
 selection:[],
 operations:[],
 bases:[],
 cost:0,
 moneyAfter:saved.value.money,
 tick:saved.value.tick,
 requires:[],
 state:saved.value,
 records:[...pending.value.records],
};
const committed = await repository.commitPrepared(created.value,prepared);
if (!committed.ok) fail(`A versão não avançou: ${committed.error.message}`);
const exported = await repository.export(committed.value);
if (!exported.ok) fail(`Não foi possível exportar: ${exported.error.message}`);
const written = encodeBundle(exported.value,codec);
const verified = await verifyBundle(exported.value,hasher,codec);
if (!verified.ok) fail(`A exportação não confere com os próprios endereços: ${verified.error.message}`);
writeFileSync(output,written);
process.stdout.write([
 `Mundo ${created.value.worldId}/${created.value.branchId}`,
 `População antes: ${before.aggregate} agregados + ${materializedCount(before)} materializados = ${totalOf(before)}`,
 `População depois: ${after.aggregate} agregados + ${materializedCount(after)} materializados = ${totalOf(after)}`,
 `Geração: ${committed.value.generation} · cabeça ${committed.value.commit.hash.slice(0,12)}…`,
 `Escrito: ${output} (${written.byteLength} bytes)`,
].join('\n')+'\n');
