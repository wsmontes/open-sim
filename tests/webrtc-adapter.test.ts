// The live channel of a player-hosted session (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.3, §8.4;
// OpenSim Protocol §23, §30): one peer connection per participant with three data channels, an offer and an answer that
// travel as a signed message the players copy by hand, and the object port of the protocol on top of the same link.
// The platform peer is injected and the signaling is a text outbox, so nothing here touches a real network, a public
// STUN/TURN server or a relay — and two pages on one machine are not evidence about NAT, which is why no test claims
// that.
import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createDirectObjectStore} from '../src/adapters/blobs/direct';
import type {ObjectStore} from '../src/adapters/blobs/direct';
import {ed25519Verifier,generateSessionKeyPair,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {createManualSignaling,signalText,signSignal} from '../src/adapters/network/manual-signaling';
import type {ManualSignaling,SessionScope,SessionSigner,SignedSignal} from '../src/adapters/network/manual-signaling';
import {BUFFER_AGREEMENT} from '../src/adapters/network/object-transfer';
import {createWebRtcObjectTransport,createWebRtcPeers,createWebRtcTransport,sessionDescriptor} from '../src/adapters/network/webrtc';
import type {RelayPolicy,RtcChannel,RtcConfiguration,RtcDescription,RtcEvent,RtcFactory,RtcIceCandidate,RtcPeer,TurnCredentials,WebRtcConfig,WebRtcPeers} from '../src/adapters/network/webrtc';
import {createKernel} from '../src/world/kernel';
import type {KernelTransport} from '../src/world/kernel';
import {WORLD_PROTOCOL,WIRE_VERSION} from '../src/world/model';
import type {WorldError} from '../src/world/model';
import {envelopeOf} from '../src/world/osim';
import {encodeMessage} from '../src/world/wire';
import type {Limits,TrafficClass,WireEnvelope,WireMessage} from '../src/world/wire';
import type {SessionTransport} from '../src/session/multiplayer-ports';

const codec=createJcsCodec(),hasher=bytesHasher(),verifier=ed25519Verifier();
const NOW='2026-09-29T12:00:00Z';
const ANA='did:key:z6MkAna',BOB='did:key:z6MkBob';
const SESSION:SessionScope={worldId:'victoria',branchId:'main',sessionId:'sessao-1',epoch:1};
const ANA_KEYS=await generateSessionKeyPair(),BOB_KEYS=await generateSessionKeyPair(),STRANGER_KEYS=await generateSessionKeyPair();
const signerOf=(keys:KeyPair):SessionSigner=>({key:keys.publicKey,sign:bytes=>signEd25519(keys,bytes)});
// Platform work (WebCrypto) completes in turns of the event loop, so the harness waits for a turn rather than a
// duration: no sleep, no wall clock.
const turn=()=>new Promise<void>(resolve=>{setImmediate(resolve);});
const bytesOf=(length:number)=>{const bytes=new Uint8Array(length);for(let i=0;i<length;i+=1)bytes[i]=(i*29+5)%251;return bytes;};
// A framed message whose encoded size is exactly `size`: the ceiling is checked on bytes, so a test has to state bytes.
const messageOf=(traffic:TrafficClass,size:number,over:Partial<WireEnvelope>={}):WireMessage=>{
 const envelope:WireEnvelope={worldProtocol:WORLD_PROTOCOL,wireVersion:WIRE_VERSION,kind:'message',class:traffic,worldId:SESSION.worldId,branchId:SESSION.branchId,sessionId:SESSION.sessionId,epoch:SESSION.epoch,id:`m-${traffic}-${size}`,...over};
 const empty=encodeMessage({envelope,body:{kind:'probe',pad:''}},codec).byteLength;
 return {envelope,body:{kind:'probe',pad:'x'.repeat(size-empty)}};
};

// A peer connection that lives in this process. Two fake peers are paired by the factory, descriptions travel through
// the same signals a person copies by hand, and the channels are wired by label once both sides hold a description.
// `deliver` puts a frame on a channel as if the peer had sent it — which is how a hostile or broken frame is
// simulated — and `dropAll` empties the platform buffer the way a real data channel does while it drains.
type FakeChannel=RtcChannel&{
 sent:Uint8Array[];
 options:{ordered?:boolean;maxRetransmits?:number};
 deliver(frame:Uint8Array):void;
 fill(bytes:number):void;
 dropAll():void;
 open():void;
 attach(other:FakeChannel):void;
};
function fakeChannel(label:string,options:{ordered?:boolean;maxRetransmits?:number}={}):FakeChannel{
 const listeners=new Map<string,Set<(event:RtcEvent)=>void>>();
 const sent:Uint8Array[]=[];
 let twin:FakeChannel|null=null,buffer=0,state='connecting',closed=false;
 const emit=(type:string,event:RtcEvent={})=>{for(const listener of [...(listeners.get(type)??[])])listener({type,...event});};
 const channel:FakeChannel={
  label,options,sent,binaryType:'arraybuffer',bufferedAmountLowThreshold:0,
  get readyState(){return state;},
  get bufferedAmount(){return buffer;},
  set bufferedAmount(value:number){buffer=value;},
  send(data){const frame=data.slice();buffer+=frame.byteLength;sent.push(frame);twin?.deliver(frame);},
  close(){if(closed)return;closed=true;state='closed';emit('close');twin?.close();},
  addEventListener(type,listener){const set=listeners.get(type)??new Set();set.add(listener);listeners.set(type,set);},
  removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
  deliver(frame){emit('message',{data:frame});},
  fill(bytes){buffer+=bytes;},
  dropAll(){buffer=0;emit('bufferedamountlow');},
  open(){state='open';emit('open');},
  attach(other){twin=other;},
 };
 return channel;
}
type FakePeer=RtcPeer&{
 configuration:RtcConfiguration;
 candidates:RtcIceCandidate[];
 channel(label:string):FakeChannel|null;
 labels():string[];
 ready():boolean;
 adopt(channel:FakeChannel):void;
 wired():boolean;
 markConnected():void;
};
function fakePeer(configuration:RtcConfiguration,poke:()=>void):FakePeer{
 const channels=new Map<string,FakeChannel>();
 const listeners=new Map<string,Set<(event:RtcEvent)=>void>>();
 const candidates:RtcIceCandidate[]=[];
 let local:RtcDescription|null=null,remote:RtcDescription|null=null,state='new',connected=false;
 const emit=(type:string,event:RtcEvent={})=>{for(const listener of [...(listeners.get(type)??[])])listener({type,...event});};
 return {
  configuration,candidates,
  createDataChannel(label,options){const channel=fakeChannel(label,options);channels.set(label,channel);return channel;},
  async createOffer(){return {type:'offer',sdp:'v=0\r\no=fake-offer 1 1 IN IP4 127.0.0.1\r\n'};},
  async createAnswer(){return {type:'answer',sdp:'v=0\r\no=fake-answer 1 1 IN IP4 127.0.0.1\r\n'};},
  async setLocalDescription(description){local=description;state='connecting';emit('icecandidate',{candidate:{candidate:'candidate:1 1 udp 2122260223 127.0.0.1 4000 typ host',sdpMid:'0',sdpMLineIndex:0}});poke();},
  async setRemoteDescription(description){remote=description;poke();},
  async addIceCandidate(candidate){if(candidate)candidates.push(candidate);},
  get localDescription(){return local;},
  get remoteDescription(){return remote;},
  get connectionState(){return state;},
  close(){state='closed';for(const channel of channels.values())channel.close();emit('connectionstatechange');},
  addEventListener(type,listener){const set=listeners.get(type)??new Set();set.add(listener);listeners.set(type,set);},
  removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
  channel:label=>channels.get(label)??null,
  labels:()=>[...channels.keys()],
  ready:()=>local!==null&&remote!==null,
  adopt(channel){channels.set(channel.label,channel);emit('datachannel',{channel});},
  wired:()=>connected,
  markConnected(){connected=true;state='connected';emit('connectionstatechange');},
 };
}
type FakeNetwork={factory:RtcFactory;peers:FakePeer[];configurations:RtcConfiguration[]};
function fakeNetwork():FakeNetwork{
 const peers:FakePeer[]=[];
 const configurations:RtcConfiguration[]=[];
 const wire=()=>{
  const [first,second]=peers;
  if(!first||!second||first.wired()||second.wired())return;
  if(!first.ready()||!second.ready())return;
  const labels=[...new Set([...first.labels(),...second.labels()])];
  for(const label of labels){
   const options=first.channel(label)?.options??second.channel(label)?.options??{};
   if(!first.channel(label))first.adopt(fakeChannel(label,options));
   if(!second.channel(label))second.adopt(fakeChannel(label,options));
   const left=first.channel(label)!,right=second.channel(label)!;
   left.attach(right);
   right.attach(left);
   left.open();
   right.open();
  }
  first.markConnected();
  second.markConnected();
 };
 const factory:RtcFactory=configuration=>{
  configurations.push(configuration);
  const peer=fakePeer(configuration,wire);
  peers.push(peer);
  return peer;
 };
 return {factory,peers,configurations};
}

// One participant of the session: its identity, the text outbox it copies from, and the two ports that ride the same
// link. Building both ports from the shared `peers` is what keeps one connection per participant, not four.
type Participant={actor:string;keys:KeyPair;signaling:ManualSignaling;peers:WebRtcPeers;transport:SessionTransport;objects:KernelTransport;shelf:Map<string,Uint8Array>;store:ObjectStore;refused:WorldError[]};
type JoinOptions={actor:string;keys:KeyPair;bindings:Record<string,string>;network:FakeNetwork;limits?:Limits;relay?:RelayPolicy};
function configFor(options:JoinOptions,shelf:Map<string,Uint8Array>,refused:WorldError[],signaling:ManualSignaling):WebRtcConfig{
 return {
  codec,hasher,actor:options.actor,session:SESSION,signer:signerOf(options.keys),
  signaling,
  connection:options.network.factory,relay:options.relay,limits:options.limits,
  store:createDirectObjectStore({hasher,shelf}),
  delay:async()=>{for(let i=0;i<16;i+=1)await Promise.resolve();},
  onRefused:(_peer,error)=>refused.push(error),
 };
}
function joinAs(options:JoinOptions):Participant{
 const shelf=new Map<string,Uint8Array>(),refused:WorldError[]=[];
 const signaling=createManualSignaling({codec,verifier,session:SESSION,bindings:options.bindings});
 const config=configFor(options,shelf,refused,signaling);
 const peers=createWebRtcPeers(config);
 return {actor:options.actor,keys:options.keys,signaling,peers,transport:createWebRtcTransport(config,{peers}),objects:createWebRtcObjectTransport(config,{peers}),shelf,store:config.store!,refused};
}
// The players carrying the signals by hand: whatever one put on its outbox is copied and pasted on the other side,
// until nothing is left to carry. A refusal here is a failure of the test, not something to swallow.
async function courier(participants:Participant[],until:Promise<unknown>,rounds=24):Promise<void>{
 const open=until.then(()=>true);
 let opened=false;
 void open.then(value=>{opened=value;});
 // Signing is platform work, so a signal can land in an outbox after the round that carried its neighbour: the courier
 // yields a real turn of the event loop and only stops when the link is open and nothing is left to carry.
 for(let round=0;round<rounds;round+=1){
  const outbox=participants.flatMap(from=>from.signaling.pending().map(entry=>({from,...entry})));
  for(const item of outbox){
   const to=participants.find(other=>other.actor===item.peer);
   if(!to)throw new Error(`Sem destinatário para ${item.peer}`);
   const text=item.from.signaling.copy(item.peer);
   if(text===null)continue;
   const accepted=await to.signaling.paste(text);
   if(!accepted.ok)throw new Error(`Sinal recusado: ${accepted.error.message}`);
  }
  if(!outbox.length&&opened)break;
  await turn();
 }
 await open;
}
async function pair(options:{network?:FakeNetwork;limits?:Limits;relay?:()=>Promise<TurnCredentials>;policy?:'direct'|'relay'}={}):Promise<{ana:Participant;bob:Participant;network:FakeNetwork}>{
 const network=options.network??fakeNetwork();
 const relayPolicy:RelayPolicy|undefined=options.relay||options.policy?{turn:options.relay,policy:options.policy,stun:['stun:stun.exemplo:3478'],clock:()=>NOW}:undefined;
 const ana=joinAs({actor:ANA,keys:ANA_KEYS,bindings:{[BOB]:BOB_KEYS.publicKey},network,limits:options.limits,relay:relayPolicy});
 const bob=joinAs({actor:BOB,keys:BOB_KEYS,bindings:{[ANA]:ANA_KEYS.publicKey},network,limits:options.limits,relay:relayPolicy});
 await ana.peers.invite(BOB);
 await courier([ana,bob],ana.peers.opened(BOB));
 return {ana,bob,network};
}

test('each port stands alone, so a runtime without a peer can still build them',async()=>{
 // The two factories are the fixed interface: a caller that wants only one of the traffic classes gets it without the
 // other, and nothing here needs the platform until an offer is actually made.
 const shelf=new Map<string,Uint8Array>(),refused:WorldError[]=[];
 const signaling=createManualSignaling({codec,verifier,session:SESSION,bindings:{[BOB]:BOB_KEYS.publicKey}});
 const config=configFor({actor:ANA,keys:ANA_KEYS,bindings:{[BOB]:BOB_KEYS.publicKey},network:fakeNetwork()},shelf,refused,signaling);
 const transport=createWebRtcTransport(config),objects=createWebRtcObjectTransport(config);
 expect(await objects.resolve(`osim:session:${SESSION.sessionId}`)).toEqual({ok:true,value:null});
 expect(await objects.query({components:['x.traffic']})).toEqual({ok:true,value:[]});
 await expect(transport.send(BOB,messageOf('control',1024))).rejects.toMatchObject({error:{code:'NOT_FOUND'}});
});

test('two peers open their channels through an offer copied by hand and exchange every class of message',async()=>{
 const {ana,bob,network}=await pair();
 // One peer connection for two participants and two ports: the object port rides the same link as the messages.
 expect(network.peers).toHaveLength(2);
 expect(ana.peers.connected()).toEqual([BOB]);
 expect(bob.peers.connected()).toEqual([ANA]);
 expect(network.peers[1].candidates).toHaveLength(1);
 const received:WireMessage[]=[];
 const stop=bob.transport.subscribe((peer,message)=>received.push({...message,envelope:{...message.envelope,id:`${peer}.${message.envelope.id}`}}));
 for(const traffic of ['control','durable','ephemeral'] as const)await ana.transport.send(BOB,messageOf(traffic,256));
 expect(received.map(entry=>entry.envelope.class)).toEqual(['control','durable','ephemeral']);
 expect(received.every(entry=>entry.envelope.id.startsWith(`${ANA}.`))).toBe(true);
 expect(received[0]!.body).toMatchObject({kind:'probe'});
 await expect(ana.transport.send('did:key:z6MkNinguem',messageOf('control',1024))).rejects.toMatchObject({error:{code:'NOT_FOUND'}});
 stop();
});

test('a message over the ceiling of its class, or an object on the message port, is refused',async()=>{
 const {ana}=await pair();
 expect(encodeMessage(messageOf('control',64*1024),codec)).toHaveLength(64*1024);
 await expect(ana.transport.send(BOB,messageOf('control',64*1024+1))).rejects.toMatchObject({error:{code:'LIMIT'}});
 await expect(ana.transport.send(BOB,messageOf('durable',64*1024+1))).rejects.toMatchObject({error:{code:'LIMIT'}});
 await expect(ana.transport.send(BOB,messageOf('ephemeral',16*1024+1))).rejects.toMatchObject({error:{code:'LIMIT'}});
 await expect(ana.transport.send(BOB,messageOf('object',1024))).rejects.toMatchObject({error:{code:'MALFORMED'}});
});

test('control traffic waits for the buffer to drain while a disposable frame is dropped',async()=>{
 const {ana,bob,network}=await pair();
 const control=network.peers[0].channel('control')!,ephemeral=network.peers[0].channel('ephemeral')!;
 control.fill(BUFFER_AGREEMENT.highWaterBytes);
 let settled=false;
 const sending=ana.transport.send(BOB,messageOf('control',1024)).then(()=>{settled=true;});
 await Promise.resolve();
 expect(settled).toBe(false);
 expect(control.sent).toHaveLength(0);
 control.dropAll();
 await sending;
 expect(control.sent).toHaveLength(1);
 // A presence frame above the ceiling is disposable: it must not queue behind the buffer.
 ephemeral.fill(BUFFER_AGREEMENT.highWaterBytes);
 await ana.transport.send(BOB,messageOf('ephemeral',1024));
 expect(ephemeral.sent).toHaveLength(0);
 expect(bob.refused.map(error=>error.code)).toEqual([]);
});

test('a frame with invalid bytes, or one from another session or epoch, never reaches a listener',async()=>{
 const {ana,bob,network}=await pair();
 const received:WireMessage[]=[];
 const stop=bob.transport.subscribe((_peer,message)=>received.push(message));
 const channel=network.peers[1].channel('control')!;
 channel.deliver(new TextEncoder().encode('{não é json'));
 channel.deliver(encodeMessage(messageOf('ephemeral',16*1024+1),codec));
 channel.deliver(encodeMessage(messageOf('control',256,{sessionId:'outra-sessao'}),codec));
 channel.deliver(encodeMessage(messageOf('control',256,{epoch:SESSION.epoch-1}),codec));
 channel.deliver(encodeMessage(messageOf('control',256),codec));
 expect(received).toHaveLength(1);
 expect(received[0]!.envelope.sessionId).toBe(SESSION.sessionId);
 expect(bob.refused.map(error=>error.code)).toEqual(['MALFORMED','LIMIT','CONFLICT','CONFLICT']);
 stop();
});

test('a signal from another session, or from an older epoch, is refused before it is used',async()=>{
 const network=fakeNetwork();
 const bob=joinAs({actor:BOB,keys:BOB_KEYS,bindings:{[ANA]:ANA_KEYS.publicKey},network});
 const signalOf=(session:SessionScope,id:string)=>signSignal({codec,signer:signerOf(ANA_KEYS),actor:ANA,session,signal:'offer',id,sequence:3,payload:{description:{type:'offer',sdp:'v=0'}}});
 const texts=await Promise.all([
  signalOf({...SESSION,sessionId:'outra-sessão'},'sinal-outra').then(signal=>signalText(signal,codec)),
  signalOf({...SESSION,epoch:SESSION.epoch-1},'sinal-antiga').then(signal=>signalText(signal,codec)),
  signalOf({...SESSION,epoch:SESSION.epoch+1},'sinal-futura').then(signal=>signalText(signal,codec)),
 ]);
 const [other,old,future]=await Promise.all(texts.map(text=>bob.signaling.paste(text)));
 expect(other).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(old).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(future).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(old.ok?'':old.error.message).toContain('época anterior');
 expect(future.ok?'':future.error.message).toContain('época');
 // Nothing reached the platform peer: every refusal happened before an offer could be used.
 expect(network.peers).toHaveLength(0);
});

test('a tampered signal and a session key that is not bound to the actor are refused',async()=>{
 const network=fakeNetwork();
 const bob=joinAs({actor:BOB,keys:BOB_KEYS,bindings:{[ANA]:ANA_KEYS.publicKey},network});
 const valid=await signSignal({codec,signer:signerOf(ANA_KEYS),actor:ANA,session:SESSION,signal:'offer',id:'sinal-1',sequence:1,payload:{description:{type:'offer',sdp:'v=0'}}});
 const tampered:SignedSignal={...valid,payload:{description:{type:'offer',sdp:'v=0 ATACADO'}}};
 expect(await bob.signaling.paste(signalText(tampered,codec))).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 const stranger=await signSignal({codec,signer:signerOf(STRANGER_KEYS),actor:ANA,session:SESSION,signal:'offer',id:'sinal-2',sequence:1,payload:{description:{type:'offer',sdp:'v=0'}}});
 expect(await bob.signaling.paste(signalText(stranger,codec))).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 const copy=signalText(valid,codec);
 expect(await bob.signaling.paste(copy)).toMatchObject({ok:true});
 // The same copy announced again is a replay, not a new offer.
 expect(await bob.signaling.paste(copy)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 // A new signal carrying an older counter is still new: a candidate for the answer may precede the answer it belongs
 // to, so the session's own copy is what fences a replay, not the counter.
 const late=await signSignal({codec,signer:signerOf(ANA_KEYS),actor:ANA,session:SESSION,signal:'ice',id:'sinal-3',sequence:1,payload:{candidate:{candidate:'candidate:2 1 udp 1 127.0.0.1 4001 typ host'}}});
 expect(await bob.signaling.paste(signalText(late,codec))).toMatchObject({ok:true});
 expect(await bob.signaling.paste('texto que não é um sinal')).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('relay policy is configured with temporary credentials and an expired one is refused',async()=>{
 const network=fakeNetwork();
 const temporary=async()=>({urls:['turn:relay.exemplo:3478'],username:'temporario',credential:'curta-duracao',expiresAt:'2026-09-29T12:30:00Z'});
 const {ana}=await pair({network,relay:temporary,policy:'relay'});
 expect(network.configurations[0]).toEqual({iceServers:[{urls:['stun:stun.exemplo:3478']},{urls:['turn:relay.exemplo:3478'],username:'temporario',credential:'curta-duracao'}],iceTransportPolicy:'relay'});
 // A permanent secret never ships in the app: the adapter asks for a credential with a deadline and refuses what is
 // already expired instead of connecting with it.
 const stale=fakeNetwork();
 const expired=async()=>({...await temporary(),expiresAt:'2026-09-29T11:00:00Z'});
 const peer=joinAs({actor:BOB,keys:BOB_KEYS,bindings:{[ANA]:ANA_KEYS.publicKey},network:stale,relay:{turn:expired,policy:'relay',clock:()=>NOW}});
 const invited=await peer.peers.invite(ANA);
 expect(invited).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 expect(stale.configurations).toEqual([]);
 expect(ana.peers.connected()).toEqual([BOB]);
});

test('the session descriptor is published as a session object and join resolves it over the link',async()=>{
 const network=fakeNetwork();
 const ana=joinAs({actor:ANA,keys:ANA_KEYS,bindings:{[BOB]:BOB_KEYS.publicKey},network});
 const kernelA=createKernel({transports:[ana.objects]});
 const descriptor=sessionDescriptor(SESSION,{actor:ANA,space:'osim:space:victoria',participants:[ANA,BOB],mode:'realtime',startedAt:NOW});
 // Published before anyone was connected: the device is the first holder of its own reality.
 const published=await kernelA.publish(descriptor);
 expect(published).toMatchObject({ok:true,status:'applied'});
 expect(published.ok?published.replication.map(error=>error.code):[]).toEqual(['NOT_FOUND']);
 const bob=joinAs({actor:BOB,keys:BOB_KEYS,bindings:{[ANA]:ANA_KEYS.publicKey},network});
 await bob.peers.invite(ANA);
 await courier([ana,bob],bob.peers.opened(ANA));
 const kernelB=createKernel({transports:[bob.objects]});
 // A kernel receives remote objects while something is subscribed to it (the subscription is what registers the
 // transport listener), so the pull-join below is the path that proves resolution without a local copy.
 const joined=await kernelB.join(`osim:session:${SESSION.sessionId}`);
 kernelB.subscribe({},()=>{});
 expect(joined.ok?joined.value?.type:null).toBe('session');
 expect(joined.ok?joined.value?.id:null).toBe(`osim:session:${SESSION.sessionId}`);
 expect(joined.ok?joined.value?.body:null).toMatchObject({timeline:`osim:timeline:${SESSION.branchId}`,epoch:SESSION.epoch,mode:'realtime'});
 // And what a peer publishes from now on arrives as an object of the protocol, not as a session message.
 const capability=envelopeOf('capability','osim:capability:convite-1',ANA,{issuer:ANA,subject:BOB,entity:'osim:entity:casa-1',component:'osim.furniture',actions:['set','merge']});
 expect(await kernelA.publish(capability)).toMatchObject({ok:true,status:'applied'});
 const resolved=kernelB.resolve('osim:capability:convite-1');
 expect(resolved.ok?resolved.value?.actor:null).toBe(ANA);
});

test('a query answers with what the peer holds and absence is an answer',async()=>{
 const {ana,bob}=await pair();
 const kernelA=createKernel({transports:[ana.objects]});
 expect(await kernelA.publish(envelopeOf('entity','osim:entity:casa-1',ANA,{components:{'x.traffic':{flow:3}}}))).toMatchObject({ok:true,status:'applied'});
 const found=await bob.objects.query({components:['x.traffic']});
 expect(found.ok?found.value.map(object=>object.id):[]).toEqual(['osim:entity:casa-1']);
 const nothing=await bob.objects.resolve('osim:entity:inexistente');
 expect(nothing).toEqual({ok:true,value:null});
});

test('an object travels over the same link and only bytes that match the address are stored',async()=>{
 const {ana,bob}=await pair();
 const bytes=bytesOf(40*1024),ref=await hasher.ref(bytes);
 expect(await ana.store.put(bytes)).toEqual({ok:true,value:ref});
 const got=await bob.peers.transfer(ref,ANA);
 expect(got).toEqual({ok:true,value:bytes});
 expect(bob.shelf.get(ref.hash)).toEqual(bytes);
 const absent=await bob.peers.transfer({hash:'ef'.repeat(32),bytes:1024},ANA);
 expect(absent).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
});

test('a peer whose channel is gone is reported instead of pretended',async()=>{
 const {ana,bob}=await pair();
 bob.peers.close();
 expect(bob.peers.connected()).toEqual([]);
 await expect(ana.transport.send(BOB,messageOf('control',1024))).rejects.toMatchObject({error:{code:'NOT_FOUND'}});
 expect(await ana.objects.publish(envelopeOf('capability','osim:capability:c2',ANA,{issuer:ANA,subject:BOB}))).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 expect(await ana.objects.resolve('osim:session:inexistente')).toEqual({ok:true,value:null});
});
