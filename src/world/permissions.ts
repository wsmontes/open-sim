import type {Action, CellCoord, Tool} from '../core/model';
import {COST} from '../core/model';
import {chunkId, validCell} from '../core/coordinates';
import {assertJsonSafe, isComponentKey, isEntityId} from '../core/protocol';
import type {ContentHasher, WorldCodec} from './ports';
import type {Head, JsonValue, ObjectRef, WorldResult} from './model';
import {WIRE_VERSION, WORLD_PROTOCOL, failed, isRef, ok, sameRef} from './model';
import type {Limits} from './wire';
import {narrowerLimits} from './wire';
import {assertClosed,isPlainObject,RESERVED_KEYS} from '../core/guards';
import {countOf,hexOf,instantOf,stringOf as textOf} from './readers';

// Identity, grants and capability negotiation for a shared session (docs/superpowers/specs/2026-09-29-federated-world
// -design.md §7.2, §7.4, §9, §10). Pure: the clock, the codec, the hasher and the verifier are injected, because the
// world contract transports bytes and proofs and never performs cryptography nor reads the environment. The clock is
// only ever consulted to decide whether a grant is valid now; it never orders commits and never resolves a conflict.

// --- identity (spec §7.2) --------------------------------------------------------------------------------------
// A principal is an external identity with a declared scheme; nothing here assumes that an account on one network is
// the same person as an equally named account on another. The root key that identifies the principal signs a
// short-lived session key, and only that session key signs messages, so a leaked session does not leak the identity.
export type Principal = {scheme: string; id: string};
export type Signature = {algorithm: 'Ed25519'; key: string; value: string};
export type IdentityScope = {worldId: string; branchId: string; sessionId: string; notBefore: string; notAfter: string};
export type IdentityProof = {kind: 'identity'; principal: Principal; sessionKey: string; scope: IdentityScope; delegation: Signature};
export type MessageProof = {kind: 'message'; algorithm: 'Ed25519'; sessionKey: string; signature: string};
export type Proof = IdentityProof | MessageProof;
// The verifier is handed the exact bytes it has to check — the canonical body, encoded by the caller's codec — so a
// signature can never be a boolean the sender supplies: the bytes and the key decide, not the message.
export interface SignatureVerifier {
 verify(proof: Proof, bytes: Uint8Array): Promise<boolean>;
}
export type SessionBindingRequest = {principal: Principal; scope: IdentityScope};
export interface IdentityProvider {
 bindSession(request: SessionBindingRequest): Promise<WorldResult<IdentityProof>>;
}
const SCHEME = /^[a-z][a-z0-9-]{0,15}$/, PUBLIC_KEY = /^[0-9a-f]{64}$/, INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, REGION = /^\d+:\d+$/;
const samePrincipal = (left: Principal, right: Principal) => left.scheme === right.scheme && left.id === right.id;

// The canonical bodies are what a signature covers. Proofs stay detached (spec §9.2), so the bytes of a proposal do
// not depend on its own signature and the digest over them is stable.
export const identityBody = (proof: IdentityProof): JsonValue => ({
 kind: 'identity',
 principal: {scheme: proof.principal.scheme, id: proof.principal.id},
 sessionKey: proof.sessionKey,
 scope: {worldId: proof.scope.worldId, branchId: proof.scope.branchId, sessionId: proof.scope.sessionId, notBefore: proof.scope.notBefore, notAfter: proof.scope.notAfter},
});
export const identityBytes = (proof: IdentityProof, codec: WorldCodec): Uint8Array => codec.encode(identityBody(proof));
export const proposalBody = (proposal: Proposal): JsonValue => {
 const {proof: _detached, ...body} = proposal;
 return body as unknown as JsonValue;
};
export const proposalBytes = (proposal: Proposal, codec: WorldCodec): Uint8Array => codec.encode(proposalBody(proposal));
export const grantBody = (grant: Grant): JsonValue => {
 const {proof: _detached, ...body} = grant;
 return body as unknown as JsonValue;
};
export const grantBytes = (grant: Grant, codec: WorldCodec): Uint8Array => codec.encode(grantBody(grant));
// External identities become the id the core orders commands by (spec §7.2): `p_` plus the SHA-256 of the canonical
// identity. It is deterministic, it fits the core's actor pattern, and it never collides with a local name.
export async function actorId(principal: Principal, hasher: ContentHasher, codec: WorldCodec): Promise<string> {
 const digest = await hasher.ref(codec.encode({scheme: principal.scheme, id: principal.id}));
 return `p_${digest.hash}`;
}

// --- capabilities and negotiation (spec §9, §10) ---------------------------------------------------------------
export type ActionCapability = 'admin' | 'host' | 'build' | 'demolish' | 'tick' | 'component' | 'policy';
export const WRITE_ACTIONS: readonly ActionCapability[] = ['build', 'demolish', 'tick', 'component', 'policy'];
export type Role = 'owner' | 'host' | 'collaborator' | 'spectator';
export type NamespaceDecl = {key: string; critical: boolean};
export type Capabilities = {
 kind: 'capabilities';
 worldProtocol: number;
 wireVersion: number;
 rules: {family: string; version: number};
 actions: readonly ActionCapability[];
 namespaces: readonly NamespaceDecl[];
 limits: Limits;
};
export type SessionAgreement = {
 kind: 'agreement';
 worldProtocol: 2;
 wireVersion: 1;
 rules: {family: string; version: number};
 actions: readonly ActionCapability[];
 critical: readonly string[];
 unknownCritical: readonly string[];
 unsupportedCritical: readonly string[];
 write: boolean;
 limits: Limits;
};
// The role a peer holds in the session follows from what was agreed, never from what it claimed: a session with no
// writing has only spectators, and a critical rule this client cannot honour (or the peer cannot) stops writing.
export function roleFor(agreement: SessionAgreement): Role {
 if (!agreement.write) return 'spectator';
 if (agreement.actions.includes('admin')) return 'owner';
 if (agreement.actions.includes('host')) return 'host';
 for (const action of agreement.actions) if (WRITE_ACTIONS.includes(action)) return 'collaborator';
 return 'spectator';
}
export async function negotiate(local: Capabilities, remote: Capabilities): Promise<WorldResult<SessionAgreement>> {
 if (local.worldProtocol !== WORLD_PROTOCOL || remote.worldProtocol !== WORLD_PROTOCOL) return failed('WORLD_PROTOCOL_UNSUPPORTED', `Protocolo de mundo ${local.worldProtocol}/${remote.worldProtocol} não é suportado (esperado ${WORLD_PROTOCOL})`);
 if (local.wireVersion !== WIRE_VERSION || remote.wireVersion !== WIRE_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `Versão de transporte ${local.wireVersion}/${remote.wireVersion} não é suportada (esperada ${WIRE_VERSION})`);
 // Rules decide what a command means, so a different family or version is not a filter: it is another simulation.
 if (local.rules.family !== remote.rules.family) return failed('CONFLICT', `Família de regras diferente: ${local.rules.family} e ${remote.rules.family}`);
 if (local.rules.version !== remote.rules.version) return failed('CONFLICT', `Versão de regras diferente: ${local.rules.version} e ${remote.rules.version}`);
 const ours = new Set(local.namespaces.map(declaration => declaration.key));
 const theirs = new Set(remote.namespaces.map(declaration => declaration.key));
 const critical = local.namespaces.filter(declaration => declaration.critical && theirs.has(declaration.key)).map(declaration => declaration.key);
 const unknownCritical = remote.namespaces.filter(declaration => declaration.critical && !ours.has(declaration.key)).map(declaration => declaration.key);
 const unsupportedCritical = local.namespaces.filter(declaration => declaration.critical && !theirs.has(declaration.key)).map(declaration => declaration.key);
 const actions = local.actions.filter(action => remote.actions.includes(action));
 const write = !unknownCritical.length && !unsupportedCritical.length && actions.some(action => WRITE_ACTIONS.includes(action));
 return ok({
  kind: 'agreement',
  worldProtocol: 2,
  wireVersion: 1,
  rules: {family: local.rules.family, version: local.rules.version},
  actions,
  critical,
  unknownCritical,
  unsupportedCritical,
  write,
  limits: narrowerLimits(local.limits, remote.limits),
 });
}

// --- grants and proposals (spec §7.2, §7.4) --------------------------------------------------------------------
// A grant is the branch owner's answer to "what may this principal do here". It is immutable and carries its own id so
// a revocation can name an ordered point in the branch. Nothing here lets a grant grow: a delegated host may only
// narrow the grant that issued it (checked through the context chain), never extend its actions, region or ceiling.
export type Grant = {
 kind: 'grant';
 id: string;
 principal: Principal;
 worldId: string;
 branchId: string;
 actions: readonly ActionCapability[];
 namespaces: readonly string[];
 entities?: readonly string[];
 regions?: readonly string[];
 spendLimit: number;
 epoch?: number;
 notBefore?: string;
 notAfter?: string;
 delegatedBy?: string;
 proof: MessageProof;
};
export type Preconditions = {revision: number};
export type Proposal = {
 worldProtocol: 2;
 wireVersion: 1;
 kind: 'proposal';
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 id: string;
 principal: Principal;
 sessionKey: string;
 observedHead: ObjectRef;
 intent: Action;
 preconditions: Preconditions;
 costLimit: number;
 proof: MessageProof;
};
export type ProposalMark = {id: string; epoch: number; worldId: string; branchId: string; digest: string};
export type AuthorizationContext = {
 head: Head;
 revision: number;
 epoch: number;
 now: string;
 identity: IdentityProof;
 codec: WorldCodec;
 hasher: ContentHasher;
 verifier: SignatureVerifier;
 marks: readonly ProposalMark[];
 revokedGrants: readonly string[];
 chain: readonly Grant[];
};
export type AuthorizedProposal = {
 proposal: Proposal;
 grant: Grant;
 actorId: string;
 action: ActionCapability;
 approvedCost: number;
 digest: string;
 duplicate: boolean;
};

// The cost a grant has to cover, computed the way the core computes it: repeated cells are one cell.
function cellCount(cells: readonly CellCoord[]): number {
 const distinct = new Set<string>();
 for (const cell of cells) distinct.add(`${cell.x}:${cell.y}`);
 return distinct.size;
}
function costOf(intent: Action): number {
 if (intent.type === 'build') return cellCount(intent.cells) * COST[intent.tool];
 if (intent.type === 'demolish') return cellCount(intent.cells) * COST.demolish;
 return 0;
}
function scopeError(grant: Grant, intent: Action): string | null {
 if (intent.type === 'build' || intent.type === 'demolish') {
  if (!grant.regions) return null;
  for (const cell of intent.cells) {
   const region = chunkId(cell);
   if (!grant.regions.includes(region)) return `Ação fora da região concedida (${region})`;
  }
  return null;
 }
 if (intent.type === 'component') {
  if (!grant.namespaces.includes(intent.key)) return `Namespace fora da concessão: ${intent.key}`;
  if (grant.entities && !grant.entities.includes(intent.entity)) return `Entidade fora da concessão: ${intent.entity}`;
 }
 return null;
}
// The inner grant has to fit inside the outer one in every dimension the outer one bounds.
function widening(outer: Grant, inner: Grant): string | null {
 for (const action of inner.actions) if (!outer.actions.includes(action)) return `Concessão delegada amplia a ação ${action}`;
 for (const key of inner.namespaces) if (!outer.namespaces.includes(key)) return `Concessão delegada amplia o namespace ${key}`;
 if (outer.entities) {
  if (!inner.entities) return 'Concessão delegada amplia as entidades';
  for (const entity of inner.entities) if (!outer.entities.includes(entity)) return `Concessão delegada amplia a entidade ${entity}`;
 }
 if (outer.regions) {
  if (!inner.regions) return 'Concessão delegada amplia a região';
  for (const region of inner.regions) if (!outer.regions.includes(region)) return `Concessão delegada amplia a região ${region}`;
 }
 if (inner.spendLimit > outer.spendLimit) return 'Concessão delegada amplia o limite de gasto';
 if (outer.epoch !== undefined && inner.epoch !== outer.epoch) return 'Concessão delegada muda a época';
 if (outer.notBefore !== undefined && (inner.notBefore === undefined || inner.notBefore < outer.notBefore)) return 'Concessão delegada amplia a validade';
 if (outer.notAfter !== undefined && (inner.notAfter === undefined || inner.notAfter > outer.notAfter)) return 'Concessão delegada amplia a validade';
 return null;
}
function chainError(chain: readonly Grant[], grant: Grant): string | null {
 let outer: Grant | null = null;
 for (const entry of chain) {
  if (outer) {
   if (entry.delegatedBy !== outer.id) return 'Corrente de concessões quebrada';
   const problem = widening(outer, entry);
   if (problem) return problem;
  }
  outer = entry;
 }
 if (!outer) return grant.delegatedBy === undefined ? null : 'Concessão delegada sem a concessão que a emitiu';
 if (grant.delegatedBy !== outer.id) return 'Corrente de concessões quebrada';
 return widening(outer, grant);
}

// Whether an incoming grant may be trusted: its own signature is checked against the identity that presented it, not
// against a claim inside the document.
export type IssuerContext = {codec: WorldCodec; verifier: SignatureVerifier};
export async function verifyGrant(grant: Grant, issuer: IdentityProof, context: IssuerContext): Promise<WorldResult<Grant>> {
 if (grant.proof.sessionKey !== issuer.sessionKey) return failed('SIGNATURE', 'A concessão não foi assinada pela chave de sessão apresentada');
 if (!await context.verifier.verify(issuer, identityBytes(issuer, context.codec))) return failed('SIGNATURE', 'Vínculo de identidade do emissor não verificado');
 if (!await context.verifier.verify(grant.proof, grantBytes(grant, context.codec))) return failed('SIGNATURE', 'Assinatura da concessão não verificada');
 return ok(grant);
}

export async function authorize(grant: Grant, proposal: Proposal, context: AuthorizationContext): Promise<WorldResult<AuthorizedProposal>> {
 if (proposal.worldProtocol !== WORLD_PROTOCOL || proposal.wireVersion !== WIRE_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `Proposta da versão ${proposal.worldProtocol}/${proposal.wireVersion} não é suportada`);
 if (!INSTANT.test(context.now)) return failed('MALFORMED', 'Relógio da sessão inválido');
 if (proposal.worldId !== context.head.worldId || proposal.branchId !== context.head.branchId) return failed('CONFLICT', 'Proposta para outro mundo ou ramificação');
 if (grant.worldId !== proposal.worldId || grant.branchId !== proposal.branchId) return failed('PERMISSION', 'Concessão para outro mundo ou ramificação');
 // A proposal from a previous host epoch is fenced: only the current epoch may write (spec §7.5).
 if (proposal.epoch !== context.epoch) return failed('PERMISSION', `Proposta da época ${proposal.epoch}; a sessão está na época ${context.epoch}`);
 if (grant.epoch !== undefined && grant.epoch !== context.epoch) return failed('PERMISSION', `Concessão da época ${grant.epoch} não vale na época ${context.epoch}`);
 if (!samePrincipal(grant.principal, proposal.principal)) return failed('PERMISSION', 'Concessão para outro principal');
 const identity = context.identity;
 if (!samePrincipal(identity.principal, proposal.principal)) return failed('SIGNATURE', 'A prova de identidade é de outro principal');
 if (identity.sessionKey !== proposal.sessionKey || identity.sessionKey !== proposal.proof.sessionKey) return failed('SIGNATURE', 'Assinatura por chave de sessão diferente da vinculada');
 // A local identity is its root key, so a proof that delegates the local principal to another root is a forgery even
 // when the delegation signature itself verifies.
 if (identity.principal.scheme === 'local' && identity.delegation.key !== identity.principal.id) return failed('SIGNATURE', 'Chave raiz não corresponde ao principal local');
 if (identity.scope.worldId !== proposal.worldId || identity.scope.branchId !== proposal.branchId || identity.scope.sessionId !== proposal.sessionId) return failed('SIGNATURE', 'Vínculo de identidade para outra sessão');
 // Validity is a half-open window in UTC: it ends exactly at `notAfter`, so two clients comparing the same instants
 // as text agree on the boundary.
 if (context.now < identity.scope.notBefore || context.now >= identity.scope.notAfter) return failed('SIGNATURE', 'Vínculo de identidade fora da validade');
 if (!await context.verifier.verify(identity, identityBytes(identity, context.codec))) return failed('SIGNATURE', 'Vínculo de identidade não verificado');
 // The bytes are the proposal without its proof; the signature has to cover exactly that.
 const bytes = proposalBytes(proposal, context.codec);
 if (!await context.verifier.verify(proposal.proof, bytes)) return failed('SIGNATURE', 'Assinatura da proposta não verificada');
 // Grant state, all of it decided by the context: revocation is an ordered point in the branch, and validity is
 // checked against the injected clock.
 if (context.revokedGrants.includes(grant.id)) return failed('PERMISSION', 'Concessão revogada');
 if (grant.notBefore !== undefined && context.now < grant.notBefore) return failed('PERMISSION', 'Concessão ainda não válida');
 if (grant.notAfter !== undefined && context.now >= grant.notAfter) return failed('PERMISSION', 'Concessão expirada');
 const growth = chainError(context.chain, grant);
 if (growth) return failed('PERMISSION', growth);
 // The action itself: capability, then the region, namespace and entity bounds.
 const action: ActionCapability = proposal.intent.type;
 if (!grant.actions.includes(action)) return failed('PERMISSION', `Concessão sem a ação ${action}`);
 const outside = scopeError(grant, proposal.intent);
 if (outside) return failed('PERMISSION', outside);
 const approvedCost = costOf(proposal.intent);
 if (approvedCost > proposal.costLimit) return failed('PERMISSION', `Custo ${approvedCost} acima do limite ${proposal.costLimit} da proposta`);
 if (proposal.costLimit > grant.spendLimit) return failed('PERMISSION', `Limite de gasto ${proposal.costLimit} acima da concessão ${grant.spendLimit}`);
 // A proposal is only valid against the head and revision it was written for.
 if (!sameRef(proposal.observedHead, context.head.commit)) return failed('CONFLICT', 'A ramificação mudou desde a proposta');
 if (proposal.preconditions.revision !== context.revision) return failed('CONFLICT', 'A partida mudou desde a proposta');
 // Replay: the same id and the same digest in this branch and epoch was already accepted, so the caller answers with
 // the receipt it stored. The same id anywhere else, or with different content, is a different attempt pretending to
 // be a repeat.
 const digest = await context.hasher.ref(bytes);
 const mark = context.marks.find(entry => entry.id === proposal.id);
 if (mark) {
  if (mark.epoch !== proposal.epoch || mark.worldId !== proposal.worldId || mark.branchId !== proposal.branchId) return failed('CONFLICT', 'Proposta repetida noutra ramificação ou época');
  if (mark.digest !== digest.hash) return failed('CONFLICT', 'Mesmo identificador de proposta com conteúdo diferente');
 }
 return ok({proposal, grant, actorId: await actorId(proposal.principal, context.hasher, context.codec), action, approvedCost, digest: digest.hash, duplicate: mark !== undefined});
}

// --- control bodies, read strictly (spec §10) ------------------------------------------------------------------
// These schemas are closed: an unknown field means a newer contract, and an older client has to refuse the document
// instead of ignoring the field it does not understand. Capabilities are the one document whose version is read
// rather than enforced, because announcing a version this client does not support is exactly what negotiation is for.
export type ControlBody =
 | {kind: 'identity'; identity: IdentityProof}
 | {kind: 'grant'; grant: Grant}
 | {kind: 'proposal'; proposal: Proposal}
 | {kind: 'capabilities'; capabilities: Capabilities}
 | {kind: 'agreement'; agreement: SessionAgreement};

export function controlFrom(value: JsonValue): WorldResult<ControlBody> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Controle não é um objeto');
 try {
  const kind = value['kind'];
  if (kind === 'identity') {
   const identity = identityFrom(value);
   if (!identity.ok) return identity;
   return ok({kind: 'identity', identity: identity.value});
  }
  if (kind === 'grant') {
   const grant = grantFrom(value);
   if (!grant.ok) return grant;
   return ok({kind: 'grant', grant: grant.value});
  }
  if (kind === 'proposal') {
   const proposal = proposalFrom(value);
   if (!proposal.ok) return proposal;
   return ok({kind: 'proposal', proposal: proposal.value});
  }
  if (kind === 'capabilities') {
   const capabilities = capabilitiesFrom(value);
   if (!capabilities.ok) return capabilities;
   return ok({kind: 'capabilities', capabilities: capabilities.value});
  }
  if (kind === 'agreement') {
   const agreement = agreementFrom(value);
   if (!agreement.ok) return agreement;
   return ok({kind: 'agreement', agreement: agreement.value});
  }
  return failed('MALFORMED', `Controle de tipo desconhecido: ${String(kind)}`);
 } catch (error) {
  return failed('MALFORMED', error instanceof Error ? error.message : 'Controle inválido');
 }
}

const stringOf = (value: unknown, label: string, max = 200): WorldResult<string> =>
 RESERVED_KEYS.includes(value as string) ? failed('MALFORMED', `${label} inválido`) : textOf(value, label, max);
// Versions this client speaks: a document of another wire version is refused, an announcement is read.
function versioned(value: Record<string, unknown>, label: string): WorldResult<null> {
 if (value['worldProtocol'] !== WORLD_PROTOCOL) return failed('WORLD_PROTOCOL_UNSUPPORTED', `${label} do protocolo ${String(value['worldProtocol'])} não é suportado (esperado ${WORLD_PROTOCOL})`);
 if (value['wireVersion'] !== WIRE_VERSION) return failed('WIRE_VERSION_UNSUPPORTED', `${label} da versão ${String(value['wireVersion'])} não é suportada (esperada ${WIRE_VERSION})`);
 return ok(null);
}
function principalFrom(value: unknown): WorldResult<Principal> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Principal inválido');
 assertClosed(value, ['scheme', 'id'], 'Principal');
 const scheme = value['scheme'], id = value['id'];
 if (typeof scheme !== 'string' || !SCHEME.test(scheme)) return failed('MALFORMED', `Esquema de identidade inválido: ${String(scheme)}`);
 const identifier = stringOf(id, 'Identificador do principal');
 if (!identifier.ok) return identifier;
 if (scheme === 'local' && !PUBLIC_KEY.test(identifier.value)) return failed('MALFORMED', 'Principal local sem chave pública');
 return ok({scheme, id: identifier.value});
}
function scopeFrom(value: unknown): WorldResult<IdentityScope> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Vínculo sem escopo');
 assertClosed(value, ['worldId', 'branchId', 'sessionId', 'notBefore', 'notAfter'], 'Escopo');
 const worldId = stringOf(value['worldId'], 'Mundo', 80);
 if (!worldId.ok) return worldId;
 const branchId = stringOf(value['branchId'], 'Ramificação', 80);
 if (!branchId.ok) return branchId;
 const sessionId = stringOf(value['sessionId'], 'Sessão', 80);
 if (!sessionId.ok) return sessionId;
 const notBefore = instantOf(value['notBefore'], 'Início da validade');
 if (!notBefore.ok) return notBefore;
 const notAfter = instantOf(value['notAfter'], 'Fim da validade');
 if (!notAfter.ok) return notAfter;
 if (!(notBefore.value < notAfter.value)) return failed('MALFORMED', 'Janela de validade invertida');
 return ok({worldId: worldId.value, branchId: branchId.value, sessionId: sessionId.value, notBefore: notBefore.value, notAfter: notAfter.value});
}
function signatureFrom(value: unknown, label: string): WorldResult<Signature> {
 if (!isPlainObject(value)) return failed('MALFORMED', `${label} inválida`);
 assertClosed(value, ['algorithm', 'key', 'value'], label);
 if (value['algorithm'] !== 'Ed25519') return failed('MALFORMED', `${label} com algoritmo desconhecido: ${String(value['algorithm'])}`);
 const key = hexOf(value['key'], `Chave de ${label}`, 64);
 if (!key.ok) return key;
 const signature = hexOf(value['value'], `Assinatura de ${label}`, 128);
 if (!signature.ok) return signature;
 return ok({algorithm: 'Ed25519', key: key.value, value: signature.value});
}
function messageProofFrom(value: unknown, label: string): WorldResult<MessageProof> {
 if (!isPlainObject(value)) return failed('MALFORMED', `${label} sem assinatura`);
 assertClosed(value, ['kind', 'algorithm', 'sessionKey', 'signature'], label);
 if (value['kind'] !== 'message') return failed('MALFORMED', `${label} com prova de tipo desconhecido: ${String(value['kind'])}`);
 if (value['algorithm'] !== 'Ed25519') return failed('MALFORMED', `${label} com algoritmo desconhecido: ${String(value['algorithm'])}`);
 const sessionKey = hexOf(value['sessionKey'], 'Chave de sessão', 64);
 if (!sessionKey.ok) return sessionKey;
 const signature = hexOf(value['signature'], 'Assinatura da mensagem', 128);
 if (!signature.ok) return signature;
 return ok({kind: 'message', algorithm: 'Ed25519', sessionKey: sessionKey.value, signature: signature.value});
}
function identityFrom(value: unknown): WorldResult<IdentityProof> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Prova de identidade inválida');
 assertClosed(value, ['kind', 'principal', 'sessionKey', 'scope', 'delegation'], 'Prova de identidade');
 if (value['kind'] !== 'identity') return failed('MALFORMED', `Prova de tipo desconhecido: ${String(value['kind'])}`);
 const principal = principalFrom(value['principal']);
 if (!principal.ok) return principal;
 const sessionKey = hexOf(value['sessionKey'], 'Chave de sessão', 64);
 if (!sessionKey.ok) return sessionKey;
 const scope = scopeFrom(value['scope']);
 if (!scope.ok) return scope;
 const delegation = signatureFrom(value['delegation'], 'Delegação');
 if (!delegation.ok) return delegation;
 return ok({kind: 'identity', principal: principal.value, sessionKey: sessionKey.value, scope: scope.value, delegation: delegation.value});
}
const CAPABILITY: Record<string, ActionCapability> = {admin: 'admin', host: 'host', build: 'build', demolish: 'demolish', tick: 'tick', component: 'component', policy: 'policy'};
function actionsFrom(value: unknown, label: string): WorldResult<ActionCapability[]> {
 if (!Array.isArray(value)) return failed('MALFORMED', `${label} inválidas`);
 const actions: ActionCapability[] = [];
 for (const entry of value) {
  const action = typeof entry === 'string' ? CAPABILITY[entry] : undefined;
  if (!action) return failed('MALFORMED', `Capacidade desconhecida: ${String(entry)}`);
  if (actions.includes(action)) return failed('MALFORMED', `Capacidade repetida: ${action}`);
  actions.push(action);
 }
 return ok(actions);
}
function namespacesFrom(value: unknown): WorldResult<NamespaceDecl[]> {
 if (!Array.isArray(value)) return failed('MALFORMED', 'Namespaces inválidos');
 const namespaces: NamespaceDecl[] = [];
 for (const entry of value) {
  if (!isPlainObject(entry)) return failed('MALFORMED', 'Declaração de namespace inválida');
  assertClosed(entry, ['key', 'critical'], 'Declaração de namespace');
  const key = stringOf(entry['key'], 'Namespace', 80);
  if (!key.ok) return key;
  if (!isComponentKey(key.value)) return failed('MALFORMED', `Namespace inválido: ${key.value}`);
  if (typeof entry['critical'] !== 'boolean') return failed('MALFORMED', `Namespace ${key.value} sem criticidade declarada`);
  if (namespaces.some(declaration => declaration.key === key.value)) return failed('MALFORMED', `Namespace repetido: ${key.value}`);
  namespaces.push({key: key.value, critical: entry['critical']});
 }
 return ok(namespaces);
}
function namespaceListFrom(value: unknown, label: string): WorldResult<string[]> {
 if (!Array.isArray(value)) return failed('MALFORMED', `${label} inválidos`);
 const keys: string[] = [];
 for (const entry of value) {
  const key = stringOf(entry, 'Namespace', 80);
  if (!key.ok) return key;
  if (!isComponentKey(key.value)) return failed('MALFORMED', `Namespace inválido: ${key.value}`);
  if (keys.includes(key.value)) return failed('MALFORMED', `Namespace repetido: ${key.value}`);
  keys.push(key.value);
 }
 return ok(keys);
}
function rulesFrom(value: unknown): WorldResult<Capabilities['rules']> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Regras ausentes');
 assertClosed(value, ['family', 'version'], 'Regras');
 const family = stringOf(value['family'], 'Família de regras', 40);
 if (!family.ok) return family;
 const version = countOf(value['version'], 'Versão das regras', 1);
 if (!version.ok) return version;
 return ok({family: family.value, version: version.value});
}
function limitsFrom(value: unknown): WorldResult<Limits> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Limites ausentes');
 const fields = ['participants', 'maxControlBytes', 'maxDurableBytes', 'maxSegmentBytes', 'maxObjectBytes', 'maxInflightObjectBytes', 'maxProposalQueue', 'proposalsPerSecond', 'presencePerSecond'] as const;
 assertClosed(value, fields, 'Limites');
 const read: Record<string, number> = {};
 for (const field of fields) {
  const amount = countOf(value[field], field, 1);
  if (!amount.ok) return amount;
  read[field] = amount.value;
 }
 return ok({participants: read['participants']!, maxControlBytes: read['maxControlBytes']!, maxDurableBytes: read['maxDurableBytes']!, maxSegmentBytes: read['maxSegmentBytes']!, maxObjectBytes: read['maxObjectBytes']!, maxInflightObjectBytes: read['maxInflightObjectBytes']!, maxProposalQueue: read['maxProposalQueue']!, proposalsPerSecond: read['proposalsPerSecond']!, presencePerSecond: read['presencePerSecond']!});
}
function capabilitiesFrom(value: unknown): WorldResult<Capabilities> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Capacidades inválidas');
 assertClosed(value, ['kind', 'worldProtocol', 'wireVersion', 'rules', 'actions', 'namespaces', 'limits'], 'Capacidades');
 if (value['kind'] !== 'capabilities') return failed('MALFORMED', `Documento de tipo desconhecido: ${String(value['kind'])}`);
 const worldProtocol = countOf(value['worldProtocol'], 'Protocolo de mundo', 1);
 if (!worldProtocol.ok) return worldProtocol;
 const wireVersion = countOf(value['wireVersion'], 'Versão de transporte', 1);
 if (!wireVersion.ok) return wireVersion;
 const rules = rulesFrom(value['rules']);
 if (!rules.ok) return rules;
 const actions = actionsFrom(value['actions'], 'Capacidades');
 if (!actions.ok) return actions;
 const namespaces = namespacesFrom(value['namespaces']);
 if (!namespaces.ok) return namespaces;
 const limits = limitsFrom(value['limits']);
 if (!limits.ok) return limits;
 return ok({kind: 'capabilities', worldProtocol: worldProtocol.value, wireVersion: wireVersion.value, rules: rules.value, actions: actions.value, namespaces: namespaces.value, limits: limits.value});
}
function agreementFrom(value: unknown): WorldResult<SessionAgreement> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Acordo inválido');
 assertClosed(value, ['kind', 'worldProtocol', 'wireVersion', 'rules', 'actions', 'critical', 'unknownCritical', 'unsupportedCritical', 'write', 'limits'], 'Acordo');
 if (value['kind'] !== 'agreement') return failed('MALFORMED', `Documento de tipo desconhecido: ${String(value['kind'])}`);
 const version = versioned(value, 'Acordo');
 if (!version.ok) return version;
 const rules = rulesFrom(value['rules']);
 if (!rules.ok) return rules;
 const actions = actionsFrom(value['actions'], 'Capacidades acordadas');
 if (!actions.ok) return actions;
 const critical = namespaceListFrom(value['critical'], 'Namespaces críticos');
 if (!critical.ok) return critical;
 const unknownCritical = namespaceListFrom(value['unknownCritical'], 'Namespaces críticos desconhecidos');
 if (!unknownCritical.ok) return unknownCritical;
 const unsupportedCritical = namespaceListFrom(value['unsupportedCritical'], 'Namespaces críticos não suportados pelo par');
 if (!unsupportedCritical.ok) return unsupportedCritical;
 if (typeof value['write'] !== 'boolean') return failed('MALFORMED', 'Acordo sem estado de escrita');
 const limits = limitsFrom(value['limits']);
 if (!limits.ok) return limits;
 return ok({kind: 'agreement', worldProtocol: 2, wireVersion: 1, rules: rules.value, actions: actions.value, critical: critical.value, unknownCritical: unknownCritical.value, unsupportedCritical: unsupportedCritical.value, write: value['write'], limits: limits.value});
}
const TOOL_KIND: Record<string, Tool> = {road:'road',avenue:'avenue',highway:'highway',residential:'residential',commercial:'commercial',industrial:'industrial',park:'park',power:'power'};
function cellsFrom(value: unknown): WorldResult<CellCoord[]> {
 if (!Array.isArray(value) || !value.length || value.length > 1024) return failed('MALFORMED', 'Seleção inválida');
 const cells: CellCoord[] = [];
 for (const entry of value) {
  if (!isPlainObject(entry)) return failed('MALFORMED', 'Coordenada inválida');
  assertClosed(entry, ['x', 'y'], 'Coordenada');
  const x = entry['x'], y = entry['y'];
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)) return failed('MALFORMED', 'Coordenada inválida');
  const cell = {x, y};
  if (!validCell(cell)) return failed('MALFORMED', 'Coordenada fora do mundo');
  cells.push(cell);
 }
 return ok(cells);
}
export function intentFrom(value: unknown): WorldResult<Action> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Intenção inválida');
 const type = value['type'];
 if (type === 'tick') {
  assertClosed(value, ['type'], 'Intenção');
  return ok({type: 'tick'});
 }
 if (type === 'build' || type === 'demolish') {
  assertClosed(value, type === 'build' ? ['type', 'tool', 'cells'] : ['type', 'cells'], 'Intenção');
  const cells = cellsFrom(value['cells']);
  if (!cells.ok) return cells;
  if (type === 'demolish') return ok({type: 'demolish', cells: cells.value});
  const name = value['tool'];
  if (typeof name !== 'string') return failed('MALFORMED', 'Ferramenta inválida');
  const tool = TOOL_KIND[name];
  if (!tool) return failed('MALFORMED', `Ferramenta desconhecida: ${name}`);
  return ok({type: 'build', tool, cells: cells.value});
 }
 if (type === 'policy') {
  assertClosed(value, ['type', 'tax', 'services', 'borrow'], 'Intenção');
  const tax=value['tax'],services=value['services'],borrow=value['borrow'];
  if(tax===undefined&&services===undefined&&borrow===undefined)return failed('MALFORMED','Política sem alteração');
  for(const [name,entry] of [['tax',tax],['services',services],['borrow',borrow]] as const){
   if(entry!==undefined&&(typeof entry!=='number'||!Number.isFinite(entry)))return failed('MALFORMED',`Valor inválido em política: ${name}`);
  }
  return ok({type:'policy',...(tax!==undefined?{tax:tax as number}:{}),...(services!==undefined?{services:services as number}:{}),...(borrow!==undefined?{borrow:borrow as number}:{})});
 }
 if (type === 'component') {
  assertClosed(value, ['type', 'key', 'entity', 'value'], 'Intenção');
  const key = stringOf(value['key'], 'Namespace do componente', 80);
  if (!key.ok) return key;
  if (!isComponentKey(key.value)) return failed('MALFORMED', `Namespace inválido: ${key.value}`);
  const entity = stringOf(value['entity'], 'Entidade do componente', 80);
  if (!entity.ok) return entity;
  if (!isEntityId(entity.value)) return failed('MALFORMED', `Entidade inválida: ${entity.value}`);
  try {
   assertJsonSafe(value['value'], 'Valor do componente');
  } catch (error) {
   return failed('MALFORMED', error instanceof Error ? error.message : 'Valor do componente inválido');
  }
  return ok({type: 'component', key: key.value, entity: entity.value, value: value['value']});
 }
 return failed('MALFORMED', `Ação desconhecida: ${String(type)}`);
}
function regionListFrom(value: unknown, label: string): WorldResult<string[]> {
 if (!Array.isArray(value)) return failed('MALFORMED', `${label} inválidas`);
 const regions: string[] = [];
 for (const entry of value) {
  const region = stringOf(entry, 'Região', 40);
  if (!region.ok) return region;
  if (!REGION.test(region.value)) return failed('MALFORMED', `Região inválida: ${region.value}`);
  if (regions.includes(region.value)) return failed('MALFORMED', `Região repetida: ${region.value}`);
  regions.push(region.value);
 }
 return ok(regions);
}
function entityListFrom(value: unknown): WorldResult<string[]> {
 if (!Array.isArray(value)) return failed('MALFORMED', 'Entidades inválidas');
 const entities: string[] = [];
 for (const entry of value) {
  const entity = stringOf(entry, 'Entidade', 80);
  if (!entity.ok) return entity;
  if (!isEntityId(entity.value)) return failed('MALFORMED', `Entidade inválida: ${entity.value}`);
  if (entities.includes(entity.value)) return failed('MALFORMED', `Entidade repetida: ${entity.value}`);
  entities.push(entity.value);
 }
 return ok(entities);
}
function grantFrom(value: unknown): WorldResult<Grant> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Concessão inválida');
 assertClosed(value, ['kind', 'id', 'principal', 'worldId', 'branchId', 'actions', 'namespaces', 'entities', 'regions', 'spendLimit', 'epoch', 'notBefore', 'notAfter', 'delegatedBy', 'proof'], 'Concessão');
 if (value['kind'] !== 'grant') return failed('MALFORMED', `Documento de tipo desconhecido: ${String(value['kind'])}`);
 const id = stringOf(value['id'], 'Identificador da concessão', 80);
 if (!id.ok) return id;
 const principal = principalFrom(value['principal']);
 if (!principal.ok) return principal;
 const worldId = stringOf(value['worldId'], 'Mundo', 80);
 if (!worldId.ok) return worldId;
 const branchId = stringOf(value['branchId'], 'Ramificação', 80);
 if (!branchId.ok) return branchId;
 const actions = actionsFrom(value['actions'], 'Ações concedidas');
 if (!actions.ok) return actions;
 const namespaces = namespaceListFrom(value['namespaces'], 'Namespaces concedidos');
 if (!namespaces.ok) return namespaces;
 const spendLimit = countOf(value['spendLimit'], 'Limite de gasto');
 if (!spendLimit.ok) return spendLimit;
 const proof = messageProofFrom(value['proof'], 'Concessão');
 if (!proof.ok) return proof;
 const grant: Grant = {kind: 'grant', id: id.value, principal: principal.value, worldId: worldId.value, branchId: branchId.value, actions: actions.value, namespaces: namespaces.value, spendLimit: spendLimit.value, proof: proof.value};
 if (value['entities'] !== undefined) {
  const entities = entityListFrom(value['entities']);
  if (!entities.ok) return entities;
  grant.entities = entities.value;
 }
 if (value['regions'] !== undefined) {
  const regions = regionListFrom(value['regions'], 'Regiões');
  if (!regions.ok) return regions;
  grant.regions = regions.value;
 }
 if (value['epoch'] !== undefined) {
  const epoch = countOf(value['epoch'], 'Época');
  if (!epoch.ok) return epoch;
  grant.epoch = epoch.value;
 }
 if (value['notBefore'] !== undefined) {
  const notBefore = instantOf(value['notBefore'], 'Início da validade');
  if (!notBefore.ok) return notBefore;
  grant.notBefore = notBefore.value;
 }
 if (value['notAfter'] !== undefined) {
  const notAfter = instantOf(value['notAfter'], 'Fim da validade');
  if (!notAfter.ok) return notAfter;
  grant.notAfter = notAfter.value;
 }
 if (grant.notBefore !== undefined && grant.notAfter !== undefined && !(grant.notBefore < grant.notAfter)) return failed('MALFORMED', 'Janela de validade invertida');
 if (value['delegatedBy'] !== undefined) {
  const delegatedBy = stringOf(value['delegatedBy'], 'Concessão de origem', 80);
  if (!delegatedBy.ok) return delegatedBy;
  grant.delegatedBy = delegatedBy.value;
 }
 return ok(grant);
}
function headRefFrom(value: unknown): WorldResult<ObjectRef> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Cabeça observada inválida');
 assertClosed(value, ['hash', 'bytes'], 'Cabeça observada');
 if (!isRef(value)) return failed('MALFORMED', 'Cabeça observada inválida');
 return ok({hash: value['hash'], bytes: value['bytes']});
}
function proposalFrom(value: unknown): WorldResult<Proposal> {
 if (!isPlainObject(value)) return failed('MALFORMED', 'Proposta inválida');
 assertClosed(value, ['worldProtocol', 'wireVersion', 'kind', 'worldId', 'branchId', 'sessionId', 'epoch', 'id', 'principal', 'sessionKey', 'observedHead', 'intent', 'preconditions', 'costLimit', 'proof'], 'Proposta');
 if (value['kind'] !== 'proposal') return failed('MALFORMED', `Documento de tipo desconhecido: ${String(value['kind'])}`);
 const version = versioned(value, 'Proposta');
 if (!version.ok) return version;
 const worldId = stringOf(value['worldId'], 'Mundo', 80);
 if (!worldId.ok) return worldId;
 const branchId = stringOf(value['branchId'], 'Ramificação', 80);
 if (!branchId.ok) return branchId;
 const sessionId = stringOf(value['sessionId'], 'Sessão', 80);
 if (!sessionId.ok) return sessionId;
 const epoch = countOf(value['epoch'], 'Época');
 if (!epoch.ok) return epoch;
 const id = stringOf(value['id'], 'Identificador da proposta', 80);
 if (!id.ok) return id;
 const principal = principalFrom(value['principal']);
 if (!principal.ok) return principal;
 const sessionKey = hexOf(value['sessionKey'], 'Chave de sessão', 64);
 if (!sessionKey.ok) return sessionKey;
 const observedHead = headRefFrom(value['observedHead']);
 if (!observedHead.ok) return observedHead;
 const intent = intentFrom(value['intent']);
 if (!intent.ok) return intent;
 const preconditions = value['preconditions'];
 if (!isPlainObject(preconditions)) return failed('MALFORMED', 'Pré-condições ausentes');
 assertClosed(preconditions, ['revision'], 'Pré-condições');
 const revision = countOf(preconditions['revision'], 'Revisão esperada');
 if (!revision.ok) return revision;
 const costLimit = countOf(value['costLimit'], 'Limite de custo');
 if (!costLimit.ok) return costLimit;
 const proof = messageProofFrom(value['proof'], 'Proposta');
 if (!proof.ok) return proof;
 return ok({worldProtocol: 2, wireVersion: 1, kind: 'proposal', worldId: worldId.value, branchId: branchId.value, sessionId: sessionId.value, epoch: epoch.value, id: id.value, principal: principal.value, sessionKey: sessionKey.value, observedHead: observedHead.value, intent: intent.value, preconditions: {revision: revision.value}, costLimit: costLimit.value, proof: proof.value});
}
