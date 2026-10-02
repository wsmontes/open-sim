// The conformance replay (task 17 of docs/superpowers/plans/2026-09-29-federated-world.md). A v2 bundle is the
// internal package and the accepted operations are what a player-hosted session recorded; replaying them under the
// world's own rules has to reach the same version, byte for byte, in any runtime. That is the whole point: a foreign
// client that reproduces these addresses has implemented the boundary, not a lookalike.
//
// Three honesties are structural. Every object read from the package is re-encoded and re-hashed before use, because an
// address is a claim and re-hashing is the only way to test it. A mark carries the digest of the operation's own bytes,
// and that digest is recomputed — the ledger is not believed because it is written down. And an operation the rules
// cannot re-execute is not guessed at: a command is replayed by the rules, while a composition (a merge, an update of
// the real base) carries the state it produced, because composing two versions is not re-executing intentions.
import {applyCommand} from '../core/commands';
import {durableJson} from '../core/protocol';
import type {BaseChunk,Command,GameState} from '../core/model';
import {MAX_OBJECT_BYTES,WORLD_PROTOCOL,WIRE_VERSION,failed,isRef,ok,sameRef} from './model';
import type {DatasetTerm,Head,JsonValue,ObjectRef,WorldBundle,WorldDefinition,WorldResult} from './model';
import type {ContentHasher,WorldCodec} from './ports';
import {closedProblem,isPlainObject,} from '../core/guards';

// A package with more operations than this is refused before anything is applied: a bound the caller can act on beats a
// partial replay. The number follows the session's own queue limit (128 proposals, at most two operations per change).
export const MAX_REPLAY_OPERATIONS = 256;

export type ReplayPorts = {codec: WorldCodec; hasher: ContentHasher};
// The semantic hash covers the canonical text of the world's identity, and turning text into bytes is a platform
// concern (TextEncoder is DOM/Node, and this layer compiles with neither), so the caller injects it — which is also
// what lets the Node runner and the browser page be compared: same bytes, two runtimes.
export type ReplayOptions = ReplayPorts & {hashText: (text: string) => Promise<string>};
// What a client can reproduce. A command names the intention and the rules apply it; a composition names the state it
// produced, which is what `resolveMerge`/`resolveBaseUpdate` hand to the repository (task 5 delta in the plan).
export type ReplayOperation =
 | {kind: 'command'; mark: string; actor: string; digest: string; command: Command}
 | {kind: 'composed'; mark: string; actor: string; digest: string; state: GameState; note?: string};
export type AcceptedOperation = ReplayOperation;
// The version object this replay produces. `WorldCommit` in the session layer satisfies this shape, which is how a
// checkpoint can be published as a version without the world layer importing the session layer.
export type ReplayCommit = {kind: 'world-commit'; parents: ObjectRef[]; tree: ObjectRef; generation: number; rules: {family: string; version: number}; datasets: ObjectRef[]; accepted: string[]; author?: string};
export type ReplayBaseRef = {id: string; ref: ObjectRef};
// What the replay reached. `Checkpoint` from src/session/world-repository.ts satisfies every field here, so a caller
// that holds both needs no conversion — only the replay's own accounting (`ledger`, `receipts`, `duplicates`) is extra.
export type ReplayCheckpoint = {
 head: Head;
 commit: ReplayCommit;
 definition: WorldDefinition;
 terms: readonly DatasetTerm[];
 tree: ObjectRef;
 stateRef: ObjectRef;
 state: GameState;
 bases: readonly ReplayBaseRef[];
 // The projection a device's receipt index would give for these deliveries, and the marks the versions record.
 receipts: readonly string[];
 ledger: readonly string[];
 duplicates: readonly string[];
 versions: {worldProtocol: number; wireVersion: number; rules: {family: string; version: number}};
};
export type ConformanceCase = {name: string; bundle: WorldBundle; operations: readonly AcceptedOperation[]};
export type ConformancePackage = {cases: readonly ConformanceCase[]};
export type ReplayReportCase = {name: string; generation: number; stateRef: ObjectRef; semanticHash: string; semanticText: string};
export type ReplayReport = {protocol: 'osim/0.1'; cases: ReplayReportCase[]};

const MARK = /^p\.(\d{1,6})\.([-\w]{1,80})@([0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const URI = /^[a-z][a-z0-9+.-]*:[^\s\u0000-\u001f]{1,220}$/;
const OBJECT_FIELDS: readonly string[] = ['ref','value'];
const DEFINITION_FIELDS: readonly string[] = ['worldId','branchId','origin','profiles','rules'];
const ORIGIN_FIELDS: readonly string[] = ['kind','note','parent'];
const RULES_FIELDS: readonly string[] = ['family','version'];
const TERM_FIELDS: readonly string[] = ['source','attribution','license'];
const HEAD_FIELDS: readonly string[] = ['worldId','branchId','commit','generation'];
const COMMIT_FIELDS: readonly string[] = ['kind','parents','tree','generation','rules','datasets','accepted','author'];
const TREE_FIELDS: readonly string[] = ['kind','definition','terms','state','attached'];

const refOf = (value: unknown): ObjectRef | null => isRef(value) ? {hash:value.hash, bytes:value.bytes} : null;
const addressPart = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 80 ? value : null;
// A record that declares every field it is allowed to carry: the critical schemas of this contract are closed, so a
// newer writer has to say so through `extensions` instead of a field an older reader would drop in silence.
function known(refs: readonly ObjectRef[]): ObjectRef[] {
 const seen = new Set<string>(), kept: ObjectRef[] = [];
 for (const ref of refs) {
  if (seen.has(ref.hash)) continue;
  seen.add(ref.hash);
  kept.push(ref);
 }
 return kept;
}
const markIdOf = (mark: string): string => mark.split('.')[2]!.split('@')[0]!;

// The same closed reading the codec applies to a package on the wire, applied to a package that already arrived as a
// value: a definition with an unknown field, a head pointing at another world or a generation that disagrees with its
// commit are refused here instead of becoming a confusing failure three steps later.
function definitionOf(value: unknown): WorldResult<WorldDefinition> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Pacote sem definição de mundo');
 const problem = closedProblem(value, DEFINITION_FIELDS, 'Definição');
 if (problem) return failed('MALFORMED', problem);
 const worldId = addressPart(value['worldId']), branchId = addressPart(value['branchId']);
 if (!worldId || !branchId) return failed('MALFORMED', 'Pacote com endereço de mundo inválido');
 const rules = value['rules'];
 if (!isPlainObject(rules)) return failed('MALFORMED', 'Pacote sem regras');
 const rulesProblem = closedProblem(rules, RULES_FIELDS, 'Regras');
 if (rulesProblem) return failed('MALFORMED', rulesProblem);
 if (typeof rules['family'] !== 'string' || !rules['family'] || !Number.isSafeInteger(rules['version']) || (rules['version'] as number) < 1) return failed('MALFORMED', 'Regras inválidas');
 const origin = value['origin'];
 if (!isPlainObject(origin)) return failed('MALFORMED', 'Pacote sem origem');
 const originProblem = closedProblem(origin, ORIGIN_FIELDS, 'Origem');
 if (originProblem) return failed('MALFORMED', originProblem);
 if (!['legacy-save','new','fork'].includes(String(origin['kind']))) return failed('MALFORMED', 'Origem inválida');
 const profiles = value['profiles'];
 if (!Array.isArray(profiles) || profiles.some(profile => typeof profile !== 'string' || !profile)) return failed('MALFORMED', 'Perfis inválidos');
 const parsedOrigin: WorldDefinition['origin'] = {kind: origin['kind'] as WorldDefinition['origin']['kind']};
 if (origin['note'] !== undefined) {
  if (typeof origin['note'] !== 'string') return failed('MALFORMED', 'Nota de origem inválida');
  parsedOrigin.note = origin['note'];
 }
 if (origin['parent'] !== undefined) {
  if (!isPlainObject(origin['parent'])) return failed('MALFORMED', 'Origem de fork inválida');
  const parentWorld = addressPart(origin['parent']['worldId']), parentBranch = addressPart(origin['parent']['branchId']);
  if (!parentWorld || !parentBranch) return failed('MALFORMED', 'Origem de fork inválida');
  const parentProblem = closedProblem(origin['parent'], ['worldId','branchId'], 'Origem de fork');
  if (parentProblem) return failed('MALFORMED', parentProblem);
  parsedOrigin.parent = {worldId:parentWorld, branchId:parentBranch};
 }
 return ok({worldId, branchId, origin:parsedOrigin, profiles:[...profiles] as string[], rules:{family:rules['family'], version:rules['version'] as number}});
}
function termsOf(value: unknown): WorldResult<DatasetTerm[]> {
 if (!Array.isArray(value)) return failed('MALFORMED', 'Pacote sem termos de dados');
 const terms: DatasetTerm[] = [];
 for (const entry of value) {
  if (!isPlainObject(entry)) return failed('MALFORMED', 'Termo de dados inválido');
  const problem = closedProblem(entry, TERM_FIELDS, 'Termo de dados');
  if (problem) return failed('MALFORMED', problem);
  if (typeof entry['source'] !== 'string' || !entry['source']) return failed('MALFORMED', 'Termo de dados sem fonte');
  const term: DatasetTerm = {source:entry['source']};
  for (const field of ['attribution','license'] as const) {
   if (entry[field] === undefined) continue;
   if (typeof entry[field] !== 'string') return failed('MALFORMED', `${field} inválida no termo de dados`);
   term[field] = entry[field] as string;
  }
  terms.push(term);
 }
 return ok(terms);
}

type LoadedBundle = {head: Head; definition: WorldDefinition; terms: DatasetTerm[]; objects: Map<string, JsonValue>};

function checkBundle(bundle: unknown): WorldResult<LoadedBundle> {
 if (!isPlainObject(bundle)) return failed('MALFORMED', 'Pacote ausente');
 const envelope = bundle['envelope'];
 if (!isPlainObject(envelope)) return failed('MALFORMED', 'Pacote sem envelope');
 const envelopeProblem = closedProblem(envelope, ['worldProtocol','wireVersion','kind'], 'Envelope do pacote');
 if (envelopeProblem) return failed('MALFORMED', envelopeProblem);
 if (envelope['worldProtocol'] !== WORLD_PROTOCOL) return failed('WORLD_PROTOCOL_UNSUPPORTED', `Protocolo de mundo ${String(envelope['worldProtocol'])} não é suportado (esperado ${WORLD_PROTOCOL})`);
 if (envelope['wireVersion'] !== WIRE_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `Versão de transporte ${String(envelope['wireVersion'])} não é suportada (esperada ${WIRE_VERSION})`);
 if (envelope['kind'] !== 'bundle') return failed('MALFORMED', `Envelope de tipo desconhecido: ${String(envelope['kind'])}`);
 const definition = definitionOf(bundle['definition']);
 if (!definition.ok) return definition;
 // This client reproduces the rules it implements; another family is another simulation, not a filter.
 if (definition.value.rules.family !== 'city') return failed('WORLD_PROTOCOL_UNSUPPORTED', `Família de regras ${definition.value.rules.family} não é reproduzível por este cliente`);
 const terms = termsOf(bundle['terms']);
 if (!terms.ok) return terms;
 const completeness = bundle['completeness'];
 if (!isPlainObject(completeness) || typeof completeness['complete'] !== 'boolean') return failed('MALFORMED', 'Pacote sem estado de completude');
 if (completeness['complete'] !== true) {
  const missing = Array.isArray(completeness['missing']) ? completeness['missing'].map(refOf).filter((ref): ref is ObjectRef => ref !== null) : [];
  return failed('MISSING_OBJECT', `Pacote incompleto: faltam ${missing.length} objeto(s)${missing.length ? `, o primeiro é ${missing[0]!.hash.slice(0,12)}…` : ''}`);
 }
 if (!Array.isArray(bundle['objects'])) return failed('MALFORMED', 'Pacote sem lista de objetos');
 const objects = new Map<string, JsonValue>();
 for (const entry of bundle['objects']) {
  if (!isPlainObject(entry)) return failed('MALFORMED', 'Objeto de pacote inválido');
  const problem = closedProblem(entry, OBJECT_FIELDS, 'Objeto de pacote');
  if (problem) return failed('MALFORMED', problem);
  const ref = refOf(entry['ref']);
  if (!ref) return failed('MALFORMED', 'Objeto de pacote sem endereço válido');
  objects.set(ref.hash, entry['value'] as JsonValue);
 }
 const head = bundle['head'];
 if (head === undefined) return failed('MALFORMED', 'Pacote sem versão: um replay de conformidade parte de uma versão publicada');
 if (!isPlainObject(head)) return failed('MALFORMED', 'Cabeça de pacote inválida');
 const headProblem = closedProblem(head, HEAD_FIELDS, 'Cabeça de pacote');
 if (headProblem) return failed('MALFORMED', headProblem);
 const worldId = addressPart(head['worldId']), branchId = addressPart(head['branchId']), commit = refOf(head['commit']);
 if (!worldId || !branchId || !commit) return failed('MALFORMED', 'Cabeça de pacote inválida');
 if (worldId !== definition.value.worldId || branchId !== definition.value.branchId) return failed('MALFORMED', 'A cabeça do pacote é de outro mundo ou ramificação');
 const generation = head['generation'];
 if (!Number.isSafeInteger(generation) || (generation as number) < 1) return failed('MALFORMED', 'Geração inválida na cabeça do pacote');
 return ok({head:{worldId, branchId, commit, generation:generation as number}, definition:definition.value, terms:terms.value, objects});
}

function checkOperation(value: unknown, index: number): WorldResult<ReplayOperation> {
 if (!isPlainObject(value)) return failed('MALFORMED', `Operação ${index} não é um documento`);
 if (value['kind'] !== 'command' && value['kind'] !== 'composed') return failed('MALFORMED', `Operação ${index} tem tipo desconhecido: ${String(value['kind'])}`);
 const mark = value['mark'], digest = value['digest'], actor = value['actor'];
 if (typeof mark !== 'string' || !MARK.test(mark)) return failed('MALFORMED', `Operação ${index} sem marca de livro-razão`);
 if (typeof digest !== 'string' || !DIGEST.test(digest)) return failed('MALFORMED', `Operação ${index} sem digest`);
 if (typeof actor !== 'string' || !URI.test(actor)) return failed('MALFORMED', `Operação ${index} sem ator do protocolo`);
 // The mark names its own digest, and that digest is recomputed from the operation's bytes below: a mark that does not
 // even agree with itself is refused before anything is hashed.
 if (mark.split('@')[1] !== digest) return failed('MALFORMED', `A marca da operação ${index} não carrega o digest que ela mesma declara`);
 if (value['kind'] === 'command') {
  const command = value['command'];
  if (!isPlainObject(command) || command['version'] !== 1) return failed('MALFORMED', `Operação ${index} sem comando`);
  if (addressPart(command['worldId']) === null || typeof command['actorId'] !== 'string' || !Number.isSafeInteger(command['sequence']) || !Number.isSafeInteger(command['expectedRevision']) || !isPlainObject(command['action'])) return failed('MALFORMED', `Operação ${index} com comando inválido`);
  return ok({kind:'command', mark, actor, digest, command:command as unknown as Command});
 }
 const state = value['state'];
 if (!isPlainObject(state) || typeof state['worldId'] !== 'string' || !Number.isSafeInteger(state['revision']) || !Number.isSafeInteger(state['tick']) || !Number.isSafeInteger(state['money']) || !isPlainObject(state['chunks']) || !isPlainObject(state['components'])) return failed('MALFORMED', `Composição ${index} sem estado`);
 const note = value['note'];
 if (note !== undefined && typeof note !== 'string') return failed('MALFORMED', `Composição ${index} com nota inválida`);
 const operation: ReplayOperation = {kind:'composed', mark, actor, digest, state:state as unknown as GameState};
 if (typeof note === 'string') operation.note = note;
 return ok(operation);
}

export async function replayWorld(bundle: WorldBundle, operations: readonly AcceptedOperation[], ports: ReplayPorts): Promise<WorldResult<ReplayCheckpoint>> {
 const loaded = checkBundle(bundle);
 if (!loaded.ok) return loaded;
 if (!Array.isArray(operations)) return failed('MALFORMED', 'Lista de operações ausente');
 if (operations.length > MAX_REPLAY_OPERATIONS) return failed('LIMIT', `O replay reproduz até ${MAX_REPLAY_OPERATIONS} operações e o pacote traz ${operations.length}`);
 const {head, definition, terms, objects} = loaded.value;
 const cache = new Map<string, JsonValue>();
 // Reading is where an address stops being a claim: the value is re-encoded with the canonical codec and re-hashed, so
 // a package whose bytes moved is refused before the replay reasons about it.
 const read = async (ref: ObjectRef): Promise<WorldResult<JsonValue>> => {
  const stored = objects.get(ref.hash);
  if (stored === undefined) return failed('MISSING_OBJECT', `Objeto ausente no pacote: ${ref.hash.slice(0, 12)}…`);
  const cached = cache.get(ref.hash);
  if (cached !== undefined) return ok(cached);
  let actual: ObjectRef;
  try {
   actual = await ports.hasher.ref(ports.codec.encode(stored));
  } catch (error) {
   return failed('MALFORMED', `Objeto ${ref.hash.slice(0, 12)}… não é JSON canônico: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!sameRef(actual, ref)) return failed('HASH_MISMATCH', `O objeto ${ref.hash.slice(0, 12)}… não corresponde aos bytes: ${actual.hash.slice(0, 12)}…`);
  if (actual.bytes > MAX_OBJECT_BYTES) return failed('LIMIT', `Objeto de ${actual.bytes} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
  cache.set(ref.hash, stored);
  return ok(stored);
 };
 const address = async (value: JsonValue): Promise<ObjectRef> => ports.hasher.ref(ports.codec.encode(value));
 const commitValue = await read(head.commit);
 if (!commitValue.ok) return commitValue;
 const commit = commitValue.value;
 if (!isPlainObject(commit) || commit['kind'] !== 'world-commit') return failed('MALFORMED', 'A cabeça do pacote não aponta um commit');
 const commitProblem = closedProblem(commit, COMMIT_FIELDS, 'Commit do pacote');
 if (commitProblem) return failed('MALFORMED', commitProblem);
 if (commit['generation'] !== head.generation) return failed('MALFORMED', 'Geração do commit não corresponde à cabeça do pacote');
 const rules = commit['rules'];
 if (!isPlainObject(rules) || rules['family'] !== definition.rules.family || rules['version'] !== definition.rules.version) return failed('MALFORMED', 'O commit do pacote segue outras regras que a definição');
 const treeRef = refOf(commit['tree']);
 const parents = Array.isArray(commit['parents']) ? commit['parents'].map(refOf) : null;
 const datasets = Array.isArray(commit['datasets']) ? commit['datasets'].map(refOf) : null;
 const accepted = Array.isArray(commit['accepted']) && commit['accepted'].every(entry => typeof entry === 'string') ? [...commit['accepted']] as string[] : null;
 if (!treeRef || !parents || !datasets || !accepted || parents.some(entry => entry === null) || datasets.some(entry => entry === null)) return failed('MALFORMED', 'Commit do pacote incompleto');
 let currentCommit: ReplayCommit = {kind:'world-commit', parents:[...parents] as ObjectRef[], tree:treeRef, generation:head.generation, rules:{family:definition.rules.family, version:definition.rules.version}, datasets:[...datasets] as ObjectRef[], accepted};
 if (typeof commit['author'] === 'string') currentCommit.author = commit['author'];
 const treeValue = await read(treeRef);
 if (!treeValue.ok) return treeValue;
 const tree = treeValue.value;
 if (!isPlainObject(tree) || tree['kind'] !== 'world-tree') return failed('MALFORMED', 'O commit do pacote não aponta uma árvore');
 const treeProblem = closedProblem(tree, TREE_FIELDS, 'Árvore do pacote');
 if (treeProblem) return failed('MALFORMED', treeProblem);
 const stateRef = refOf(tree['state']);
 const attached = Array.isArray(tree['attached']) ? tree['attached'].map(refOf) : null;
 if (!stateRef || !attached || attached.some(entry => entry === null)) return failed('MALFORMED', 'Árvore do pacote incompleta');
 const stateValue = await read(stateRef);
 if (!stateValue.ok) return stateValue;
 if (!isPlainObject(stateValue.value) || stateValue.value['kind'] !== 'city-state' || !isPlainObject(stateValue.value['state'])) return failed('MALFORMED', 'O estado do pacote não é um estado de mundo');
 let state = stateValue.value['state'] as unknown as GameState;
 if (state.worldId !== definition.worldId) return failed('MALFORMED', 'O estado do pacote é de outro mundo');
 // A region the state does not have yet may still be built on, if the package carries the frozen base for it.
 const available: BaseChunk[] = [];
 for (const value of objects.values()) if (isPlainObject(value) && value['kind'] === 'base-chunk' && isPlainObject(value['base'])) available.push(value['base'] as unknown as BaseChunk);
 const ledger: string[] = [...currentCommit.accepted];
 const receipts: string[] = [], duplicates: string[] = [];
 const seen = new Set(ledger);
 let currentTree: ObjectRef = treeRef, currentStateRef: ObjectRef = stateRef, currentCommitRef: ObjectRef = head.commit;
 let attachedRefs: ObjectRef[] = [...attached] as ObjectRef[];
 let currentTreeValue: JsonValue = tree;
 let generation = head.generation;
 for (const [index, raw] of operations.entries()) {
  const checked = checkOperation(raw, index);
  if (!checked.ok) return checked;
  const operation = checked.value;
  if (seen.has(operation.mark)) {
   // The ledger answers a resend; it does not apply the same acceptance twice (the session behaves the same way).
   duplicates.push(operation.mark);
   continue;
  }
  // The digest covers the operation's own bytes: a command's canonical form, or for a composition the state it
  // produced — the same bytes a repository addresses.
  try {
   const actual = operation.kind === 'command'
    ? await address({kind:'accepted-command', command:operation.command as unknown as JsonValue})
    : await address({kind:'city-state', state:operation.state as unknown as JsonValue});
   if (actual.hash !== operation.digest) return failed('HASH_MISMATCH', `A operação ${operation.mark} não corresponde ao endereço que ela declara`);
  } catch (error) {
   return failed('MALFORMED', `Operação ${operation.mark} não é JSON canônico: ${error instanceof Error ? error.message : String(error)}`);
  }
  let next: GameState;
  if (operation.kind === 'command') {
   if (operation.command.worldId !== state.worldId) return failed('CONFLICT', `A operação ${operation.mark} é do mundo ${operation.command.worldId}, e esta versão é de ${state.worldId}`);
   const applied = applyCommand(state, operation.command, available);
   if (applied.status === 'rejected') return failed('CONFLICT', `A operação ${operation.mark} não se aplica: ${applied.reason ?? 'recusada'}`);
   if (applied.status === 'duplicate') {
    duplicates.push(operation.mark);
    continue;
   }
   next = applied.state;
  } else {
   // A composition is the issuer's statement about a result, so it is held to what a statement can be held to: it
   // belongs to this world, it follows the same rules, and it advances this version instead of rewinding it.
   if (operation.state.worldId !== state.worldId) return failed('CONFLICT', `A composição ${operation.mark} é do mundo ${operation.state.worldId}, e esta versão é de ${state.worldId}`);
   if (operation.state.formatVersion !== state.formatVersion || operation.state.rulesVersion !== state.rulesVersion) return failed('CONFLICT', `A composição ${operation.mark} segue outras regras`);
   if (operation.state.revision < state.revision) return failed('CONFLICT', `A composição ${operation.mark} não avança a revisão desta versão`);
   next = operation.state;
  }
  const snapshotRef = await address({kind:'city-state', state:next as unknown as JsonValue});
  attachedRefs = known(attachedRefs.filter(ref => !sameRef(ref, snapshotRef)));
  currentTreeValue = {kind:'world-tree', definition:definition as unknown as JsonValue, terms:terms as unknown as JsonValue, state:snapshotRef as unknown as JsonValue, attached:attachedRefs as unknown as JsonValue};
  currentTree = await address(currentTreeValue);
  currentCommit = {kind:'world-commit', parents:[currentCommitRef], tree:currentTree, generation:generation + 1, rules:{family:definition.rules.family, version:definition.rules.version}, datasets:known(currentCommit.datasets), accepted:[operation.mark], author:operation.actor};
  currentCommitRef = await address(currentCommit as unknown as JsonValue);
  generation += 1;
  currentStateRef = snapshotRef;
  state = next;
  seen.add(operation.mark);
  ledger.push(operation.mark);
  receipts.push(`${markIdOf(operation.mark)}@${operation.digest}`);
 }
 const bases: ReplayBaseRef[] = [];
 for (const id of Object.keys(state.chunks).sort()) if (isPlainObject(state.chunks[id]?.base)) bases.push({id, ref:await address({kind:'base-chunk', base:state.chunks[id]!.base as unknown as JsonValue})});
 return ok({
  head:{worldId:definition.worldId, branchId:definition.branchId, commit:currentCommitRef, generation},
  commit:currentCommit,
  definition,
  terms,
  tree:currentTree,
  stateRef:currentStateRef,
  state,
  bases,
  receipts,
  ledger,
  duplicates,
  versions:{worldProtocol:WORLD_PROTOCOL, wireVersion:WIRE_VERSION, rules:{family:definition.rules.family, version:definition.rules.version}},
 });
}

// The public conformance report: the same package and the same bytes give the same address and the same semantic hash in
// every runtime. The report carries the canonical text as well as its hash so two runtimes can be diffed without
// hashing anything, and `protocol` names the boundary the package belongs to.
export async function replayFixture(pkg: ConformancePackage, ports: ReplayOptions): Promise<WorldResult<ReplayReport>> {
 if (!isPlainObject(pkg) || !Array.isArray(pkg['cases'])) return failed('MALFORMED', 'Pacote de conformidade sem casos');
 const cases: ReplayReportCase[] = [];
 for (const entry of pkg['cases']) {
  if (!isPlainObject(entry) || typeof entry['name'] !== 'string' || !entry['name']) return failed('MALFORMED', 'Caso de conformidade sem nome');
  const replayed = await replayWorld(entry['bundle'] as unknown as WorldBundle, entry['operations'] as unknown as readonly AcceptedOperation[], ports);
  if (!replayed.ok) return failed(replayed.error.code, `${entry['name']}: ${replayed.error.message}`);
  const semanticText = durableJson(replayed.value.state);
  cases.push({name:entry['name'], generation:replayed.value.head.generation, stateRef:replayed.value.stateRef, semanticHash:await ports.hashText(semanticText), semanticText});
 }
 return ok({protocol:'osim/0.1', cases});
}
