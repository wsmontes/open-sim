// The cooperative session as the player meets it (plan Task 9): the game shows the branch, the participants and the
// save states the spec names, and a live session is created, invited, left or continued in a personal version without
// the personal save being touched. The session is the one of Task 7 and the transport is the in-process one, so what
// is exercised here is the experience layer over real sessions: who orders a transaction, who is allowed to tick, what
// a refusal does to the player's selection, and what presence is allowed to change (nothing durable).
// @vitest-environment jsdom
import {RULES_VERSION} from '../src/core/model';
import {expect,test,vi} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {ed25519Verifier,generateSessionKeyPair,localIdentityProvider,signEd25519} from '../src/adapters/crypto/session-keys';
import type {KeyPair} from '../src/adapters/crypto/session-keys';
import {createMemoryNetwork} from '../src/adapters/network/memory';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {createHostSession,deferred,readBody} from '../src/session/host-session';
import {createReplicaSession} from '../src/session/replica-session';
import {createSession} from '../src/session/local-session';
import type {MapSource,SaveStore} from '../src/session/ports';
import {importLegacy} from '../src/session/world-bundle';
import {createWorldRepository} from '../src/session/world-repository';
import type {WorldRepository} from '../src/session/world-repository';
import type {WorldStorage} from '../src/session/world-ports';
import {createTickClock} from '../src/presentation/clock';
import {createGameSessionView,createMultiplayerPanel,hostSessionLink,proposalOf,replicaSessionLink} from '../src/presentation/multiplayer';
import type {LinkContext} from '../src/presentation/multiplayer';
import {createGame} from '../src/core/commands';
import {quoteAction} from '../src/core/quote';
import {createKernel} from '../src/world/kernel';
import {actorId,grantBytes} from '../src/world/permissions';
import type {Grant,IdentityProof,IdentityScope,Principal,Proposal} from '../src/world/permissions';
import {NETWORK_LIMITS} from '../src/world/wire';
import type {Limits,WireMessage} from '../src/world/wire';
import type {Action,BaseChunk,CellCoord,CommandResult,GameState,SavedGame,ViewState} from '../src/core/model';
import type {Head,JsonValue,WorldResult} from '../src/world/model';
import {blank} from './fixtures/world';

const codec=createJcsCodec(),hasher=bytesHasher(),verifier=ed25519Verifier();
const NOW='2026-09-29T12:00:00Z';
const SESSION='sessao-ui';
const MAIN={worldId:'victoria',branchId:'main'};
const ANA={scheme:'nostr',id:'npub1ana'};
const BETO={scheme:'nostr',id:'npub1beto'};
const terms=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const savedView:ViewState={x:12.5,y:-4,zoom:1.5,speed:1,place:'Victoria'};
// Cells inside '9:9', whose origin is (288,288): the free block the player builds on.
const at=(x:number,y:number):CellCoord=>({x:288+x,y:288+y});
// A row of free cells of the managed region, so a cost is exactly `count` times the price of the tool.
const row=(count:number):CellCoord[]=>Array.from({length:count},(_unused,index)=>at(index%32,Math.floor(index/32)));
const build=(tool:'park'|'road'|'power',cells:CellCoord[]):Action=>({type:'build',tool,cells});

// --- the people and the documents they sign --------------------------------------------------------------------
type Actor={principal:Principal;identity:IdentityProof;keys:KeyPair;root:KeyPair};
async function actorOf(principal:Principal,keys:KeyPair,root:KeyPair):Promise<Actor>{
 const scope:IdentityScope={...MAIN,sessionId:SESSION,notBefore:'2026-09-29T11:00:00Z',notAfter:'2026-09-29T13:00:00Z'};
 const bound=await localIdentityProvider({root,session:keys,codec}).bindSession({principal,scope});
 if(!bound.ok)throw new Error(bound.error.message);
 return {principal,identity:bound.value,keys,root};
}
async function grantOf(grantee:Actor,over:Partial<Grant>={}):Promise<Grant>{
 const base:Grant={kind:'grant',id:`concessao-${grantee.principal.id}`,principal:grantee.principal,...MAIN,actions:['build','demolish','component','tick'],namespaces:[],spendLimit:30000,proof:{kind:'message',algorithm:'Ed25519',sessionKey:grantee.root.publicKey,signature:''}};
 const merged:Grant={...base,...over};
 return {...merged,proof:{kind:'message',algorithm:'Ed25519',sessionKey:grantee.root.publicKey,signature:await signEd25519(grantee.root,grantBytes(merged,codec))}};
}
const ANA_KEYS=await generateSessionKeyPair(),ANA_ROOT=await generateSessionKeyPair();
const BETO_KEYS=await generateSessionKeyPair(),BETO_ROOT=await generateSessionKeyPair();
const ANA_ACTOR=await actorOf(ANA,ANA_KEYS,ANA_ROOT);
const BETO_ACTOR=await actorOf(BETO,BETO_KEYS,BETO_ROOT);
const ANA_GRANT=await grantOf(ANA_ACTOR);
const BETO_GRANT=await grantOf(BETO_ACTOR);
// The signing port of a session key: the experience layer builds proposals and never touches a crypto adapter.
const signerOf=(actor:Actor)=>({key:actor.keys.publicKey,sign:(bytes:Uint8Array)=>signEd25519(actor.keys,bytes)});

// --- the device, the branch and the wire ----------------------------------------------------------------------
type Fault={skip?:number;fail?:number;gate?:Promise<void>};
// A device that can hold its next write pending: the queue of a session is then genuinely busy while a test looks.
function faulty(storage:WorldStorage,fault:Fault):WorldStorage{
 let skip=fault.skip??0;
 let fail=fault.fail??0;
 return {
  head:address=>storage.head(address),
  heads:worldId=>storage.heads(worldId),
  object:ref=>storage.object(ref),
  receipt:(address,id)=>storage.receipt(address,id),
  receipts:address=>storage.receipts(address),
  async commit(transaction):Promise<WorldResult<Head>>{
   if(skip>0){skip-=1;return storage.commit(transaction);}
   if(fault.gate)await fault.gate;
   if(fail>0){fail-=1;return {ok:false,error:{code:'QUOTA',message:'Dispositivo sem espaço'}};}
   return storage.commit(transaction);
  },
 };
}
async function open(worlds:WorldRepository,state:GameState):Promise<Head>{
 const save:SavedGame={version:1,state,view:savedView};
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error(imported.error.message);
 const created=await worlds.create(imported.value);
 if(!created.ok)throw new Error(created.error.message);
 return created.value;
}
function maps(captures:Record<string,BaseChunk>):{source:MapSource;calls:string[]}{
 const calls:string[]=[];
 return {calls,source:{attribution:{text:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright'},async loadChunk(id){calls.push(id);const base=captures[id];if(!base)throw new Error(`Região indisponível: ${id}`);return base;}}};
}
// A personal game the experience layer does not write while a live session owns the branch.
function personalGame():{dispatch(action:Action):CommandResult;getState():GameState}{
 const state=createGame(MAIN.worldId,7,blank('9:9'));
 return {dispatch:()=>({state,status:'rejected',reason:'Sem sessão aberta'}),getState:()=>state};
}
let counter=0;
const envelopeOf=(over:{class?:'control'|'durable';id?:string}={})=>({worldProtocol:2 as const,wireVersion:1 as const,kind:'message' as const,class:over.class??'control' as const,worldId:MAIN.worldId,branchId:MAIN.branchId,sessionId:SESSION,epoch:1,id:over.id??`t${++counter}`});
const messageOf=(body:JsonValue,over:{class?:'control'|'durable';id?:string}={}):WireMessage=>({envelope:envelopeOf(over),body});

// --- the whole thing, wired the way the client wires it -------------------------------------------------------
async function scene(options:{fault?:Fault;limits?:Limits;costLimit?:number}={}){
 const start=createGame(MAIN.worldId,7,blank('9:9'));
 const hostWorlds=createWorldRepository({storage:faulty(createWorldMemoryStorage(),options.fault??{}),codec,hasher});
 const replicaWorlds=createWorldRepository({storage:createWorldMemoryStorage(),codec,hasher});
 const startHead=await open(hostWorlds,start),replicaHead=await open(replicaWorlds,start);
 const source=maps({'9:9':blank('9:9')});
 const net=createMemoryNetwork();
 const limits=options.limits??NETWORK_LIMITS;
 // The object plane of the session (§27, §39.5): the descriptor and the capabilities of a transfer are published here.
 const kernel=createKernel();
 // One endpoint per peer: the client's link and the session it speaks to are the same pipe.
 const hostTransport=net.connect('host'),replicaTransport=net.connect('beto');
 const host=createHostSession({repository:hostWorlds,transport:hostTransport,peer:'host',head:startHead,identity:ANA_ACTOR.identity,grants:[ANA_GRANT,BETO_GRANT],rules:{family:'city',version:RULES_VERSION},bases:source.source,verifier,codec,hasher,now:()=>NOW,sessionId:SESSION,epoch:1,limits,peers:['beto'],capabilities:kernel});
 const replica=createReplicaSession({repository:replicaWorlds,transport:replicaTransport,peer:'beto',host:'host',head:replicaHead,verifier,codec,hasher,now:()=>NOW,sessionId:SESSION,epoch:1,limits,grants:[ANA_GRANT,BETO_GRANT]});
 const common:Omit<LinkContext,'principal'|'sessionKey'|'signer'|'peers'|'transport'|'peer'|'identity'|'grants'>={worldId:MAIN.worldId,branchId:MAIN.branchId,sessionId:SESSION,epoch:1,codec,costLimit:options.costLimit??10000};
 const anaLink=hostSessionLink(host,{...common,principal:ANA,sessionKey:ANA_ACTOR.keys.publicKey,signer:signerOf(ANA_ACTOR),transport:hostTransport,peer:'host',identity:ANA_ACTOR.identity,grants:[ANA_GRANT],peers:[{id:'beto',role:'collaborator'}],id:()=>`ana-${++counter}`});
 const wire=net.connect('beto-wire');
 const betoLink=replicaSessionLink(replica,replicaWorlds,'host',{...common,principal:BETO,sessionKey:BETO_ACTOR.keys.publicKey,signer:signerOf(BETO_ACTOR),transport:replicaTransport,peer:'beto',identity:BETO_ACTOR.identity,grants:[BETO_GRANT],peers:[{id:'host',role:'host'}],id:()=>`beto-${++counter}`});
 const quote=(action:Action,state:GameState)=>quoteAction(state,action,Object.values(state.chunks).map(chunk=>chunk.base));
 const anaView=createGameSessionView({worldId:MAIN.worldId,branchId:MAIN.branchId,local:personalGame(),head:()=>host.head(),quote,registry:kernel,self:ANA.id,now:()=>NOW,monotonic:()=>0});
 const betoView=createGameSessionView({worldId:MAIN.worldId,branchId:MAIN.branchId,local:personalGame(),head:()=>replica.head(),quote,registry:kernel,self:BETO.id,now:()=>NOW,monotonic:()=>0});
 const inbox:WireMessage[]=[];
 wire.subscribe((_peer,message)=>inbox.push(message));
 await anaView.attach(anaLink);await betoView.attach(betoLink);
 // Delivery is a decision of the test: a round settles the sessions, hands over what they queued and repeats.
 async function settle(rounds=16){
  for(let round=0;round<rounds;round+=1){
   await host.idle();await replica.idle();
   if(!net.queued())return;
   net.deliver();
  }
 }
 // The identities this client presented are handled in arrival order, before anything it proposes.
 await settle();
 const state=async()=>{const point=await host.checkpoint();return point.state;};
 return {
  host,replica,hostWorlds,replicaWorlds,net,source,kernel,anaView,betoView,anaLink,betoLink,startHead,settle,state,inbox,
  // A partition: the frames are taken off the wire and never handed over.
  drop:()=>net.batch().length,
  // A peer's documents arrive on the wire, the way the host reads them.
  async receive(body:JsonValue){await wire.send('host',messageOf(body));await settle();},
 };
}

// --- 1. who is allowed to advance the clock -------------------------------------------------------------------
test('a replica never schedules a tick and refuses to order one',async()=>{
 const s=await scene();
 const head=s.host.head();
 vi.useFakeTimers();
 try{
  let ticks=0;
  const clock=createTickClock(()=>{ticks+=1;});
  clock.setRole('replica');clock.setSpeed(2);
  vi.advanceTimersByTime(2000);
  expect(ticks).toBe(0);
  clock.setRole('host');
  vi.advanceTimersByTime(1000);
  expect(ticks).toBeGreaterThan(0);
  clock.stop();
 }finally{vi.useRealTimers();}
 const refused=await s.betoView.tick();
 expect(refused.ok).toBe(false);
 if(!refused.ok)expect(refused.error.code).toBe('PERMISSION');
 expect(s.replica.head().commit.hash).toBe(head.commit.hash);
 const ordered=await s.anaView.tick();
 expect(ordered.ok).toBe(true);
 expect(s.host.head().commit.hash).not.toBe(head.commit.hash);
 await s.settle();
 expect(s.replica.head().commit.hash).toBe(s.host.head().commit.hash);
});

// --- 2. a suspended tab pauses the match -----------------------------------------------------------------------
test('a hidden host tab reports the match as paused',async()=>{
 const s=await scene();
 s.anaView.setHostVisible(false);
 await s.anaView.refresh();
 const paused=s.anaView.status();
 expect(paused.kind).toBe('paused');
 expect(paused.text).toBe('Partida pausada');
 s.anaView.setHostVisible(true);
 await s.anaView.refresh();
 expect(s.anaView.status().kind).not.toBe('paused');
});

// --- 3. a refusal restores the preview and keeps the selection -------------------------------------------------
test('a refused action keeps the selection and brings the fresh preview',async()=>{
 const s=await scene({costLimit:1});
 const cells=row(1);
 const before=await s.state();
 const receipt=await s.anaView.submitAction(build('power',cells));
 expect(receipt.status).toBe('refused');
 const refusal=s.anaView.refusal();
 expect(refusal?.cells).toEqual(cells);
 expect(refusal?.reason).toMatch(/limite 1|teto/);
 expect(refusal?.preview?.cost).toBe(500);
 expect(refusal?.preview?.money).toBe(before.money);
 const after=await s.state();
 expect(after.money).toBe(before.money);
 expect(after.revision).toBe(before.revision);
 s.anaView.clearRefusal();
 expect(s.anaView.refusal()).toBeNull();
});

// --- 4. an invite is not a personal save -----------------------------------------------------------------------
test('entering a session does not overwrite the personal save',async()=>{
 const writes:string[]=[];
 const stored=new Map<string,unknown>();
 const saves:SaveStore={async read(slot){return stored.get(slot)??null;},async write(slot,data){writes.push(slot);stored.set(slot,data);}};
 const personal=createSession({maps:maps({'9:9':blank('9:9')}).source,saves,worldId:MAIN.worldId,seed:7});
 await personal.initialize('9:9');
 await personal.save(savedView);
 const personalSave=await saves.read('open-sim');
 const personalRevision=personal.getState().revision;
 const s=await scene();
 const attached=createGameSessionView({worldId:MAIN.worldId,branchId:MAIN.branchId,local:personal,head:()=>s.host.head()});
 attached.setPersistence(personal.getSaveStatus());
 await attached.attach(s.anaLink);
 await attached.submitAction(build('power',row(1)));
 await s.settle();
 await attached.refresh();
 await attached.leave();
 expect(writes).toEqual(['open-sim']);
 expect(await saves.read('open-sim')).toEqual(personalSave);
 expect(personal.getState().revision).toBe(personalRevision);
 expect(attached.mode()).toBe('local');
});

// --- 5. a full queue refuses without touching the state --------------------------------------------------------
test('a full queue preserves the state and keeps the selection',async()=>{
 const fault:Fault={skip:1};
 const s=await scene({fault,limits:{...NETWORK_LIMITS,maxProposalQueue:1}});
 const gate=deferred<void>();
 fault.gate=gate.promise;
 const first=s.anaView.submitAction(build('power',row(2)));
 await vi.waitFor(()=>{expect(s.host.pending()).toBe(1);});
 const second=await s.anaView.submitAction(build('power',row(1)));
 expect(second.status).toBe('refused');
 expect(second.code).toBe('LIMIT');
 expect(s.anaView.refusal()?.cells).toEqual(row(1));
 const held=await s.state();
 expect(held.money).toBe(20000);
 expect(held.revision).toBe(0);
 gate.resolve();
 expect((await first).status).toBe('accepted');
 await s.settle();
 const after=await s.state();
 expect(after.money).toBe(20000-2*500);
 expect(after.revision).toBe(1);
});

// --- 5b. a device that cannot write, and a personal error that does not speak for a session ---------------------
test('a device that cannot write pauses the session instead of claiming a save',async()=>{
 const s=await scene({fault:{skip:1,fail:1}});
 const receipt=await s.anaView.submitAction(build('road',[at(1,1)]));
 expect(receipt.status).toBe('failed');
 expect(receipt.code).toBe('QUOTA');
 await s.anaView.refresh();
 expect(s.anaView.status().kind).toBe('storage-error');
 expect(s.anaView.status().text).toBe('Falha ao salvar');
 const healthy=await scene();
 healthy.anaView.setPersistence({status:'error',message:'o save pessoal falhou',blocked:false});
 await healthy.anaView.refresh();
 const live=healthy.anaView.status();
 expect(live.kind).toBe('saved-local');
 expect(live.text).toBe('Salvo neste dispositivo');
});

// --- 6. presence is declared, disposable and never durable -----------------------------------------------------
test('presence changes nothing durable and never carries the camera',async()=>{
 const sent:{peer:string;label:string;at:string}[]=[];
 const s=await scene();
 const declared=createGameSessionView({worldId:MAIN.worldId,branchId:MAIN.branchId,local:personalGame(),head:()=>s.host.head(),ephemeral:{send:statement=>sent.push(statement)},self:ANA.id,now:()=>NOW,monotonic:()=>0});
 await declared.attach(s.anaLink);
 const before=await s.state();
 const participants=declared.participants().map(entry=>`${entry.id}:${entry.role}`);
 for(let index=0;index<14;index+=1)declared.declarePresence('Ana');
 declared.receivePresence({peer:'host',label:'Eu sou o dono da ramificação',at:NOW});
 declared.receivePresence({peer:'desconhecido',label:'Quem?',at:NOW});
 expect(sent.length).toBe(10);
 for(const statement of sent)expect(Object.keys(statement).sort()).toEqual(['at','label','peer']);
 const after=await s.state();
 expect(after.revision).toBe(before.revision);
 expect(after.money).toBe(before.money);
 expect(declared.participants().map(entry=>`${entry.id}:${entry.role}`)).toEqual(participants);
 expect(declared.presence().map(entry=>entry.peer).sort()).toEqual(['desconhecido','host','npub1ana']);
 expect(declared.status().kind).toBe('saved-local');
});

// --- 7. two claims on the same money --------------------------------------------------------------------------
test('a disputed budget accepts one claim and refuses the other with a preview',async()=>{
 const s=await scene();
 const observed=await s.host.checkpoint();
 const proposal:Proposal=await proposalOf(build('power',row(40)),{principal:BETO,sessionKey:BETO_ACTOR.keys.publicKey,signer:signerOf(BETO_ACTOR),codec,worldId:MAIN.worldId,branchId:MAIN.branchId,sessionId:SESSION,epoch:1,id:'beto-1',head:observed.head,revision:observed.state.revision,costLimit:30000});
 await s.receive(BETO_ACTOR.identity as unknown as JsonValue);
 await s.receive(BETO_GRANT as unknown as JsonValue);
 await s.receive(proposal as unknown as JsonValue);
 const peerReceipt=s.inbox.flatMap(message=>{const parsed=readBody(message.body);return parsed.ok&&parsed.value.kind==='proposal-receipt'?[parsed.value.receipt]:[];}).at(-1);
 expect(peerReceipt?.status).toBe('accepted');
 const shared=await s.state();
 expect(shared.money).toBe(0);
 await s.anaView.refresh();
 const claim=[at(10,1)];
 const receipt=await s.anaView.submitAction(build('power',claim));
 expect(receipt.status).toBe('refused');
 expect(s.anaView.refusal()?.reason).toContain('Dinheiro insuficiente');
 expect(s.anaView.refusal()?.preview?.money).toBe(0);
 expect(s.anaView.refusal()?.preview?.cost).toBe(500);
 expect(s.anaView.refusal()?.cells).toEqual(claim);
 const after=await s.state();
 expect(after.money).toBe(0);
 expect(after.revision).toBe(shared.revision);
 expect(after.actors[await actorId(BETO,hasher,codec)]).toBe(1);
});

// --- 8. after a partition the replica catches up and the host reports the copy ---------------------------------
test('after a partition the replica catches up and the host reports the copy',async()=>{
 const s=await scene();
 await s.anaView.submitAction(build('road',[at(1,1)]));
 await s.settle();
 await s.anaView.refresh();
 expect(s.anaView.status().text).toBe('Copiado por 1 amigo');
 const missed=await s.anaView.submitAction(build('road',[at(2,1)]));
 expect(missed.status).toBe('accepted');
 // The transport accepted the frame, which is not a copy: only a replica's own receipt is (§7.4 step 6).
 expect(missed.replicas).toContain('beto');
 expect(s.drop()).toBeGreaterThan(0);
 await s.settle();
 await s.anaView.refresh();
 expect(s.anaView.status().kind).toBe('pending');
 expect(s.anaView.status().text).toBe('Mudanças pendentes');
 expect(s.replica.head().commit.hash).not.toBe(s.host.head().commit.hash);
 // The replica asks for the parent it never received and reproduces both versions on its own device.
 await s.anaView.submitAction(build('road',[at(3,1)]));
 await s.settle();
 expect(s.replica.head().commit.hash).toBe(s.host.head().commit.hash);
 // Caught up, the next commit reaches it directly and its own receipt is what earns the copy on the host's side.
 await s.anaView.submitAction(build('road',[at(4,1)]));
 await s.settle();
 await s.anaView.refresh();
 await s.betoView.refresh();
 expect(s.anaView.status().text).toBe('Copiado por 1 amigo');
 expect(s.betoView.status().kind).toBe('replicated');
});

// --- 9. the panel the player reads -----------------------------------------------------------------------------
test('the panel shows the branch, the participants and the save states',async()=>{
 const s=await scene();
 await s.anaView.submitAction(build('road',[at(1,1)]));
 await s.settle();
 await s.anaView.refresh();
 const root=document.createElement('div');
 root.id='hud';
 document.body.append(root);
 const asked:string[]=[];
 const panel=createMultiplayerPanel(root,{onCreate:()=>asked.push('criar'),onJoin:text=>asked.push(`entrar:${text}`),onInvite:()=>asked.push('convidar'),onLeave:()=>asked.push('sair'),onContinueLocal:()=>asked.push('pessoal'),onPause:()=>asked.push('pausar'),onTransfer:text=>asked.push(`transferir:${text}`)});
 panel.update(s.anaView.describe());
 const node=root.querySelector<HTMLElement>('#panel-multiplayer');
 expect(node?.classList.contains('panel')).toBe(true);
 expect(node?.dataset.panel).toBe('multiplayer');
 expect(node?.querySelector('[data-drag-handle]')).not.toBeNull();
 expect(node?.querySelector('[data-panel-body]')).not.toBeNull();
 expect(node?.querySelector('[data-close]')).not.toBeNull();
 expect(node?.textContent).toContain('victoria/main');
 expect(node?.textContent).toContain('ana');
 expect(node?.textContent).toContain('beto');
 expect(node?.textContent).toContain('Copiado por 1 amigo');
 const descriptor=s.anaView.descriptor();
 expect(descriptor?.uri).toBe(`osim:session:${SESSION}`);
 const resolved=await s.anaView.resolveSession(`osim:session:${SESSION}`);
 expect(resolved.ok).toBe(true);
 if(resolved.ok)expect(resolved.value?.sessionId).toBe(SESSION);
 const labels=[...node!.querySelectorAll('button')].map(button=>button.textContent??'');
 expect(labels.some(text=>text.includes('Criar sessão'))).toBe(true);
 expect(labels.some(text=>text.includes('Convidar'))).toBe(true);
 expect(labels.some(text=>text.includes('Sair'))).toBe(true);
 expect(labels.some(text=>text.includes('Continuar em versão pessoal'))).toBe(true);
 expect(labels.some(text=>text.includes('Pausar partida'))).toBe(true);
 expect(labels.some(text=>text.includes('Transferir sessão'))).toBe(true);
 const paste=node!.querySelector<HTMLTextAreaElement>('#multiplayer-invite');
 expect(paste).not.toBeNull();
 if(paste)paste.value='oferta-de-teste';
 node!.querySelector<HTMLButtonElement>('#multiplayer-join')?.click();
 expect(asked).toContain('entrar:oferta-de-teste');
 node!.querySelector<HTMLButtonElement>('#multiplayer-leave')?.click();
 expect(asked).toContain('sair');
 panel.destroy();
 expect(root.querySelector('#panel-multiplayer')).toBeNull();
});

// --- 10. pausing the epoch and handing the branch over ---------------------------------------------------------
test('pausing stops the epoch, and the transfer publishes the capability of the next one',async()=>{
 const s=await scene();
 await s.anaView.submitAction(build('road',[at(1,1)]));
 await s.settle();
 await s.anaView.refresh();
 const root=document.createElement('div');
 document.body.append(root);
 const asked:string[]=[];
 const panel=createMultiplayerPanel(root,{onCreate:()=>{},onJoin:()=>{},onInvite:()=>{},onLeave:()=>{},onContinueLocal:()=>{},onPause:()=>asked.push('pausar'),onTransfer:text=>asked.push(`transferir:${text}`)});
 panel.update(s.anaView.describe());
 // The control stops the epoch this device orders — exactly what the app's onPause does.
 root.querySelector<HTMLButtonElement>('#multiplayer-pause')?.click();
 expect(asked).toContain('pausar');
 s.anaView.pause();
 await s.anaView.refresh();
 const paused=s.anaView.status();
 expect(paused.kind).toBe('paused');
 expect(paused.text).toBe('Partida pausada');
 expect(paused.detail).toContain('pausada');
 const refused=await s.anaView.submitAction(build('road',[at(2,1)]));
 expect(refused.status).toBe('refused');
 await s.betoView.refresh();
 expect(s.betoView.head()?.commit.hash).toBe(s.host.head().commit.hash);
 expect(s.betoView.status().kind).not.toBe('pending');
 // Once stopped, the panel stops offering to stop it again — and keeps the transfer, which is how a paused branch is
 // handed over or a transfer with an incomplete package is retried.
 panel.update(s.anaView.describe());
 expect(root.querySelector<HTMLButtonElement>('#multiplayer-pause')?.hidden).toBe(true);
 expect(root.querySelector<HTMLButtonElement>('#multiplayer-transfer')?.hidden).toBe(false);
 // The successor is named in the same field the invite uses, and the transfer publishes the capability of the new
 // epoch as an object another client resolves (§27).
 const field=root.querySelector<HTMLTextAreaElement>('#multiplayer-invite');
 if(!field)throw new Error('Campo do convite ausente');
 field.value=`${BETO.scheme}:${BETO.id}`;
 root.querySelector<HTMLButtonElement>('#multiplayer-transfer')?.click();
 expect(asked).toContain(`transferir:${BETO.scheme}:${BETO.id}`);
 const offered=await s.anaView.handover(BETO);
 expect(offered.ok).toBe(true);
 if(!offered.ok)throw new Error(offered.error.message);
 expect(offered.value.epoch).toBe(2);
 expect(offered.value.previousEpoch).toBe(1);
 expect(offered.value.published).toBe(true);
 expect(offered.value.capability.type).toBe('capability');
 expect(offered.value.capability.actor).toBe(`${ANA.scheme}:${ANA.id}`);
 const stored=await s.kernel.resolve(offered.value.capability.id);
 expect(stored.ok&&stored.value!==null).toBe(true);
 expect(s.anaView.invite()).toBe(offered.value.capability.id);
 expect(s.anaView.message()).toContain('época 2');
 panel.update(s.anaView.describe());
 expect(root.querySelector('#multiplayer-message')?.textContent).toContain('época 2');
 panel.destroy();
});
