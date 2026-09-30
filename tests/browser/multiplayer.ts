// A manual live session between two real browsers, driven by copy and paste
// (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.3, §8.4; plan Tarefa 8). The platform peer is the
// real `RTCPeerConnection`, the codec and the hasher are the same adapters the rest of the client uses, and the only
// thing that is manual is the signaling: each side shows a text, a person carries it to the other side, and the
// adapter refuses anything that was not signed by the key the invite bound to that participant.
//
// What this page can prove: the three data channels open, signed offers and answers are accepted and tampered ones are
// not, a session descriptor published by one side is resolved by the other, and an object travels in segments and is
// checked against its address. What it cannot prove — and must never be read as proving — is NAT traversal or relay
// behavior: two tabs on one machine share one network stack and one host.
import {createJcsCodec} from '../../src/adapters/codec/jcs';
import {bytesHasher} from '../../src/adapters/hash/content';
import {createDirectObjectStore} from '../../src/adapters/blobs/direct';
import type {ObjectStore} from '../../src/adapters/blobs/direct';
import {ed25519Verifier,generateSessionKeyPair,signEd25519} from '../../src/adapters/crypto/session-keys';
import type {KeyPair} from '../../src/adapters/crypto/session-keys';
import {createManualSignaling} from '../../src/adapters/network/manual-signaling';
import type {ManualSignaling,SessionScope} from '../../src/adapters/network/manual-signaling';
import {createWebRtcPeers,sessionDescriptor} from '../../src/adapters/network/webrtc';
import type {WebRtcConfig,WebRtcPeers} from '../../src/adapters/network/webrtc';
import {WORLD_PROTOCOL,WIRE_VERSION} from '../../src/world/model';
import type {ObjectRef} from '../../src/world/model';
import type {WireEnvelope} from '../../src/world/wire';

const codec = createJcsCodec(), hasher = bytesHasher();
const element = <T extends HTMLElement>(id: string): T => {
 const found = document.getElementById(id);
 if (!found) throw new Error(`Página sem #${id}`);
 return found as T;
};
const registro = element<HTMLPreElement>('registro'), estado = element<HTMLPreElement>('estado');
const say = (line: string) => { registro.textContent = `${new Date().toLocaleTimeString()} · ${line}\n${registro.textContent ?? ''}`; };
const field = (id: string) => element<HTMLTextAreaElement>(id).value.trim();

// The invite of one participant: who it is, which key signs its signals this session, and which session that is. A real
// invite is a signed object (Tarefa 10); here a person carries it, which is the same information through a slower
// channel.
type Invite = {actor: string; sessionKey: string; session: SessionScope; name: string};
type Side = {invite: Invite; keys: KeyPair; signaling: ManualSignaling; peers: WebRtcPeers; store: ObjectStore; space: string};
let side: Side | null = null;

function parseInvite(text: string): Invite {
 const parsed = JSON.parse(text) as Invite;
 if (!parsed.actor || !parsed.sessionKey || !parsed.session?.sessionId || !parsed.session.worldId) throw new Error('Código de convite incompleto');
 return parsed;
}
function readInvite(id: string): Invite {
 try { return parseInvite(field(id)); } catch (error) { say(`código ilegível: ${error instanceof Error ? error.message : String(error)}`); throw error; }
}
// One side of the session: its own identity, the store it serves objects from, and a signaling that accepts a peer's
// signals only with the key the invite bound to that peer. Anything signed by another key is refused before an offer
// ever reaches the platform.
function startSide(invite: Invite, keys: KeyPair, peer: Invite, store: ObjectStore): Side {
 const signaling = createManualSignaling({codec, verifier:ed25519Verifier(), session:invite.session, bindings:{[peer.actor]:peer.sessionKey}});
 const space = 'osim:space:earth';
 const config: WebRtcConfig = {
  codec, hasher, actor:invite.actor, session:invite.session, signer:{key:keys.publicKey, sign:bytes => signEd25519(keys, bytes)},
  signaling, store, onRefused:(from, error) => say(`recusado por ${from}: ${error.code} ${error.message}`),
 };
 const peers = createWebRtcPeers(config);
 // Everything that arrives on the message port is logged by class: that is what tells a proposal (durable) apart from a
 // cursor (ephemeral) without either of them carrying meaning for the transport.
 peers.transport.subscribe((from, message) => say(`recebido de ${from}: classe ${message.envelope.class}`));
 return {invite, keys, signaling, store, space, peers};
}
function rebind(peer: Invite) {
 if (!side) throw new Error('Gere a identidade primeiro');
 const {invite, keys, store} = side;
 side = startSide(invite, keys, peer, store);
}
const peerActor = () => (side ? readInvite('codigo-par').actor : '');
// Manual signaling trickles: the offer goes out first and the candidates of this device follow as the platform gathers
// them. So the thing a person carries is not one message but the whole outbox view, one signal per line, and pasting it
// on the other side delivers every line — a line that was already used is refused as a replay, which is what the log
// shows.
function fillBox(boxId: string, signaling: ManualSignaling) {
 const pending = signaling.pending().map(entry => entry.text);
 element<HTMLTextAreaElement>(boxId).value = pending.join('\n');
 say(`caixa de saída com ${pending.length} sinal(is)`);
}
async function pasteBox(signaling: ManualSignaling, text: string) {
 const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
 let accepted = 0, refused = 0;
 for (const line of lines) {
  const outcome = await signaling.paste(line);
  if (outcome.ok) accepted += 1; else { refused += 1; say(`linha recusada: ${outcome.error.code} ${outcome.error.message}`); }
 }
 say(`caixa colada: ${accepted} sinal(is) aceito(s), ${refused} recusado(s)`);
}
function waitFor(peer: string) {
 if (!side) throw new Error('Sessão ainda não começou');
 say(`esperando os canais com ${peer}…`);
 void side.peers.opened(peer).then(() => {
  estado.textContent = `conectado a ${peer} · canais de controle, efêmero e objeto abertos`;
  say(`canais abertos com ${peer}`);
 }).catch(error => say(`conexão falhou: ${String(error)}`));
}
// Every button reports its failure in the log instead of dying in the console: this page is a diagnostic, and a silent
// failure would look like a network problem.
function onClick(id: string, action: () => Promise<void> | void) {
 element<HTMLButtonElement>(id).addEventListener('click', () => {
  void (async () => { try { await action(); } catch (error) { say(`falhou: ${error instanceof Error ? error.message : String(error)}`); } })();
 });
}

onClick('gerar', async () => {
 const name = element<HTMLInputElement>('nome').value.trim() || 'jogador';
 const pasted = field('codigo-par');
 const keys = await generateSessionKeyPair();
 // The guest joins the session the invite names; the host names a new one. Either way the session id comes with the
 // invite, so both sides sign the same session and the same epoch.
 const session: SessionScope = pasted ? parseInvite(pasted).session : {worldId:'victoria', branchId:'main', sessionId:`sessao${Date.now().toString(36)}`, epoch:1};
 const invite: Invite = {actor:`local:${name}`, sessionKey:keys.publicKey, session, name};
 element<HTMLTextAreaElement>('codigo-local').value = JSON.stringify(invite);
 // Without the peer's code yet, this side is its own peer for the purpose of a signaling that accepts nobody.
 side = startSide(invite, keys, pasted ? parseInvite(pasted) : invite, createDirectObjectStore({hasher}));
 estado.textContent = `identidade ${invite.actor} pronta · sessão ${session.sessionId} na época ${session.epoch}`;
 say(`identidade criada: ${invite.actor}`);
});

onClick('registrar', () => {
 rebind(readInvite('codigo-par'));
 say(`convite de ${peerActor()} registrado: só sinais assinados por essa chave de sessão são aceitos`);
 estado.textContent = `convite de ${peerActor()} registrado na sessão ${side?.invite.session.sessionId ?? ''}`;
});

onClick('oferta', async () => {
 if (!side) throw new Error('Gere a identidade e registre o convite primeiro');
 const peer = peerActor();
 const outcome = await side.peers.invite(peer);
 if (!outcome.ok) { say(`a oferta não saiu: ${outcome.error.message}`); return; }
 fillBox('saida-oferta', side.signaling);
 say(`oferta assinada para ${peer}: copie a caixa e leve ao convidado`);
 waitFor(peer);
});

onClick('atualizar-oferta', () => {
 if (!side) throw new Error('Sessão ainda não começou');
 fillBox('saida-oferta', side.signaling);
});

onClick('entrar', async () => {
 if (!side) throw new Error('Gere a identidade e registre o convite primeiro');
 await pasteBox(side.signaling, field('entrada-oferta'));
 if (!side.peers.connected().length) { say('a oferta ainda não abriu conexão: confira se a caixa do anfitrião inteira foi colada'); return; }
 const peer = side.peers.connected()[0]!;
 // `paste` waits for the handler, so the answer is already signed in the outbox when it returns.
 fillBox('saida-resposta', side.signaling);
 say(`resposta assinada para ${peer}: copie a caixa e leve de volta ao anfitrião`);
 waitFor(peer);
});

onClick('atualizar-resposta', () => {
 if (!side) throw new Error('Sessão ainda não começou');
 fillBox('saida-resposta', side.signaling);
});

onClick('aceitar', async () => {
 if (!side) throw new Error('Gere a identidade e registre o convite primeiro');
 await pasteBox(side.signaling, field('entrada-resposta'));
 const peer = side.peers.connected()[0];
 if (peer) waitFor(peer);
});

// §24/§45: a presence frame is disposable — it must not become history, and it must not queue behind durable work.
onClick('presenca', async () => {
 if (!side) throw new Error('Sessão ainda não começou');
 const peer = peerActor();
 const envelope: WireEnvelope = {worldProtocol:WORLD_PROTOCOL, wireVersion:WIRE_VERSION, kind:'message', class:'ephemeral', worldId:side.invite.session.worldId, branchId:side.invite.session.branchId, sessionId:side.invite.session.sessionId, epoch:side.invite.session.epoch, id:`presenca${Date.now().toString(36)}`};
 await side.peers.transport.send(peer, {envelope, body:{kind:'osim.presence', cursor:{x:12.5, y:-4}}});
 say('cursora efêmero enviado: não vira evento, não espera o canal durável');
});

onClick('publicar', async () => {
 if (!side) throw new Error('Sessão ainda não começou');
 const peer = peerActor();
 const descriptor = sessionDescriptor(side.invite.session, {actor:side.invite.actor, space:side.space, participants:[side.invite.actor, peer], mode:'realtime', startedAt:new Date().toISOString()});
 const published = await side.peers.objects.publish(descriptor);
 say(published.ok ? `descritor ${descriptor.id} publicado e replicado` : `publicação recusada: ${published.error.message}`);
});

onClick('resolver', async () => {
 if (!side) throw new Error('Sessão ainda não começou');
 const resolved = await side.peers.objects.resolve(`osim:session:${side.invite.session.sessionId}`);
 say(resolved.ok && resolved.value ? `descritor resolvido: ${JSON.stringify(resolved.value.body)}` : `o descritor não veio: ${resolved.ok ? 'ninguém tem' : resolved.error.message}`);
});

onClick('enviar', async () => {
 if (!side) throw new Error('Sessão ainda não começou');
 const block = new Uint8Array(64 * 1024);
 for (let index = 0; index < block.length; index += 1) block[index] = (index * 29 + 5) % 251;
 const stored = await side.store.put(block);
 if (!stored.ok) { say(`o bloco não entrou: ${stored.error.message}`); return; }
 element<HTMLTextAreaElement>('endereco').value = `${stored.value.hash}:${stored.value.bytes}`;
 say(`bloco de 64 KiB guardado em ${stored.value.hash.slice(0, 12)}…; leve o endereço para o outro lado`);
});

onClick('transferir', async () => {
 if (!side) throw new Error('Sessão ainda não começou');
 const [hash, bytes] = field('entrada-endereco').split(':');
 const ref: ObjectRef = {hash:hash ?? '', bytes:Number(bytes)};
 const got = await side.peers.transfer(ref, peerActor());
 say(got.ok ? `objeto recebido e conferido contra o endereço: ${got.value.byteLength} bytes` : `transferência recusada: ${got.error.code} ${got.error.message}`);
});
