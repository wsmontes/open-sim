// A live session over a transport that moves framed messages inside one process
// (docs/superpowers/specs/2026-09-29-federated-world-design.md §7). The host orders transactions, validates a
// proposal against the version its author observed, applies it with the core and publishes objects, idempotency
// receipt and head advance in one device transaction before confirming anything. Replicas verify the grant, the
// epoch, the parent, the operation and the result, and ask for the frozen regions they do not have instead of
// presuming them. Nothing here reads the clock, the network or a device: every one of them is injected.
import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {ed25519Verifier,generateSessionKeyPair,localIdentityProvider,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {createMemoryNetwork} from '../src/adapters/network/memory';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {createHostSession,deferred,readBody} from '../src/session/host-session';
import type {AcceptedCommit,HostSession,ProposalReceipt,SessionBody} from '../src/session/host-session';
import {createReplicaSession} from '../src/session/replica-session';
import type {ReplicaSession} from '../src/session/replica-session';
import type {MapSource} from '../src/session/ports';
import {importLegacy} from '../src/session/world-bundle';
import {createWorldRepository} from '../src/session/world-repository';
import type {WorldRepository} from '../src/session/world-repository';
import type {WorldStorage} from '../src/session/world-ports';
import {createGame} from '../src/core/commands';
import {durableJson} from '../src/core/protocol';
import {cellIndex} from '../src/core/coordinates';
import {grantBytes,proposalBytes} from '../src/world/permissions';
import type {Grant,IdentityProof,IdentityScope,Proposal,Principal} from '../src/world/permissions';
import {NETWORK_LIMITS} from '../src/world/wire';
import type {Limits,TrafficClass,WireMessage} from '../src/world/wire';
import type {Action,BaseChunk,CellCoord,GameState,SavedGame,ViewState} from '../src/core/model';
import type {Head,JsonValue,WorldResult} from '../src/world/model';
import {blank} from './fixtures/world';
import chaos from './fixtures/federated-world/session-chaos.json';

const codec=createJcsCodec(),hasher=bytesHasher(),verifier=ed25519Verifier();
const NOW='2026-09-29T12:00:00Z';
const SESSION='sessao-1';
const MAIN={worldId:'victoria',branchId:'main'};
const ANA={scheme:'nostr',id:'npub1ana'};
const terms=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const view:ViewState={x:12.5,y:-4,zoom:1.5,speed:1,place:'Victoria'};
// Cells inside '9:9', whose origin is (288,288). Anything else is written in absolute coordinates.
const at=(x:number,y:number):CellCoord=>({x:288+x,y:288+y});
const scopeOf=(over:Partial<IdentityScope>={}):IdentityScope=>({...MAIN,sessionId:SESSION,notBefore:'2026-09-29T11:00:00Z',notAfter:'2026-09-29T13:00:00Z',...over});

// --- the people and the documents they sign --------------------------------------------------------------------
type Actor={principal:Principal;identity:IdentityProof;keys:KeyPair};
async function actorOf(principal:Principal,keys:KeyPair,root:KeyPair,sessionId=SESSION):Promise<Actor>{
 const bound=await localIdentityProvider({root,session:keys,codec}).bindSession({principal,scope:scopeOf({sessionId})});
 if(!bound.ok)throw new Error(bound.error.message);
 return {principal,identity:bound.value,keys};
}
// The keys identify the person; the binding identifies the person in a session, and a session has its own.
const ANA_KEYS=await generateSessionKeyPair(),ANA_ROOT=await generateSessionKeyPair();
const ANA_ACTOR=await actorOf(ANA,ANA_KEYS,ANA_ROOT);
async function grantOf(grantee:Actor,signer:KeyPair,over:Partial<Grant>={}):Promise<Grant>{
 const base:Grant={kind:'grant',id:'concessao-1',principal:grantee.principal,...MAIN,actions:['build','demolish','component','tick'],namespaces:[],spendLimit:1000,proof:{kind:'message',algorithm:'Ed25519',sessionKey:signer.publicKey,signature:''}};
 const merged:Grant={...base,...over};
 return {...merged,proof:{kind:'message',algorithm:'Ed25519',sessionKey:signer.publicKey,signature:await signEd25519(signer,grantBytes(merged,codec))}};
}
type ProposalOptions={id:string;intent:Action;head:Head;revision:number;costLimit?:number;sessionId?:string;epoch?:number};
async function proposalOf(actor:Actor,sessionId:string,epoch:number,options:ProposalOptions):Promise<Proposal>{
 const base:Proposal={worldProtocol:2,wireVersion:1,kind:'proposal',worldId:options.head.worldId,branchId:options.head.branchId,sessionId,epoch,id:options.id,principal:actor.principal,sessionKey:actor.keys.publicKey,observedHead:options.head.commit,intent:options.intent,preconditions:{revision:options.revision},costLimit:options.costLimit??1000,proof:{kind:'message',algorithm:'Ed25519',sessionKey:actor.keys.publicKey,signature:''}};
 return {...base,proof:{kind:'message',algorithm:'Ed25519',sessionKey:actor.keys.publicKey,signature:await signEd25519(actor.keys,proposalBytes(base,codec))}};
}
const propose=(options:ProposalOptions):Promise<Proposal>=>proposalOf(ANA_ACTOR,SESSION,1,options);
const build=(tool:'park'|'road'|'power',cells:CellCoord[]):Action=>({type:'build',tool,cells});

// --- the device, the branch and the wire ----------------------------------------------------------------------
// A device that can refuse the next write (a full disk), hold a write pending (a slow save) or report a failure after
// it already wrote (a process that dies between persisting and answering). `skip` lets the writes a test never wants
// to fail (the branch creation) through untouched.
type Fault={skip?:number;times?:number;after?:boolean;gate?:Promise<void>};
function faulty(storage:WorldStorage,plan:Fault|null):WorldStorage{
 const fault:Fault=plan??{};
 let skip=fault.skip??0,remaining=fault.times??0;
 return {
  head:address=>storage.head(address),
  heads:worldId=>storage.heads(worldId),
  object:ref=>storage.object(ref),
  receipt:(address,id)=>storage.receipt(address,id),
  receipts:address=>storage.receipts(address),
  async commit(transaction):Promise<WorldResult<Head>>{
   if(skip>0){skip-=1;return storage.commit(transaction);}
   if(fault.gate)await fault.gate;
   if(remaining>0){
    remaining-=1;
    if(!fault.after)return {ok:false,error:{code:'QUOTA',message:'Dispositivo sem espaço'}};
    const written=await storage.commit(transaction);
    if(!written.ok)return written;
    return {ok:false,error:{code:'QUOTA',message:'A resposta durável se perdeu depois de gravar'}};
   }
   return storage.commit(transaction);
  },
 };
}
async function open(worlds:WorldRepository,state:GameState):Promise<Head>{
 const save:SavedGame={version:1,state,view};
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error(imported.error.message);
 const created=await worlds.create(imported.value);
 if(!created.ok)throw new Error(created.error.message);
 return created.value;
}
function maps(captures:Record<string,BaseChunk>,missing:readonly string[]=[]){
 const calls:string[]=[];
 const source:MapSource={attribution:{text:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright'},async loadChunk(id){calls.push(id);const base=captures[id];if(!base||missing.includes(id))throw new Error(`Região indisponível: ${id}`);return base;}};
 return {source,calls};
}
let counter=0;
const wire=(body:JsonValue,over:Partial<{class:TrafficClass;worldId:string;branchId:string;sessionId:string;epoch:number;id:string}>={}):WireMessage=>({envelope:{worldProtocol:2,wireVersion:1,kind:'message',class:over.class??'control',worldId:over.worldId??MAIN.worldId,branchId:over.branchId??MAIN.branchId,sessionId:over.sessionId??SESSION,epoch:over.epoch??1,id:over.id??`t${++counter}`},body});
// Every body read here goes through the session's own reader, so a test never guesses a shape the session would refuse.
function sessionBody(message:WireMessage):SessionBody{
 const parsed=readBody(message.body);
 if(!parsed.ok)throw new Error(parsed.error.message);
 return parsed.value;
}
const bodiesOf=<T extends SessionBody['kind']>(inbox:readonly WireMessage[],kind:T)=>inbox.flatMap(message=>{
 const parsed=readBody(message.body);
 return parsed.ok&&parsed.value.kind===kind?[parsed.value as Extract<SessionBody,{kind:T}>]:[];
});
const receiptsOf=(inbox:readonly WireMessage[],id?:string)=>bodiesOf(inbox,'proposal-receipt').map(body=>body.receipt).filter(receipt=>!id||receipt.id===id);
const lastReceipt=(inbox:readonly WireMessage[],id:string):ProposalReceipt=>{const found=receiptsOf(inbox,id);const receipt=found[found.length-1];if(!receipt)throw new Error(`Sem recibo para ${id}`);return receipt;};
const stateOf=async(worlds:WorldRepository,head:Head):Promise<GameState>=>{const point=await worlds.checkout(head);if(!point.ok)throw new Error(point.error.message);return point.value.state;};
const branchHead=async(worlds:WorldRepository,worldId:string):Promise<Head>=>{const branches=await worlds.branches(worldId);if(!branches.ok)throw new Error(branches.error.message);const head=branches.value[0];if(!head)throw new Error('Ramificação ausente');return head;};
const semanticHash=async(state:GameState)=>(await hasher.ref(new TextEncoder().encode(durableJson(state)))).hash;

// --- a whole session, wired the way the client wires it -------------------------------------------------------
type SceneOptions={start?:GameState;replicaStart?:GameState;captures?:Record<string,BaseChunk>;missing?:readonly string[];limits?:Limits;hostFault?:Fault;sessionId?:string;epoch?:number};
async function scene(options:SceneOptions={}){
 const start=options.start??createGame(MAIN.worldId,7,blank('9:9'));
 const hostDevice=createWorldMemoryStorage(),replicaDevice=createWorldMemoryStorage();
 const hostWorlds=createWorldRepository({storage:faulty(hostDevice,options.hostFault??null),codec,hasher});
 const replicaWorlds=createWorldRepository({storage:replicaDevice,codec,hasher});
 const startHead=await open(hostWorlds,start);
 const replicaHead=await open(replicaWorlds,options.replicaStart??start);
 const net=createMemoryNetwork();
 const source=maps(options.captures??{},options.missing??[]);
 const limits=options.limits??NETWORK_LIMITS;
 const sessionId=options.sessionId??SESSION,epoch=options.epoch??1;
 const actor=await actorOf(ANA,ANA_KEYS,ANA_ROOT,sessionId);
 const host=createHostSession({repository:hostWorlds,transport:net.connect('host'),peer:'host',head:startHead,identity:actor.identity,grants:[await grantOf(actor,actor.keys)],rules:{family:'city',version:1},bases:source.source,verifier,codec,hasher,now:()=>NOW,sessionId,epoch,limits,peers:['beto']});
 let replica:ReplicaSession=createReplicaSession({repository:replicaWorlds,transport:net.connect('beto'),peer:'beto',host:'host',head:replicaHead,verifier,codec,hasher,now:()=>NOW,sessionId,epoch,limits});
 const inbox:WireMessage[]=[];const player=net.connect('ana');player.subscribe((_peer,message)=>inbox.push(message));
 const proposals=new Map<string,Proposal>();
 // Delivery is a decision of the test, so a round settles the sessions, hands over what they queued, and repeats
 // until nothing is left — bounded, because a message may answer another one.
 async function settle(rounds=12){
  for(let round=0;round<rounds;round+=1){
   await host.idle();
   await replica.idle();
   if(!net.queued())return;
   net.deliver();
  }
  await host.idle();
  await replica.idle();
 }
 async function participate(over:Partial<Grant>={}){
  await player.send('host',wire(actor.identity as unknown as JsonValue,{sessionId,epoch,id:`${actor.principal.id}-identity`}));
  await player.send('host',wire(await grantOf(actor,actor.keys,over) as unknown as JsonValue,{sessionId,epoch,id:`${actor.principal.id}-grant`}));
  await settle();
 }
 async function proposal(options:{id:string;intent:Action;head?:Head;revision?:number;costLimit?:number}){
  const boot=await host.checkpoint();
  const built=await proposalOf(actor,sessionId,epoch,{...options,head:options.head??boot.head,revision:options.revision??boot.state.revision});
  proposals.set(built.id,built);
  return built;
 }
 async function send(proposal:Proposal,deliver=true,repeat=false){
  await player.send('host',wire(proposal as unknown as JsonValue,{class:'durable',sessionId,id:`${proposal.id}${repeat?'-repeat':''}`}));
  if(deliver)await settle();
 }
 // The order of a delivery is a decision of the test: the frames addressed to one peer go first, everything else
 // follows, and both sessions are settled before the next decision. Nothing is dropped on the way.
 async function deliverTo(peer:string){
  const batch=net.batch();
  for(const entry of batch)if(entry.to===peer)net.dispatch(entry);
  await host.idle();
  await replica.idle();
  for(const entry of batch)if(entry.to!==peer)net.dispatch(entry);
  await host.idle();
  await replica.idle();
 }
 async function submit(options:Omit<ProposalOptions,'head'|'revision'>&{head?:Head;revision?:number;deliver?:boolean}){
  const built=await proposal(options);
  await send(built,options.deliver??true);
  return lastReceipt(inbox,built.id);
 }
 // The same attempt again, the way a client that lost the answer repeats it: a fresh envelope carrying the proposal
 // the author already signed.
 async function repeat(id:string){
  const proposal=proposals.get(id);
  if(!proposal)throw new Error(`Proposta ${id} não enviada`);
  await send(proposal,true,true);
  return lastReceipt(inbox,id);
 }
 // The commit the host published for a proposal, read back from the frames it sent: a test never rebuilds a commit.
 const commitOf=(id:string):AcceptedCommit=>{
  const found=bodiesOf(inbox,'commit').map(body=>body.commit).filter(commit=>commit.id===id);
  const commit=found[found.length-1];
  if(!commit)throw new Error(`Commit ausente para ${id}`);
  return commit;
 };
 return {net,host,hostWorlds,replicaWorlds,startHead,replicaHead,inbox,source,proposals,player,actor,settle,participate,proposal,deliverTo,submit,repeat,commitOf,setReplica:(next:ReplicaSession)=>{replica=next;},replica:()=>replica};
}

test('a build is ordered, persisted with its receipt and replicated with the same semantic hash',async()=>{
 const s=await scene();
 expect(s.replicaHead.commit).toEqual(s.startHead.commit);
 await s.participate();
 const receipt=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 expect(receipt.status).toBe('accepted');
 expect(receipt.sequence).toBe(1);
 expect(receipt.rebased).toBe(false);
 expect(receipt.head.generation).toBe(2);
 expect(receipt.replicas).toEqual(['beto','ana']);
 const hostState=await stateOf(s.hostWorlds,receipt.head);
 expect(hostState.money).toBe(20000-30);
 // The receipt of the delivery and the version it produced are readable from the same checkpoint: they were written
 // by one device transaction, which is what makes a lost answer cheap to repeat.
 const point=await s.hostWorlds.checkout(receipt.head);
 if(!point.ok)throw new Error(point.error.message);
 expect(point.value.receipts).toContain('p1');
 const replicaState=await stateOf(s.replicaWorlds,s.replica().head());
 expect(await semanticHash(replicaState)).toBe(await semanticHash(hostState));
 expect(s.replica().head().commit).toEqual(receipt.head.commit);
 expect(s.replica().receipts().at(-1)?.status).toBe('adopted');
 // "Copied by one friend" is the replica's own receipt, never a delivery confirmation (§7.4 step 6).
 expect(s.host.confirmations().at(-1)?.status).toBe('adopted');
});

test('two builds competing for the same balance never spend beyond it',async()=>{
 for(const order of [['p1','p2'],['p2','p1']]){
  const s=await scene({start:{...createGame(MAIN.worldId,7,blank('9:9')),money:50}});
  await s.participate();
  const head=s.host.head();
  const first=await s.host.submit(await s.proposal({id:order[0]!,intent:build('park',[at(1,1)]),head,revision:0}));
  const second=await s.host.submit(await s.proposal({id:order[1]!,intent:build('park',[at(3,3)]),head,revision:0}));
  expect(first.status).toBe('accepted');
  expect(second.status).toBe('refused');
  expect(second.code).toBe('CONFLICT');
  expect(second.preview?.reason).toBe('Dinheiro insuficiente');
  expect(second.preview?.revision).toBe(1);
  const state=await stateOf(s.hostWorlds,s.host.head());
  expect(state.money).toBe(20);
  expect(state.revision).toBe(1);
  expect(s.host.head().generation).toBe(2);
 }
});

test('a repeated delivery is answered from the receipt it produced and charges once',async()=>{
 const s=await scene();
 await s.participate();
 const first=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 // The very same frame again: the host answers the duplicate from the receipt it already produced.
 await s.player.send('host',wire(s.proposals.get('p1') as unknown as JsonValue,{class:'durable',id:'p1'}));
 await s.settle();
 expect(receiptsOf(s.inbox,'p1').length).toBe(2);
 const again=await s.repeat('p1');
 expect(again.status).toBe('duplicate');
 expect(again.head.commit).toEqual(first.head.commit);
 expect(again.head.generation).toBe(first.head.generation);
 const state=await stateOf(s.hostWorlds,s.host.head());
 expect(state.money).toBe(20000-30);
 expect(state.revision).toBe(1);
 // The same identifier with different content is another attempt pretending to be a repeat, not a repeat.
 const impostor=await s.host.submit(await s.proposal({id:'p1',intent:build('park',[at(5,5)]),head:first.parent,revision:0}));
 expect(impostor.status).toBe('refused');
 expect(impostor.code).toBe('CONFLICT');
 expect((await stateOf(s.hostWorlds,s.host.head())).money).toBe(20000-30);
});

test('a refused proposal leaves no gap for the next accepted one',async()=>{
 const water=blank('9:9');water.cells[cellIndex(at(1,1))]={terrain:'water'};
 const s=await scene({start:createGame(MAIN.worldId,7,water)});
 await s.participate();
 const refused=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 expect(refused.status).toBe('refused');
 expect(refused.preview?.reason).toBe('Não é possível construir na água');
 expect(refused.head.generation).toBe(1);
 const accepted=await s.submit({id:'p2',intent:build('park',[at(2,2)])});
 expect(accepted.status).toBe('accepted');
 expect(accepted.sequence).toBe(1);
 const info=await s.host.checkpoint();
 expect(info.state.actors[accepted.actorId!]).toBe(1);
 expect(info.state.revision).toBe(1);
 expect(info.state.money).toBe(20000-30);
 expect(s.host.head().generation).toBe(2);
});

test('the host rebases a proposal it observed earlier only while its intent and ceiling stay intact',async()=>{
 const s=await scene();
 await s.participate();
 const head=s.host.head();
 const first=await s.host.submit(await s.proposal({id:'p1',intent:build('park',[at(1,1)]),head,revision:0}));
 const rebased=await s.host.submit(await s.proposal({id:'p2',intent:build('park',[at(2,2)]),head,revision:0}));
 expect(first.rebased).toBe(false);
 expect(rebased.status).toBe('accepted');
 expect(rebased.rebased).toBe(true);
 expect(rebased.sequence).toBe(2);
 const state=await stateOf(s.hostWorlds,s.host.head());
 expect(state.money).toBe(20000-60);
 expect(state.revision).toBe(2);
 // The ceiling the author approved is not a suggestion: a proposal whose cost exceeds it is refused, not silently
 // applied at a price nobody agreed to.
 const expensive=await s.host.submit(await s.proposal({id:'p3',intent:build('power',[at(4,4)]),head,revision:0,costLimit:100}));
 expect(expensive.status).toBe('refused');
 expect(expensive.code).toBe('PERMISSION');
 expect(expensive.head.generation).toBe(3);
 expect((await stateOf(s.hostWorlds,s.host.head())).money).toBe(20000-60);
});

test('a region that was never frozen is refused instead of inventing terrain',async()=>{
 const s=await scene({missing:['0:0']});
 await s.participate();
 const receipt=await s.submit({id:'p1',intent:build('park',[{x:5,y:5}])});
 expect(receipt.status).toBe('refused');
 expect(receipt.code).toBe('NOT_FOUND');
 expect(s.source.calls).toContain('0:0');
 expect(s.host.head().generation).toBe(1);
 expect((await stateOf(s.hostWorlds,s.host.head())).money).toBe(20000);
});

test('a failed persistence confirms nothing, pauses durable confirmations and keeps the attempt',async()=>{
 const s=await scene({hostFault:{skip:1,times:1}});
 await s.participate();
 const failed=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 expect(failed.status).toBe('failed');
 expect(failed.code).toBe('QUOTA');
 expect(s.host.head().generation).toBe(1);
 expect((await branchHead(s.hostWorlds,MAIN.worldId)).generation).toBe(1);
 expect((await stateOf(s.hostWorlds,s.host.head())).money).toBe(20000);
 // Nothing durable is confirmed while the attempt is pending, and the pending attempt itself can be retried.
 const other=await s.host.submit(await s.proposal({id:'p2',intent:build('park',[at(2,2)]),head:s.host.head(),revision:0}));
 expect(other.status).toBe('failed');
 expect(other.code).toBe('QUOTA');
 const retried=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 expect(retried.status).toBe('accepted');
 const state=await stateOf(s.hostWorlds,s.host.head());
 expect(state.money).toBe(20000-30);
 expect(state.revision).toBe(1);
 expect(s.host.head().generation).toBe(2);
});

test('a host that lost the answer before replying repeats the result instead of applying twice',async()=>{
 const s=await scene({hostFault:{skip:1,times:1,after:true}});
 await s.participate();
 const lost=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 expect(lost.status).toBe('failed');
 expect(lost.code).toBe('QUOTA');
 // The device did advance: the write happened and only the answer was lost.
 expect((await branchHead(s.hostWorlds,MAIN.worldId)).generation).toBe(2);
 // A session reopened on the branch reads its receipts out of the history it reopens, so the retry is answered with
 // the version already produced instead of applying the build again.
 const reopened=createHostSession({repository:s.hostWorlds,transport:s.net.connect('host2'),peer:'host2',head:await branchHead(s.hostWorlds,MAIN.worldId),identity:ANA_ACTOR.identity,grants:[await grantOf(ANA_ACTOR,ANA_ACTOR.keys)],rules:{family:'city',version:1},bases:s.source.source,verifier,codec,hasher,now:()=>NOW,sessionId:SESSION,epoch:1,limits:NETWORK_LIMITS});
 const retry=await reopened.submit(await propose({id:'p1',intent:build('park',[at(1,1)]),head:s.startHead,revision:0}));
 expect(retry.status).toBe('duplicate');
 expect(retry.head.generation).toBe(2);
 expect(reopened.head().generation).toBe(2);
 const state=await stateOf(s.hostWorlds,reopened.head());
 expect(state.money).toBe(20000-30);
 expect(state.revision).toBe(1);
});

test('a replica asks for a frozen base before adopting and verifies the bytes it gets',async()=>{
 const s=await scene({captures:{'0:0':blank('0:0')}});
 await s.participate();
 const proposal=await s.proposal({id:'p1',intent:build('park',[{x:5,y:5}]),head:s.host.head(),revision:0});
 s.proposals.set('p1',proposal);
 const receipt=await s.host.submit(proposal);
 expect(receipt.status).toBe('accepted');
 await s.deliverTo('beto');
 // The commit was delivered, but the replica holds no frozen base for '0:0' and invents none.
 expect(s.replica().head().generation).toBe(1);
 const pending=s.replica().receipts().at(-1)!;
 expect(pending.status).toBe('pending');
 expect(pending.missing?.map(ref=>ref.hash)).toEqual(receipt.bases?.filter(base=>base.id==='0:0').map(base=>base.ref.hash));
 const queued=s.net.batch();
 const requests=queued.map(entry=>readBody(entry.message.body)).filter(parsed=>parsed.ok&&parsed.value.kind==='base-request');
 expect(requests.length).toBe(1);
 for(const parsed of requests)if(parsed.ok&&parsed.value.kind==='base-request')expect(parsed.value.bases.map(base=>base.id)).toEqual(['0:0']);
 for(const entry of queued)s.net.dispatch(entry);
 await s.settle();

 expect(s.replica().head().commit).toEqual(receipt.head.commit);
 expect(await semanticHash(await stateOf(s.replicaWorlds,s.replica().head()))).toBe(await semanticHash(await stateOf(s.hostWorlds,receipt.head)));
});

test('bytes that do not match the declared base are never adopted',async()=>{
 const s=await scene({captures:{'0:0':blank('0:0')}});
 await s.participate();
 const proposal=await s.proposal({id:'p1',intent:build('park',[{x:5,y:5}]),head:s.host.head(),revision:0});
 s.proposals.set('p1',proposal);
 const accepted=await s.host.submit(proposal);
 expect(accepted.status).toBe('accepted');
 await s.deliverTo('beto');
 await s.deliverTo('host');
 const queued=s.net.batch();
 const responses=queued.map(entry=>({entry,parsed:readBody(entry.message.body)})).filter(item=>item.parsed.ok&&item.parsed.value.kind==='base-response');
 expect(responses.length).toBe(1);
 // A hostile or broken answer arrives first: the object does not hash to the address the commit declares it by.
 const damaged=responses[0]!.parsed.ok&&responses[0]!.parsed.value.kind==='base-response'?responses[0]!.parsed.value.objects.map((object,index)=>{
  if(index!==0)return object;
  const replacement=blank('0:0');
  replacement.cells[0]={terrain:'water'};
  // The value is JSON by construction: a frozen base is plain data and travels as such.
  return {...object,value:{kind:'base-chunk',base:replacement} as unknown as JsonValue};
 }):[];
 for(const entry of queued)if(entry!==responses[0]!.entry)s.net.dispatch(entry);
 s.net.dispatch({...responses[0]!.entry,message:wire({kind:'base-response',objects:damaged} as unknown as JsonValue,{class:'object',id:'resposta-adulterada'})});
 await s.deliverTo('beto');
 expect(s.replica().head().generation).toBe(1);
 expect(s.replica().receipts().at(-1)?.code).toBe('HASH_MISMATCH');
 expect((await stateOf(s.replicaWorlds,s.replica().head())).money).toBe(20000);
 // The region arrives again, verified this time, and only then is the commit adopted.
 await s.settle();
 expect(s.replica().head().commit).toEqual(accepted.head.commit);
 expect(s.replica().receipts().at(-1)?.status).toBe('adopted');
});

test('peers with a different frozen base are reported instead of reconciled by guesswork',async()=>{
 const other=blank('9:9');other.source='outra-captura';other.cells[0]={terrain:'water'};
 const s=await scene({replicaStart:createGame(MAIN.worldId,7,other)});
 await s.participate();
 const receipt=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 expect(receipt.status).toBe('accepted');
 const divergent=s.replica().receipts().at(-1)!;
 expect(divergent.status).toBe('divergent');
 expect(divergent.reason).toContain('9:9');
 expect(divergent.evidence?.bases.map(base=>base.id)).toEqual(['9:9']);
 expect(s.replica().divergences().length).toBe(1);
 expect(s.replica().head().generation).toBe(1);
 // Integration stops: the next commit is refused instead of being applied on a base nobody agreed on.
 const later=await s.submit({id:'p2',intent:build('park',[at(2,2)])});
 expect(later.status).toBe('accepted');
 expect(s.replica().receipts().at(-1)?.status).toBe('refused');
 expect(s.replica().head().generation).toBe(1);
 expect((await stateOf(s.replicaWorlds,s.replica().head())).money).toBe(20000);
});

test('an inverted delivery waits for its parent and is applied exactly once',async()=>{
 const s=await scene();
 await s.participate();
 const head=s.host.head();
 const first=await s.proposal({id:'p1',intent:build('park',[at(1,1)]),head,revision:0});
 const second=await s.proposal({id:'p2',intent:build('park',[at(2,2)]),head,revision:0});
 s.proposals.set('p1',first);s.proposals.set('p2',second);
 await s.player.send('host',wire(first as unknown as JsonValue,{class:'durable',id:'p1'}));
 await s.player.send('host',wire(second as unknown as JsonValue,{class:'durable',id:'p2'}));
 await s.deliverTo('host');
 // The second commit reaches the replica before the first one it depends on: it is buffered and asked for, never
 // applied on a parent the replica cannot place.
 const frames=s.net.batch();
 for(const entry of [...frames.filter(entry=>entry.to==='beto')].reverse())s.net.dispatch(entry);
 for(const entry of frames.filter(entry=>entry.to!=='beto'))s.net.dispatch(entry);
 await s.replica().idle();
 const buffered=s.replica().receipts().filter(entry=>entry.id==='p2')[0]!;
 expect(buffered.status).toBe('pending');
 await s.settle();
 expect(s.replica().head().generation).toBe(3);
 expect(s.replica().head().commit).toEqual(s.host.head().commit);
 expect(s.replica().receipts().filter(receipt=>receipt.status==='adopted').length).toBe(2);
 const replicaHistory=await s.replicaWorlds.history(s.replica().head(),10);
 const hostHistory=await s.hostWorlds.history(s.host.head(),10);
 if(!replicaHistory.ok||!hostHistory.ok)throw new Error('Histórico ausente');
 expect(replicaHistory.value.flatMap(version=>version.accepted)).toEqual(hostHistory.value.flatMap(version=>version.accepted));
 expect(await semanticHash(await stateOf(s.replicaWorlds,s.replica().head()))).toBe(await semanticHash(await stateOf(s.hostWorlds,s.host.head())));
});

test('the proposal queue is bounded and a full queue changes nothing',async()=>{
 const gate=deferred<void>();
 const s=await scene({hostFault:{skip:1,gate:gate.promise},limits:{...NETWORK_LIMITS,maxProposalQueue:1}});
 await s.participate();
 const head=s.host.head();
 const first=s.host.submit(await s.proposal({id:'p1',intent:build('park',[at(1,1)]),head,revision:0}));
 expect(s.host.pending()).toBe(1);
 const refused=await s.host.submit(await s.proposal({id:'p2',intent:build('park',[at(2,2)]),head,revision:0}));
 expect(s.host.pending()).toBe(1);
 expect(refused.status).toBe('refused');
 expect(refused.code).toBe('LIMIT');
 gate.resolve();
 expect((await first).status).toBe('accepted');
 expect(s.host.pending()).toBe(0);
 expect(s.host.head().generation).toBe(2);
 expect((await stateOf(s.hostWorlds,s.host.head())).revision).toBe(1);
 expect((await stateOf(s.hostWorlds,s.host.head())).money).toBe(20000-30);
});

test('a replica buffers only what it can place, and only the host schedules ticks',async()=>{
 const s=await scene({limits:{...NETWORK_LIMITS,maxProposalQueue:1}});
 await s.participate();
 expect('step' in s.replica()).toBe(false);
 const receipt=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 expect(receipt.status).toBe('accepted');
 // A peer may not schedule a tick: the clock of the session belongs to the host (§7.5).
 const peerTick=await s.host.submit(await s.proposal({id:'t1',intent:{type:'tick'},head:s.host.head(),revision:1}));
 expect(peerTick.status).toBe('refused');
 expect(peerTick.code).toBe('PERMISSION');
 // A commit whose parent the replica never saw is buffered and asked for, under a bound.
 const real=s.commitOf('p1');
 const orphan=(id:string,marker:string):AcceptedCommit=>({...real,id,digest:'00'.repeat(32),parent:{...real.parent,commit:{hash:marker.repeat(32),bytes:1},generation:real.parent.generation+5}});
 const first=await s.replica().receive(orphan('o1','ab'));
 expect(first.status).toBe('pending');
 expect(s.replica().pending().commits).toBe(1);
 const second=await s.replica().receive(orphan('o2','cd'));
 expect(second.status).toBe('refused');
 expect(second.code).toBe('LIMIT');
 expect(s.replica().receipts().every(entry=>entry.id!=='o1'||entry.status!=='adopted')).toBe(true);
 // A tick is the host's, and the replica only ever follows it.
 const tick=await s.host.step();
 expect(tick.ok).toBe(true);
 await s.settle();
 expect((await stateOf(s.replicaWorlds,s.replica().head())).tick).toBe((await stateOf(s.hostWorlds,s.host.head())).tick);
});

test('a session reopened from the checkpoint and the branch recognises what it already adopted',async()=>{
 const s=await scene();
 await s.participate();
 const receipt=await s.submit({id:'p1',intent:build('park',[at(1,1)])});
 const adopted=s.replica().receipts().at(-1)!;
 expect(adopted.status).toBe('adopted');
 const reopened=createReplicaSession({repository:s.replicaWorlds,transport:s.net.connect('beto2'),peer:'beto2',host:'host',head:adopted.head,verifier,codec,hasher,now:()=>NOW,sessionId:SESSION,epoch:1,limits:NETWORK_LIMITS});
 expect((await reopened.receive(s.commitOf('p1'))).status).toBe('duplicate');
 expect((await reopened.receive(s.commitOf('p1'))).status).toBe('duplicate');
 expect(reopened.head().commit).toEqual(receipt.head.commit);
 expect((await stateOf(s.replicaWorlds,reopened.head())).money).toBe(20000-30);
});

// The fixture is data, checked by the driver below; the compiler widens a JSON import, so its shape is declared here.
type ChaosStep=
 | {kind:'participation'}
 | {kind:'proposal';id:string;tool:string;cells:number[][];deliver?:boolean}
 | {kind:'duplicate';id:string}
 | {kind:'reverse'}
 | {kind:'deliver';to:string}
 | {kind:'drop';to:string;of:string}
 | {kind:'tick'}
 | {kind:'reload';peer:string}
 | {kind:'settle'};
type ChaosScenario={
 worldId:string;branchId:string;sessionId:string;epoch:number;seed:number;chunk:string;host:string;replica:string;
 grant:{spendLimit:number};
 steps:ChaosStep[];
 expect:{money:number;tick:number;revision:number;generation:number;accepted:string[];refused:string[];duplicated:string[];eachOperationOnce:boolean};
};
const scenario=chaos as unknown as ChaosScenario;

test('a deterministic chaos session keeps one commit per operation and asks for whatever it lacks',async()=>{
 const s=await scene({captures:{'0:0':blank('0:0')},limits:{...NETWORK_LIMITS,maxProposalQueue:4},sessionId:scenario.sessionId,epoch:scenario.epoch});
 const statusOf=(id:string)=>receiptsOf(s.inbox,id).at(-1)?.status;
 for(const step of scenario.steps){
  if(step.kind==='participation')await s.participate({spendLimit:scenario.grant.spendLimit});
  else if(step.kind==='proposal'){
   const boot=await s.host.checkpoint();
   const proposal=await s.proposal({id:step.id,intent:build(step.tool==='road'?'road':'park',step.cells.map(([x,y])=>({x,y}))),head:boot.head,revision:boot.state.revision});
   await s.player.send('host',wire(proposal as unknown as JsonValue,{class:'durable',sessionId:scenario.sessionId,id:step.id}));
   if(step.deliver!==false)await s.settle();
  }else if(step.kind==='duplicate')await s.repeat(step.id);
  else if(step.kind==='reverse'){
   for(const entry of [...s.net.batch()].reverse())s.net.dispatch(entry);
   await s.settle();
  }else if(step.kind==='deliver'){
   for(const entry of s.net.batch())if(entry.to===step.to)s.net.dispatch(entry);
   await s.host.idle();
  }else if(step.kind==='drop'){
   for(const entry of s.net.batch()){
    const body=sessionBody(entry.message);
    if(entry.to===step.to&&body.kind==='commit'&&body.commit.id===step.of)continue;
    s.net.dispatch(entry);
   }
   await s.settle();
  }else if(step.kind==='tick'){
   const result=await s.host.step();
   if(!result.ok)throw new Error(result.error.message);
   await s.settle();
  }else if(step.kind==='reload'){
   s.setReplica(createReplicaSession({repository:s.replicaWorlds,transport:s.net.connect(step.peer),peer:step.peer,host:scenario.host,head:s.replica().head(),verifier,codec,hasher,now:()=>NOW,sessionId:scenario.sessionId,epoch:scenario.epoch,limits:{...NETWORK_LIMITS,maxProposalQueue:4}}));
  }else await s.settle();
 }
 const hostHead=s.host.head();
 const hostState=await stateOf(s.hostWorlds,hostHead);
 const replicaState=await stateOf(s.replicaWorlds,s.replica().head());
 expect(hostHead.generation).toBe(scenario.expect.generation);
 expect(hostState.money).toBe(scenario.expect.money);
 expect(hostState.tick).toBe(scenario.expect.tick);
 expect(hostState.revision).toBe(scenario.expect.revision);
 expect(s.replica().head().commit).toEqual(hostHead.commit);
 expect(await semanticHash(replicaState)).toBe(await semanticHash(hostState));
 // An operation that was accepted once and repeated later is accepted first and answered as a duplicate afterwards.
 for(const id of scenario.expect.accepted)expect(receiptsOf(s.inbox,id).some(receipt=>receipt.status==='accepted')).toBe(true);
 for(const id of scenario.expect.refused)expect(statusOf(id)).toBe('refused');
 for(const id of scenario.expect.duplicated)expect(statusOf(id)).toBe('duplicate');
 const hostHistory=await s.hostWorlds.history(hostHead,32);
 const replicaHistory=await s.replicaWorlds.history(s.replica().head(),32);
 if(!hostHistory.ok||!replicaHistory.ok)throw new Error('Histórico ausente');
 const operations=hostHistory.value.flatMap(version=>version.accepted);
 for(const id of scenario.expect.accepted)expect(operations.filter(entry=>entry.includes(`.${id}@`)).length).toBe(1);
 expect(replicaHistory.value.flatMap(version=>version.accepted)).toEqual(operations);
 // One commit per operation, one create commit, and nothing applied twice: the branch has exactly the shape the
 // scenario declares.
 expect(operations.length).toBe(scenario.expect.accepted.length+2);
 expect(hostHistory.value.length).toBe(scenario.expect.generation);
});
