// The cooperative session's adapters for a single process (spec 2026-10-01 §5.1 `SessionPorts`, stage E): keys,
// transport and the host/replica sessions wired over an in-memory network and kernel registry, so two clients in one
// test or terminal can share one branch with no network stack. The browser host passes WebRTC + manual signaling
// instead; the client controller (src/client/session.ts) never sees either — it only receives the SessionLink and the
// invite text through the SessionPorts contract.
//
// Both players back onto one shared world storage here, which is the honest shape of two clients in one process: the
// bytes a host freezes are the bytes a replica reads, so adoption needs no base-request round trip and the replica
// catches up as soon as the network is drained. On a real network the two devices hold separate storages and the
// session layer already asks for the frozen regions it lacks (tests/multiplayer-session.test.ts); that path is a host
// concern, not the client's.
import type {Head} from '../../world/model';
import type {Grant, Principal} from '../../world/permissions';
import {grantBytes} from '../../world/permissions';
import {createKernel} from '../../world/kernel';
import type {Kernel} from '../../world/kernel';
import type {WorldCodec, ContentHasher} from '../../world/ports';
import type {SignatureVerifier} from '../../world/permissions';
import type {SessionListener, SessionTransport} from '../../session/multiplayer-ports';
import {createHostSession} from '../../session/host-session';
import {createReplicaSession} from '../../session/replica-session';
import type {ReplicaSession} from '../../session/replica-session';
import {createWorldRepository} from '../../session/world-repository';
import type {WorldRepository} from '../../session/world-repository';
import type {WorldStorage} from '../../session/world-ports';
import type {MapSource} from '../../session/ports';
import {hostSessionLink, replicaSessionLink} from '../../presentation/session-view';
import type {SessionLink} from '../../presentation/session-view';
import {sessionText} from './descriptor';
import {createMemoryNetwork} from '../network/memory';
import type {MemoryNetwork} from '../network/memory';
import {generateSessionKeyPair, localIdentityProvider, signEd25519, ed25519Verifier} from '../crypto/session-keys';
import type {HostHandle, JoinHandle, JoinRequest, OpenHostRequest, SessionPorts} from '../../client/session';

export type MemorySessionConfig = {
 repository: WorldRepository;
 storage: WorldStorage;
 codec: WorldCodec;
 hasher: ContentHasher;
 maps: MapSource;
 // Wall-clock ISO instant for the identity scope and the host's `now`; a manual clock keeps it deterministic.
 now: () => string;
 verifier?: SignatureVerifier;
 kernel?: Kernel;
};

// A host registered in this process, so `join` can find who to talk to and present a grant the owner signed. The
// owner's root key is what signs a collaborator's grant: an invite that carried no authority would be refused by the
// replica, so the fabric mints one here the way a real owner would when it admits a friend.
type RegisteredHost = {
 peer: string;
 ownerRoot: {publicKey: string; secretKey: string};
 ownerSession: {publicKey: string; secretKey: string};
 ownerGrant: Grant;
 liveHead(): Head;
 scope: {worldId: string; branchId: string; sessionId: string; epoch: number; notBefore: string; notAfter: string};
 rulesVersion: number;
 addPeer(peer: string): void;
};

// Frames addressed to a client's own peer stay on the device: that is where a client presents its identity to the
// session it hosts, so a host can accept its own proposal without a round trip (spec §7.4). The browser's main.ts has
// the same wrapper; it is logic, not an adapter, so it lives wherever the transport is composed.
function localFirst(transport: SessionTransport, self: string): SessionTransport {
 const listeners = new Set<SessionListener>();
 return {
  async send(peer, message) {
   if (peer === self) {
    for (const listener of [...listeners]) listener(self, message);
    return;
   }
   await transport.send(peer, message);
  },
  subscribe(listener) {
   listeners.add(listener);
   const stop = transport.subscribe(listener);
   return () => {
    listeners.delete(listener);
    stop();
   };
  },
 };
}

export type MemorySessionPorts = SessionPorts & {
 // Drains the in-memory network until nothing is queued, letting both sessions read what they were sent. A caller
 // (the playthrough runner) calls this after a step so a replica sees what the host just confirmed.
 settle(rounds?: number): Promise<void>;
 network: MemoryNetwork;
};

export function createMemorySessionPorts(config: MemorySessionConfig): MemorySessionPorts {
 const verifier = config.verifier ?? ed25519Verifier();
 const kernel = config.kernel ?? createKernel();
 const net = createMemoryNetwork();
 // The sessions wired on this fabric, so `settle` can let each read its inbox and the host can tick its replicas.
 const idlers = new Set<() => Promise<void>>();
 const hosts = new Map<string, RegisteredHost>();
 let peerCount = 0;
 const SPEND_LIMIT = 1_000_000;

 const settle = async (rounds = 24): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
   for (const idle of [...idlers]) await idle();
   if (!net.queued()) return;
   net.deliver();
  }
  for (const idle of [...idlers]) await idle();
 };

 const openHost = async (request: OpenHostRequest): Promise<HostHandle> => {
  const peer = `host-${(peerCount += 1)}`;
  const ownerRoot = await generateSessionKeyPair();
  const ownerSession = await generateSessionKeyPair();
  const startedAt = new Date(Date.parse(config.now()));
  // The session's instants are second-precision UTC (world/permissions INSTANT): a millisecond form is refused, so
  // the scope and `now` are formatted to the second the protocol accepts.
  const instant = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
  const scope = {
   worldId: request.worldId,
   branchId: request.branchId,
   sessionId: request.sessionId,
   notBefore: instant(startedAt),
   notAfter: instant(new Date(startedAt.getTime() + 12 * 3600_000)),
  };
  const principal: Principal = {scheme: 'local', id: ownerRoot.publicKey};
  const bound = await localIdentityProvider({root: ownerRoot, session: ownerSession, codec: config.codec}).bindSession({principal, scope});
  if (!bound.ok) throw new Error(bound.error.message);
  // A local principal is its root key: what this device signs with is what this device is.
  const unsigned: Grant = {
   kind: 'grant', id: `proprietario-${request.sessionId}`, principal, worldId: request.worldId, branchId: request.branchId,
   actions: ['build', 'demolish', 'component', 'tick', 'policy', 'host'], namespaces: [], spendLimit: SPEND_LIMIT,
   proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: ownerRoot.publicKey, signature: ''},
  };
  const grant: Grant = {...unsigned, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: ownerRoot.publicKey, signature: await signEd25519(ownerRoot, grantBytes(unsigned, config.codec))}};
  const epoch = 1;
  const peers: string[] = [];
  // Frames addressed to the host's own peer are delivered synchronously (localFirst), so the host reads its own
  // identity before it orders its first proposal without a network round trip (§7.4 step 2) — the browser does the
  // same. Frames to other peers go through the memory network, drained by `settle`.
  const transport = localFirst(net.connect(peer), peer);
  const signer = {key: ownerSession.publicKey, sign: (bytes: Uint8Array) => signEd25519(ownerSession, bytes)};
  const host = createHostSession({
   repository: config.repository, transport, peer, head: request.base, identity: bound.value, grants: [grant],
   rules: {family: 'city', version: request.rulesVersion}, bases: config.maps, verifier, codec: config.codec, hasher: config.hasher,
   now: () => instant(startedAt), sessionId: request.sessionId, epoch, peers, capabilities: kernel,
  });
  const hostIdle = () => host.idle();
  idlers.add(hostIdle);
  const registered: RegisteredHost = {
   peer, ownerRoot, ownerSession, ownerGrant: grant, liveHead: () => host.head(), scope: {...scope, epoch}, rulesVersion: request.rulesVersion,
   addPeer: next => { if (!peers.includes(next)) peers.push(next); },
  };
  hosts.set(request.sessionId, registered);
  const link: SessionLink = hostSessionLink(host, {
   worldId: request.worldId, branchId: request.branchId, sessionId: request.sessionId, epoch, principal,
   sessionKey: ownerSession.publicKey, signer, codec: config.codec, costLimit: SPEND_LIMIT, transport, peer,
   identity: bound.value, grants: [grant],
  });
  return {
   link, branchId: request.branchId,
   invite: () => sessionText({uri: `osim:session:${request.sessionId}`, actor: `${principal.scheme}:${principal.id}`, worldId: request.worldId, branchId: request.branchId, sessionId: request.sessionId, epoch, participants: [`${principal.id} (anfitrião)`], startedAt: startedAt.toISOString()}, config.codec),
   close: () => { idlers.delete(hostIdle); net.disconnect(peer); hosts.delete(request.sessionId); },
  };
 };

 const join = async (request: JoinRequest): Promise<JoinHandle | null> => {
  const host = hosts.get(request.sessionId);
  if (!host) return null; // no host registered in this process for that invite: an honest "nobody answered".
  const peer = `replica-${(peerCount += 1)}`;
  host.addPeer(peer);
  const joinerRoot = await generateSessionKeyPair();
  const joinerSession = await generateSessionKeyPair();
  const principal: Principal = {scheme: 'local', id: joinerRoot.publicKey};
  const scope = {worldId: request.worldId, branchId: request.branchId, sessionId: request.sessionId, notBefore: host.scope.notBefore, notAfter: host.scope.notAfter};
  const bound = await localIdentityProvider({root: joinerRoot, session: joinerSession, codec: config.codec}).bindSession({principal, scope});
  if (!bound.ok) throw new Error(bound.error.message);
  // The owner admits the friend: the grant naming the collaborator is signed with the owner's session key, which is
  // exactly what a replica verifies against the owner's binding before it trusts a commit it carries.
  const unsigned: Grant = {
   kind: 'grant', id: `colaborador-${principal.id}`, principal, worldId: request.worldId, branchId: request.branchId,
   actions: ['build', 'demolish', 'component'], namespaces: [], spendLimit: SPEND_LIMIT,
   proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: host.ownerSession.publicKey, signature: ''},
  };
  const grant: Grant = {...unsigned, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: host.ownerSession.publicKey, signature: await signEd25519(host.ownerSession, grantBytes(unsigned, config.codec))}};
  const transport = net.connect(peer);
  const signer = {key: joinerSession.publicKey, sign: (bytes: Uint8Array) => signEd25519(joinerSession, bytes)};
  // The replica reads the host's branch out of the shared storage it was opened against; a fresh repository over the
  // same storage keeps the replica's own head cursor without duplicating the bytes.
  const replicaRepo = createWorldRepository({storage: config.storage, codec: config.codec, hasher: config.hasher});
  // A late joiner starts at the host's current confirmed head, so it sees everything already built on this shared
  // storage; from there it verifies and adopts each new commit the host sends. (On a real network the replica would
  // request the frozen prefix it lacks; the shared storage makes that a local read here.)
  const startHead = host.liveHead();
  const replica: ReplicaSession = createReplicaSession({
   repository: replicaRepo, transport, peer, host: host.peer, head: startHead, verifier, codec: config.codec, hasher: config.hasher,
   now: () => host.scope.notBefore, sessionId: request.sessionId, epoch: request.epoch, grants: [host.ownerGrant, grant],
  });
  const replicaIdle = () => replica.idle();
  idlers.add(replicaIdle);
  const link: SessionLink = replicaSessionLink(replica, replicaRepo, host.peer, {
   worldId: request.worldId, branchId: request.branchId, sessionId: request.sessionId, epoch: request.epoch, principal,
   sessionKey: joinerSession.publicKey, signer, codec: config.codec, costLimit: SPEND_LIMIT, transport, peer,
   identity: bound.value, grants: [grant], peers: [{id: host.ownerRoot.publicKey, role: 'host'}],
  });
  return {link, close: () => { idlers.delete(replicaIdle); net.disconnect(peer); }};
 };

 return {openHost, join, settle, network: net};
}
