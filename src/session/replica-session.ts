import type {BaseChunk,GameState} from '../core/model';
import {applyCommand} from '../core/commands';
import type {Head,JsonValue,ObjectRef,WorldObject,WorldResult} from '../world/model';
import {WORLD_PROTOCOL,WIRE_VERSION,failed,ok,sameRef} from '../world/model';
import type {ContentHasher,WorldCodec} from '../world/ports';
import {NETWORK_LIMITS,replayOf} from '../world/wire';
import type {Limits,TrafficClass,WireEnvelope,WireMessage} from '../world/wire';
import {actorId,authorize,grantBytes,identityBytes} from '../world/permissions';
import type {Grant,ProposalMark,SignatureVerifier} from '../world/permissions';
import {baseOf,baseValueOf,deferred,readBody,readRecord} from './host-session';
import type {AcceptedCommit,ReplicaReceipt,SessionBody} from './host-session';
import type {SessionTransport} from './multiplayer-ports';
import type {BaseRef,WorldRepository} from './world-repository';

// The replica side of a live session (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.1, §7.4, §7.5).
// A replica is a verifier, not a second writer and not a second clock: it never schedules a tick, it never invents a
// frozen region, and it never advances its head over an operation it could not recompute. For every commit it
// re-authorizes the proposal (binding, grant, epoch, ceiling and the version its author observed), applies the
// derived command with its own core and publishes the result through its own repository — because a version is
// addressed by content, agreeing on it is proved by producing the same head, and disagreement becomes visible
// instead of being smoothed over.
//
// Three situations stop the replica instead of being guessed at: a parent it cannot place (buffered and asked for,
// under a bound), a frozen region it does not hold (asked for by address, verified by hash, before anything is
// adopted) and two different versions of the same generation (reported as a divergence, with the evidence kept).
// The environment is injected exactly as on the host side: no adapter, no clock, no timer.

const LIMIT={ledger:512,receipts:128,seen:1024,objects:16,pending:64};
export type ReplicaOptions={
 repository:WorldRepository;
 transport:SessionTransport;
 peer:string;
 host:string;
 head:Head;
 verifier:SignatureVerifier;
 codec:WorldCodec;
 hasher:ContentHasher;
 now:()=>string;
 sessionId:string;
 epoch:number;
 limits?:Limits;
 // The grants this replica was told about before the session started, when the invite carried them: a commit that
 // arrives with a grant nobody announced is refused instead of being trusted because it was signed.
 grants?:readonly Grant[];
};
export type ReplicaPending={commits:number;objects:number};
export type ReplicaSession={
 receive(commit:AcceptedCommit):Promise<ReplicaReceipt>;
 head():Head;
 pending():ReplicaPending;
 receipts():readonly ReplicaReceipt[];
 divergences():readonly ReplicaReceipt[];
 idle():Promise<void>;
};
// What waits for a parent, or for the frozen regions a commit rests on.
type Waiting={commit:AcceptedCommit;missing:ObjectRef[];attempts:number};

export function createReplicaSession(options:ReplicaOptions):ReplicaSession{
 const limits=options.limits??NETWORK_LIMITS;
 const ledger=new Map<string,{digest:string;epoch:number;head:Head}>();
 const versions=new Map<string,Head>();
 const receiptsLog:ReplicaReceipt[]=[];
 const waitingObjects=new Map<string,Waiting>();
 const waitingParents=new Map<string,AcceptedCommit[]>();
 const received=new Map<string,WorldObject>();
 const answers=new Map<string,ReplicaReceipt>();
 const seen:WireEnvelope[]=[];
 let head=options.head,state:GameState|null=null,stopped=false,counter=0,working=false,inFlight=0;
 const jobs:Array<{commit:AcceptedCommit;answer:(receipt:ReplicaReceipt)=>void}>=[];

 // The replica opens the version it was given, and reads the operations it already adopted out of the branch it
 // reopens: a repeated delivery is recognised from the commit itself, the same way the host recognises it.
 async function load():Promise<WorldResult<GameState>>{
  const point=await options.repository.checkout(options.head);
  if(!point.ok)return point;
  const history=await options.repository.history(options.head,LIMIT.ledger);
  if(history.ok)for(const version of history.value){
   versions.set(version.head.commit.hash,version.head);
   for(const entry of version.accepted){
    const record=readRecord(entry);
    if(record)ledger.set(record.id,{digest:record.digest,epoch:record.epoch,head:version.head});
   }
  }
  versions.set(options.head.commit.hash,options.head);
  state=point.value.state;
  return ok(point.value.state);
 }
 const boot=load();
 function remember(envelope:WireEnvelope):void{
  seen.push(envelope);
  while(seen.length>LIMIT.seen)seen.shift();
 }
 function record(receipt:ReplicaReceipt):ReplicaReceipt{
  receiptsLog.push(receipt);
  while(receiptsLog.length>LIMIT.receipts)receiptsLog.shift();
  return receipt;
 }
 async function send(body:SessionBody,id?:string):Promise<void>{
  const envelope:WireEnvelope={worldProtocol:WORLD_PROTOCOL,wireVersion:WIRE_VERSION,kind:'message',class:trafficOf(body),worldId:head.worldId,branchId:head.branchId,sessionId:options.sessionId,epoch:options.epoch,id:id??`${options.peer}.${options.epoch}.${(counter+=1)}`};
  try{
   await options.transport.send(options.host,{envelope,body:body as unknown as JsonValue});
  }catch{
   // A transport that fails loses the request, not the session: what was already persisted stays, and a commit whose
   // objects never arrive simply stays pending until another copy reaches this replica.
  }
 }
 function trafficOf(body:SessionBody):TrafficClass{
  if(body.kind==='commit')return 'durable';
  if(body.kind==='base-response'||body.kind==='commit-response')return 'object';
  return 'control';
 }
 async function addressOf(value:JsonValue):Promise<ObjectRef>{return options.hasher.ref(options.codec.encode(value));}
 async function versionAt(ref:ObjectRef):Promise<Head|null>{
  const known=versions.get(ref.hash);
  if(known)return known;
  const history=await options.repository.history(head,LIMIT.ledger);
  if(!history.ok)return null;
  for(const version of history.value){versions.set(version.head.commit.hash,version.head);if(version.head.commit.hash===ref.hash)return version.head;}
  return null;
 }
 async function stateAt(target:Head,live:GameState):Promise<WorldResult<GameState>>{
  if(target.commit.hash===head.commit.hash)return ok(live);
  const point=await options.repository.checkout(target);
  if(!point.ok)return point;
  return ok(point.value.state);
 }
 // The base this replica would use for a region: its own frozen one, or the object it verified earlier. A region it
 // manages under another address is never replaced by the one the host used: those are two different maps.
 async function baseFor(reference:BaseRef,live:GameState):Promise<WorldResult<BaseChunk>>{
  const chunk=live.chunks[reference.id];
  if(chunk){
   const own=await addressOf(baseValueOf(chunk.base));
   if(sameRef(own,reference.ref))return ok(chunk.base);
  }
  const stored=received.get(reference.ref.hash);
  const base=stored?baseOf(stored.value):null;
  if(!stored||!base)return failed('NOT_FOUND',`A base congelada de ${reference.id} não está disponível nesta réplica`);
  if(!sameRef(await addressOf(stored.value),reference.ref))return failed('HASH_MISMATCH',`A base de ${reference.id} não corresponde ao endereço declarado`);
  return ok(base);
 }
 // Anything the commit declares that this replica has not verified yet: the frozen regions of its own unmanaged
 // ground, and the objects the change published that are not among them.
 async function unavailable(commit:AcceptedCommit,live:GameState):Promise<{bases:BaseRef[];objects:ObjectRef[]}>{
  const bases:BaseRef[]=[];
  for(const reference of commit.bases){
   const base=await baseFor(reference,live);
   if(!base.ok&&!received.has(reference.ref.hash))bases.push(reference);
  }
  const foreign:ObjectRef[]=[];
  for(const ref of commit.objects){
   if(received.has(ref.hash))continue;
   if(!commit.bases.some(reference=>reference.ref.hash===ref.hash))foreign.push(ref);
  }
  return {bases,objects:foreign};
 }
 async function materialized(commit:AcceptedCommit,live:GameState):Promise<WorldResult<BaseChunk[]>>{
  const bases:BaseChunk[]=[];
  for(const reference of commit.bases){
   const base=await baseFor(reference,live);
   if(!base.ok)return base;
   bases.push(base.value);
  }
  return ok(bases);
 }
 // The objects the change published, with the values the replica verified by hash: they are what its own tree will
 // attach, and therefore part of the version it is about to produce.
 async function carried(commit:AcceptedCommit):Promise<WorldResult<WorldObject[]>>{
  const published:WorldObject[]=[];
  for(const ref of commit.objects){
   const stored=received.get(ref.hash);
   if(!stored||!sameRef(await addressOf(stored.value),ref))return failed('NOT_FOUND',`O objeto ${ref.hash.slice(0,12)}… declarado pelo commit não está disponível verificável`);
   published.push(stored);
  }
  return ok(published);
 }
 // The same authorization the host performed, repeated by the replica: the binding, the grant, the epoch, the head
 // and the revision the author observed. A replica that trusted the host's word here would be a copy, not a verifier.
 async function authorization(commit:AcceptedCommit,live:GameState):Promise<WorldResult<null>>{
  const proofs=commit.authorization;
  if(!await options.verifier.verify(proofs.identity,identityBytes(proofs.identity,options.codec)))return failed('SIGNATURE','Vínculo de identidade do autor não verificado');
  const scope=proofs.identity.scope;
  if(scope.worldId!==head.worldId||scope.branchId!==head.branchId||scope.sessionId!==options.sessionId)return failed('SIGNATURE','Identidade vinculada a outra sessão');
  if(commit.command.actorId!==await actorId(proofs.identity.principal,options.hasher,options.codec))return failed('SIGNATURE','O comando não é do principal que autorizou a mudança');
  const proposal=proofs.proposal;
  if(!proposal){
   if(proofs.grant&&!proofs.grant.actions.includes('tick'))return failed('PERMISSION','A concessão do anfitrião não inclui ticks');
   return ok(null);
  }
  const grant=proofs.grant;
  if(!grant)return failed('MALFORMED','Commit sem a concessão que autorizou a proposta');
  if(options.grants&&!options.grants.some(known=>known.id===grant.id))return failed('PERMISSION',`A concessão ${grant.id} não foi anunciada a esta réplica`);
  if(!await options.verifier.verify(grant.proof,grantBytes(grant,options.codec)))return failed('SIGNATURE','Assinatura da concessão não verificada');
  const observed=await versionAt(proposal.observedHead);
  if(!observed)return failed('CONFLICT','A proposta observou uma versão fora do histórico desta réplica; peça reconciliação');
  const observedState=await stateAt(observed,live);
  if(!observedState.ok)return observedState;
  const marks:ProposalMark[]=[];
  for(const [id,entry] of ledger)marks.push({id,epoch:entry.epoch,worldId:head.worldId,branchId:head.branchId,digest:entry.digest});
  const authorized=await authorize(grant,proposal,{head:observed,revision:observedState.value.revision,epoch:options.epoch,now:options.now(),identity:proofs.identity,codec:options.codec,hasher:options.hasher,verifier:options.verifier,marks,revokedGrants:[],chain:[]});
  return authorized.ok?ok(null):authorized;
 }
 async function persist(expected:Head,change:{id:string;state:GameState;operations:readonly string[];objects:readonly WorldObject[];author:string}):Promise<WorldResult<Head>>{
  try{
   return await options.repository.commit(expected,{id:change.id,state:change.state,operations:change.operations,objects:change.objects,author:change.author});
  }catch(error){
   return failed('QUOTA',error instanceof Error&&error.message?error.message:'Falha de armazenamento');
  }
 }
 // The verification is the recomputation: the command is applied to the version this replica confirmed, and the head
 // it produces has to be the head the host claimed. Objects, receipt and head land in one device transaction, so a
 // replica is never a partial copy.
 async function adopt(commit:AcceptedCommit):Promise<ReplicaReceipt>{
  const receipt=(over:Partial<ReplicaReceipt>&{status:ReplicaReceipt['status']}):ReplicaReceipt=>record({kind:'replica-receipt',peer:options.peer,id:commit.id,digest:commit.digest,head,hostHead:commit.head,...over});
  if(commit.worldId!==head.worldId||commit.branchId!==head.branchId||commit.sessionId!==options.sessionId||commit.epoch!==options.epoch)return receipt({status:'refused',code:'CONFLICT',reason:'Commit de outra sessão, ramificação ou época'});
  const known=ledger.get(commit.id);
  if(known&&known.digest===commit.digest)return receipt({status:'duplicate',head:known.head});
  if(known)return receipt({status:'refused',code:'CONFLICT',reason:`A operação ${commit.id} já foi adotada com outro conteúdo`});
  if(stopped)return receipt({status:'refused',code:'CONFLICT',reason:'A integração automática está parada: há uma divergência para resolver'});
  const live=state;
  if(!live)return receipt({status:'refused',code:'MALFORMED',reason:'A sessão não abriu esta ramificação'});
  // Regions this replica already manages under another address: adopting the host's version of the same ground would
  // silently rewrite a map nobody agreed to change, so it is reported and integration stops.
  const conflicts:BaseRef[]=[];
  for(const reference of commit.bases){
   const chunk=live.chunks[reference.id];
   if(!chunk)continue;
   if(!sameRef(await addressOf(baseValueOf(chunk.base)),reference.ref))conflicts.push(reference);
  }
  if(conflicts.length){
   stopped=true;
   return receipt({status:'divergent',code:'CONFLICT',reason:`A base congelada de ${conflicts.map(reference=>reference.id).join(', ')} difere da declarada pelo anfitrião`,evidence:{bases:conflicts}});
  }
  if(commit.parent.commit.hash!==head.commit.hash){
   const mine=await versionAt(commit.parent.commit);
   if(mine)return receipt({status:'refused',code:'CONFLICT',reason:'A sessão já confirmou esta versão; nenhum retrocesso silencioso'});
   if(commit.parent.generation>head.generation){
    if(waitingParents.size>=limits.maxProposalQueue)return receipt({status:'refused',code:'LIMIT',reason:`Limite de ${limits.maxProposalQueue} commit(s) à espera do pai`});
    waitingParents.set(commit.parent.commit.hash,[...(waitingParents.get(commit.parent.commit.hash)??[]),commit]);
    await send({kind:'commit-request',head:commit.parent,objects:[commit.parent.commit]});
    return receipt({status:'pending',missing:[commit.parent.commit],reason:`Esperando o pai da geração ${commit.parent.generation}`});
   }
   return receipt({status:'divergent',code:'CONFLICT',reason:`A ramificação tem outra versão na geração ${commit.parent.generation}`});
  }
  // The regions the commit rests on have to be in hand before anything is computed, and asking by address is the only
  // way to get them: a replica that used its own capture for the same region would produce a different city.
  const needed=await unavailable(commit,live);
  if(needed.bases.length||needed.objects.length){
   if(waitingObjects.size>=LIMIT.pending)return receipt({status:'refused',code:'LIMIT',reason:`Limite de ${LIMIT.pending} pedido(s) de objeto em aberto`});
   waitingObjects.set(commit.id,{commit,missing:[...needed.bases.map(reference=>reference.ref),...needed.objects],attempts:0});
   await send({kind:'base-request',bases:needed.bases,objects:needed.objects});
   return receipt({status:'pending',missing:[...needed.bases.map(reference=>reference.ref),...needed.objects],reason:'A base congelada precisa ser pedida e verificada antes de adotar'});
  }
  const authorized=await authorization(commit,live);
  if(!authorized.ok)return receipt({status:'refused',code:authorized.error.code,reason:authorized.error.message});
  const bases=await materialized(commit,live);
  if(!bases.ok)return receipt({status:'refused',code:bases.error.code,reason:bases.error.message});
  const objects=await carried(commit);
  if(!objects.ok)return receipt({status:'refused',code:objects.error.code,reason:objects.error.message});
  const applied=applyCommand(live,commit.command,bases.value);
  if(applied.status!=='applied')return receipt({status:'divergent',code:'CONFLICT',reason:`O núcleo recusou a operação: ${applied.reason??applied.status}`});
  const persisted=await persist(commit.parent,{id:commit.id,state:applied.state,operations:commit.operations,objects:objects.value,author:commit.author});
  if(!persisted.ok)return receipt({status:'refused',code:persisted.error.code,reason:persisted.error.message});
  if(persisted.value.commit.hash!==commit.head.commit.hash){
   // Both peers computed a version and they are not the same one. This replica keeps its own computation as evidence
   // and stops adopting: an unsignalled divergence is worse than a paused session (§7.5).
   stopped=true;
   return receipt({status:'divergent',head:persisted.value,code:'CONFLICT',reason:`O resultado desta réplica difere do head declarado (${persisted.value.commit.hash.slice(0,12)}… / ${commit.head.commit.hash.slice(0,12)}…)`});
  }
  head=persisted.value;
  state=applied.state;
  ledger.set(commit.id,{digest:commit.digest,epoch:commit.epoch,head});
  versions.set(head.commit.hash,head);
  waitingObjects.delete(commit.id);
  return receipt({status:'adopted'});
 }
 // A commit that was waiting for its parent becomes placeable as soon as the parent became this replica's version. The
 // promotion happens in the queue loop and never inside a job: a job that waited for another job of the same worker
 // would wait for itself.
 function promote():void{
  const ready=waitingParents.get(head.commit.hash)??[];
  waitingParents.delete(head.commit.hash);
  for(const commit of ready){inFlight+=1;jobs.push({commit,answer:()=>{}});}
 }
 // Objects are verified against the address that was asked for, never against the sender's word. An object that does
 // not match is dropped, the request is repeated once, and then the attempt is abandoned with a reason instead of
 // being adopted on trust.
 async function acceptObjects(incoming:readonly WorldObject[]):Promise<void>{
  for(const object of incoming){
   if(object.ref.bytes>limits.maxObjectBytes)continue;
   if(!sameRef(await addressOf(object.value),object.ref))continue;
   received.set(object.ref.hash,object);
   while(received.size>LIMIT.objects){const oldest=received.keys().next().value;if(oldest===undefined)break;received.delete(oldest);}
  }
  const live=state;
  if(!live)return;
  for(const entry of [...waitingObjects.values()]){
   const missing=entry.missing.filter(ref=>!received.has(ref.hash));
   if(!missing.length){
    waitingObjects.delete(entry.commit.id);
    enqueue(entry.commit);
    continue;
   }
   entry.attempts+=1;
   record({kind:'replica-receipt',peer:options.peer,id:entry.commit.id,digest:entry.commit.digest,status:'refused',head,hostHead:entry.commit.head,code:'HASH_MISMATCH',reason:missing.length===entry.missing.length?'A base pedida não chegou verificável':'Parte da base pedida não chegou verificável',missing});
   if(entry.attempts>1){
    waitingObjects.delete(entry.commit.id);
    continue;
   }
   const needed=await unavailable(entry.commit,live);
   await send({kind:'base-request',bases:needed.bases,objects:needed.objects});
  }
 }
 async function handle(peer:string,message:WireMessage):Promise<void>{
  const envelope=message.envelope;
  if(envelope.worldId!==head.worldId||envelope.branchId!==head.branchId)return;
  const replay=replayOf(seen,envelope);
  if(replay==='replay')return;
  // Like the host: a repeated frame is answered from its receipt, and a receipt that recorded no adoption leaves the
  // attempt open, so the frame is verified again instead of being answered with a decision that wrote nothing.
  const previous=replay==='duplicate'?answers.get(envelope.id):undefined;
  if(previous&&(previous.status==='adopted'||previous.status==='duplicate')){
   await send({kind:'replica-receipt',receipt:previous},envelope.id);
   return;
  }
  if(replay==='new')remember(envelope);
  if(envelope.sessionId!==options.sessionId||envelope.epoch!==options.epoch)return;
  const parsed=readBody(message.body);
  if(!parsed.ok)return;
  if(parsed.value.kind==='commit'){
   const receipt=await enqueue(parsed.value.commit);
   answers.set(envelope.id,receipt);
   while(answers.size>LIMIT.receipts){const oldest=answers.keys().next().value;if(oldest===undefined)break;answers.delete(oldest);}
   await send({kind:'replica-receipt',receipt});
   return;
  }
  if(parsed.value.kind==='base-response'){await acceptObjects(parsed.value.objects);return;}
  if(parsed.value.kind==='commit-response'){
   await acceptObjects(parsed.value.objects);
   for(const commit of parsed.value.commits)await enqueue(commit);
  }
 }
 const queued=()=>inFlight;
 let drainRun:Promise<void>=Promise.resolve();
 function start():void{
  if(working||!jobs.length)return;
  working=true;
  drainRun=(async()=>{
   try{
    const opened=await boot;
    while(jobs.length){
     const job=jobs.shift()!;
     try{
      if(!opened.ok)job.answer(record({kind:'replica-receipt',peer:options.peer,id:job.commit.id,digest:job.commit.digest,status:'refused',head,hostHead:job.commit.head,code:opened.error.code,reason:opened.error.message}));
      else{
       try{job.answer(await adopt(job.commit));}
       catch(error){job.answer(record({kind:'replica-receipt',peer:options.peer,id:job.commit.id,digest:job.commit.digest,status:'refused',head,hostHead:job.commit.head,code:'QUOTA',reason:error instanceof Error&&error.message?error.message:'Falha desconhecida'}));}
      }
     }finally{inFlight-=1;}
     promote();
    }
   }finally{working=false;}
  })();
 }
 function enqueue(commit:AcceptedCommit):Promise<ReplicaReceipt>{
  if(queued()>=limits.maxProposalQueue)return Promise.resolve(record({kind:'replica-receipt',peer:options.peer,id:commit.id,digest:commit.digest,status:'refused',head,hostHead:commit.head,code:'LIMIT',reason:`Fila de replicação cheia (${limits.maxProposalQueue})`}));
  const answer=deferred<ReplicaReceipt>();
  inFlight+=1;
  jobs.push({commit,answer:answer.resolve});
  start();
  return answer.promise;
 }
 // A replica handles what is addressed to it in arrival order, and `idle` is the point where a driver may look at the
 // session: control answers and durable commits are both processed through the same queue.
 let handling:Promise<void>=Promise.resolve();
 options.transport.subscribe((peer,message)=>{
  handling=handling.then(()=>handle(peer,message)).catch(()=>undefined);
 });
 async function idle():Promise<void>{
  for(let round=0;round<64;round+=1){
   const run=drainRun;
   await handling;
   await run;
   if(!working&&!jobs.length&&inFlight===0)return;
  }
 }
 return {
  receive:enqueue,
  head:()=>head,
  pending:()=>({commits:waitingParents.size+waitingObjects.size,objects:received.size}),
  receipts:()=>receiptsLog,
  divergences:()=>receiptsLog.filter(entry=>entry.status==='divergent'),
  idle,
 };
}
