// The cooperative session as the player meets it, independent of any surface (spec 2026-10-01 §6.3, §7; stage E). The
// flows that lived in src/browser/main.ts — open a session on a forked branch, copy the invite, join one, transfer it,
// pause it, leave it — are pure orchestration over three things the game already has: the session view (the router),
// the version machine (to fork from the version on screen) and the clock role (only the host ticks). Everything that
// needs crypto keys, a transport or signaling is an ADAPTER the host injects through `SessionPorts`: the browser host
// passes WebRTC + manual signaling, the Node/test host passes an in-memory transport. This module reaches for none of
// them, so it compiles without DOM or Node, like the rest of src/client.
import type {Head} from '../world/model';
import type {Principal} from '../world/permissions';
import type {ClockRole} from '../presentation/clock';
import type {SessionLink, SessionMode} from '../presentation/session-view';
import type {VersionsController} from './versions';

// What the controller needs from the game around it, kept as a narrow port so the session never reaches for the
// LocalSession or the panel module. The router is the GameSessionView; the versions machine forks the shared branch.
export type SessionEnv = {
 worldId: string;
 branchId: string;
 // The session view the game routes world-changing actions through. The controller only uses the slice below, so a
 // test can satisfy it without the whole panel model.
 router: SessionRouter;
 // The version machine, or null when the host composed no repository: without it there is no branch to fork, so a
 // session cannot open and the controller says so instead of pretending.
 versions: VersionsController | null;
 // Only the host advances the branch's clock (spec §7.5): opening a session makes this device the host, leaving
 // returns it to its own clock. The city client wires this to its tick clock.
 setRole(role: ClockRole): void;
 // The branches the device already holds, so a fresh session branch gets a name no existing branch has taken.
 branchIds(): Promise<readonly string[]>;
 // Fork the version on screen into a new branch the session orders; the host builds its session on this head.
 fork(base: Head, branchId: string): Promise<Head>;
 // The rules version the host stamps the session with: the state on screen carries it (spec: a session binds the
 // family and version the branch is played under). Read lazily so it is the current state, not a boot snapshot.
 rulesVersion(): number;
 // The adapters: crypto, transport and signaling the host composed.
 ports: SessionPorts;
 // Called whenever something the panel reads changed, so the surface can redraw.
 changed(): void;
};

// The slice of the session view the cooperative flows use. GameSessionView satisfies it; declared structurally so the
// client depends on the contract, not on the panel beside it.
export type SessionRouter = {
 mode(): SessionMode;
 notify(text: string): void;
 message(): string;
 setInvite(text: string): void;
 descriptor(): {uri: string} | null;
 attach(link: SessionLink): Promise<void>;
 resolveSession(uri: string): Promise<{ok: boolean; value?: {sessionId: string; worldId: string; branchId: string; epoch: number; participants: readonly unknown[]} | null; error?: {message: string}}>;
 handover(successor: Principal): Promise<{ok: boolean}>;
 pause(reason?: string): void;
 leave(reason?: string): Promise<void>;
 refresh(): Promise<void>;
};

// What a host opens for the controller: the identity, grant, transport and HostSession the adapters built, exposed as
// the SessionLink the router attaches plus the invite text a person copies and a close that drops the peers. The
// controller never sees a key, a peer or a signal — only the link and the words.
export type HostHandle = {
 link: SessionLink;
 branchId: string;
 // The §23 descriptor text, built once the session is attached (the router publishes the descriptor itself; this is
 // the copyable form). The controller asks for it when the player presses Convidar.
 invite(): string;
 close(): void;
};
export type OpenHostRequest = {worldId: string; branchId: string; sessionId: string; base: Head; rulesVersion: number};

// What a host joins for the controller: the replica SessionLink and a close. A host that cannot reach the peer
// in-memory returns null, and the controller reports the gap precisely instead of inventing a connection.
export type JoinHandle = {link: SessionLink; close(): void};
export type JoinRequest = {uri: string; worldId: string; branchId: string; sessionId: string; epoch: number};

// The adapter boundary of a session (spec §5.1 `SessionPorts`): keys, transport and signaling live behind these two
// factories, so the browser passes WebRTC + manual signaling and the Node/test host passes in-memory transports, and
// neither touches the controller. A host that cannot join (no network, no registered peer) leaves `join` off or
// returns null, and the controller documents that it joined no replica.
export type SessionPorts = {
 openHost(request: OpenHostRequest): Promise<HostHandle>;
 join?(request: JoinRequest): Promise<JoinHandle | null>;
};

export type SessionController = {
 open(): Promise<void>;
 invite(): void;
 join(text: string): Promise<void>;
 transfer(text: string): Promise<void>;
 pause(): void;
 leave(reason?: string): Promise<void>;
 // The branch the open session orders, or null when there is no live session; a host that reopens the game reads it.
 branchId(): string | null;
};

function describeError(error: unknown): string {
 const message = (error as {message?: unknown} | null)?.message;
 return typeof message === 'string' && message ? message : 'Falha ao falar com a sessão cooperativa.';
}

// A pasted invite names a session either by its URI or by the §23 document a person copied: both name the same object.
// Kept here (not in the surface) because the controller is the one place that turns a pasted blob into a session.
export function inviteUri(text: string): string | null {
 const trimmed = text.trim();
 if (trimmed.startsWith('osim:session:')) return trimmed.split(/\s/)[0] ?? null;
 let parsed: unknown;
 try {
  parsed = JSON.parse(trimmed);
 } catch {
  return null;
 }
 if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
 const id = (parsed as Record<string, unknown>)['id'];
 return typeof id === 'string' && id.startsWith('osim:session:') ? id : null;
}

// The successor of a transfer as the player names it: an actor URI with a scheme (nostr:npub1…, local:<key>). A bare
// name is refused, because handing the branch to an identifier space the client invented points at no authority.
export function readPrincipal(text: string): Principal | null {
 const trimmed = text.trim();
 if (!trimmed.length) return null;
 const separator = trimmed.indexOf(':');
 if (separator <= 0) return null;
 const scheme = trimmed.slice(0, separator), id = trimmed.slice(separator + 1).split(/\s/)[0] ?? '';
 return id.length > 0 && id.length <= 200 ? {scheme, id} : null;
}

export function createSessionController(env: SessionEnv): SessionController {
 const {router, versions} = env;
 // The live session this device holds: the branch it orders, the handle that owns the peers, and the role it took.
 let open: {handle: HostHandle | JoinHandle; branchId: string} | null = null;
 const sessionBranchId = (taken: ReadonlySet<string>): string => {
  let id = 'sessao-1';
  for (let next = 2; taken.has(id); next += 1) id = `sessao-${next}`;
  return id;
 };

 return {
  branchId: () => open?.branchId ?? null,
  async open() {
   if (router.mode() !== 'local') {
    router.notify('Já existe uma sessão aberta nesta partida.');
    env.changed();
    return;
   }
   if (!versions) {
    router.notify('Sem repositório de versões neste host: não há ramificação para compartilhar.');
    env.changed();
    return;
   }
   const base = versions.shown() ?? versions.head() ?? null;
   if (!base) {
    router.notify('Nenhuma versão aberta para compartilhar.');
    env.changed();
    return;
   }
   try {
    const taken = new Set(await env.branchIds());
    const branchId = sessionBranchId(taken);
    const forked = await env.fork(base, branchId);
    const sessionId = `${env.worldId}-${branchId}`;
    const handle = await env.ports.openHost({worldId: env.worldId, branchId, sessionId, base: forked, rulesVersion: env.rulesVersion()});
    open = {handle, branchId};
    await router.attach(handle.link);
    env.setRole('host');
    versions.setShown(forked);
    router.notify('Sessão aberta nesta versão: construa com os amigos e use Convidar para copiar o convite.');
    await versions.refresh();
   } catch (error) {
    router.notify(describeError(error));
   }
   env.changed();
  },
  invite() {
   const descriptor = router.descriptor();
   if (!descriptor) {
    router.notify('Crie a sessão antes de convidar.');
    env.changed();
    return;
   }
   const handle = open?.handle;
   const text = handle && 'invite' in handle ? handle.invite() : descriptor.uri;
   router.setInvite(text);
   router.notify('Convite pronto: passe este texto para o amigo e cole o dele em Entrar.');
   env.changed();
  },
  async join(text) {
   if (router.mode() !== 'local') {
    router.notify('Feche a sessão atual antes de entrar em outra.');
    env.changed();
    return;
   }
   const uri = inviteUri(text);
   if (!uri) {
    router.notify('O convite colado não nomeia uma sessão.');
    env.changed();
    return;
   }
   const found = await router.resolveSession(uri);
   if (!found.ok || !found.value) {
    router.notify(`Convite recusado: ${found.ok ? 'descritor ausente' : found.error?.message ?? 'não encontrado'}`);
    env.changed();
    return;
   }
   const descriptor = found.value;
   const joiner = env.ports.join;
   if (!joiner) {
    // The adapter cannot open a replica channel here (no transport wired): say exactly what was found, and that no
    // replica was joined. This is the honest gap when a host passes no `join` (e.g. a browser without a live peer).
    router.notify(`Sessão ${descriptor.sessionId}: ${descriptor.worldId}/${descriptor.branchId}, época ${descriptor.epoch}, ${descriptor.participants.length} participante(s). Este host não abre o canal da réplica.`);
    env.changed();
    return;
   }
   try {
    const handle = await joiner({uri, worldId: descriptor.worldId, branchId: descriptor.branchId, sessionId: descriptor.sessionId, epoch: descriptor.epoch});
    if (!handle) {
     router.notify(`Sessão ${descriptor.sessionId} encontrada, mas nenhum anfitrião respondeu ao canal da réplica.`);
     env.changed();
     return;
    }
    open = {handle, branchId: descriptor.branchId};
    await router.attach(handle.link);
    // A replica never orders the branch, so it never ticks: it follows the host's clock (spec §7.5).
    env.setRole('replica');
    router.notify(`Entrou na sessão ${descriptor.sessionId}: você vê o que o anfitrião confirma e constrói pelo anfitrião.`);
    await router.refresh();
   } catch (error) {
    router.notify(describeError(error));
   }
   env.changed();
  },
  async transfer(text) {
   const successor = readPrincipal(text);
   if (!successor) {
    router.notify('Escreva no campo o ator do sucessor com esquema, como nostr:npub1… ou local:<chave>.');
    env.changed();
    return;
   }
   await router.handover(successor);
   env.changed();
  },
  pause() {
   router.pause();
   env.changed();
  },
  async leave(reason) {
   const closing = open;
   if (!closing) {
    env.changed();
    return;
   }
   open = null;
   closing.handle.close();
   env.setRole('local');
   if (versions) versions.setShown(versions.head());
   await router.leave(reason ?? `Sessão encerrada. A versão compartilhada ficou em ${closing.branchId}; a partida segue na versão pessoal.`);
   if (versions) await versions.refresh();
   env.changed();
  },
 };
}
