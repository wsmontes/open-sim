import {verifyEvent} from 'nostr-tools/pure';
import {bytesHasher,sha256Hex} from '../hash/content';
import {signEd25519} from '../crypto/session-keys';
import {envelopeOf} from '../../world/osim';
import {DEFAULT_LIMITS,parseStrictJson} from '../../world/codec';
import type {OsimEnvelope} from '../../world/osim';
import {identityBytes} from '../../world/permissions';
import type {ActionCapability,IdentityProof,IdentityScope,MessageProof,Principal,SignatureVerifier} from '../../world/permissions';
import {failed,isRef,ok} from '../../world/model';
import type {ContentHasher,WorldCodec} from '../../world/ports';
import type {Head,JsonValue,WorldResult} from '../../world/model';
import {contentText,epochSeconds,npubOfPrincipal,verifyBinding} from './identity';
import type {NostrBinding,NostrEvent,NostrEventTemplate,NostrIdentity} from './identity';

// Invitations (task 10 of docs/superpowers/plans/2026-09-29-federated-world.md; docs/OpenSim-Protocol-0.1.txt §27, §28
// and the task 10 delta in docs/kernel.md). An invitation is a signed `capability` document: it says who may ask to
// join, which world, branch and head the session starts from, which actions it proposes, until when it is valid and
// where the peers signal. The one thing it never is, is authority: opening one produces a `join-request`, and a join
// request is an ask. Writing still needs a `Grant` evaluated by `authorize` of task 6, so holding the link, the
// descriptor and a verified signature together still grants nothing.
//
// The public half and the private half are separated on purpose. `announce` produces the envelope a client may publish
// where anyone can read it: issuer, subject, entity, proposed actions, validity and the *digest* of the invitation.
// The descriptor — head, epoch, endpoints — travels privately, so the announcement commits to it without disclosing
// it, and no announcement ever contains a key or a world snapshot.
const CAPABILITY: Record<string, ActionCapability> = {admin: 'admin', host: 'host', build: 'build', demolish: 'demolish', tick: 'tick', component: 'component'};
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, HEX = /^[0-9a-f]{64}$/, SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TRANSPORTS = ['nostr', 'webrtc', 'manual'] as const;
const INVITE_PREFIX = 'osim:capability:invite-', SESSION_PREFIX = 'osim:session:';
// One stateless SHA-256 port instance for the ids this module derives; a caller verifying a request injects the same
// port, so an id and its verification can never disagree about which bytes are addressed.
const hasher = bytesHasher();

function plain(value: unknown): value is Record<string, unknown> {
 return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function stringOf(value: unknown, label: string): WorldResult<string> {
 if (typeof value !== 'string' || !value.length || value.length > 200) return failed('MALFORMED', `${label} inválido`);
 return ok(value);
}
function uriOf(value: unknown, label: string): WorldResult<string> {
 const text = stringOf(value, label);
 if (!text.ok) return text;
 return SCHEME.test(value as string) ? text : failed('MALFORMED', `${label} sem esquema: ${text.value}`);
}
function instantOf(value: unknown, label: string): WorldResult<string> {
 if (typeof value !== 'string' || !INSTANT.test(value)) return failed('MALFORMED', `${label} fora do formato de instante`);
 return ok(value);
}
function actionsOf(value: unknown): WorldResult<ActionCapability[]> {
 if (!Array.isArray(value) || !value.length) return failed('MALFORMED', 'Convite sem ações propostas');
 const actions: ActionCapability[] = [];
 for (const entry of value) {
  const action = typeof entry === 'string' ? CAPABILITY[entry] : undefined;
  if (!action) return failed('MALFORMED', `Ação desconhecida no convite: ${String(entry)}`);
  if (!actions.includes(action)) actions.push(action);
 }
 return ok(actions);
}
function headOf(value: unknown, worldId: string, branchId: string): WorldResult<Head> {
 if (!plain(value)) return failed('MALFORMED', 'Cabeça de mundo inválida');
 if (value['worldId'] !== worldId || value['branchId'] !== branchId) return failed('MALFORMED', 'Cabeça de outro mundo ou ramificação');
 const commit = value['commit'], generation = value['generation'];
 if (!isRef(commit)) return failed('MALFORMED', 'Cabeça sem referência de commit');
 if (!Number.isSafeInteger(generation) || (generation as number) < 0) return failed('MALFORMED', 'Cabeça sem geração');
 return ok({worldId, branchId, commit, generation: generation as number});
}
function endpointsOf(value: unknown): WorldResult<InviteEndpoint[]> {
 if (!Array.isArray(value) || !value.length) return failed('MALFORMED', 'Convite sem ponto de encontro');
 const endpoints: InviteEndpoint[] = [];
 for (const entry of value) {
  if (!plain(entry)) return failed('MALFORMED', 'Ponto de encontro inválido');
  const transport = entry['transport'], uri = stringOf(entry['uri'], 'Endereço do ponto de encontro');
  if (!uri.ok) return uri;
  if (typeof transport !== 'string' || !(TRANSPORTS as readonly string[]).includes(transport)) return failed('MALFORMED', `Transporte desconhecido: ${String(transport)}`);
  endpoints.push({transport: transport as InviteEndpoint['transport'], uri: uri.value});
 }
 return ok(endpoints);
}
function policyOf(value: unknown): WorldResult<InvitePolicy> {
 if (!plain(value)) return failed('MALFORMED', 'Política de convite inválida');
 if (value['kind'] === 'open' || value['kind'] === 'approval') return ok({kind: value['kind']});
 if (value['kind'] !== 'recipient') return failed('MALFORMED', `Política de convite desconhecida: ${String(value['kind'])}`);
 if (!plain(value['subject'])) return failed('MALFORMED', 'Política de destinatário sem principal');
 const scheme = stringOf(value['subject']['scheme'], 'Esquema do destinatário'), id = stringOf(value['subject']['id'], 'Identidade do destinatário');
 if (!scheme.ok) return scheme;
 if (!id.ok) return id;
 return ok({kind: 'recipient', subject: {scheme: scheme.value, id: id.value}});
}
function samePrincipal(left: Principal, right: Principal): boolean {
 return left.scheme === right.scheme && left.id === right.id;
}

// --- the invitation document ----------------------------------------------------------------------------------
export type InvitePolicy = {kind: 'open'} | {kind: 'approval'} | {kind: 'recipient'; subject: Principal};
export type InviteEndpoint = {transport: 'nostr' | 'webrtc' | 'manual'; uri: string};
// The session descriptor of protocol §23 with what this client needs to reach the session as extensions: the body of
// a capability document is open, so a client that does not know these fields carries them unchanged.
export type SessionDescriptor = {
 type: 'session';
 id: string;
 timeline: string;
 space?: string;
 participants: string[];
 mode: 'realtime';
 startedAt: string;
 world: {worldId: string; branchId: string; epoch: number};
 head: Head;
 host: string;
 endpoints: InviteEndpoint[];
};
export type InviteBody = {
 type: 'capability';
 version: 1;
 issuer: string;
 subject?: string;
 entity: string;
 actions: ActionCapability[];
 policy: InvitePolicy;
 session: SessionDescriptor;
 notBefore: string;
 notAfter: string;
};
// The typed view of a signed event: the body is derived from the content that was signed, never from a field next to
// it, so there is exactly one place an invitation can say what world it is for.
export type Invite = {id: string; event: NostrEvent; body: InviteBody};
export type InviteInput = {
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 head: Head;
 startedAt: string;
 space?: string;
 endpoints: readonly InviteEndpoint[];
 policy: InvitePolicy;
 actions: readonly ActionCapability[];
 notBefore: string;
 notAfter: string;
};
function sessionIdOf(descriptor: SessionDescriptor): string {
 return descriptor.id.slice(SESSION_PREFIX.length);
}
export async function inviteIdOf(content: string): Promise<string> {
 return `${INVITE_PREFIX}${(await sha256Hex(content)).slice(0, 16)}`;
}
// The invitation as text: what a person copies, what a private message carries, what a file keeps. Nothing about it
// depends on a relay, so the manual path needs no network and no signer on the receiving side.
export function inviteText(invite: {id: string; event: NostrEvent}, codec: WorldCodec): string {
 return contentText(codec, {kind: 'invite', version: 1, id: invite.id, event: invite.event});
}
function bodyFrom(value: unknown): WorldResult<InviteBody> {
 if (!plain(value)) return failed('MALFORMED', 'Convite sem corpo');
 if (value['type'] !== 'capability' || value['version'] !== 1) return failed('MALFORMED', `Convite de tipo ou versão desconhecida: ${String(value['type'])}/${String(value['version'])}`);
 const issuer = uriOf(value['issuer'], 'Emissor'), entity = stringOf(value['entity'], 'Entidade do convite');
 if (!issuer.ok) return issuer;
 if (!entity.ok) return entity;
 const actions = actionsOf(value['actions']), policy = policyOf(value['policy']);
 if (!actions.ok) return actions;
 if (!policy.ok) return policy;
 const notBefore = instantOf(value['notBefore'], 'Início da validade'), notAfter = instantOf(value['notAfter'], 'Fim da validade');
 if (!notBefore.ok) return notBefore;
 if (!notAfter.ok) return notAfter;
 if (notAfter.value <= notBefore.value) return failed('MALFORMED', 'Convite com validade vazia');
 const session = value['session'];
 if (!plain(session)) return failed('MALFORMED', 'Convite sem descritor de sessão');
 if (session['type'] !== 'session' || session['mode'] !== 'realtime') return failed('MALFORMED', 'Descritor de sessão de outro tipo ou modo');
 const id = stringOf(session['id'], 'Sessão'), timeline = stringOf(session['timeline'], 'Linha do tempo'), host = uriOf(session['host'], 'Anfitrião'), startedAt = instantOf(session['startedAt'], 'Início da sessão');
 if (!id.ok) return id;
 if (!timeline.ok) return timeline;
 if (!host.ok) return host;
 if (!startedAt.ok) return startedAt;
 if (!id.value.startsWith(SESSION_PREFIX) || !timeline.value.startsWith('osim:timeline:')) return failed('MALFORMED', 'Sessão ou linha do tempo fora do vocabulário do protocolo');
 if (host.value !== issuer.value) return failed('MALFORMED', 'Anfitrião diferente do emissor do convite');
 const world = session['world'];
 if (!plain(world)) return failed('MALFORMED', 'Descritor sem mundo');
 const worldId = stringOf(world['worldId'], 'Mundo'), branchId = stringOf(world['branchId'], 'Ramificação'), epoch = world['epoch'];
 if (!worldId.ok) return worldId;
 if (!branchId.ok) return branchId;
 if (!Number.isSafeInteger(epoch) || (epoch as number) < 0) return failed('MALFORMED', 'Descritor sem época');
 const head = headOf(session['head'], worldId.value, branchId.value), endpoints = endpointsOf(session['endpoints']);
 if (!head.ok) return head;
 if (!endpoints.ok) return endpoints;
 const participants = session['participants'];
 if (!Array.isArray(participants) || participants.some(entry => typeof entry !== 'string')) return failed('MALFORMED', 'Descritor com participantes inválidos');
 const space = session['space'] === undefined ? ok(undefined) : stringOf(session['space'], 'Espaço');
 if (!space.ok) return space;
 const subject = value['subject'] === undefined ? ok(undefined) : uriOf(value['subject'], 'Destinatário');
 if (!subject.ok) return subject;
 if (policy.value.kind === 'recipient' && subject.value !== `${policy.value.subject.scheme}:${policy.value.subject.id}`) return failed('MALFORMED', 'Destinatário diferente do sujeito da política');
 return ok({
  type: 'capability', version: 1, issuer: issuer.value, ...(subject.value === undefined ? {} : {subject: subject.value}), entity: entity.value,
  actions: actions.value, policy: policy.value,
  session: {
   type: 'session', id: id.value, timeline: timeline.value, ...(space.value === undefined ? {} : {space: space.value}),
   participants: [...participants] as string[], mode: 'realtime', startedAt: startedAt.value,
   world: {worldId: worldId.value, branchId: branchId.value, epoch: epoch as number}, head: head.value, host: host.value, endpoints: endpoints.value,
  },
  notBefore: notBefore.value, notAfter: notAfter.value,
 });
}
// The single validation point for an invitation from anywhere: the id has to be the digest of the signed content, the
// event has to verify, the `d` tag has to agree with the id, and the body has to be readable.
export async function inviteFrom(event: unknown): Promise<WorldResult<Invite>> {
 if (!plain(event)) return failed('MALFORMED', 'Convite sem evento assinado');
 const {kind, pubkey, id, sig, content, tags, created_at} = event as Record<string, unknown>;
 if (typeof kind !== 'number' || typeof pubkey !== 'string' || !HEX.test(pubkey) || typeof id !== 'string' || typeof sig !== 'string' || typeof content !== 'string' || !Array.isArray(tags)) return failed('MALFORMED', 'Evento do convite inválido');
 const signed: NostrEvent = {kind, created_at: Number(created_at), tags: (tags as string[][]).map(tag => [...tag]), content, pubkey, id, sig};
 if (!Number.isSafeInteger(signed.created_at)) return failed('MALFORMED', 'Evento do convite sem instante');
 if (!verifyEvent(signed)) return failed('SIGNATURE', 'Assinatura do convite não verificada');
 const inviteId = await inviteIdOf(content);
 if (!signed.tags.some(tag => tag[0] === 'd' && tag[1] === inviteId)) return failed('SIGNATURE', 'Convite sem o identificador que o seu conteúdo endereça');
 const parsed = parseStrictJson(content, undefined, DEFAULT_LIMITS.maxNodes);
 if (!parsed.ok) return parsed;
 const body = bodyFrom(parsed.value);
 if (!body.ok) return body;
 return ok({id: inviteId, event: signed, body: body.value});
}
export function verifyInvite(value: unknown): Promise<WorldResult<Invite>> {
 if (!plain(value)) return Promise.resolve(failed('MALFORMED', 'Convite inválido'));
 return inviteFrom(value['event']);
}
export async function parseInvite(text: string): Promise<WorldResult<Invite>> {
 const parsed = parseStrictJson(text, undefined, DEFAULT_LIMITS.maxNodes);
 if (!parsed.ok) return parsed;
 if (!plain(parsed.value) || parsed.value['kind'] !== 'invite' || parsed.value['version'] !== 1) return failed('MALFORMED', 'Texto não é um convite');
 const event = parsed.value['event'];
 const verified = await inviteFrom(event);
 if (!verified.ok) return verified;
 return parsed.value['id'] === verified.value.id ? verified : failed('MALFORMED', 'Convite com identificador diferente do conteúdo');
}
// The public half: the envelope a client may publish where anyone can read it. It names the invitation by digest,
// never by content, so a reader learns that a session exists and what it proposes, and nothing that lets it join.
export function announce(invite: Invite): OsimEnvelope {
 const body = invite.body;
 return envelopeOf('capability', invite.id, body.issuer, {
  type: 'capability', version: 1, issuer: body.issuer,
  ...(body.subject === undefined ? {} : {subject: body.subject}),
  entity: body.entity, actions: body.actions, policy: body.policy.kind,
  notBefore: body.notBefore, notAfter: body.notAfter,
  invite: {id: invite.id, event: invite.event.id},
 });
}

// --- joining: an ask, never a grant ----------------------------------------------------------------------------
export type JoinRequest = {
 kind: 'join-request';
 version: 1;
 id: string;
 invite: {id: string; event: string};
 session: {worldId: string; branchId: string; sessionId: string; epoch: number; head: Head};
 principal: Principal;
 sessionKey: string;
 actions: ActionCapability[];
 approval: 'none' | 'required';
 binding: NostrBinding;
 identity: IdentityProof;
 proof: MessageProof;
};
// The signed body, written out field by field rather than spread: what a signature covers is the one thing in this
// file a reader must be able to see at a glance, and a field added to the type later is not silently signed. The id
// (its own digest) and the signature itself stay outside it.
export const joinRequestBody = (request: JoinRequest): JsonValue => ({
 kind: request.kind, version: request.version,
 invite: {id: request.invite.id, event: request.invite.event},
 session: {
  worldId: request.session.worldId, branchId: request.session.branchId, sessionId: request.session.sessionId,
  epoch: request.session.epoch,
  head: {worldId: request.session.head.worldId, branchId: request.session.head.branchId, commit: {hash: request.session.head.commit.hash, bytes: request.session.head.commit.bytes}, generation: request.session.head.generation},
 },
 principal: {scheme: request.principal.scheme, id: request.principal.id},
 sessionKey: request.sessionKey,
 actions: [...request.actions],
 approval: request.approval,
 binding: {
  kind: request.binding.kind, version: request.binding.version, npub: request.binding.npub,
  deviceKey: request.binding.deviceKey, issuedAt: request.binding.issuedAt,
  event: {kind: request.binding.event.kind, created_at: request.binding.event.created_at, tags: request.binding.event.tags.map(tag => [...tag]), content: request.binding.event.content, pubkey: request.binding.event.pubkey, id: request.binding.event.id, sig: request.binding.event.sig},
 },
 identity: {
  kind: request.identity.kind, principal: {scheme: request.identity.principal.scheme, id: request.identity.principal.id},
  sessionKey: request.identity.sessionKey,
  scope: {worldId: request.identity.scope.worldId, branchId: request.identity.scope.branchId, sessionId: request.identity.scope.sessionId, notBefore: request.identity.scope.notBefore, notAfter: request.identity.scope.notAfter},
  delegation: {algorithm: request.identity.delegation.algorithm, key: request.identity.delegation.key, value: request.identity.delegation.value},
 },
});
export function joinRequestBytes(request: JoinRequest, codec: WorldCodec): Uint8Array {
 return codec.encode(joinRequestBody(request));
}
// The whole chain in one place, because a caller holding only this document has to be able to check it: the session
// key signed the request, the device key the npub authorized delegated that session key, and the binding is a real
// signature by that npub. None of this makes the request authority — it only makes it an ask from who it claims.
export async function verifyJoinRequest(request: JoinRequest, context: {codec: WorldCodec; verifier: SignatureVerifier; hasher: ContentHasher}): Promise<WorldResult<JoinRequest>> {
 if (request.kind !== 'join-request' || request.version !== 1) return failed('MALFORMED', 'Pedido de entrada de versão desconhecida');
 const binding = verifyBinding(request.binding);
 if (!binding.ok) return binding;
 const npub = npubOfPrincipal(request.principal);
 if (!npub.ok) return npub;
 if (request.principal.id !== `nostr:${binding.value.npub}`) return failed('SIGNATURE', 'O pedido diz ser de outra identidade que não a do vínculo');
 if (!samePrincipal(request.identity.principal, request.principal)) return failed('SIGNATURE', 'A prova de identidade é de outro principal');
 if (request.identity.sessionKey !== request.sessionKey || request.identity.delegation.key !== binding.value.deviceKey) return failed('SIGNATURE', 'A chave de sessão não foi delegada pelo dispositivo que o npub autorizou');
 const scope = request.identity.scope;
 if (scope.worldId !== request.session.worldId || scope.branchId !== request.session.branchId || scope.sessionId !== request.session.sessionId) return failed('SIGNATURE', 'Vínculo de identidade para outra sessão');
 const bytes = joinRequestBytes(request, context.codec);
 if (request.id !== (await context.hasher.ref(bytes)).hash) return failed('MALFORMED', 'O identificador do pedido não é o resumo do seu corpo');
 if (!await context.verifier.verify(request.identity, identityBytes(request.identity, context.codec))) return failed('SIGNATURE', 'Vínculo de identidade do pedido não verificado');
 if (!await context.verifier.verify(request.proof, bytes)) return failed('SIGNATURE', 'Assinatura do pedido não verificada');
 return ok(request);
}

// --- the service -----------------------------------------------------------------------------------------------
export type InviteServiceOptions = {codec: WorldCodec; now: () => string; identity?: NostrIdentity};
export type InviteService = {
 create(input: InviteInput): Promise<WorldResult<Invite>>;
 open(invite: Invite): Promise<WorldResult<JoinRequest>>;
 spent(): readonly string[];
};
export function createInviteService(options: InviteServiceOptions): InviteService {
 const {codec, now, identity} = options;
 // A link opened here was spent here: the same invitation is not a second join, and another session key does not make
 // it one. The host keeps its own ledger of receipts; this one keeps the link from behaving like a bearer token.
 const opened = new Map<string, string>();
 return {
  async create(input) {
   if (!identity) return failed('NOT_FOUND', 'Sem identidade local para convidar');
   if (input.head.worldId !== input.worldId || input.head.branchId !== input.branchId) return failed('MALFORMED', 'Cabeça de outro mundo ou ramificação');
   if (!input.worldId || !input.branchId || !input.sessionId) return failed('MALFORMED', 'Convite sem mundo, ramificação ou sessão');
   if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) return failed('MALFORMED', 'Época inválida');
   const actions = actionsOf([...input.actions]), policy = policyOf(input.policy), endpoints = endpointsOf([...input.endpoints]);
   if (!actions.ok) return actions;
   if (!policy.ok) return policy;
   if (!endpoints.ok) return endpoints;
   const startedAt = instantOf(input.startedAt, 'Início da sessão'), notBefore = instantOf(input.notBefore, 'Início da validade'), notAfter = instantOf(input.notAfter, 'Fim da validade');
   if (!startedAt.ok) return startedAt;
   if (!notBefore.ok) return notBefore;
   if (!notAfter.ok) return notAfter;
   if (notAfter.value <= notBefore.value) return failed('MALFORMED', 'Convite com validade vazia');
   // The issuer is the key that signs, never a field someone handed in: a document nobody signed is not an invitation.
   const subject = policy.value.kind === 'recipient' ? `${policy.value.subject.scheme}:${policy.value.subject.id}` : undefined;
   const body: InviteBody = {
    type: 'capability', version: 1, issuer: identity.principal.id, ...(subject === undefined ? {} : {subject}),
    entity: `${SESSION_PREFIX}${input.sessionId}`, actions: actions.value, policy: policy.value,
    session: {
     type: 'session', id: `${SESSION_PREFIX}${input.sessionId}`, timeline: `osim:timeline:${input.branchId}`,
     ...(input.space === undefined ? {} : {space: input.space}),
     participants: [identity.principal.id], mode: 'realtime', startedAt: startedAt.value,
     world: {worldId: input.worldId, branchId: input.branchId, epoch: input.epoch}, head: input.head,
     host: identity.principal.id, endpoints: endpoints.value,
    },
    notBefore: notBefore.value, notAfter: notAfter.value,
   };
   const content = contentText(codec, body);
   const template: NostrEventTemplate = {kind: 1, created_at: epochSeconds(now()), tags: [['t', 'osim-0.1'], ['t', 'osim-invite'], ['d', await inviteIdOf(content)], ['o', 'capability']], content};
   let event: NostrEvent;
   try {
    event = await identity.signer.signEvent(template);
   } catch (error) {
    return failed('SIGNATURE', `Assinador recusou a assinatura do convite: ${error instanceof Error ? error.message : String(error)}`);
   }
   return inviteFrom(event);
  },
  async open(invite) {
   if (!identity) return failed('NOT_FOUND', 'Sem identidade local para entrar');
   const verified = await inviteFrom(invite.event);
   if (!verified.ok) return verified;
   const body = verified.value.body, descriptor = body.session;
   const instant = now();
   if (!INSTANT.test(instant)) return failed('MALFORMED', `Relógio da sessão inválido: ${instant}`);
   if (instant < body.notBefore) return failed('PERMISSION', 'Convite ainda não vale');
   if (instant >= body.notAfter) return failed('PERMISSION', 'Convite expirado');
   if (body.policy.kind === 'recipient' && !samePrincipal(body.policy.subject, identity.principal)) return failed('PERMISSION', 'Convite para outro destinatário');
   if (opened.has(verified.value.id)) return failed('CONFLICT', `Convite já usado nesta sessão (${opened.get(verified.value.id)})`);
   const sessionId = sessionIdOf(descriptor);
   const scope: IdentityScope = {worldId: descriptor.world.worldId, branchId: descriptor.world.branchId, sessionId, notBefore: body.notBefore, notAfter: body.notAfter};
   const bound = await identity.provider(codec).bindSession({principal: identity.principal, scope});
   if (!bound.ok) return bound;
   const unsigned: JoinRequest = {
    kind: 'join-request', version: 1, id: '', invite: {id: verified.value.id, event: verified.value.event.id},
    session: {worldId: scope.worldId, branchId: scope.branchId, sessionId, epoch: descriptor.world.epoch, head: descriptor.head},
    principal: identity.principal, sessionKey: bound.value.sessionKey, actions: [...body.actions],
    approval: body.policy.kind === 'approval' ? 'required' : 'none',
    binding: identity.binding, identity: bound.value,
    proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: bound.value.sessionKey, signature: ''},
   };
   const bytes = joinRequestBytes(unsigned, codec);
   const request: JoinRequest = {...unsigned, id: (await hasher.ref(bytes)).hash, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: unsigned.sessionKey, signature: await signEd25519(identity.session, bytes)}};
   opened.set(verified.value.id, sessionId);
   return ok(request);
  },
  spent: () => [...opened.keys()],
 };
}
