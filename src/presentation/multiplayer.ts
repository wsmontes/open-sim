// The experience layer of a cooperative session (plan Task 9; spec §6.3, §7.3–§7.5; OpenSim Protocol §23–§26, §39.5).
// The game keeps one entry point for what a player asks: `submitAction` dispatches it locally when nobody else is in
// the branch, and hands it to the live session when there is one — the personal session's own contract is what the
// local path calls, unchanged. `tick` follows the same rule, because only the host orders the branch: a replica that
// scheduled its own ticks would invent a second authority for the same money and the same revision.
//
// A session is an object, not a field of the game: the descriptor of §23 is published through the kernel registry and
// resolved by `join` (§39.5), so another client can find it without either side shipping session state as history.
// Everything else here is deliberately ephemeral: movement and presence travel on their own port, are rate limited,
// never carry the camera and never change a durable identity (§7.3, §24).
import type {Action,CellCoord,CommandResult,GameState} from '../core/model';
import type {Head,JsonValue,WorldResult} from '../world/model';
import {WORLD_PROTOCOL,WIRE_VERSION,failed,ok} from '../world/model';
import type {PublishResult,Resolved} from '../world/kernel';
import {envelopeOf,timelineUri} from '../world/osim';
import type {OsimEnvelope} from '../world/osim';
import {proposalBytes} from '../world/permissions';
import type {Grant,IdentityProof,Principal,Proposal,Role} from '../world/permissions';
import type {WorldCodec} from '../world/ports';
import type {TrafficClass,WireMessage} from '../world/wire';
import type {HostSession,ProposalReceipt,ReceiptPreview,ReplicaReceipt} from '../session/host-session';
import type {ReplicaSession} from '../session/replica-session';
import type {SessionTransport} from '../session/multiplayer-ports';
import type {WorldRepository} from '../session/world-repository';
import {persistenceOf} from '../session/ports';
import type {PersistenceReport,PersistenceStatus} from '../session/ports';

export type SessionMode = 'local' | 'host' | 'replica';
// The states the spec names (§6.3): persisted on this device, copied by a friend, pending, paused, the source is
// behind, or the device could not write. They are exclusive, in that order of precedence: a device that cannot write
// says so instead of claiming a save, and a paused match says so instead of claiming a copy.
export type SessionStatusKind = 'saved-local' | 'replicated' | 'pending' | 'paused' | 'source-error' | 'storage-error';
export type SessionStatus = {kind: SessionStatusKind; text: string; detail: string; copies: number};
// A participant is a durable identity with a role in this branch; presence is declared separately and adds nothing.
export type Participant = {id: string; role: Role};
export type PresenceStatement = {peer: string; label: string; at: string};
// The ephemeral port (§7.3): disposable, rate limited, and separate from the durable queue on purpose.
export type EphemeralPort = {send(statement: PresenceStatement): void};
export type Refusal = {action: Action; cells: readonly CellCoord[]; reason: string; preview: ReceiptPreview | null};

// What the experience needs from a live session, whoever holds it. A host orders transactions and is the only one
// that ticks; a replica only verifies them. Both are the session layer's own objects (src/session/host-session.ts,
// replica-session.ts) behind the slice the game uses, so no adapter reaches this module and a test can wire a link
// without a network.
export type SessionLink = {
 mode: 'host' | 'replica';
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 actorUri: string;
 head(): Head;
 checkpoint(): Promise<{head: Head; state: GameState}>;
 pending(): number;
 // The durable confirmations a peer sent for the versions it adopted: a transport that accepted a frame is not one.
 confirmations(): readonly ReplicaReceipt[];
 // A peer that stopped integrating, and why: a divergence, a missing base, an unreachable host.
 stopped(): {code: string; message: string} | null;
 participants(): readonly Participant[];
 // What this client has to say before it can be heard: who it is and, when it brings one, the grant it presents. The
 // identity a session accepts a proposal from is the one presented on the control plane (§7.4 step 2), and the host
 // itself is no exception. The frames are ordered with the proposals that follow them, so no answer is expected here.
 ready(): Promise<void>;
 submitAction(action: Action): Promise<ProposalReceipt>;
 tick(): Promise<WorldResult<Head>>;
};

// §7.4 step 1: an action of the game becomes a signed proposal that names the version the player observed and the
// ceiling they approved. The signature comes from the session key through an injected signer, so building a proposal
// needs no crypto adapter here.
export type ProposalSigner = {key: string; sign(bytes: Uint8Array): Promise<string>};
export type LinkContext = {
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 principal: Principal;
 sessionKey: string;
 signer: ProposalSigner;
 codec: WorldCodec;
 costLimit: number;
 // This client's own endpoint in the session: the frames it speaks and the identity it presents with them.
 transport: SessionTransport;
 peer: string;
 identity: IdentityProof;
 grants?: readonly Grant[];
 peers?: readonly Participant[];
 id?: () => string;
};
export type ProposalRequest = {
 principal: Principal;
 sessionKey: string;
 signer: ProposalSigner;
 codec: WorldCodec;
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 id: string;
 head: Head;
 revision: number;
 costLimit: number;
};
const ROLE_LABELS: Record<Role, string> = {owner: 'proprietário', host: 'anfitrião', collaborator: 'colaborador', spectator: 'visitante'};
const STATUS_TEXT: Record<SessionStatusKind, string> = {
 'saved-local': 'Salvo neste dispositivo',
 replicated: 'Copiado por 1 amigo',
 pending: 'Mudanças pendentes',
 paused: 'Partida pausada',
 'source-error': 'Fonte desatualizada',
 'storage-error': 'Falha ao salvar',
};
// A statement over the rate is dropped, never queued: presence has a deadline and a queue would defeat it.
const PRESENCE_PER_SECOND = 10;
const PRESENCE_WINDOW_MS = 1000;
const PRESENCE_LIMIT = 64;

export async function proposalOf(action: Action, request: ProposalRequest): Promise<Proposal> {
 const base: Proposal = {
  worldProtocol: WORLD_PROTOCOL,
  wireVersion: WIRE_VERSION,
  kind: 'proposal',
  worldId: request.worldId,
  branchId: request.branchId,
  sessionId: request.sessionId,
  epoch: request.epoch,
  id: request.id,
  principal: request.principal,
  sessionKey: request.sessionKey,
  observedHead: request.head.commit,
  intent: action,
  preconditions: {revision: request.revision},
  costLimit: request.costLimit,
  proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: request.sessionKey, signature: ''},
 };
 const proof = {kind: 'message' as const, algorithm: 'Ed25519' as const, sessionKey: request.sessionKey, signature: await request.signer.sign(proposalBytes(base, request.codec))};
 return {...base, proof};
}

const actorUriOf = (principal: Principal): string => `${principal.scheme}:${principal.id}`;
// A device that reopens a branch must not restart a counter blindly (the same identifier with another body is a
// conflict, not a repeat), so the caller can inject its own uniqueness policy.
const nextId = (context: LinkContext): string => context.id ? context.id() : `${context.principal.id}.${context.epoch}.${Date.now().toString(36)}`;
const frameOf = (context: LinkContext, traffic: TrafficClass, body: JsonValue, id: string): WireMessage => ({
 envelope: {worldProtocol: WORLD_PROTOCOL, wireVersion: WIRE_VERSION, kind: 'message', class: traffic, worldId: context.worldId, branchId: context.branchId, sessionId: context.sessionId, epoch: context.epoch, id},
 body,
});
// The control documents a client presents to a session: who signs and, when it carries one, what it was granted. A
// control body is the document itself — the schema is closed, so wrapping it in another `kind` would be a document
// nobody can read.
async function announce(context: LinkContext, to: string): Promise<void> {
 await context.transport.send(to, frameOf(context, 'control', context.identity as unknown as JsonValue, `${context.peer}.identity`));
 for(const grant of context.grants ?? [])await context.transport.send(to, frameOf(context, 'control', grant as unknown as JsonValue, `${context.peer}.grant.${grant.id}`));
}

// A presence statement as a frame of the session: the ephemeral class of §7.3, which nobody persists and which carries
// only what a person chose to declare.
export function presenceFrame(session: {worldId: string;branchId: string;sessionId: string;epoch: number}, statement: PresenceStatement, id: string): WireMessage {
 return {envelope: {worldProtocol: WORLD_PROTOCOL, wireVersion: WIRE_VERSION, kind: 'message', class: 'ephemeral', worldId: session.worldId, branchId: session.branchId, sessionId: session.sessionId, epoch: session.epoch, id}, body: statement as unknown as JsonValue};
}

export function hostSessionLink(session: HostSession, context: LinkContext): SessionLink {
 // A host hears its own client the same way it hears a peer: the identity that authorizes a proposal has to be
 // presented, and this endpoint is where this client says it.
 let announced: Promise<void> | null = null;
 const ready = () => announced ??= announce(context, context.peer);
 return {
  mode: 'host',
  worldId: context.worldId,
  branchId: context.branchId,
  sessionId: context.sessionId,
  epoch: context.epoch,
  actorUri: actorUriOf(context.principal),
  head: () => session.head(),
  checkpoint: () => session.checkpoint(),
  pending: () => session.pending(),
  confirmations: () => session.confirmations(),
  // The host reports what it cannot write through its receipts; there is no higher authority to stop it here.
  stopped: () => null,
  participants: () => [{id: context.principal.id, role: 'host'}, ...(context.peers ?? [])],
  ready,
  tick: () => session.step(),
  async submitAction(action) {
   await ready();
   const observed = await session.checkpoint();
   const proposal = await proposalOf(action, {...context, id: nextId(context), head: observed.head, revision: observed.state.revision});
   return session.submit(proposal);
  },
 };
}

export function replicaSessionLink(session: ReplicaSession, repository: WorldRepository, host: string, context: LinkContext): SessionLink {
 const receiptOf = (status: 'refused' | 'failed', code: ProposalReceipt['code'], reason: string): ProposalReceipt => ({kind: 'proposal-receipt', id: `replica-${session.head().generation}`, digest: '', status, parent: session.head(), head: session.head(), rebased: false, code, reason});
 let announced: Promise<void> | null = null;
 const ready = () => announced ??= announce(context, host);
 return {
  mode: 'replica',
  worldId: context.worldId,
  branchId: context.branchId,
  sessionId: context.sessionId,
  epoch: context.epoch,
  actorUri: actorUriOf(context.principal),
  head: () => session.head(),
  async checkpoint() {
   const head = session.head();
   const point = await repository.checkout(head);
   if(!point.ok)throw new Error(point.error.message);
   return {head, state: point.value.state};
  },
  pending: () => {const waiting = session.pending();return waiting.commits + waiting.objects;},
  confirmations: () => session.receipts(),
  stopped: () => {const last = session.divergences().at(-1);return last ? {code: last.code ?? 'CONFLICT', message: last.reason ?? `Resultado diferente do anfitrião ${host}`} : null;},
  participants: () => [{id: context.principal.id, role: 'collaborator'}, ...(context.peers ?? [])],
  ready,
  // A replica verifies what the host ordered; ordering is the host's, and the replica-writer path of a session is the
  // session layer's to expose before this one can pretend to walk it.
  async submitAction() {await ready();return receiptOf('refused', 'PERMISSION', 'Esta réplica não ordena transações: a proposta precisa chegar ao anfitrião');},
  async tick() {return failed<Head>('PERMISSION', 'A réplica não agenda ticks: o anfitrião é quem marca o tempo');},
 };
}

// The protocol boundary of a session (§23, §39.5): the descriptor is published as an object and resolved by `join`,
// never shipped as session traffic. The registry is the kernel's own object plane, so a transport that carries objects
// (Task 8) attaches where the network is configured.
export type SessionRegistry = {
 publish(object: OsimEnvelope): Promise<PublishResult>;
 join(uri: string): Promise<WorldResult<Resolved | null>>;
};
export type SessionDescriptor = {
 uri: string;
 // The actor of the §48 envelope: the principal this session speaks as, in its protocol form.
 actor: string;
 worldId: string;
 branchId: string;
 sessionId: string;
 epoch: number;
 participants: readonly string[];
 startedAt: string;
};
const sessionIdOf = (sessionId: string): string => `osim:session:${sessionId}`;

export function sessionEnvelope(descriptor: SessionDescriptor): OsimEnvelope {
 // §23: id, space, timeline, participants, mode and the start instant. The world/branch/epoch of this client travel
 // in the open body, so a peer can check that the descriptor is the session it was invited to.
 return envelopeOf('session', sessionIdOf(descriptor.sessionId), descriptor.actor, {
  worldId: descriptor.worldId,
  branchId: descriptor.branchId,
  epoch: descriptor.epoch,
  space: 'osim:space:earth',
  timeline: timelineUri(descriptor.branchId),
  participants: [...descriptor.participants],
  mode: 'realtime',
  startedAt: descriptor.startedAt,
 });
}
export const sessionText = (descriptor: SessionDescriptor, codec: WorldCodec): string => new TextDecoder().decode(codec.encode(sessionEnvelope(descriptor) as unknown as JsonValue));

export function readSessionDescriptor(object: OsimEnvelope | Resolved | null): SessionDescriptor | null {
 if(!object || object.type !== 'session' || !object.id.startsWith('osim:session:'))return null;
 const body = object.body;
 if(!body || typeof body !== 'object' || Array.isArray(body))return null;
 const source = body as Record<string, JsonValue>;
 const worldId = source['worldId'], branchId = source['branchId'], epoch = source['epoch'], participants = source['participants'], startedAt = source['startedAt'];
 if(typeof worldId !== 'string' || typeof branchId !== 'string' || typeof epoch !== 'number')return null;
 return {
  uri: object.id,
  actor: object.actor,
  worldId,
  branchId,
  sessionId: object.id.slice('osim:session:'.length),
  epoch,
  participants: Array.isArray(participants) ? participants.filter((entry): entry is string => typeof entry === 'string') : [],
  startedAt: typeof startedAt === 'string' ? startedAt : '',
 };
}

// The action input of the game: one quote for the version the device holds, so a refusal can show the fresh price
// without the panel re-deriving it.
export type ActionQuote = {status: 'ok' | 'blocked'; cost: number; reason?: string};
export type SessionViewOptions = {
 worldId: string;
 branchId: string;
 // The personal game, read through the contract `LocalSession` already exposes: the local path calls `dispatch`
 // exactly as the game did before, and a session that is live never touches the personal save.
 local: {dispatch(action: Action): CommandResult;getState(): GameState};
 head?: () => Head | null;
 commit?: (action: Action, state: GameState) => Promise<Head | null>;
 quote?: (action: Action, state: GameState) => ActionQuote;
 registry?: SessionRegistry;
 ephemeral?: EphemeralPort;
 self?: string;
 now?: () => string;
 monotonic?: () => number;
};
export type GameSessionView = {
 mode: () => SessionMode;
 // The device's own save state, pushed by whoever owns the personal session. It is an input and not a callback: a
 // report that asked the view about itself while the view asked the report would be a loop.
 setPersistence: (report: PersistenceReport) => void;
 state: () => GameState | null;
 head: () => Head | null;
 pending: () => number;
 status: () => SessionStatus;
 participants: () => readonly Participant[];
 presence: () => readonly PresenceStatement[];
 descriptor: () => SessionDescriptor | null;
 refusal: () => Refusal | null;
 message: () => string;
 invite: () => string;
 submitAction: (action: Action) => Promise<ProposalReceipt>;
 tick: () => Promise<WorldResult<Head>>;
 declarePresence: (label: string) => void;
 receivePresence: (statement: PresenceStatement) => void;
 setSourceError: (message: string | null) => void;
 notify: (text: string) => void;
 setHostVisible: (visible: boolean) => void;
 setInvite: (text: string) => void;
 attach: (link: SessionLink) => Promise<void>;
 resolveSession: (uri: string) => Promise<WorldResult<SessionDescriptor | null>>;
 leave: (reason?: string) => Promise<void>;
 refresh: () => Promise<void>;
 clearRefusal: () => void;
 describe: () => MultiplayerInfo;
};

const cellsOf = (action: Action): readonly CellCoord[] => action.type === 'build' || action.type === 'demolish' ? action.cells : [];
const messageOf = (error: unknown): string => error instanceof Error && error.message ? error.message : 'Falha desconhecida na sessão';

export function createGameSessionView(options: SessionViewOptions): GameSessionView {
 const now = options.now ?? (() => new Date().toISOString());
 const monotonic = options.monotonic ?? (() => Date.now());
 let link: SessionLink | null = null, descriptor: SessionDescriptor | null = null, confirmed: {head: Head; state: GameState} | null = null;
 let message = '', invite = '', sourceError: string | null = null, storageFailure: string | null = null, hostVisible = true, inFlight = 0, submitted = false;
 let persistence: PersistenceStatus = {state: 'unsaved', message: '', blocked: false};
 let refusal: Refusal | null = null;
 const presenceOf = new Map<string, PresenceStatement>(), stamps: number[] = [];
 // A game that never published a version has no commit to name: the local receipt reports generation 0 with the
 // address of the branch instead of inventing bytes.
 const unpublished = (): Head => ({worldId: options.worldId, branchId: options.branchId, commit: {hash: '', bytes: 0}, generation: 0});
 const mode = (): SessionMode => link ? link.mode : 'local';
 const head = (): Head | null => link ? confirmed?.head ?? null : options.head?.() ?? null;
 const live = (): GameState | null => link ? confirmed?.state ?? null : options.local.getState();
 // Only a receipt counts as a copy (§7.4 step 6): for a host they are the receipts of its peers, for a replica its own
 // adoption — either way the version named is the one the copy holds.
 function copies(): number {
  const current = head();
  const peers = new Set<string>();
  for(const receipt of link?.confirmations() ?? []){
   if(receipt.status !== 'adopted' && receipt.status !== 'duplicate')continue;
   if(!current || receipt.head.commit.hash !== current.commit.hash)continue;
   peers.add(receipt.peer);
  }
  return peers.size;
 }
 function replicatedText(count: number): string {
  if(mode() === 'replica')return count === 1 ? 'Cópia confirmada neste dispositivo' : `${count} cópias confirmadas neste dispositivo`;
  return count === 1 ? 'Copiado por 1 amigo' : `Copiado por ${count} amigos`;
 }
 function status(): SessionStatus {
  const save = persistence;
  const count = copies();
  if(sourceError)return {kind: 'source-error', text: STATUS_TEXT['source-error'], detail: sourceError, copies: count};
  // The device's own save error governs the personal game: while a session owns the branch, what this device writes is
  // the session's own durable confirmation, and a stale personal error would say nothing about it.
  if(!link && save.state === 'error')return {kind: 'storage-error', text: STATUS_TEXT['storage-error'], detail: save.message, copies: count};
  // A durable write this device refused pauses new confirmations (§7.4 step 5): saying "Salvo" over it would be the
  // false claim the spec forbids.
  if(storageFailure)return {kind: 'storage-error', text: STATUS_TEXT['storage-error'], detail: storageFailure, copies: count};
  const stop = link?.stopped() ?? null;
  if(stop && stop.code === 'QUOTA')return {kind: 'storage-error', text: STATUS_TEXT['storage-error'], detail: stop.message, copies: count};
  // A hidden tab is not a promise that the browser will keep working: the match is paused until the host is back.
  if(link && link.mode === 'host' && !hostVisible)return {kind: 'paused', text: STATUS_TEXT.paused, detail: 'A aba do anfitrião está oculta; a partida continua quando ela voltar.', copies: count};
  if(stop)return {kind: 'paused', text: STATUS_TEXT.paused, detail: stop.message, copies: count};
  if(inFlight > 0)return {kind: 'pending', text: STATUS_TEXT.pending, detail: `${inFlight} ação(ões) aguardando confirmação durável`, copies: count};
  const peers = participants().length - 1;
  if(link && (link.pending() > 0 || (peers > 0 && submitted && count === 0)))return {kind: 'pending', text: STATUS_TEXT.pending, detail: peers > 0 ? 'Os participantes ainda não confirmaram esta versão' : 'Integração da sessão em andamento', copies: count};
  if(count > 0)return {kind: 'replicated', text: replicatedText(count), detail: '', copies: count};
  if(!link && save.state === 'saving')return {kind: 'pending', text: STATUS_TEXT.pending, detail: 'Salvando neste dispositivo', copies: 0};
  return {kind: 'saved-local', text: STATUS_TEXT['saved-local'], detail: '', copies: count};
 }
 function participants(): readonly Participant[] {
  return link ? link.participants() : [{id: options.self ?? 'local-player', role: 'owner'}];
 }
 function rememberPresence(statement: PresenceStatement): void {
  presenceOf.delete(statement.peer);
  presenceOf.set(statement.peer, statement);
  while(presenceOf.size > PRESENCE_LIMIT){const oldest = presenceOf.keys().next().value;if(oldest === undefined)break;presenceOf.delete(oldest);}
 }
 async function refresh(): Promise<void> {
  if(!link)return;
  try{
   confirmed = await link.checkpoint();
  }catch(error){
   // The last confirmed version stays: reading a device that cannot answer is not a reason to forget what it wrote.
   message = messageOf(error);
  }
 }
 // A locally accepted action is the device's own authority, so it becomes a checkpoint before the receipt is answered;
 // the receipt names the version that checkpoint published.
 async function localReceipt(action: Action, before: GameState, result: CommandResult): Promise<ProposalReceipt> {
  const quote = options.quote?.(action, before);
  const preview: ReceiptPreview = {revision: before.revision, tick: before.tick, money: before.money, cost: quote?.cost ?? 0, ...(result.reason ? {reason: result.reason} : {})};
  if(result.status === 'rejected')refusal = {action, cells: cellsOf(action), reason: result.reason ?? 'Ação recusada', preview};
  else refusal = null;
  const parent = options.head?.() ?? unpublished();
  const published = result.status === 'rejected' ? null : await options.commit?.(action, result.state).catch(() => null) ?? null;
  return {
   kind: 'proposal-receipt',
   id: `local-${before.revision}`,
   digest: '',
   status: result.status === 'applied' ? 'accepted' : result.status === 'duplicate' ? 'duplicate' : 'refused',
   parent,
   head: published ?? parent,
   rebased: false,
   cost: quote?.cost,
   ...(result.reason ? {reason: result.reason} : {}),
   preview,
  };
 }
 async function submitAction(action: Action): Promise<ProposalReceipt> {
  const active = link;
  if(!active){
   const before = options.local.getState();
   return localReceipt(action, before, options.local.dispatch(action));
  }
  // The economic result is not shown before the confirmation: the panel reads the version the receipt names, and a
  // refusal brings the fresh preview the host computed (§7.4 step 3) instead of an optimistic number.
  inFlight += 1;
  submitted = true;
  try{
   const receipt = await active.submitAction(action);
   storageFailure = receipt.status === 'failed' && receipt.code === 'QUOTA' ? receipt.reason ?? 'O dispositivo não escreveu a versão' : null;
   if(receipt.status === 'refused' || receipt.status === 'failed'){
    const live_ = live();
    const quote = live_ ? options.quote?.(action, live_) : undefined;
    const fresh = receipt.preview;
    // A refusal that never reached the quote reports no cost, and zero there means "not priced", not "free": the price
    // the player would pay comes from this device's own quote against the version it holds.
    const preview: ReceiptPreview | null = fresh || live_ ? {
     revision: fresh?.revision ?? live_?.revision ?? 0,
     tick: fresh?.tick ?? live_?.tick ?? 0,
     money: fresh?.money ?? live_?.money ?? 0,
     cost: fresh && fresh.cost > 0 ? fresh.cost : quote?.cost ?? 0,
     ...(receipt.reason ? {reason: receipt.reason} : {}),
    } : null;
    refusal = {action, cells: cellsOf(action), reason: receipt.reason ?? receipt.code ?? 'Ação recusada', preview};
   }else refusal = null;
   await refresh();
   return receipt;
  }finally{
   inFlight -= 1;
  }
 }
 return {
  mode,
  setPersistence(report) {persistence = persistenceOf(report);},
  state: live,
  head,
  pending: () => link?.pending() ?? 0,
  status,
  participants,
  presence: () => [...presenceOf.values()],
  descriptor: () => descriptor,
  refusal: () => refusal,
  message: () => message,
  invite: () => invite,
  submitAction,
  async tick() {
   const active = link;
   if(active){
    const result = await active.tick();
    if(result.ok)await refresh();
    return result;
   }
   const result = options.local.dispatch({type: 'tick'});
   return result.status === 'rejected' ? failed<Head>('CONFLICT', result.reason ?? 'O núcleo recusou o tick') : ok(head() ?? unpublished());
  },
  declarePresence(label) {
   const stamp = monotonic();
   while(stamps.length && stamp - stamps[0]! > PRESENCE_WINDOW_MS)stamps.shift();
   if(stamps.length >= PRESENCE_PER_SECOND)return;
   stamps.push(stamp);
   const statement: PresenceStatement = {peer: options.self ?? 'local-player', label, at: now()};
   rememberPresence(statement);
   options.ephemeral?.send(statement);
  },
  receivePresence(statement) {rememberPresence(statement);},
  setSourceError(next) {sourceError = next;},
  notify(text) {message = text;},
  setHostVisible(visible) {hostVisible = visible;},
  setInvite(text) {invite = text;},
  async attach(next) {
   link = next;
   submitted = false;
   refusal = null;
   storageFailure = null;
   presenceOf.clear();
   stamps.length = 0;
   descriptor = {uri: sessionIdOf(next.sessionId), actor: next.actorUri, worldId: next.worldId, branchId: next.branchId, sessionId: next.sessionId, epoch: next.epoch, participants: next.participants().map(entry => `${entry.id} (${ROLE_LABELS[entry.role]})`), startedAt: now()};
   await refresh();
   try{
    await next.ready();
   }catch(error){
    message = messageOf(error);
   }
   const registry = options.registry;
   if(!registry){message = 'Sessão aberta sem registro de descritores: ninguém entra por link.';return;}
   try{
    const published = await registry.publish(sessionEnvelope(descriptor));
    if(!published.ok){message = `O descritor da sessão foi recusado: ${published.error.message}`;return;}
    // §39.5: a session is entered by resolving it, so the descriptor this device published is resolved the same way a
    // peer's would be, and a descriptor that cannot be resolved is not a session to enter.
    const joined = await registry.join(descriptor.uri);
    message = joined.ok && joined.value ? '' : 'O descritor publicado não pôde ser resolvido por join.';
   }catch(error){
    message = messageOf(error);
   }
  },
  async resolveSession(uri) {
   const registry = options.registry;
   if(!registry)return failed<SessionDescriptor | null>('NOT_FOUND', 'Esta partida não tem registro de sessões para resolver um convite');
   try{
    const joined = await registry.join(uri);
    if(!joined.ok)return failed(joined.error.code, joined.error.message);
    const found = readSessionDescriptor(joined.value);
    return found ? ok<SessionDescriptor | null>(found) : failed<SessionDescriptor | null>('NOT_FOUND', `Nada descreve a sessão ${uri}`);
   }catch(error){
    return failed<SessionDescriptor | null>('NOT_FOUND', messageOf(error));
   }
  },
  async leave(reason) {
   const closed = link;
   link = null;
   descriptor = null;
   confirmed = null;
   refusal = null;
   storageFailure = null;
   invite = '';
   submitted = false;
   presenceOf.clear();
   stamps.length = 0;
   message = reason ?? (closed ? `Sessão encerrada. A versão da sessão está em ${closed.worldId}/${closed.branchId}.` : '');
  },
  refresh,
  clearRefusal() {refusal = null;},
  describe() {
   const active = link;
   const current = head();
   return {
    mode: mode(),
    modeLabel: !active ? 'Sozinho' : active.mode === 'host' ? 'Você é o anfitrião' : 'Réplica verificadora',
    worldId: active?.worldId ?? options.worldId,
    branchId: active?.branchId ?? options.branchId,
    head: current ? `#${current.generation} ${current.commit.hash.slice(0, 7)}` : 'Sem versão',
    descriptor: descriptor?.uri ?? '',
    invite,
    status: status(),
    pending: active ? active.pending() : 0,
    participants: participants().map(entry => ({id: entry.id, role: ROLE_LABELS[entry.role]})),
    presence: [...presenceOf.values()].map(entry => `${entry.label} (${entry.peer})`),
    message,
    canCreate: !active,
    canInvite: !!active,
    canJoin: !active,
    canLeave: !!active,
    canContinueLocal: !!active,
   };
  },
 };
}

// --- the panel ------------------------------------------------------------------------------------------------
// The card the player reads: the branch, who is in it, the session descriptor and the save states the spec names. It
// is a `.panel` like the others, so `hud.ts` picks it up as one more draggable card.
export type MultiplayerInfo = {
 mode: SessionMode;
 modeLabel: string;
 worldId: string;
 branchId: string;
 head: string;
 descriptor: string;
 invite: string;
 status: SessionStatus;
 pending: number;
 participants: readonly {id: string; role: string}[];
 presence: readonly string[];
 message: string;
 canCreate: boolean;
 canInvite: boolean;
 canJoin: boolean;
 canLeave: boolean;
 canContinueLocal: boolean;
};
export type MultiplayerActions = {
 onCreate: () => void;
 onJoin: (text: string) => void;
 onInvite: () => void;
 onLeave: () => void;
 onContinueLocal: () => void;
};
export type MultiplayerPanel = {update(info: MultiplayerInfo): void;destroy(): void};

export function createMultiplayerPanel(root: HTMLElement, actions: MultiplayerActions): MultiplayerPanel {
 const doc = root.ownerDocument;
 const make = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = doc.createElement(tag);
  if(className)node.className = className;
  if(text !== undefined)node.textContent = text;
  return node;
 };
 const button = (text: string, id: string): HTMLButtonElement => {
  const node = doc.createElement('button');
  node.type = 'button';
  node.id = id;
  node.textContent = text;
  return node;
 };
 const panel = make('section', 'panel');
 panel.id = 'panel-multiplayer';
 panel.dataset.panel = 'multiplayer';
 panel.setAttribute('aria-label', 'Sessão cooperativa');
 panel.style.left = '8px';
 panel.style.top = '480px';
 panel.style.width = 'min(320px,calc(100vw - 16px))';
 const head = make('header', 'panel-head');
 head.dataset.dragHandle = '';
 const title = make('h2', 'panel-title', 'Sessão');
 const collapse = button('▾', 'multiplayer-collapse');
 collapse.className = 'panel-collapse';
 collapse.dataset.collapse = '';
 collapse.setAttribute('aria-expanded', 'true');
 collapse.setAttribute('aria-label', 'Minimizar painel Sessão');
 collapse.title = 'Minimizar painel';
 head.append(title, collapse);
 const body = make('div', 'panel-body');
 body.dataset.panelBody = '';
 const where = make('p', 'multiplayer-where');
 where.id = 'multiplayer-where';
 const statusLine = make('p', 'multiplayer-status');
 statusLine.id = 'multiplayer-status';
 statusLine.setAttribute('role', 'status');
 const detailLine = make('p', 'multiplayer-detail');
 detailLine.id = 'multiplayer-detail';
 const people = make('ul', 'multiplayer-participants');
 people.id = 'multiplayer-participants';
 const presentLine = make('p', 'multiplayer-presence');
 presentLine.id = 'multiplayer-presence';
 const descriptorLine = make('p', 'multiplayer-descriptor');
 descriptorLine.id = 'multiplayer-descriptor';
 const inviteText = doc.createElement('textarea');
 inviteText.id = 'multiplayer-invite';
 inviteText.className = 'multiplayer-invite';
 inviteText.rows = 3;
 inviteText.spellcheck = false;
 inviteText.setAttribute('aria-label', 'Convite ou oferta da sessão');
 const create = button('Criar sessão', 'multiplayer-create');
 const share = button('Convidar', 'multiplayer-invite-button');
 const join = button('Entrar', 'multiplayer-join');
 const leave = button('Sair', 'multiplayer-leave');
 const personal = button('Continuar em versão pessoal', 'multiplayer-personal');
 const controls = make('div', 'multiplayer-controls');
 controls.append(create, share, join, leave, personal);
 const messageLine = make('p', 'multiplayer-message');
 messageLine.id = 'multiplayer-message';
 messageLine.setAttribute('role', 'alert');
 body.append(where, statusLine, detailLine, people, presentLine, descriptorLine, inviteText, controls, messageLine);
 panel.append(head, body);
 root.append(panel);
 let written = '';
 const listen = <E extends Event>(target: EventTarget, type: string, handler: (event: E) => void) => {
  const listener = handler as EventListener;
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
 };
 const forget: (() => void)[] = [];
 forget.push(listen(create, 'click', () => actions.onCreate()));
 forget.push(listen(share, 'click', () => actions.onInvite()));
 forget.push(listen(join, 'click', () => actions.onJoin(inviteText.value)));
 forget.push(listen(leave, 'click', () => actions.onLeave()));
 forget.push(listen(personal, 'click', () => actions.onContinueLocal()));
 return {
  update(info) {
   where.textContent = `${info.worldId}/${info.branchId} · ${info.modeLabel} · ${info.head}`;
   statusLine.textContent = info.pending ? `${info.status.text} · ${info.pending} em andamento` : info.status.text;
   statusLine.setAttribute('data-state', info.status.kind);
   detailLine.textContent = info.status.detail;
   detailLine.hidden = !info.status.detail;
   people.replaceChildren();
   for(const participant of info.participants)people.append(make('li', undefined, `${participant.id} — ${participant.role}`));
   presentLine.textContent = info.presence.length ? `Presentes (efêmero): ${info.presence.join(', ')}` : '';
   presentLine.hidden = !info.presence.length;
   descriptorLine.textContent = info.descriptor ? `Descritor: ${info.descriptor}` : 'Sem sessão aberta';
   // The field is the player's clipboard as much as the invite's: it is only rewritten when the invite itself changed.
   if(info.invite !== written){
    written = info.invite;
    inviteText.value = info.invite;
   }
   create.hidden = !info.canCreate;
   share.hidden = !info.canInvite;
   join.hidden = !info.canJoin;
   leave.hidden = !info.canLeave;
   personal.hidden = !info.canContinueLocal;
   messageLine.textContent = info.message;
   messageLine.hidden = !info.message;
  },
  destroy() {
   for(const stop of forget)stop();
   panel.remove();
  },
 };
}
