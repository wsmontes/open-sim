// Navigation between worlds (task 17 of docs/superpowers/plans/2026-09-29-federated-world.md). A link is the document
// this client publishes so somebody else can find and enter a world they do not have. It is deliberately **not** a new
// protocol kind — OpenSim 0.1 defines seven and a link is not one of them (§3) — it is this client's own document
// wrapped around a view URI (§40) and capability declarations (§27).
//
// Three rules decide the shape of everything here. Holding a link is not a grant, so resolving one produces a visit
// target that says `write: false` and carries no proof: writing still goes through `authorize` against a grant the
// version owner signed (§28). The registry is closed, so a field nobody declared is refused instead of forwarded —
// "convenient" private material has no road into a public document. And a fixed link names a version while a moving
// link names a branch: the difference is the whole reason two people can share a world and still visit different
// states, so a document that claims both is refused rather than read as whichever field the reader looks at first.
import {parseOsimUri,parseViewUri} from './osim';
import type {Head,JsonValue,ObjectRef,WorldAddress,WorldError,WorldResult} from './model';
import {failed,isRef,ok} from './model';

export const WORLD_LINK_VERSION = 1;
// What a public capability may name: the four state operations of §15 and the writing actions this client already
// scopes grants by (src/world/permissions.ts). A role (`admin`, `host`) is not an action — it follows from what a
// session agreed, never from a share file — so it is refused here instead of quietly published as an action.
export const PUBLIC_ACTIONS: readonly string[] = ['set','merge','remove','delete','build','demolish','tick','component'];
// A declaration, never a token: what the issuer says somebody may do, with no key and no proof attached. The optional
// `type` is the §27 discriminator, accepted so a capability document written by the protocol's own example is read
// unchanged (and refused when it claims to be something else).
export type PublicCapability = {type?: 'capability'; issuer: string; subject?: string; entity?: string; component?: string; actions: readonly string[]; policy?: string};
// Where a copy of the world can be asked for it (§31: several providers, none of them required). `copy` is an
// identifier the resolver understands; this layer only orders copies, it never speaks to one.
export type LinkSource = {copy: string; transport: string};
// Where the visitor arrives: a view (§40), an entity, or a live session. The URI identifies what was asked for, never
// which server answers.
export type WorldLinkArrival = {kind: 'view' | 'entity' | 'session'; uri: string};
// What a bridge records about the copy it publishes: the original id survives every hop, because two bridges
// republishing one world must not turn it into two worlds.
export type LinkBridge = {bridge: string; hops: number; origin: string};
export type WorldLinkTarget = {kind: 'commit'; commit: ObjectRef} | {kind: 'branch'};
export type WorldLink = {
 kind: 'world-link';
 version: typeof WORLD_LINK_VERSION;
 id: string;
 world: WorldAddress;
 target: WorldLinkTarget;
 arrival: WorldLinkArrival;
 capabilities: readonly PublicCapability[];
 actor: string;
 sources: readonly LinkSource[];
 bridge?: LinkBridge;
 publishedAt?: string;
 title?: string;
};
// What resolving a link produced. `role` and `write` are the honest answer to "am I allowed to build here": a visitor
// with a link has looked, and nothing else follows from it.
export type VisitTarget = {
 kind: 'visit';
 link: string;
 world: WorldAddress;
 commit: ObjectRef;
 generation: number;
 moving: boolean;
 arrival: WorldLinkArrival;
 role: 'visitor';
 write: false;
 capabilities: readonly PublicCapability[];
 servedBy: string;
 unavailable: readonly string[];
 degraded: boolean;
};
// What the world layer asks for objects. The resolver answers with values it has already checked against their
// address — that is what addressing content means — so this layer validates shape and consistency, never bytes.
export interface ObjectResolver {
 copies(): readonly LinkSource[];
 head(copy: string, world: WorldAddress): Promise<WorldResult<Head | null>>;
 object(copy: string, ref: ObjectRef): Promise<WorldResult<JsonValue | null>>;
}

const URI = /^[a-z][a-z0-9+.-]*:[^\s\u0000-\u001f]{1,220}$/;
const TOKEN = /^[a-z][a-z0-9.+-]{1,31}$/;
const COPY = /^[^\s\u0000-\u001f]{1,200}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const RESERVED = ['__proto__','constructor','prototype'];
const LINK_FIELDS: readonly string[] = ['kind','version','id','world','target','arrival','capabilities','actor','sources','bridge','publishedAt','title'];
const CAPABILITY_FIELDS: readonly string[] = ['type','issuer','subject','entity','component','actions','policy'];
const SOURCE_FIELDS: readonly string[] = ['copy','transport'];
const BRIDGE_FIELDS: readonly string[] = ['bridge','hops','origin'];
const ARRIVAL_FIELDS: readonly string[] = ['kind','uri'];
const ADDRESS_FIELDS: readonly string[] = ['worldId','branchId'];
const TARGET_FIELDS: readonly string[] = ['kind','commit'];

function plain(value: unknown): value is Record<string, unknown> {
 return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
// A closed record: every field has to be one this contract declares, and the refusal names the field, because a reader
// that silently dropped it would be publishing something other than what it was handed.
function closed(value: Record<string, unknown>, allowed: readonly string[], label: string): WorldError | null {
 for (const key of Object.keys(value)) {
  if (RESERVED.includes(key)) return {code:'MALFORMED', message:`${label} com campo reservado: ${key}`};
  if (!allowed.includes(key)) return {code:'MALFORMED', message:`${label} com campo não declarado: ${key}`};
 }
 return null;
}
function text(value: unknown, label: string, pattern: RegExp = URI): WorldResult<string> {
 if (typeof value !== 'string' || !pattern.test(value)) return failed('MALFORMED', `${label} não é um identificador válido: ${String(value).slice(0,40)}`);
 return ok(value);
}
function optionalText(value: unknown, label: string, pattern: RegExp = URI): WorldResult<string | undefined> {
 return value === undefined ? ok(undefined) : text(value, label, pattern);
}
function addressOf(value: unknown): WorldResult<WorldAddress> {
 if (!plain(value)) return failed('MALFORMED', 'Endereço de mundo ausente');
 const problem = closed(value, ADDRESS_FIELDS, 'Endereço de mundo');
 if (problem) return {ok:false, error:problem};
 const worldId = text(value['worldId'], 'worldId', COPY), branchId = text(value['branchId'], 'branchId', COPY);
 if (!worldId.ok) return worldId;
 if (!branchId.ok) return branchId;
 return ok({worldId:worldId.value, branchId:branchId.value});
}
// The same closed address check a link applies, exported because a card carries an address too and two readers must not
// disagree about what an address is.
export const checkWorldAddress = addressOf;
export function checkPublicCapability(value: unknown): WorldResult<PublicCapability> {
 if (!plain(value)) return failed('MALFORMED', 'Capacidade pública ausente');
 const problem = closed(value, CAPABILITY_FIELDS, 'Capacidade pública');
 if (problem) return {ok:false, error:problem};
 if (value['type'] !== undefined && value['type'] !== 'capability') return failed('MALFORMED', `Documento de capacidade com tipo desconhecido: ${String(value['type'])}`);
 const issuer = text(value['issuer'], 'Emissor da capacidade');
 if (!issuer.ok) return issuer;
 // An entity is named by an `osim:entity:` URI, and an identifier from another ecosystem is carried as it is (§4).
 if (value['entity'] !== undefined) {
  const entity = text(value['entity'], 'Entidade da capacidade');
  if (!entity.ok) return entity;
 }
 const subject = optionalText(value['subject'], 'Sujeito da capacidade');
 if (!subject.ok) return subject;
 const component = optionalText(value['component'], 'Componente da capacidade', /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9_]*)+$/);
 if (!component.ok) return component;
 const policy = optionalText(value['policy'], 'Política da capacidade', COPY);
 if (!policy.ok) return policy;
 const actions = value['actions'];
 if (!Array.isArray(actions) || !actions.length) return failed('MALFORMED', 'A capacidade não declara ação alguma');
 const declared: string[] = [];
 for (const action of actions) {
  if (typeof action !== 'string' || !PUBLIC_ACTIONS.includes(action)) return failed('MALFORMED', `Ação pública desconhecida: ${String(action).slice(0,24)}`);
  declared.push(action);
 }
 const capability: PublicCapability = {issuer:issuer.value, actions:declared};
 if (value['type'] === 'capability') capability.type = 'capability';
 if (subject.value) capability.subject = subject.value;
 if (typeof value['entity'] === 'string') capability.entity = value['entity'];
 if (component.value) capability.component = component.value;
 if (policy.value) capability.policy = policy.value;
 return ok(capability);
}
function checkArrival(value: unknown): WorldResult<WorldLinkArrival> {
 if (!plain(value)) return failed('MALFORMED', 'Lugar de chegada ausente');
 const problem = closed(value, ARRIVAL_FIELDS, 'Lugar de chegada');
 if (problem) return {ok:false, error:problem};
 const kind = value['kind'];
 if (kind !== 'view' && kind !== 'entity' && kind !== 'session') return failed('MALFORMED', `Lugar de chegada desconhecido: ${String(kind)}`);
 const uri = text(value['uri'], 'URI do lugar de chegada');
 if (!uri.ok) return uri;
 if (kind === 'view') {
  const view = parseViewUri(uri.value);
  if (!view.ok) return failed('MALFORMED', `A vista de chegada não é um URI de vista: ${uri.value}`);
 } else {
  const parsed = parseOsimUri(uri.value);
  if (parsed.scheme !== 'osim' || parsed.kind !== kind) return failed('MALFORMED', `A chegada ${kind} precisa de um identificador ${kind}`);
 }
 return ok({kind, uri:uri.value});
}
function checkSource(value: unknown): WorldResult<LinkSource> {
 if (!plain(value)) return failed('MALFORMED', 'Cópia sem identificador');
 const problem = closed(value, SOURCE_FIELDS, 'Cópia');
 if (problem) return {ok:false, error:problem};
 const copy = text(value['copy'], 'Identificador da cópia', COPY), transport = text(value['transport'], 'Transporte da cópia', TOKEN);
 if (!copy.ok) return copy;
 if (!transport.ok) return transport;
 return ok({copy:copy.value, transport:transport.value});
}
function checkBridge(value: unknown): WorldResult<LinkBridge> {
 if (!plain(value)) return failed('MALFORMED', 'Ponte inválida');
 const problem = closed(value, BRIDGE_FIELDS, 'Ponte');
 if (problem) return {ok:false, error:problem};
 const bridge = text(value['bridge'], 'Identificador da ponte'), origin = text(value['origin'], 'Identificador original');
 if (!bridge.ok) return bridge;
 if (!origin.ok) return origin;
 const hops = value['hops'];
 if (!Number.isSafeInteger(hops) || (hops as number) < 1 || (hops as number) > 64) return failed('MALFORMED', `Salto de ponte inválido: ${String(hops)}`);
 return ok({bridge:bridge.value, origin:origin.value, hops:hops as number});
}
// The whole document, checked field by field against a closed registry: this is the function a receiving client runs
// before it believes anything a link says.
export function checkWorldLink(value: unknown): WorldResult<WorldLink> {
 if (!plain(value)) return failed('MALFORMED', 'Link de mundo ausente');
 const problem = closed(value, LINK_FIELDS, 'Link de mundo');
 if (problem) return {ok:false, error:problem};
 if (value['kind'] !== 'world-link') return failed('MALFORMED', `Documento de tipo desconhecido: ${String(value['kind'])}`);
 if (value['version'] !== WORLD_LINK_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `Versão de link ${String(value['version'])} não é suportada (esperada ${WORLD_LINK_VERSION})`);
 const id = text(value['id'], 'Identificador do link');
 if (!id.ok) return id;
 const actor = text(value['actor'], 'Ator do link');
 if (!actor.ok) return actor;
 const world = addressOf(value['world']);
 if (!world.ok) return world;
 const target = value['target'];
 if (!plain(target)) return failed('MALFORMED', 'O link não diz o que visita');
 const targetProblem = closed(target, TARGET_FIELDS, 'Alvo do link');
 if (targetProblem) return {ok:false, error:targetProblem};
 let resolvedTarget: WorldLinkTarget;
 if (target['kind'] === 'commit') {
  const commit = target['commit'];
  if (!isRef(commit)) return failed('MALFORMED', 'Um link fixo precisa do commit que visita');
  resolvedTarget = {kind:'commit', commit:{hash:commit.hash, bytes:commit.bytes}};
 } else if (target['kind'] === 'branch') {
  // A branch moves, so a moving link carrying a commit would be a fixed link pretending to be current: the two are
  // different promises and a document may only make one.
  if ('commit' in target) return failed('MALFORMED', 'Um link móvel não pode fixar um commit');
  resolvedTarget = {kind:'branch'};
 } else return failed('MALFORMED', `Alvo de link desconhecido: ${String(target['kind'])}`);
 const arrival = checkArrival(value['arrival']);
 if (!arrival.ok) return arrival;
 const capabilities: PublicCapability[] = [];
 if (value['capabilities'] !== undefined) {
  if (!Array.isArray(value['capabilities'])) return failed('MALFORMED', 'Capacidades do link não são uma lista');
  for (const entry of value['capabilities']) {
   const capability = checkPublicCapability(entry);
   if (!capability.ok) return capability;
   capabilities.push(capability.value);
  }
 }
 const sources: LinkSource[] = [];
 if (!Array.isArray(value['sources'])) return failed('MALFORMED', 'O link não lista nenhuma cópia');
 for (const entry of value['sources']) {
  const source = checkSource(entry);
  if (!source.ok) return source;
  sources.push(source.value);
 }
 const bridge = value['bridge'] === undefined ? ok(undefined) : checkBridge(value['bridge']);
 if (!bridge.ok) return bridge;
 const publishedAt = optionalText(value['publishedAt'], 'Instante de publicação', INSTANT);
 if (!publishedAt.ok) return publishedAt;
 const title = optionalText(value['title'], 'Título do link', COPY);
 if (!title.ok) return title;
 const link: WorldLink = {kind:'world-link', version:WORLD_LINK_VERSION, id:id.value, world:world.value, target:resolvedTarget, arrival:arrival.value, capabilities, actor:actor.value, sources};
 if (bridge.value) link.bridge = bridge.value;
 if (publishedAt.value) link.publishedAt = publishedAt.value;
 if (title.value) link.title = title.value;
 return ok(link);
}

const refOf = (value: unknown): ObjectRef | null => isRef(value) ? {hash:value.hash, bytes:value.bytes} : null;
// §6/§5: a tree carries a definition (an address) and a state; a commit carries a generation, a tree and its parents.
function treeAddress(value: JsonValue | null): WorldAddress | null {
 if (!plain(value) || value['kind'] !== 'world-tree') return null;
 const definition = value['definition'];
 if (!plain(definition) || typeof definition['worldId'] !== 'string' || typeof definition['branchId'] !== 'string') return null;
 return {worldId:definition['worldId'], branchId:definition['branchId']};
}
const stateOf = (value: JsonValue | null): JsonValue | null => plain(value) && value['kind'] === 'city-state' && plain(value['state']) ? value['state'] : null;
// The order copies are asked in: what the link itself names, then whatever this client already knows. A mirror answers
// only when the origin did not, and the target says so instead of pretending the origin answered.
function orderCopies(named: readonly LinkSource[], known: readonly LinkSource[]): LinkSource[] {
 const ordered: LinkSource[] = [], seen = new Set<string>();
 for (const source of [...named, ...known]) {
  if (seen.has(source.copy)) continue;
  seen.add(source.copy);
  ordered.push(source);
 }
 return ordered;
}

type VersionAt = {commit: ObjectRef; generation: number; commitValue: JsonValue; treeRef: ObjectRef; stateRef: ObjectRef};

// One copy answering one question: which version is here, and is it really here. A copy that reports a head without
// the commit, or a commit whose tree or state it cannot produce, is not a copy of this world and the next one is
// asked — falling back is what several providers (§31) are for, and it never invents a version.
async function versionAt(copy: LinkSource, link: WorldLink, resolver: ObjectResolver): Promise<WorldResult<VersionAt>> {
 let commit: ObjectRef | null = link.target.kind === 'commit' ? link.target.commit : null;
 let generation: number | null = null;
 if (link.target.kind === 'branch') {
  const head = await resolver.head(copy.copy, link.world);
  if (!head.ok) return head;
  if (!head.value) return failed('NOT_FOUND', `A cópia ${copy.copy} não tem ${link.world.worldId}/${link.world.branchId}`);
  if (head.value.worldId !== link.world.worldId || head.value.branchId !== link.world.branchId) return failed('CONFLICT', `A cópia ${copy.copy} responde por ${head.value.worldId}/${head.value.branchId} em vez de ${link.world.worldId}/${link.world.branchId}`);
  commit = head.value.commit;
  generation = head.value.generation;
 }
 const commitRead = await resolver.object(copy.copy, commit!);
 if (!commitRead.ok) return commitRead;
 // Absence and disagreement are different answers: a copy that does not have the object is asked no more, while a copy
 // that has something else where the object should be is refusing to be a copy of this world.
 if (commitRead.value === null) return failed('NOT_FOUND', `A cópia ${copy.copy} não tem o commit ${commit!.hash.slice(0,12)}…`);
 if (!plain(commitRead.value) || commitRead.value['kind'] !== 'world-commit') return failed('CONFLICT', `A cópia ${copy.copy} tem outro objeto onde o commit ${commit!.hash.slice(0,12)}… deveria estar`);
 const commitValue = commitRead.value;
 const commitGeneration = commitValue['generation'];
 if (!Number.isSafeInteger(commitGeneration) || (commitGeneration as number) < 1) return failed('MALFORMED', `Commit inválido em ${copy.copy}`);
 if (generation !== null && commitGeneration !== generation) return failed('CONFLICT', `A cópia ${copy.copy} responde a geração ${generation} e o commit diz ${String(commitGeneration)}`);
 const treeRef = refOf(commitValue['tree']);
 if (!treeRef) return failed('MALFORMED', `Commit sem árvore em ${copy.copy}`);
 const treeRead = await resolver.object(copy.copy, treeRef);
 if (!treeRead.ok) return treeRead;
 if (treeRead.value === null) return failed('NOT_FOUND', `A cópia ${copy.copy} não tem a árvore ${treeRef.hash.slice(0,12)}…`);
 const address = treeAddress(treeRead.value);
 if (!address) return failed('CONFLICT', `A cópia ${copy.copy} tem outro objeto onde a árvore ${treeRef.hash.slice(0,12)}… deveria estar`);
 if (address.worldId !== link.world.worldId || address.branchId !== link.world.branchId) return failed('CONFLICT', `A árvore da cópia ${copy.copy} pertence a ${address.worldId}/${address.branchId}`);
 const tree = treeRead.value as Record<string, JsonValue>;
 const stateRef = refOf(tree['state']);
 if (!stateRef) return failed('MALFORMED', `Árvore sem estado em ${copy.copy}`);
 const stateRead = await resolver.object(copy.copy, stateRef);
 if (!stateRead.ok) return stateRead;
 if (stateRead.value === null) return failed('NOT_FOUND', `A cópia ${copy.copy} não tem o estado ${stateRef.hash.slice(0,12)}…`);
 if (!stateOf(stateRead.value)) return failed('CONFLICT', `A cópia ${copy.copy} tem outro objeto onde o estado ${stateRef.hash.slice(0,12)}… deveria estar`);
 return ok({commit:commit!, generation:commitGeneration as number, commitValue, treeRef, stateRef});
}

export async function resolveWorldLink(link: WorldLink, resolver: ObjectResolver): Promise<WorldResult<VisitTarget>> {
 const checked = checkWorldLink(link);
 if (!checked.ok) return checked;
 const wanted = checked.value;
 const copies = orderCopies(wanted.sources, resolver.copies());
 if (!copies.length) return failed('NOT_FOUND', `O link ${wanted.id} não indica nenhuma cópia e este cliente não conhece outra`);
 const unavailable: string[] = [];
 let answer: WorldError | null = null;
 for (const copy of copies) {
  const version = await versionAt(copy, wanted, resolver);
  if (!version.ok) {
   unavailable.push(copy.copy);
   answer ??= version.error;
   continue;
  }
  return ok({
   kind:'visit',
   link:wanted.id,
   world:wanted.world,
   commit:version.value.commit,
   generation:version.value.generation,
   moving:wanted.target.kind === 'branch',
   arrival:wanted.arrival,
   role:'visitor',
   // A visit target is not a grant: this field is a literal `false`, and no capability inside the link can change it.
   write:false,
   capabilities:wanted.capabilities,
   servedBy:copy.copy,
   unavailable,
   degraded:copy.copy !== wanted.sources[0]?.copy,
  });
 }
 return failed(answer?.code ?? 'NOT_FOUND', answer?.message ?? `Nenhuma cópia tem ${wanted.world.worldId}/${wanted.world.branchId}`);
}

// --- bridges ---------------------------------------------------------------------------------------------------
export type ForwardingPolicy = {bridge: string; maxHops: number; seen?: readonly string[]};
export type ForwardedLink = {href: string; origin: string; bridge: string; hops: number; duplicate: boolean; link: WorldLink};

// Republishing a link on another transport. The original id is the identity of the thing being forwarded and never
// changes, so the second bridge publishing the same world cannot turn it into a second world; the bridge's own record
// is `href` and a bridge that already published this `href` answers `duplicate` instead of publishing twice. Beyond
// the hop limit the copy is refused — a loop is not detected by guessing who is a loop, it is bounded (§31).
export function forwardWorldLink(link: WorldLink, policy: ForwardingPolicy): WorldResult<ForwardedLink> {
 const checked = checkWorldLink(link);
 if (!checked.ok) return checked;
 const bridge = text(policy.bridge, 'Identificador da ponte');
 if (!bridge.ok) return bridge;
 if (!Number.isSafeInteger(policy.maxHops) || policy.maxHops < 1 || policy.maxHops > 64) return failed('MALFORMED', `Limite de encaminhamento inválido: ${String(policy.maxHops)}`);
 const origin = checked.value.bridge?.origin ?? checked.value.id;
 const hops = (checked.value.bridge?.hops ?? 0) + 1;
 const href = `${bridge.value}#${origin}`;
 if (hops > policy.maxHops) return failed('LIMIT', `O link ${origin} já foi encaminhado ${hops - 1} vez(es) e o limite da ponte é ${policy.maxHops}`);
 const duplicate = checked.value.bridge?.bridge === bridge.value || (policy.seen ?? []).includes(href);
 return ok({href, origin, bridge:bridge.value, hops, duplicate, link:duplicate ? checked.value : {...checked.value, bridge:{bridge:bridge.value, hops, origin}}});
}
