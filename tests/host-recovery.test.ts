// A player-hosted branch changing hands, and what is left when it does not (plan Task 13; spec §7.5; OpenSim Protocol
// §27 capability, §28 scoped authority, §39.5 join). The host orders transactions and is the only one that writes: a
// planned transfer pauses the epoch, publishes the capability of the successor and replicates the last head, and the
// successor only writes in the epoch the owner granted it. When the host is simply gone nothing is elected by a
// timeout — the owner recovers from the last verifiable prefix available, or the work continues as a personal fork —
// and two claims on the same epoch stop the integration instead of being merged by guesswork.
import {RULES_VERSION} from '../src/core/model';
import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {ed25519Verifier,generateSessionKeyPair,localIdentityProvider,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {createMemoryNetwork} from '../src/adapters/network/memory';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {createHostSession,readBody} from '../src/session/host-session';
import type {HostSession,SessionBody} from '../src/session/host-session';
import {createReplicaSession} from '../src/session/replica-session';
import type {EpochReceipt,ReplicaSession} from '../src/session/replica-session';
import {acceptHandover,activeWritersForBranch,epochAuthority,prepareHandover,recoverBranch} from '../src/session/recovery';
import type {EpochGrant,HandoverOffer,RecoveryCandidate} from '../src/session/recovery';
import type {MapSource} from '../src/session/ports';
import {importLegacy} from '../src/session/world-bundle';
import {createWorldRepository} from '../src/session/world-repository';
import type {WorldRepository} from '../src/session/world-repository';
import type {WorldStorage} from '../src/session/world-ports';
import {sessionEnvelope} from '../src/presentation/multiplayer';
import {createKernel} from '../src/world/kernel';
import {createGame} from '../src/core/commands';
import {durableJson} from '../src/core/protocol';
import {grantBytes,proposalBytes} from '../src/world/permissions';
import type {Grant,IdentityProof,IdentityScope,Proposal,Principal} from '../src/world/permissions';
import {NETWORK_LIMITS} from '../src/world/wire';
import type {Limits,TrafficClass,WireMessage} from '../src/world/wire';
import type {Action,BaseChunk,CellCoord,GameState,SavedGame,ViewState} from '../src/core/model';
import type {Head,JsonValue,} from '../src/world/model';
import {blank} from './fixtures/world';
import chaos from './fixtures/federated-world/session-chaos.json';

const codec=createJcsCodec(),hasher=bytesHasher(),verifier=ed25519Verifier();
const NOW='2026-09-29T12:00:00Z';
const SESSION='sessao-transferencia';
const MAIN={worldId:'victoria',branchId:'main'};
const ANA={scheme:'nostr',id:'npub1ana'},BETO={scheme:'nostr',id:'npub1beto'},CAIO={scheme:'nostr',id:'npub1caio'};
const terms=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const view:ViewState={x:12.5,y:-4,zoom:1.5,speed:1,place:'Victoria'};
// Cells inside '9:9', whose origin is (288,288).
const at=(x:number,y:number):CellCoord=>({x:288+x,y:288+y});
const scopeOf=(over:Partial<IdentityScope>={}):IdentityScope=>({...MAIN,sessionId:SESSION,notBefore:'2026-09-29T11:00:00Z',notAfter:'2026-09-29T13:00:00Z',...over});

// --- the people and the documents they sign --------------------------------------------------------------------
type Actor={principal:Principal;identity:IdentityProof;keys:KeyPair;root:KeyPair};
async function actorOf(principal:Principal,keys:KeyPair,root:KeyPair,sessionId=SESSION):Promise<Actor>{
 const bound=await localIdentityProvider({root,session:keys,codec}).bindSession({principal,scope:scopeOf({sessionId})});
 if(!bound.ok)throw new Error(bound.error.message);
 return {principal,identity:bound.value,keys,root};
}
const ANA_KEYS=await generateSessionKeyPair(),ANA_ROOT=await generateSessionKeyPair();
const BETO_KEYS=await generateSessionKeyPair(),BETO_ROOT=await generateSessionKeyPair();
const CAIO_KEYS=await generateSessionKeyPair(),CAIO_ROOT=await generateSessionKeyPair();
const ANA_ACTOR=await actorOf(ANA,ANA_KEYS,ANA_ROOT);
const BETO_ACTOR=await actorOf(BETO,BETO_KEYS,BETO_ROOT);
const CAIO_ACTOR=await actorOf(CAIO,CAIO_KEYS,CAIO_ROOT);
// The owner issues grants with the session key it presented, which is exactly what `verifyGrant` checks against the
// issuer's binding when a peer has to believe a concession it received.
async function grantOf(grantee:Actor,signer:KeyPair,over:Partial<Grant>={}):Promise<Grant>{
 const base:Grant={kind:'grant',id:`concessao-${grantee.principal.id}`,principal:grantee.principal,...MAIN,actions:['build','demolish','component','tick','host'],namespaces:[],spendLimit:30000,proof:{kind:'message',algorithm:'Ed25519',sessionKey:signer.publicKey,signature:''}};
 const merged:Grant={...base,...over};
 return {...merged,proof:{kind:'message',algorithm:'Ed25519',sessionKey:signer.publicKey,signature:await signEd25519(signer,grantBytes(merged,codec))}};
}
const ANA_GRANT=await grantOf(ANA_ACTOR,ANA_KEYS);
const BETO_GRANT=await grantOf(BETO_ACTOR,ANA_KEYS);
const CAIO_GRANT=await grantOf(CAIO_ACTOR,ANA_KEYS);
type ProposalOptions={id:string;intent:Action;head:Head;revision:number;costLimit?:number;epoch?:number};
async function proposalOf(actor:Actor,epoch:number,options:ProposalOptions):Promise<Proposal>{
 const base:Proposal={worldProtocol:2,wireVersion:1,kind:'proposal',worldId:options.head.worldId,branchId:options.head.branchId,sessionId:SESSION,epoch:options.epoch??epoch,id:options.id,principal:actor.principal,sessionKey:actor.keys.publicKey,observedHead:options.head.commit,intent:options.intent,preconditions:{revision:options.revision},costLimit:options.costLimit??30000,proof:{kind:'message',algorithm:'Ed25519',sessionKey:actor.keys.publicKey,signature:''}};
 return {...base,proof:{kind:'message',algorithm:'Ed25519',sessionKey:actor.keys.publicKey,signature:await signEd25519(actor.keys,proposalBytes(base,codec))}};
}
const build=(tool:'park'|'road'|'power',cells:CellCoord[]):Action=>({type:'build',tool,cells});

// --- the devices, the branch and the wire ---------------------------------------------------------------------
async function open(worlds:WorldRepository,state:GameState):Promise<Head>{
 const save:SavedGame={version:1,state,view};
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error(imported.error.message);
 const created=await worlds.create(imported.value);
 if(!created.ok)throw new Error(created.error.message);
 return created.value;
}
// A device that can stop answering for one object: the copy a transfer offers is then honestly incomplete, which is
// what a host that lost bytes looks like from outside.
function hiding(storage:WorldStorage,hidden:Set<string>):WorldStorage{
 return {
  head:address=>storage.head(address),
  heads:worldId=>storage.heads(worldId),
  object:ref=>hidden.has(ref.hash)?Promise.resolve(null):storage.object(ref),
  receipt:(address,id)=>storage.receipt(address,id),
  receipts:address=>storage.receipts(address),
  commit:transaction=>storage.commit(transaction),
 };
}
function maps(captures:Record<string,BaseChunk>){
 const calls:string[]=[];
 const source:MapSource={attribution:{text:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright'},async loadChunk(id){calls.push(id);const base=captures[id];if(!base)throw new Error(`Região indisponível: ${id}`);return base;}};
 return {source,calls};
}
let counter=0;
const wire=(body:JsonValue,over:Partial<{class:TrafficClass;sessionId:string;epoch:number;id:string}>={}):WireMessage=>({envelope:{worldProtocol:2,wireVersion:1,kind:'message',class:over.class??'control',worldId:MAIN.worldId,branchId:MAIN.branchId,sessionId:over.sessionId??SESSION,epoch:over.epoch??1,id:over.id??`t${++counter}`},body});
const bodiesOf=<T extends SessionBody['kind']>(inbox:readonly WireMessage[],kind:T)=>inbox.flatMap(message=>{
 const parsed=readBody(message.body);
 return parsed.ok&&parsed.value.kind===kind?[parsed.value as Extract<SessionBody,{kind:T}>]:[];
});
const receiptsOf=(inbox:readonly WireMessage[],id?:string)=>bodiesOf(inbox,'proposal-receipt').map(body=>body.receipt).filter(receipt=>!id||receipt.id===id);
const statusOf=(inbox:readonly WireMessage[],id:string)=>receiptsOf(inbox,id).at(-1)?.status;
const stateOf=async(worlds:WorldRepository,head:Head):Promise<GameState>=>{const point=await worlds.checkout(head);if(!point.ok)throw new Error(point.error.message);return point.value.state;};
const semanticHash=async(state:GameState)=>(await hasher.ref(new TextEncoder().encode(durableJson(state)))).hash;

// --- a whole branch, wired the way the client wires it ---------------------------------------------------------
type SceneOptions={ledgerWindow?:number;limits?:Limits};
async function scene(options:SceneOptions={}){
 const start=createGame(MAIN.worldId,7,blank('9:9'));
 const hostDevice=createWorldMemoryStorage(),betoDevice=createWorldMemoryStorage(),caioDevice=createWorldMemoryStorage();
 const hidden=new Set<string>();
 const hostWorlds=createWorldRepository({storage:hiding(hostDevice,hidden),codec,hasher});
 const betoWorlds=createWorldRepository({storage:betoDevice,codec,hasher});
 const caioWorlds=createWorldRepository({storage:caioDevice,codec,hasher});
 const startHead=await open(hostWorlds,start);
 const betoHead=await open(betoWorlds,start),caioHead=await open(caioWorlds,start);
 const net=createMemoryNetwork();
 const source=maps({'9:9':blank('9:9')});
 const kernel=createKernel();
 const limits=options.limits??NETWORK_LIMITS;
 const host=createHostSession({repository:hostWorlds,transport:net.connect('host'),peer:'host',head:startHead,identity:ANA_ACTOR.identity,grants:[ANA_GRANT,BETO_GRANT,CAIO_GRANT],rules:{family:'city',version:RULES_VERSION},bases:source.source,verifier,codec,hasher,now:()=>NOW,sessionId:SESSION,epoch:1,limits,peers:['beto','caio'],capabilities:kernel,ledgerWindow:options.ledgerWindow});
 const beto:ReplicaSession=createReplicaSession({repository:betoWorlds,transport:net.connect('beto'),peer:'beto',host:'host',head:betoHead,verifier,codec,hasher,now:()=>NOW,sessionId:SESSION,epoch:1,limits,grants:[ANA_GRANT,BETO_GRANT,CAIO_GRANT]});
 const caio:ReplicaSession=createReplicaSession({repository:caioWorlds,transport:net.connect('caio'),peer:'caio',host:'host',head:caioHead,verifier,codec,hasher,now:()=>NOW,sessionId:SESSION,epoch:1,limits,grants:[ANA_GRANT,BETO_GRANT,CAIO_GRANT]});
 const inbox:WireMessage[]=[];const player=net.connect('ana');player.subscribe((_peer,message)=>inbox.push(message));
 const proposals=new Map<string,Proposal>();
 async function settle(rounds=12){
  for(let round=0;round<rounds;round+=1){
   await host.idle();await beto.idle();await caio.idle();
   if(!net.queued())return;
   net.deliver();
  }
  await host.idle();
 }
 async function participate(actor:Actor,grant:Grant){
  await player.send('host',wire(actor.identity as unknown as JsonValue,{id:`${actor.principal.id}-identity`}));
  await player.send('host',wire(grant as unknown as JsonValue,{id:`${actor.principal.id}-grant`}));
  await settle();
 }
 async function proposalFor(actor:Actor,epoch:number,options:{id:string;intent:Action;head?:Head;revision?:number;costLimit?:number}){
  const boot=await host.checkpoint();
  const built=await proposalOf(actor,epoch,{...options,head:options.head??boot.head,revision:options.revision??boot.state.revision});
  proposals.set(built.id,built);
  return built;
 }
 async function sendProposal(session:HostSession,proposal:Proposal,over:Partial<{epoch:number;id:string}>={}){
  await player.send('host',wire(proposal as unknown as JsonValue,{class:'durable',id:over.id??proposal.id,epoch:over.epoch??proposal.epoch}));
  return session.submit(proposal);
 }
 const commitOf=(id:string)=>{const found=bodiesOf(inbox,'commit').map(body=>body.commit).filter(commit=>commit.id===id);const commit=found[found.length-1];if(!commit)throw new Error(`Commit ausente para ${id}`);return commit;};
 // A host session opened on the successor's own device, in the epoch the transfer granted.
 async function successorHost(grant:EpochGrant,peers:readonly string[]=['caio']){
  return createHostSession({repository:betoWorlds,transport:net.connect('beto-host'),peer:'beto-host',head:beto.head(),identity:BETO_ACTOR.identity,grants:[grant.grant],rules:{family:'city',version:RULES_VERSION},bases:source.source,verifier,codec,hasher,now:()=>NOW,sessionId:SESSION,epoch:grant.epoch,limits,peers});
 }
 return {net,host,beto,caio,betoWorlds,caioWorlds,hostWorlds,kernel,startHead,source,proposals,inbox,player,hidden,settle,participate,proposalFor,sendProposal,commitOf,successorHost,replicas:()=>beto};
}
// A branch with one accepted build in it, and the version that build produced. The owner presents what it writes
// with before anything is ordered: a session only accepts a proposal from an identity it was shown.
async function ownedBranch(){
 const s=await scene();
 await s.participate(ANA_ACTOR,ANA_GRANT);
 const built=await s.host.submit(await s.proposalFor(ANA_ACTOR,1,{id:'p1',intent:build('park',[at(1,1)])}));
 if(built.status!=='accepted')throw new Error(`Construção recusada: ${built.reason??built.status}`);
 await s.settle();
 return {...s,built:built.head};
}
const epochGrantOf=async(offer:HandoverOffer,over:Partial<Grant>={}):Promise<EpochGrant>=>({
 kind:'epoch-grant',
 id:`epoca-${offer.epoch}`,
 owner:offer.owner,
 successor:offer.successor,
 worldId:offer.worldId,
 branchId:offer.branchId,
 sessionId:offer.sessionId,
 epoch:offer.epoch,
 head:offer.head,
 grant:await grantOf(BETO_ACTOR,ANA_KEYS,{id:`concessao-epoca-${offer.epoch}`,epoch:offer.epoch,...over}),
});
const candidateOf=(over:Partial<RecoveryCandidate>&{head:Head}):RecoveryCandidate=>({epoch:1,writer:ANA,complete:true,confirmed:false,source:'cópia local',...over});

test('a planned transfer pauses the epoch, publishes the capability and replicates the last head',async()=>{
 const s=await ownedBranch();
 const head=s.built;
 // The session descriptor is what the successor joins by (§23, §39.5).
 const descriptor={uri:`osim:session:${SESSION}`,actor:`${ANA.scheme}:${ANA.id}`,worldId:MAIN.worldId,branchId:MAIN.branchId,sessionId:SESSION,epoch:1,participants:[ANA.id,BETO.id],startedAt:NOW};
 await s.kernel.publish(sessionEnvelope(descriptor));
 const offered=await prepareHandover(s.host,BETO);
 expect(offered.ok).toBe(true);
 if(!offered.ok)return;
 const offer=offered.value;
 expect(offer.epoch).toBe(2);
 expect(offer.previousEpoch).toBe(1);
 expect(offer.head.commit).toEqual(head.commit);
 expect(offer.successor).toEqual(BETO);
 expect(offer.published).toBe(true);
 expect(offer.capability.type).toBe('capability');
 expect(offer.capability.actor).toBe(`${ANA.scheme}:${ANA.id}`);
 // §27: issuer, successor, branch, session, epoch and last head travel in the published object itself.
 const stored=await s.kernel.resolve(offer.capability.id);
 expect(stored.ok&&stored.value!==null).toBe(true);
 if(stored.ok&&stored.value)expect(stored.value.body).toMatchObject({capability:'host',successor:`${BETO.scheme}:${BETO.id}`,branchId:MAIN.branchId,sessionId:SESSION,epoch:2,previousEpoch:1});
 const joined=await s.kernel.join(`osim:session:${SESSION}`);
 expect(joined.ok&&joined.value!==null).toBe(true);
 // Paused means paused: nothing durable is confirmed in the epoch that is closing.
 const after=await s.host.submit(await s.proposalFor(ANA_ACTOR,1,{id:'p2',intent:build('park',[at(2,2)])}));
 expect(after.status).toBe('refused');
 expect(after.head.commit).toEqual(head.commit);
 const ticked=await s.host.step();
 expect(ticked.ok).toBe(false);
 expect(s.host.head().commit).toEqual(head.commit);
 // The offer carries the whole last head, so the successor opens the same version on its own device.
 const accepted=await acceptHandover(offer,await epochGrantOf(offer),s.caioWorlds);
 expect(accepted.ok).toBe(true);
 if(accepted.ok)expect(accepted.value.commit).toEqual(head.commit);
 expect(await semanticHash(await stateOf(s.caioWorlds,head))).toBe(await semanticHash(await stateOf(s.hostWorlds,head)));
 expect(activeWritersForBranch(epochAuthority(await epochGrantOf(offer)))).toBe(1);
});

test('a successor without the offered version asks for it instead of adopting an incomplete head',async()=>{
 const s=await ownedBranch();
 const head=s.built;
 // A copy that never saw this branch opens the offered package; a copy that has an older head does not.
 const fresh=createWorldRepository({storage:createWorldMemoryStorage(),codec,hasher});
 const offered=await prepareHandover(s.host,BETO);
 if(!offered.ok)throw new Error(offered.error.message);
 const grant=await epochGrantOf(offered.value);
 const opened=await acceptHandover(offered.value,grant,fresh);
 expect(opened.ok).toBe(true);
 expect(await semanticHash(await stateOf(fresh,head))).toBe(await semanticHash(await stateOf(s.hostWorlds,head)));
 // The host lost an object of the prefix: the offer says so, and a copy that has never opened the branch refuses
 // instead of restoring bytes nobody retained.
 const generationTwo=await s.hostWorlds.history(head,4);
 if(!generationTwo.ok)throw new Error(generationTwo.error.message);
 const ancestor=generationTwo.value.at(-1)!.head.commit;
 s.hidden.add(ancestor.hash);
 const second=await prepareHandover(s.host,BETO);
 if(!second.ok)throw new Error(second.error.message);
 expect(second.value.missing.some(ref=>ref.hash===ancestor.hash)).toBe(true);
 const unprepared=createWorldRepository({storage:createWorldMemoryStorage(),codec,hasher});
 const refused=await acceptHandover(second.value,grant,unprepared);
 expect(refused.ok).toBe(false);
 if(!refused.ok){
  expect(refused.error.code).toBe('MISSING_OBJECT');
  expect(refused.error.message).toContain(ancestor.hash.slice(0,12));
 }
 // A successor that is simply behind the offered version is told which version to fetch first: the commit never
 // reached it, so its copy stops one version short of the offer.
 const behind=await scene();
 await behind.participate(ANA_ACTOR,ANA_GRANT);
 const ahead=await behind.host.submit(await behind.proposalFor(ANA_ACTOR,1,{id:'p1',intent:build('park',[at(1,1)])}));
 if(ahead.status!=='accepted')throw new Error(ahead.reason??ahead.status);
 const late=await prepareHandover(behind.host,BETO);
 if(!late.ok)throw new Error(late.error.message);
 const behindRefusal=await acceptHandover(late.value,await epochGrantOf(late.value),behind.caioWorlds);
 expect(behindRefusal.ok).toBe(false);
 if(!behindRefusal.ok)expect(behindRefusal.error.code).toBe('MISSING_OBJECT');
 expect(behind.caio.head().generation).toBeLessThan(late.value.head.generation);
});

test('a stale epoch grant is refused, and only the new epoch writes afterwards',async()=>{
 const s=await ownedBranch();
 const head=s.built;
 const offered=await prepareHandover(s.host,BETO);
 if(!offered.ok)throw new Error(offered.error.message);
 const offer=offered.value;
 // The owner approved an earlier head in an earlier epoch: that grant cannot open this transfer.
 const stale=await epochGrantOf({...offer,epoch:offer.previousEpoch,head:s.startHead},{epoch:offer.previousEpoch});
 const refused=await acceptHandover(offer,stale,s.betoWorlds);
 expect(refused.ok).toBe(false);
 if(!refused.ok)expect(refused.error.code).toBe('CONFLICT');
 const outdated=await acceptHandover(offer,{...await epochGrantOf(offer),head:s.startHead},s.betoWorlds);
 expect(outdated.ok).toBe(false);
 // With the epoch grant of the transfer the successor accepts the head it already verified as a replica.
 const grant=await epochGrantOf(offer);
 const accepted=await acceptHandover(offer,grant,s.betoWorlds);
 expect(accepted.ok).toBe(true);
 // The successor now hosts the new epoch, and the frames of the epoch that closed are fenced.
 const host2=await s.successorHost(grant,['caio','ana']);
 await s.player.send('beto-host',wire(BETO_ACTOR.identity as unknown as JsonValue,{epoch:2,id:'beto-identity'}));
 await s.player.send('beto-host',wire(grant.grant as unknown as JsonValue,{epoch:2,id:'beto-grant'}));
 await s.settle();
 const oldEpoch=await proposalOf(ANA_ACTOR,1,{id:'velho',intent:build('park',[at(3,3)]),head,revision:1});
 await s.player.send('beto-host',wire(oldEpoch as unknown as JsonValue,{class:'durable',epoch:1,id:'velho'}));
 await s.settle();
 expect(host2.head().commit).toEqual(head.commit);
 expect(statusOf(s.inbox,'velho')).toBeUndefined();
 const proposal=await proposalOf(BETO_ACTOR,2,{id:'novo',intent:build('park',[at(3,3)]),head:host2.head(),revision:1});
 const receipt=await host2.submit(proposal);
 expect(receipt.status).toBe('accepted');
 expect(receipt.head.generation).toBe(head.generation+1);
 expect((await stateOf(s.betoWorlds,receipt.head)).money).toBe(20000-60);
 // The balance, the revision and the counter continue from the transferred head: a transfer moves the epoch and not
 // the world.
 const before=await stateOf(s.hostWorlds,head);
 const after=await stateOf(s.betoWorlds,receipt.head);
 expect(after.revision).toBe(before.revision+1);
 expect(after.actors[receipt.actorId!]).toBe(1);
});

test('a crash before the ACK leaves no writer, and recovery needs the owner',async()=>{
 const s=await ownedBranch();
 const head=s.built;
 const offered=await prepareHandover(s.host,BETO);
 if(!offered.ok)throw new Error(offered.error.message);
 // The host died between pausing and the successor accepting: the successor's copy never adopted an epoch.
 const successor=s.beto;
 const candidates=[candidateOf({head:s.host.head(),complete:true,confirmed:true,source:'ana'}),candidateOf({head:successor.head(),complete:true,epoch:2,writer:BETO,source:'beto'})];
 // Without a recovery grant the owner continues nothing: the branch would have two writers.
 const noGrant=recoverBranch([candidates[1]!],{kind:'continue',candidateIndex:0,reason:'A queda do anfitrião'});
 expect(noGrant.ok).toBe(false);
 if(!noGrant.ok)expect(noGrant.error.code).toBe('PERMISSION');
 const beforeAck=recoverBranch(candidates,{kind:'fork',candidateIndex:0,reason:'O anfitrião não voltou'});
 expect(beforeAck.ok).toBe(true);
 if(!beforeAck.ok)return;
 expect(beforeAck.value.mode).toBe('fork');
 expect(beforeAck.value.head.commit).toEqual(head.commit);
 expect(beforeAck.value.evidence.length).toBe(2);
 expect(activeWritersForBranch(beforeAck.value.authority)).toBe(0);
 // Asked to continue without a concession, the plan says exactly where to continue instead.
 const stop=recoverBranch(candidates,{kind:'stop',reason:'Sem concessão de recuperação'});
 expect(stop.ok).toBe(true);
 if(stop.ok)expect(activeWritersForBranch(stop.value.authority)).toBe(0);
});

test('two concurrent grants for the same epoch stop the integration',async()=>{
 const s=await ownedBranch();
 const head=s.built;
 const first=await prepareHandover(s.host,BETO);
 if(!first.ok)throw new Error(first.error.message);
 const grant=await epochGrantOf(first.value);
 const withGrant=candidateOf({head:s.host.head(),epoch:2,writer:BETO,grant:grant.grant,complete:true,confirmed:true,source:'beto'});
 // Another copy claims the same epoch for another writer: nothing can choose between them.
 const competing=candidateOf({head:s.host.head(),epoch:2,writer:CAIO,grant:CAIO_GRANT,complete:true,source:'caio'});
 const refused=recoverBranch([withGrant,competing],{kind:'continue',candidateIndex:0,reason:'Sigo com o Beto'});
 expect(refused.ok).toBe(false);
 if(!refused.ok)expect(refused.error.message).toContain('época 2');
 const stopped=recoverBranch([withGrant,competing],{kind:'stop',reason:'Duas concessões para a época 2'});
 expect(stopped.ok).toBe(true);
 if(!stopped.ok)return;
 expect(stopped.value.mode).toBe('stop');
 expect(activeWritersForBranch(stopped.value.authority)).toBe(0);
 expect(stopped.value.authority.kind).toBe('stopped');
 expect(stopped.value.evidence.length).toBe(2);
 // A single grant for the epoch is a writer, and the head it rests on is kept.
 const alone=recoverBranch([withGrant],{kind:'continue',candidateIndex:0,reason:'O Beto tem a concessão'});
 expect(alone.ok).toBe(true);
 if(alone.ok){
  expect(activeWritersForBranch(alone.value.authority)).toBe(1);
  expect(alone.value.head.commit).toEqual(head.commit);
  expect(alone.value.regressed).toBe(false);
 }
});

test('recovery never orders candidates by the timestamp',async()=>{
 const s=await ownedBranch();
 const head=s.built;
 const epochTwo=await grantOf(BETO_ACTOR,ANA_KEYS,{id:'concessao-epoca-2',epoch:2});
 // Two different epochs, so this is not the concurrent-history case: one copy stopped at the prefix, the other holds
 // the version this device already showed as confirmed — with the *later* timestamp on the older head.
 const older=candidateOf({head:s.startHead,epoch:1,writer:ANA,grant:ANA_GRANT,complete:true,source:'cópia antiga',observedAt:'2026-09-29T23:59:00Z'});
 const newer=candidateOf({head,epoch:2,writer:BETO,grant:epochTwo,complete:true,confirmed:true,source:'cópia local',observedAt:'2026-09-29T12:00:00Z'});
 // Going back past a confirmed version has to be said out loud: nothing here compares clocks.
 const silent=recoverBranch([older,newer],{kind:'continue',candidateIndex:0,reason:'A outra cópia é mais recente'});
 expect(silent.ok).toBe(false);
 if(!silent.ok){
  expect(silent.error.code).toBe('CONFLICT');
  expect(silent.error.message).toContain('confirmado');
 }
 const explicit=recoverBranch([older,newer],{kind:'continue',candidateIndex:0,reason:'Recupero do prefixo verificável',acknowledgeRegression:true});
 expect(explicit.ok).toBe(true);
 if(!explicit.ok)return;
 expect(explicit.value.regressed).toBe(true);
 expect(explicit.value.head.commit).toEqual(s.startHead.commit);
 // The evidence of the version that was confirmed is preserved, and reversing the candidate order changes nothing.
 expect(explicit.value.evidence.some(candidate=>candidate.confirmed&&candidate.head.commit.hash===head.commit.hash)).toBe(true);
 const reversed=recoverBranch([newer,{...older,observedAt:'2020-01-01T00:00:00Z'}],{kind:'continue',candidateIndex:1,reason:'Recupero do prefixo verificável',acknowledgeRegression:true});
 expect(reversed.ok).toBe(true);
 if(reversed.ok){
  expect(reversed.value.head.commit).toEqual(s.startHead.commit);
  expect(reversed.value.epoch).toBe(1);
 }
 // Two heads claiming one epoch are two histories of it, and that stops the integration whatever the clocks say.
 const divergent=recoverBranch([candidateOf({head,epoch:1,writer:ANA,grant:ANA_GRANT,complete:true,confirmed:true,source:'ana'}),older],{kind:'continue',candidateIndex:0,reason:'Sigo com a minha cópia'});
 expect(divergent.ok).toBe(false);
 if(!divergent.ok)expect(divergent.error.message).toContain('época 1');
 // An incomplete candidate is not adopted at all: what no copy retained is not promised.
 const incomplete=recoverBranch([candidateOf({head,epoch:1,writer:ANA,grant:ANA_GRANT,complete:false,missing:[head.commit],source:'caio'})],{kind:'continue',candidateIndex:0,reason:'Sigo com o Caio'});
 expect(incomplete.ok).toBe(false);
 if(!incomplete.ok)expect(incomplete.error.code).toBe('MISSING_OBJECT');
});

test('a receipt compacted by a checkpoint asks for reconciliation instead of charging twice',async()=>{
 const s=await scene({ledgerWindow:4});
 await s.participate(ANA_ACTOR,ANA_GRANT);
 const receipts=[];
 for(let index=1;index<=6;index+=1)receipts.push(await s.host.submit(await s.proposalFor(ANA_ACTOR,1,{id:`p${index}`,intent:build('park',[at(index,1)])})));
 expect(receipts.every(receipt=>receipt.status==='accepted')).toBe(true);
 expect((await stateOf(s.hostWorlds,s.host.head())).money).toBe(20000-6*30);
 // The receipt of `p2` was compacted out of the window this host answers from: the repeat is not the change again.
 const repeated=await s.host.submit(await s.proposalFor(ANA_ACTOR,1,{id:'p2',intent:build('park',[at(2,1)]),head:s.startHead,revision:0}));
 expect(repeated.status).toBe('refused');
 if(repeated.status==='refused')expect(repeated.reason).toContain('reconcilie');
 expect((await stateOf(s.hostWorlds,s.host.head())).money).toBe(20000-6*30);
 expect(s.host.head().generation).toBe(7);
 // A new attempt at the current head is still ordered normally: the window bounds what can be answered, not what can
 // be done.
 const fresh=await s.host.submit(await s.proposalFor(ANA_ACTOR,1,{id:'p7',intent:build('park',[at(9,1)])}));
 expect(fresh.status).toBe('accepted');
 expect((await stateOf(s.hostWorlds,s.host.head())).money).toBe(20000-7*30);
});

test('a replica follows the new epoch once, and refuses a competing or an older one',async()=>{
 const s=await ownedBranch();
 const offered=await prepareHandover(s.host,BETO);
 if(!offered.ok)throw new Error(offered.error.message);
 const grant=await epochGrantOf(offered.value);
 // The peer only follows a grant whose issuer binding it can check, and only after the head it starts from is here.
 const followed=await s.caio.follow({host:'beto-host',sessionId:SESSION,epoch:grant.epoch,head:grant.head,grant:grant.grant,issuer:ANA_ACTOR.identity});
 expect(followed.status).toBe('following');
 expect(s.caio.epoch()).toBe(2);
 expect(s.caio.host()).toBe('beto-host');
 // A second concession for the same epoch is a divergence, not a coin to flip.
 const competing=await s.caio.follow({host:'outro-host',sessionId:SESSION,epoch:2,head:grant.head,grant:{...BETO_GRANT,epoch:2},issuer:ANA_ACTOR.identity});
 expect(competing.status).toBe('divergent');
 expect(s.caio.stopped()?.code).toBe('CONFLICT');
 // And an epoch already closed is never taken up again.
 const late=await s.caio.follow({host:'host',sessionId:SESSION,epoch:1,head:s.startHead,grant:{...ANA_GRANT,epoch:1},issuer:ANA_ACTOR.identity});
 expect(late.status).toBe('refused');
});

// The fixture is data, checked by the driver below.
type HandoverScenario={successor:{scheme:string;id:string};newEpoch:number;steps:string[];expect:{money:number;revision:number;generation:number;epoch:number;activeWriters:{continue:number;stop:number;fork:number}}};
const fixture=chaos as unknown as {handover:HandoverScenario};
const handover=fixture.handover;

test('the chaos fixture drives a transfer and two recoveries with one writer at a time',async()=>{
 const expected=handover.expect;
 // The steps the fixture declares are the steps this driver walks, in order: a fixture nobody follows is a document.
 const steps=['build-h1','settle','offer','proposal-while-paused','accept','new-epoch-host','build-h2','settle','recover-continue','recover-stop','recover-fork'];
 expect(handover.steps).toEqual(steps);
 const s=await scene();
 await s.participate(ANA_ACTOR,ANA_GRANT);
 const successor={scheme:handover.successor.scheme,id:handover.successor.id};
 expect(successor).toEqual(BETO);
 const first=await s.host.submit(await s.proposalFor(ANA_ACTOR,1,{id:'h1',intent:build('park',[at(1,1)])}));
 expect(first.status).toBe('accepted');
 await s.settle();
 const offered=await prepareHandover(s.host,BETO);
 if(!offered.ok)throw new Error(offered.error.message);
 expect(offered.value.epoch).toBe(handover.newEpoch);
 // While the transfer is prepared the epoch confirms nothing: the attempt that arrives during it is refused.
 const during=await s.host.submit(await s.proposalFor(ANA_ACTOR,1,{id:'h0',intent:build('park',[at(3,3)])}));
 expect(during.status).toBe('refused');
 expect(during.head.commit).toEqual(first.head.commit);
 const grant=await epochGrantOf(offered.value);
 const accepted=await acceptHandover(offered.value,grant,s.betoWorlds);
 expect(accepted.ok).toBe(true);
 const host2=await s.successorHost(grant,['caio','ana']);
 await s.player.send('beto-host',wire(BETO_ACTOR.identity as unknown as JsonValue,{epoch:2,id:'beto-identity'}));
 await s.player.send('beto-host',wire(grant.grant as unknown as JsonValue,{epoch:2,id:'beto-grant'}));
 await s.settle();
 const second=await proposalOf(BETO_ACTOR,2,{id:'h2',intent:build('park',[at(2,2)]),head:host2.head(),revision:1});
 const applied=await host2.submit(second);
 expect(applied.status).toBe('accepted');
 await s.settle();
 const finalHead=host2.head();
 const finalState=await stateOf(s.betoWorlds,finalHead);
 expect(finalState.money).toBe(expected.money);
 expect(finalState.revision).toBe(expected.revision);
 expect(finalHead.generation).toBe(expected.generation);
 expect(applied.head.generation).toBe(expected.generation);
 expect(handover.newEpoch).toBe(expected.epoch);
 // The transfer left exactly one writer in the epoch it opened; a divergence leaves none.
 const follow=recoverBranch([candidateOf({head:finalHead,epoch:2,writer:BETO,grant:grant.grant,complete:true,confirmed:true,source:'beto'})],{kind:'continue',candidateIndex:0,reason:'O Beto hospeda a época 2'});
 expect(follow.ok).toBe(true);
 if(follow.ok)expect(activeWritersForBranch(follow.value.authority)).toBe(expected.activeWriters.continue);
 const stopped=recoverBranch([candidateOf({head:finalHead,epoch:2,writer:BETO,grant:grant.grant,complete:true,source:'beto'}),candidateOf({head:s.host.head(),epoch:2,writer:CAIO,grant:CAIO_GRANT,complete:true,source:'caio'})],{kind:'stop',reason:'Duas concessões para a época 2'});
 expect(stopped.ok).toBe(true);
 if(stopped.ok)expect(activeWritersForBranch(stopped.value.authority)).toBe(expected.activeWriters.stop);
 const forked=recoverBranch([candidateOf({head:finalHead,epoch:2,writer:BETO,complete:true,source:'beto'})],{kind:'fork',candidateIndex:0,reason:'Sem concessão de recuperação'});
 expect(forked.ok).toBe(true);
 if(forked.ok)expect(activeWritersForBranch(forked.value.authority)).toBe(expected.activeWriters.fork);
 // The successor's copy and the version it publishes are the same world: the transfer never rewrote the state.
 expect(await semanticHash(await stateOf(s.betoWorlds,finalHead))).toBe(await semanticHash(finalState));
});

// One writer per branch is the invariant the whole transfer exists to keep: `EpochReceipt` is what the peer reports.
test('the replica reports the epoch it follows',async()=>{
 const s=await ownedBranch();
 const head=s.built;
 const offered=await prepareHandover(s.host,BETO);
 if(!offered.ok)throw new Error(offered.error.message);
 const grant=await epochGrantOf(offered.value);
 const missing=await s.caio.follow({host:'beto-host',sessionId:SESSION,epoch:2,head:{...grant.head,commit:{hash:'11'.repeat(32),bytes:1}},grant:grant.grant,issuer:ANA_ACTOR.identity});
 expect(missing.status).toBe('pending');
 expect(missing.missing?.length).toBe(1);
 expect(s.caio.head().commit).toEqual(head.commit);
 const receipt:EpochReceipt=await s.caio.follow({host:'beto-host',sessionId:SESSION,epoch:2,head:grant.head,grant:grant.grant,issuer:ANA_ACTOR.identity});
 expect(receipt.kind).toBe('epoch-receipt');
 expect(s.caio.epochReceipts().at(-1)?.status).toBe('following');
 expect(s.caio.stopped()).toBeNull();
});
