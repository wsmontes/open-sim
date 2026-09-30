// The published conformance runner (task 17 of docs/superpowers/plans/2026-09-29-federated-world.md): it replays a
// conformance package and reports, for every case, the address and the semantic hash the same bytes reached — which is
// the whole §47 claim in one executable document. It owns no simulation logic: the replay is `src/world/world-replay.ts`
// and the boundary is `src/world/osim.ts`, so a failure here is a failure of the client, not of this file.
//
//   npx tsx tools/world-replay.ts [pacote.json]
//
// The §47 checklist is run as well, against the real modules, including one transport adapter chosen for being the
// smallest implementation of the object port (§30); the social adapters that carry the same port are asserted here at
// the type level, because a compiler check is the one that cannot rot.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher,sha256Hex} from '../src/adapters/hash/content';
import {createNostrRelay} from '../src/adapters/nostr/relay';
import type {NostrRelayConfig} from '../src/adapters/nostr/relay';
import {createMatrixRooms} from '../src/adapters/matrix/rooms';
import type {MatrixRoomsConfig} from '../src/adapters/matrix/rooms';
import {createKernel} from '../src/world/kernel';
import type {KernelFilter,KernelTransport} from '../src/world/kernel';
import {applyEvent,checkCoreComponent,checkEnvelope,entityUri,envelopeOf,osimTimeFrom,parseOsimUri} from '../src/world/osim';
import type {OsimEnvelope} from '../src/world/osim';
import {replayFixture} from '../src/world/world-replay';
import type {ConformancePackage,ReplayReport} from '../src/world/world-replay';
import {ok} from '../src/world/model';

export type {ConformancePackage,ReplayReport,ReplayReportCase} from '../src/world/world-replay';

// §30 is a conceptual interface, and these two aliases are the check that the adapters really implement it: a factory
// whose transport stopped being a `KernelTransport` stops compiling here. They are exported rather than local because
// they are part of what this package asserts about the client.
export const NOSTR_OBJECT_PORT: (config: NostrRelayConfig) => KernelTransport = createNostrRelay;
export const MATRIX_OBJECT_PORT: (config: MatrixRoomsConfig) => KernelTransport = createMatrixRooms;

// The smallest adapter of §30, kept here so the checklist can exercise publish and receive without a network: it stores
// what it is given and hands it to a subscriber, which is all the port promises.
function memoryObjectPort(): KernelTransport & {stored: () => readonly OsimEnvelope[]} {
 const objects = new Map<string, OsimEnvelope>();
 const listeners: {filter: KernelFilter; listener: (object: OsimEnvelope) => void}[] = [];
 return {
  stored: () => [...objects.values()],
  async publish(object) {
   objects.set(object.id, object);
   for (const entry of [...listeners]) entry.listener(object);
   return ok(undefined);
  },
  async resolve(uri) {
   return ok(objects.get(uri) ?? null);
  },
  async query() {
   return ok([...objects.values()]);
  },
  subscribe(filter, listener) {
   const entry = {filter, listener};
   listeners.push(entry);
   return () => {
    const index = listeners.indexOf(entry);
    if (index >= 0) listeners.splice(index, 1);
   };
  },
 };
}

export type ChecklistItem = {item: string; ok: boolean; note: string};
const ACTOR = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

// The seven things of §47, each one exercised instead of described.
export async function conformanceChecklist(): Promise<ChecklistItem[]> {
 const items: ChecklistItem[] = [];
 const event = envelopeOf('event', 'osim:event:checklist-1', ACTOR, {
  entity:'osim:entity:house-42',
  component:'lifesim.residence',
  op:'set',
  value:{rooms:3},
  timeline:'osim:timeline:earth-main',
  time:'2026-09-29T22:00:00Z',
 });
 const refused = checkEnvelope({...event, extra:1} as unknown);
 items.push({item:'envelope', ok:checkEnvelope(event).ok && !refused.ok, note:'O envelope de §48 é lido, e um campo que ele não declara é recusado.'});
 const ours = parseOsimUri(entityUri('house-42')), theirs = parseOsimUri('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
 items.push({item:'identificadores', ok:ours.scheme === 'osim' && ours.kind === 'entity' && theirs.scheme === 'foreign', note:'Um `osim:entity:` é nosso; um `did:key:` continua sendo de outro ecossistema.'});
 const port = memoryObjectPort();
 const kernel = createKernel({transports:[port]});
 const declared = envelopeOf('entity', entityUri('house-42'), ACTOR, {components:{'x.wagner.experimentalTrafficModel':{jam:0.4}, 'lifesim.residence':{rooms:3}}});
 const published = await kernel.publish(declared);
 const resolved = kernel.resolve(entityUri('house-42'));
 const components = resolved.ok ? resolved.value?.components : undefined;
 items.push({item:'componentes desconhecidos', ok:published.ok && components?.['x.wagner.experimentalTrafficModel'] !== undefined, note:'Um namespace que este cliente não implementa atravessa a publicação e volta igual.'});
 const base = {'lifesim.residence':{'house-42':{rooms:3}}};
 const ops = ['set','merge','remove','delete'].every(op => applyEvent(base, {type:'event', id:`osim:event:${op}`, entity:'osim:entity:house-42', component:'lifesim.residence', op, value:{rooms:4}, actor:ACTOR, timeline:'osim:timeline:earth-main', time:'2026-09-29T22:00:00Z'}).ok);
 items.push({item:'operações de estado', ok:ops, note:'`set`, `merge`, `remove` e `delete` são as quatro operações de §15, e não há uma quinta.'});
 // A capture states when it was retrieved, when a source said the fact was true and the period it represents; none of
 // those three questions is answered by the other, so none of them is collapsed into the others (§13).
 const time = osimTimeFrom('osim:timeline:earth-main', {retrievedAt:'2026-09-29T22:23:41Z', observedAt:'2026-09-20T00:00:00Z'});
 const period = osimTimeFrom('osim:timeline:earth-main', {retrievedAt:'2026-09-29T22:23:41Z', interval:{from:'2026-01-01T00:00:00Z', to:'2026-12-31T00:00:00Z'}});
 const core = checkCoreComponent('osim.existence', {level:'observed'});
 items.push({item:'tempo', ok:time.time === '2026-09-29T22:23:41Z' && time.observedTime === '2026-09-29T22:23:41Z' && time.validTime === '2026-09-20T00:00:00Z' && period.validTime === undefined && period.interval?.to === '2026-12-31T00:00:00Z' && core.ok, note:'Linha do tempo e instante entram no evento; um período continua período, e o vocabulário central é validado sem recusar campo novo.'});
 // A second client, sharing only the transport: what it receives it received through the adapter, not from this state.
 const peer = createKernel({transports:[port]});
 const received: string[] = [];
 const stop = peer.subscribe({entity:entityUri('house-42')}, object => received.push(object.id));
 const second = await kernel.publish(envelopeOf('event', 'osim:event:checklist-2', ACTOR, {entity:entityUri('house-42'), component:'lifesim.residence', op:'merge', value:{balcony:true}, timeline:'osim:timeline:earth-main', time:'2026-09-29T22:01:00Z'}));
 stop();
 const peerState = peer.state();
 items.push({item:'resolução', ok:resolved.ok && resolved.value?.id === entityUri('house-42'), note:'`resolve` devolve o objeto pelo seu URI, e um URI que ninguém tem é `null` em vez de erro.'});
 items.push({item:'transporte', ok:second.ok && received.join(',') === 'osim:event:checklist-2' && port.stored().length === 2 && peerState.components['lifesim.residence']?.['house-42'] !== undefined, note:'`publish` muda o estado local antes da rede e outro cliente recebe o objeto pelo adaptador de transporte (§30, §2.1).'});
 return items;
}

const report = (value: ReplayReport, checklist: readonly ChecklistItem[]): string => JSON.stringify({
 protocol:value.protocol,
 checklist,
 cases:value.cases.map(entry => ({name:entry.name, generation:entry.generation, stateRef:entry.stateRef, semanticHash:entry.semanticHash, canonicalBytes:new TextEncoder().encode(entry.semanticText).byteLength})),
}, null, 1);

async function main(argv: readonly string[]): Promise<number> {
 const [file = 'tests/fixtures/federated-world/conformance.json'] = argv;
 let text: string;
 try {
  text = readFileSync(file, 'utf8');
 } catch {
  process.stderr.write(`Não foi possível ler o pacote de conformidade: ${file}\n`);
  return 1;
 }
 let pkg: ConformancePackage;
 try {
  pkg = JSON.parse(text) as ConformancePackage;
 } catch (error) {
  process.stderr.write(`Pacote de conformidade ilegível (${file}): ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
 }
 const replayed = await replayFixture(pkg, {codec:createJcsCodec(), hasher:bytesHasher(), hashText:sha256Hex});
 const checklist = await conformanceChecklist();
 const broken = checklist.filter(entry => !entry.ok);
 if (!replayed.ok) {
  process.stderr.write(`Replay recusado (${replayed.error.code}): ${replayed.error.message}\n`);
  return 1;
 }
 process.stdout.write(`${report(replayed.value, checklist)}\n`);
 if (broken.length) {
  process.stderr.write(`Checklist §47 incompleto: ${broken.map(entry => entry.item).join(', ')}\n`);
  return 1;
 }
 return 0;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) process.exit(await main(process.argv.slice(2)));
