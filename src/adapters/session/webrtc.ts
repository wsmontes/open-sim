// The cooperative session's adapters for the browser (spec 2026-10-01 §5.1 `SessionPorts`, stage E): WebRTC peers,
// manual signaling and the crypto keys that back a host session. This is exactly the wiring that lived inline in
// src/browser/main.ts; moved here so the host composes it and hands the controller only the SessionLink and the invite
// text. The in-memory counterpart (src/adapters/session/memory.ts) is what the Node/test host passes instead.
//
// Joining a session as a replica over WebRTC needs the signed signal of §Task 8, which this build does not drive yet:
// `join` is therefore left off, and the client controller reports the honest gap ("este host não abre o canal da
// réplica") after it resolves the descriptor. Hosting, inviting, transferring, pausing and leaving all work.
import type {Grant, Principal} from '../../world/permissions';
import {grantBytes} from '../../world/permissions';
import type {WorldCodec, ContentHasher} from '../../world/ports';
import type {SignatureVerifier} from '../../world/permissions';
import type {SessionListener, SessionTransport} from '../../session/multiplayer-ports';
import {createHostSession} from '../../session/host-session';
import type {CapabilityPublisher} from '../../session/host-session';
import type {WorldRepository} from '../../session/world-repository';
import type {MapSource} from '../../session/ports';
import {hostSessionLink} from '../../presentation/session-view';
import type {SessionLink} from '../../presentation/session-view';
import {sessionText} from './descriptor';
import {createWebRtcPeers} from '../network/webrtc';
import {createManualSignaling} from '../network/manual-signaling';
import {generateSessionKeyPair, localIdentityProvider, signEd25519} from '../crypto/session-keys';
import type {HostHandle, OpenHostRequest, SessionPorts} from '../../client/session';

export type WebRtcSessionConfig = {
 repository: WorldRepository;
 codec: WorldCodec;
 hasher: ContentHasher;
 maps: MapSource;
 verifier: SignatureVerifier;
 // The object plane a session's descriptor and transfer capability are published to and resolved from (the kernel).
 capabilities: CapabilityPublisher & {publish(object: unknown): Promise<{ok: boolean}>};
 // The host's own peer identifier on the signaling plane; the browser uses a fixed local name as it did inline.
 self?: string;
 relay?: {stun?: readonly string[]};
};

const SPEND_LIMIT = 1_000_000;

// Frames to the host's own peer stay on the device; everything else goes to the WebRTC transport (as main.ts did).
function localFirst(transport: SessionTransport, self: string): SessionTransport {
 const listeners = new Set<SessionListener>();
 return {
  async send(peer, message) {
   if (peer === self) { for (const listener of [...listeners]) listener(self, message); return; }
   await transport.send(peer, message);
  },
  subscribe(listener) {
   listeners.add(listener);
   const stop = transport.subscribe(listener);
   return () => { listeners.delete(listener); stop(); };
  },
 };
}

export function createWebRtcSessionPorts(config: WebRtcSessionConfig): SessionPorts {
 const self = config.self ?? 'local-device';
 const openHost = async (request: OpenHostRequest): Promise<HostHandle> => {
  const startedAt = new Date();
  const instant = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;
  const root = await generateSessionKeyPair(), keys = await generateSessionKeyPair();
  const principal: Principal = {scheme: 'local', id: root.publicKey};
  const scope = {
   worldId: request.worldId, branchId: request.branchId, sessionId: request.sessionId,
   notBefore: instant(startedAt), notAfter: instant(new Date(startedAt.getTime() + 12 * 3600_000)),
  };
  const bound = await localIdentityProvider({root, session: keys, codec: config.codec}).bindSession({principal, scope});
  if (!bound.ok) throw new Error(bound.error.message);
  const unsigned: Grant = {
   kind: 'grant', id: `proprietario-${request.sessionId}`, principal, worldId: request.worldId, branchId: request.branchId,
   actions: ['build', 'demolish', 'component', 'tick', 'policy', 'host'], namespaces: [], spendLimit: SPEND_LIMIT,
   proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: root.publicKey, signature: ''},
  };
  const grant: Grant = {...unsigned, proof: {kind: 'message', algorithm: 'Ed25519', sessionKey: root.publicKey, signature: await signEd25519(root, grantBytes(unsigned, config.codec))}};
  const epoch = 1;
  const scopeWire = {worldId: request.worldId, branchId: request.branchId, sessionId: request.sessionId, epoch};
  const signer = {key: keys.publicKey, sign: (bytes: Uint8Array) => signEd25519(keys, bytes)};
  // The transport is the WebRTC one, dialed by the signaling adapter when a peer's signal arrives: with nobody bound
  // yet it carries nothing, and the invite a person copies is the §23 descriptor of the session.
  const peers = createWebRtcPeers({
   codec: config.codec, actor: `local:${root.publicKey}`, session: scopeWire, signer,
   signaling: createManualSignaling({codec: config.codec, verifier: config.verifier, session: scopeWire, bindings: {}}),
   hasher: config.hasher, relay: {stun: [...(config.relay?.stun ?? ['stun:stun.l.google.com:19302'])]},
  });
  const transport = localFirst(peers.transport, self);
  const host = createHostSession({
   repository: config.repository, transport, peer: self, head: request.base, identity: bound.value, grants: [grant],
   rules: {family: 'city', version: request.rulesVersion}, bases: config.maps, verifier: config.verifier, codec: config.codec,
   hasher: config.hasher, now: () => instant(startedAt), sessionId: request.sessionId, epoch, peers: [], capabilities: config.capabilities,
  });
  const link: SessionLink = hostSessionLink(host, {
   worldId: request.worldId, branchId: request.branchId, sessionId: request.sessionId, epoch, principal,
   sessionKey: keys.publicKey, signer, codec: config.codec, costLimit: SPEND_LIMIT, transport, peer: self,
   identity: bound.value, grants: [grant],
  });
  return {
   link, branchId: request.branchId,
   invite: () => sessionText({uri: `osim:session:${request.sessionId}`, actor: `${principal.scheme}:${principal.id}`, worldId: request.worldId, branchId: request.branchId, sessionId: request.sessionId, epoch, participants: [`${principal.id} (anfitrião)`], startedAt: startedAt.toISOString()}, config.codec),
   close: () => peers.close(),
  };
 };
 // No `join`: joining a replica over WebRTC awaits the signed signal of Task 8. The controller reports the gap.
 return {openHost};
}
