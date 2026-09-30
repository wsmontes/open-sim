import type {Action,BaseChunk,CellCoord,Command,GameState} from '../core/model';
import {applyCommand} from '../core/commands';
import {quoteAction} from '../core/quote';
import type {Quote} from '../core/quote';
import {chunkId} from '../core/coordinates';
import type {Head,JsonValue,ObjectRef,WorldError,WorldErrorCode,WorldObject,WorldResult} from '../world/model';
import {WORLD_PROTOCOL,WIRE_VERSION,failed,isRef,ok,sameRef} from '../world/model';
import type {ContentHasher,WorldCodec} from '../world/ports';
import {NETWORK_LIMITS,replayOf} from '../world/wire';
import type {Limits,TrafficClass,WireEnvelope,WireMessage} from '../world/wire';
import {actorId,authorize,controlFrom,grantBytes,identityBytes,proposalBytes} from '../world/permissions';
import type {Grant,IdentityProof,Principal,Proposal,ProposalMark,SignatureVerifier} from '../world/permissions';
import {commandFor} from './multiplayer-ports';
import type {SessionTransport} from './multiplayer-ports';
import type {MapSource} from './ports';
import type {BaseRef,WorldRepository} from './world-repository';

// The host side of a live session (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.1, §7.4, §7.5).
// The repository, the transport, the identity, the verifier, the clock, the rules and the map sources are injected, so
// this module imports no adapter, reads no clock and starts no timer: the host is the only participant that orders
// transactions, and it is the only one that schedules ticks.
//
// The pipeline is the one the spec fixes, in this order: a proposal is validated against the version its author
// observed (signature, grant, epoch, ceiling and head), the intention is requoted against the version the host is
// about to apply on, the core derives the command with the accepted sequence of the actor, and only then are the
// objects, the idempotency receipt and the head advance published in ONE device transaction. A confirmation is
// therefore a statement about durable bytes: a device that fails confirms nothing, and a transport that fails only
// means the replicas have not been told yet.
//
// This module also owns the durable vocabulary of a session, because the host is what produces it: `AcceptedCommit`
// is what a replica receives and re-verifies, the two receipts are what a player and a host learn, and the accepted
// list of a commit doubles as the host's ledger, so a host that reopens a branch recovers which proposal produced
// which version from the commit itself instead of keeping a second store that could disagree with it.

// --- the durable vocabulary of a session (spec §7.3, §7.4) -----------------------------------------------------
export type OperationRecord={id:string;epoch:number;digest:string};
// A proposal is recorded as `p.<epoch>.<id>@<digest>` and a tick as `t.<epoch>.<generation>`; the digest is the
// proposal's own, so the same identifier with another body stays distinguishable instead of looking like a repeat.
export const recordOf=(record:OperationRecord):string=>`p.${record.epoch}.${record.id}@${record.digest}`;
export function readRecord(entry:string):OperationRecord|null{
 const parts=/^p\.(\d+)\.(.+)@([0-9a-f]{64})$/.exec(entry);
 if(!parts)return null;
 const epoch=Number(parts[1]),id=parts[2]!,digest=parts[3]!;
 if(!Number.isSafeInteger(epoch)||epoch<0||!id.length||id.length>80)return null;
 return {id,epoch,digest};
}
export const tickRecord=(epoch:number,generation:number):string=>`t.${epoch}.${generation}`;
// A frozen region travels as the object the repository addresses: `{kind:'base-chunk',base}`. Both sides build it the
// same way, because the address of a region is exactly what a replica compares against its own copy, and the value of
// a region is what a change publishes when it adopts one.
export const baseValueOf=(base:BaseChunk):JsonValue=>({kind:'base-chunk',base:base as unknown as JsonValue});
export function baseOf(value:JsonValue):BaseChunk|null{
 if(!record(value)||value['kind']!=='base-chunk')return null;
 const base=value['base'];
 if(!record(base)||typeof base['id']!=='string'||!Array.isArray(base['cells']))return null;
 return base as unknown as BaseChunk;
}

// The proofs a commit carries. A proposal arrives with the identity that bound the author's session key and the grant
// the branch issued, so the replica re-authorizes the operation itself instead of trusting the host's word; a tick
// carries only the host's own identity, because a tick needs no proposal to be scheduled.
export type CommitAuthorization={identity:IdentityProof;grant?:Grant;proposal?:Proposal};
// What the host sends after the receipt and the head are durable. It carries the inputs a replica needs to reach the
// same version on its own device — the derived command, the proofs, the accepted list and the references of the
// objects the change published — but never the resulting state: reproducing the version is exactly the verification.
export type AcceptedCommit={
 kind:'commit';
 worldId:string;
 branchId:string;
 sessionId:string;
 epoch:number;
 id:string;
 digest:string;
 parent:Head;
 head:Head;
 command:Command;
 authorization:CommitAuthorization;
 objects:readonly ObjectRef[];
 bases:readonly BaseRef[];
 operations:readonly string[];
 author:string;
};
// A refusal carries a fresh preview of the version the player would be writing against, so a client can show what
// changed instead of asking the player to guess (§7.4 step 3).
export type ReceiptPreview={revision:number;tick:number;money:number;cost:number;reason?:string};
export type ProposalReceipt={
 kind:'proposal-receipt';
 id:string;
 digest:string;
 status:'accepted'|'duplicate'|'refused'|'failed';
 // The version the change was applied against, and the version the host holds afterwards. A duplicate answers with
 // the version the repeated change already produced, which is why a lost answer never costs a second build.
 parent:Head;
 head:Head;
 rebased:boolean;
 actorId?:string;
 sequence?:number;
 cost?:number;
 bases?:readonly BaseRef[];
 code?:WorldErrorCode;
 reason?:string;
 preview?:ReceiptPreview;
 // The peers the transport accepted for delivery. This is not a replica's confirmation; that is the receipt below.
 replicas?:readonly string[];
};
export type ReplicaReceipt={
 kind:'replica-receipt';
 peer:string;
 id:string;
 digest:string;
 status:'adopted'|'duplicate'|'pending'|'divergent'|'refused';
 head:Head;
 hostHead:Head;
 code?:WorldErrorCode;
 reason?:string;
 missing?:readonly ObjectRef[];
 evidence?:{bases:readonly BaseRef[]};
};
// The bodies a session speaks besides the control documents the world layer already reads (`identity`, `grant` and
// `proposal` arrive as those documents). Text is never interpreted here: a body is a document with a declared kind.
export type SessionBody=
 | {kind:'commit';commit:AcceptedCommit}
 | {kind:'base-request';bases:readonly BaseRef[];objects:readonly ObjectRef[]}
 | {kind:'base-response';objects:readonly WorldObject[]}
 | {kind:'commit-request';head:Head;objects:readonly ObjectRef[]}
 | {kind:'commit-response';commits:readonly AcceptedCommit[];objects:readonly WorldObject[]}
 | {kind:'proposal-receipt';receipt:ProposalReceipt}
 | {kind:'replica-receipt';receipt:ReplicaReceipt};

// --- reading what arrives (spec §10) ---------------------------------------------------------------------------
// A durable message is attacker-controlled, so every field a decision reads is re-checked here, and the world layer
// reads the documents it owns. What is left to the core is what the core already refuses by itself: the action of a
// command is applied by `applyCommand`, which rejects anything it does not understand.
const RESERVED_KEYS=['__proto__','constructor','prototype'];
function record(value:JsonValue|undefined):value is {[key:string]:JsonValue}{
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
}
function textOf(value:JsonValue|undefined,max:number):string|null{
 return typeof value==='string'&&value.length>0&&value.length<=max&&!RESERVED_KEYS.includes(value)?value:null;
}
function refOf(value:JsonValue|undefined):ObjectRef|null{
 return isRef(value)?{hash:value.hash,bytes:value.bytes}:null;
}
function headOf(value:JsonValue|undefined):Head|null{
 if(!record(value))return null;
 const worldId=textOf(value['worldId'],80),branchId=textOf(value['branchId'],80),commit=refOf(value['commit']),generation=value['generation'];
 if(!worldId||!branchId||!commit||typeof generation!=='number'||!Number.isSafeInteger(generation)||generation<1)return null;
 return {worldId,branchId,commit,generation};
}
function refsOf(value:JsonValue|undefined,limit:number):ObjectRef[]|null{
 if(!Array.isArray(value)||value.length>limit)return null;
 const refs:ObjectRef[]=[];
 for(const entry of value){const ref=refOf(entry);if(!ref)return null;refs.push(ref);}
 return refs;
}
function cellsOf(value:JsonValue|undefined):CellCoord[]|null{
 if(!Array.isArray(value)||!value.length||value.length>1024)return null;
 const cells:CellCoord[]=[];
 for(const entry of value){
  if(!record(entry))return null;
  const x=entry['x'],y=entry['y'];
  if(typeof x!=='number'||typeof y!=='number'||!Number.isInteger(x)||!Number.isInteger(y))return null;
  cells.push({x,y});
 }
 return cells;
}
function actionOf(value:JsonValue|undefined):Action|null{
 if(!record(value))return null;
 const type=value['type'];
 if(type==='tick')return {type:'tick'};
 if(type==='build'||type==='demolish'){
  const cells=cellsOf(value['cells']);
  if(!cells)return null;
  if(type==='demolish')return {type:'demolish',cells};
  const tool=value['tool'];
  if(tool!=='road'&&tool!=='residential'&&tool!=='commercial'&&tool!=='industrial'&&tool!=='park'&&tool!=='power')return null;
  return {type:'build',tool,cells};
 }
 if(type==='component'){
  const key=textOf(value['key'],120),entity=textOf(value['entity'],120);
  if(!key||!entity||value['value']===undefined)return null;
  return {type:'component',key,entity,value:value['value']};
 }
 return null;
}
function commandOf(value:JsonValue|undefined):Command|null{
 if(!record(value))return null;
 const worldId=textOf(value['worldId'],80),actorIdValue=textOf(value['actorId'],80),action=actionOf(value['action']);
 const sequence=value['sequence'],expectedRevision=value['expectedRevision'];
 if(value['version']!==1||!worldId||!actorIdValue||!action)return null;
 if(typeof sequence!=='number'||!Number.isSafeInteger(sequence)||sequence<1)return null;
 if(typeof expectedRevision!=='number'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)return null;
 return {version:1,worldId,actorId:actorIdValue,sequence,expectedRevision,action};
}
function authorizationOf(value:JsonValue|undefined):CommitAuthorization|null{
 if(!record(value))return null;
 const identity=controlFrom(value['identity'] ?? null);
 if(!identity.ok||identity.value.kind!=='identity')return null;
 const authorization:CommitAuthorization={identity:identity.value.identity};
 if(value['grant']!==undefined){
  const grant=controlFrom(value['grant']);
  if(!grant.ok||grant.value.kind!=='grant')return null;
  authorization.grant=grant.value.grant;
 }
 if(value['proposal']!==undefined){
  const proposal=controlFrom(value['proposal']);
  if(!proposal.ok||proposal.value.kind!=='proposal')return null;
  authorization.proposal=proposal.value.proposal;
 }
 if(!!authorization.grant!==!!authorization.proposal)return null;
 return authorization;
}
export function readCommit(value:JsonValue|undefined):WorldResult<AcceptedCommit>{
 if(!record(value))return failed('MALFORMED','Commit de sessão inválido');
 const worldId=textOf(value['worldId'],80),branchId=textOf(value['branchId'],80),sessionId=textOf(value['sessionId'],80);
 const id=textOf(value['id'],200),digest=textOf(value['digest'],128),author=textOf(value['author'],200);
 const epoch=value['epoch'],parent=headOf(value['parent']),head=headOf(value['head']),command=commandOf(value['command']);
 const authorization=authorizationOf(value['authorization']);
 const objects=refsOf(value['objects'],LIMIT.refs),bases=readBases(value['bases'],LIMIT.refs);
 if(!worldId||!branchId||!sessionId||!id||!digest||!author||!parent||!head||!command||!authorization)return failed('MALFORMED','Commit de sessão incompleto');
 if(typeof epoch!=='number'||!Number.isSafeInteger(epoch)||epoch<0)return failed('MALFORMED','Época inválida');
 if(!objects||!bases)return failed('MALFORMED','Commit com referências inválidas');
 if(!Array.isArray(value['operations'])||value['operations'].length>8)return failed('MALFORMED','Commit sem lista de operações');
 const operations:string[]=[];
 for(const entry of value['operations']){const text=textOf(entry,200);if(!text)return failed('MALFORMED','Operação aceita inválida');operations.push(text);}
 if(head.worldId!==worldId||head.branchId!==branchId||parent.worldId!==worldId||parent.branchId!==branchId)return failed('MALFORMED','Commit para outro mundo ou ramificação');
 if(parent.generation+1!==head.generation)return failed('MALFORMED','Geração do commit não segue o pai');
 return ok({kind:'commit',worldId,branchId,sessionId,epoch,id,digest,parent,head,command,authorization,objects,bases,operations,author});
}
export function readBases(value:JsonValue|undefined,limit:number):BaseRef[]|null{
 if(!Array.isArray(value)||value.length>limit)return null;
 const bases:BaseRef[]=[];
 for(const entry of value){
  if(!record(entry))return null;
  const id=textOf(entry['id'],120),ref=refOf(entry['ref']);
  if(!id||!ref)return null;
  bases.push({id,ref});
 }
 return bases;
}
function objectsOf(value:JsonValue|undefined):WorldObject[]|null{
 if(!Array.isArray(value)||value.length>LIMIT.objects)return null;
 const objects:WorldObject[]=[];
 for(const entry of value){
  if(!record(entry))return null;
  const ref=refOf(entry['ref']);
  if(!ref||entry['value']===undefined)return null;
  objects.push({ref,value:entry['value']});
 }
 return objects;
}
const STATUS=['accepted','duplicate','refused','failed'];
// A receipt carries no authority: it is read for what it reports, and a receipt that cannot be read is dropped
// instead of deciding anything.
function readReceipt(value:JsonValue|undefined):ProposalReceipt|null{
 if(!record(value)||value['kind']!=='proposal-receipt')return null;
 const id=textOf(value['id'],200),digest=textOf(value['digest'],128),parent=headOf(value['parent']),head=headOf(value['head']);
 const status=value['status'];
 if(!id||!digest||!parent||!head||typeof status!=='string'||!STATUS.includes(status))return null;
 const receipt:ProposalReceipt={kind:'proposal-receipt',id,digest,status:status as ProposalReceipt['status'],parent,head,rebased:value['rebased']===true};
 const code=value['code'],reason=value['reason'],actorIdValue=value['actorId'],sequence=value['sequence'],cost=value['cost'];
 if(typeof code==='string')receipt.code=code as WorldErrorCode;
 if(typeof reason==='string')receipt.reason=reason;
 if(typeof actorIdValue==='string')receipt.actorId=actorIdValue;
 if(typeof sequence==='number')receipt.sequence=sequence;
 if(typeof cost==='number')receipt.cost=cost;
 const bases=readBases(value['bases'],LIMIT.refs);
 if(bases)receipt.bases=bases;
 if(record(value['preview'])){
  const preview=value['preview'],revision=preview['revision'],tick=preview['tick'],money=preview['money'],price=preview['cost'];
  if(typeof revision==='number'&&typeof tick==='number'&&typeof money==='number'&&typeof price==='number'){
   const parsed:ReceiptPreview={revision,tick,money,cost:price};
   if(typeof preview['reason']==='string')parsed.reason=preview['reason'];
   receipt.preview=parsed;
  }
 }
 if(Array.isArray(value['replicas'])){
  const peers:string[]=[];
  for(const entry of value['replicas']){const peer=textOf(entry,80);if(peer)peers.push(peer);}
  receipt.replicas=peers;
 }
 return receipt;
}
function readReplicaReceipt(value:JsonValue|undefined):ReplicaReceipt|null{
 if(!record(value)||value['kind']!=='replica-receipt')return null;
 const peer=textOf(value['peer'],80),id=textOf(value['id'],200),digest=textOf(value['digest'],128),head=headOf(value['head']),hostHead=headOf(value['hostHead']);
 const status=value['status'],STATUSES=['adopted','duplicate','pending','divergent','refused'];
 if(!peer||!id||!digest||!head||!hostHead||typeof status!=='string'||!STATUSES.includes(status))return null;
 const receipt:ReplicaReceipt={kind:'replica-receipt',peer,id,digest,status:status as ReplicaReceipt['status'],head,hostHead};
 const code=value['code'],reason=value['reason'],missing=refsOf(value['missing'],LIMIT.refs);
 const evidence=record(value['evidence'])?readBases(value['evidence']['bases'],LIMIT.refs):null;
 if(typeof code==='string')receipt.code=code as WorldErrorCode;
 if(typeof reason==='string')receipt.reason=reason;
 if(missing)receipt.missing=missing;
 if(evidence)receipt.evidence={bases:evidence};
 return receipt;
}
export function readBody(body:JsonValue):WorldResult<SessionBody>{
 if(!record(body))return failed('MALFORMED','Corpo de sessão inválido');
 const kind=body['kind'];
 if(kind==='commit'){const commit=readCommit(body['commit']);return commit.ok?ok({kind:'commit',commit:commit.value}):commit;}
 if(kind==='base-request'){
  const bases=readBases(body['bases'],LIMIT.refs),objects=refsOf(body['objects'],LIMIT.refs);
  return bases&&objects?ok({kind:'base-request',bases,objects}):failed('MALFORMED','Pedido de base inválido');
 }
 if(kind==='base-response'){
  const objects=objectsOf(body['objects']);
  return objects?ok({kind:'base-response',objects}):failed('MALFORMED','Resposta de base inválida');
 }
 if(kind==='commit-request'){
  const head=headOf(body['head']),objects=refsOf(body['objects'],LIMIT.refs);
  return head&&objects?ok({kind:'commit-request',head,objects}):failed('MALFORMED','Pedido de commit inválido');
 }
 if(kind==='commit-response'){
  const objects=objectsOf(body['objects']);
  if(!objects||!Array.isArray(body['commits'])||body['commits'].length>LIMIT.commits)return failed('MALFORMED','Resposta de commit inválida');
  const commits:AcceptedCommit[]=[];
  for(const entry of body['commits']){const commit=readCommit(entry);if(!commit.ok)return commit;commits.push(commit.value);}
  return ok({kind:'commit-response',commits,objects});
 }
 if(kind==='proposal-receipt'){
  const receipt=readReceipt(body['receipt']);
  return receipt?ok({kind:'proposal-receipt',receipt}):failed('MALFORMED','Recibo inválido');
 }
 if(kind==='replica-receipt'){
  const receipt=readReplicaReceipt(body['receipt']);
  return receipt?ok({kind:'replica-receipt',receipt}):failed('MALFORMED','Confirmação inválida');
 }
 return failed('MALFORMED',`Corpo de sessão desconhecido: ${String(kind)}`);
}

// `Promise.withResolvers` is not part of this project's lib (ES2022), so a session keeps its own deferred: a job's
// answer is handed to whoever is waiting for it, and to nobody else.
export function deferred<T>():{promise:Promise<T>;resolve:(value:T)=>void}{
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(settle=>{resolve=settle;});
 return {promise,resolve};
}

// --- shapes the session keeps bounded (spec §9.3, R13) ----------------------------------------------------------
// `LEDGER_LIMIT` is how far back a reopened branch still recognises a repeated delivery: past it the attempt is older
// than what this device retained, and it asks for a reconciliation instead of being applied as something new.
const LIMIT={refs:256,objects:16,commits:8,ledger:512,outbox:64,receipts:128,seen:1024,published:512};
// The peers a host will answer for and announce to.
export type HostOptions={
 repository:WorldRepository;
 transport:SessionTransport;
 peer:string;
 head:Head;
 identity:IdentityProof;
 grants:readonly Grant[];
 rules:{family:string;version:number};
 bases:MapSource;
 verifier:SignatureVerifier;
 codec:WorldCodec;
 hasher:ContentHasher;
 now:()=>string;
 sessionId:string;
 epoch:number;
 limits?:Limits;
 peers?:readonly string[];
};
export type HostCheckpoint={head:Head;state:GameState};
export type HostSession={
 submit(proposal:Proposal):Promise<ProposalReceipt>;
 step():Promise<WorldResult<Head>>;
 head():Head;
 checkpoint():Promise<HostCheckpoint>;
 pending():number;
 confirmations():readonly ReplicaReceipt[];
 idle():Promise<void>;
};
export function createHostSession(options:HostOptions):HostSession{
 const limits=options.limits??NETWORK_LIMITS;
 const principalKey=(principal:Principal)=>`${principal.scheme}:${principal.id}`;
 const grants=new Map<string,Grant>(options.grants.map(grant=>[principalKey(grant.principal),grant]));
 const identities=new Map<string,IdentityProof>();
 const members=new Set<string>(options.peers??[]);
 const ledger=new Map<string,{digest:string;epoch:number;head:Head}>();
 const versions=new Map<string,Head>();
 const outbox=new Map<string,AcceptedCommit>();
 const answers=new Map<string,ProposalReceipt>();
 const seen:WireEnvelope[]=[];
 const frozen=new Map<string,BaseChunk>();
 const published=new Map<string,WorldObject>();
 const confirmations:ReplicaReceipt[]=[];
 let head=options.head,state:GameState|null=null,paused:WorldError|null=null,pendingAttempt:string|null=null,counter=0,working=false,inFlight=0;
 const jobs:Array<{kind:'proposal';proposal:Proposal;answer:(receipt:ProposalReceipt)=>void}|{kind:'tick';answer:(result:WorldResult<Head>)=>void}>=[];

 // The session opens once, and it opens the version it was given: the rules of the branch have to be the rules this
 // session was configured with, because different rules are another simulation and not a filter (§10).
 async function load():Promise<WorldResult<HostCheckpoint>>{
  const point=await options.repository.checkout(options.head);
  if(!point.ok)return point;
  const rules=point.value.versions.rules;
  if(rules.family!==options.rules.family||rules.version!==options.rules.version)return failed('CONFLICT',`As regras da ramificação (${rules.family} v${rules.version}) não são as desta sessão (${options.rules.family} v${options.rules.version})`);
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
  return ok({head,state:point.value.state});
 }
 const boot=load();
 async function opened():Promise<WorldResult<HostCheckpoint>>{return boot;}
 // The one seam between this session and the repository: objects, the idempotency receipt and the head advance are
 // published together, so a confirmation never covers bytes that were not written. Task 5 adds
 // `commitPrepared(expected, prepared)` to the repository; swapping this call is the whole change, and today's
 // `commit(expected, change)` already gives the same atomicity and the same idempotency key.
 async function persist(prepared:{id:string;expected:Head;state:GameState;operations:readonly string[];objects:readonly WorldObject[];author:string}):Promise<WorldResult<Head>>{
  try{
   return await options.repository.commit(prepared.expected,{id:prepared.id,state:prepared.state,operations:prepared.operations,objects:prepared.objects,author:prepared.author});
  }catch(error){
   // An adapter that throws is a device that did not confirm, and it is never a reason to believe the change landed.
   return failed('QUOTA',error instanceof Error&&error.message?error.message:'Falha de armazenamento');
  }
 }
 function baseValue(base:BaseChunk):JsonValue{return baseValueOf(base);}
 async function baseObject(base:BaseChunk):Promise<WorldObject>{
  const object:WorldObject={ref:await options.hasher.ref(options.codec.encode(baseValue(base))),value:baseValue(base)};
  published.set(object.ref.hash,object);
  // Only the regions this session can still be asked about are kept: the administered area is bounded by the plan's
  // limit, and an evicted object is simply asked for again from the live version.
  while(published.size>LIMIT.published){const oldest=published.keys().next().value;if(oldest===undefined)break;published.delete(oldest);}
  return object;
 }
 async function basesOfState(target:GameState):Promise<BaseRef[]>{
  const bases:BaseRef[]=[];
  for(const id of Object.keys(target.chunks).sort())bases.push({id,ref:(await baseObject(target.chunks[id]!.base)).ref});
  return bases;
 }
 // A region the version does not manage yet has to be frozen before anything can touch it: the frozen base is what a
 // replica later asks for by hash, and what makes the cell indices of the operation meaningful.
 async function available(intent:Action,live:GameState):Promise<WorldResult<BaseChunk[]>>{
  if(intent.type==='build'||intent.type==='demolish'){
   const wanted=new Set<string>();
   for(const cell of intent.cells)wanted.add(chunkId(cell));
   for(const id of wanted){
    if(live.chunks[id]||frozen.has(id))continue;
    let base:BaseChunk;
    try{base=await options.bases.loadChunk(id);}catch{return failed('NOT_FOUND',`A região ${id} ainda não tem base congelada verificável`);}
    if(base.id!==id)return failed('MALFORMED',`A base de ${id} veio identificada como ${base.id}`);
    frozen.set(id,base);
   }
  }
  return ok([...frozen.values()]);
 }
 // A refusal answers with the version the player would be writing against. A refusal that never reached the quote
 // reports no cost, because nothing was quoted: zero here means "not priced", not "free".
 function previewOf(live:GameState,cost:number,reason?:string):ReceiptPreview{return {revision:live.revision,tick:live.tick,money:live.money,cost,reason};}
 function marksIn():ProposalMark[]{
  const marks:ProposalMark[]=[];
  for(const [id,entry] of ledger)marks.push({id,epoch:entry.epoch,worldId:head.worldId,branchId:head.branchId,digest:entry.digest});
  return marks;
 }
 async function versionAt(ref:ObjectRef):Promise<WorldResult<Head>>{
  const known=versions.get(ref.hash);
  if(known)return ok(known);
  const history=await options.repository.history(head,LIMIT.ledger);
  if(!history.ok)return history;
  for(const version of history.value){versions.set(version.head.commit.hash,version.head);if(version.head.commit.hash===ref.hash)return ok(version.head);}
  return failed('CONFLICT',`A versão observada não está no histórico retido desta ramificação (${ref.hash.slice(0,12)}…)`);
 }
 async function stateAt(target:Head,live:GameState):Promise<WorldResult<GameState>>{
  if(target.commit.hash===head.commit.hash)return ok(live);
  const point=await options.repository.checkout(target);
  if(!point.ok)return point;
  return ok(point.value.state);
 }

 // The pipeline (§7.4). Everything before `persist` can refuse; nothing after it can un-commit, so the confirmation is
 // published only once the device has written objects, receipt and head together.
 async function apply(proposal:Proposal):Promise<ProposalReceipt>{
  const parent=head;
  const digest=(await options.hasher.ref(proposalBytes(proposal,options.codec))).hash;
  const initial:ProposalReceipt={kind:'proposal-receipt',id:proposal.id,digest,status:'refused',parent,head,rebased:false};
  const refuse=(code:WorldErrorCode,reason:string,extra:Partial<ProposalReceipt>={}):ProposalReceipt=>({...initial,code,reason,...extra});
  const live=state;
  if(!live)return refuse('MALFORMED','A sessão não abriu esta ramificação');
  // A tick is scheduled by the host, never brought by a proposal (§7.5).
  if(proposal.intent.type==='tick')return refuse('PERMISSION','O anfitrião agenda os ticks desta sessão');
  if(paused&&pendingAttempt!==proposal.id)return{...initial,status:'failed',code:paused.code,reason:`Persistência pausada: ${paused.message}`};
  const observed=await versionAt(proposal.observedHead);
  // A repeat is answered before anything else: the same identifier and the same body is the change that was already
  // accepted, and the version it produced is the answer.
  const known=ledger.get(proposal.id);
  if(known)return known.digest===digest?{...initial,status:'duplicate',parent:observed.ok?observed.value:parent,head:known.head}:refuse('CONFLICT',`A proposta ${proposal.id} já foi aceita com outro conteúdo`);
  if(!observed.ok)return refuse(observed.error.code,`${observed.error.message}; peça reconciliação`,{preview:previewOf(live,0)});
  // Who is asking, and with what. Both come from the control plane this host validated when the peer joined.
  const identity=identities.get(principalKey(proposal.principal));
  const grant=grants.get(principalKey(proposal.principal));
  if(!identity)return refuse('SIGNATURE',`A identidade de ${proposal.principal.id} não foi apresentada a esta sessão`);
  if(!grant)return refuse('PERMISSION',`Sem concessão para ${proposal.principal.id} nesta ramificação`);
  // The proposal is judged against the version its author observed, not against the version the host holds now: that
  // is what makes a rebase a decision of the host instead of a silent change of meaning.
  const observedState=await stateAt(observed.value,live);
  if(!observedState.ok)return refuse(observedState.error.code,observedState.error.message);
  const authorized=await authorize(grant,proposal,{head:observed.value,revision:observedState.value.revision,epoch:options.epoch,now:options.now(),identity,codec:options.codec,hasher:options.hasher,verifier:options.verifier,marks:marksIn(),revokedGrants:[],chain:[]});
  if(!authorized.ok)return refuse(authorized.error.code,authorized.error.message,{preview:previewOf(live,0)});
  // Reachable only if the ledger and the marks disagree, which the single source of both prevents: the answer stays a
  // duplicate without claiming a version this host cannot name.
  if(authorized.value.duplicate)return{...initial,status:'duplicate',head:parent};
  // Revalidation of the intention against the version this host is about to apply on: it is rebased only while every
  // relevant field and the approved cost stay valid, and inside the ceiling the author signed (§7.4 step 3).
  const bases=await available(proposal.intent,live);
  if(!bases.ok)return refuse(bases.error.code,bases.error.message);
  const quote=quoteAction(live,proposal.intent,bases.value);
  if(quote.status!=='ok')return refuse('CONFLICT',`Prévia obsoleta: ${quote.reason??'intenção inválida'}`,{preview:previewOf(live,quote.cost,quote.reason)});
  if(quote.cost>authorized.value.approvedCost||quote.cost>proposal.costLimit)return refuse('PERMISSION',`Custo ${quote.cost} acima do teto aprovado (${proposal.costLimit})`,{preview:previewOf(live,quote.cost,quote.reason)});
  const rebased=observed.value.commit.hash!==parent.commit.hash;
  const command=commandFor({...authorized.value,proposal:{...authorized.value.proposal,preconditions:{revision:live.revision}}},live);
  if(!command.ok)return refuse(command.error.code,command.error.message,{preview:previewOf(live,quote.cost,quote.reason)});
  const applied=applyCommand(live,command.value,bases.value);
  if(applied.status!=='applied')return refuse('CONFLICT',applied.reason??'O núcleo recusou a operação',{preview:previewOf(live,quote.cost,quote.reason)});
  const fresh=Object.keys(applied.state.chunks).filter(id=>!live.chunks[id]).sort();
  const objects:WorldObject[]=[];
  for(const id of fresh)objects.push(await baseObject(applied.state.chunks[id]!.base));
  const prepared={id:proposal.id,expected:parent,state:applied.state,operations:[recordOf({id:proposal.id,epoch:options.epoch,digest})],objects,author:proposal.principal.id};
  const persisted=await persist(prepared);
  if(!persisted.ok){
   // A device that refuses pauses new durable confirmations and keeps the attempt: the retry of the same proposal
   // re-runs the pipeline, and the receipt of the device decides whether it was already applied.
   paused=persisted.error;
   pendingAttempt=proposal.id;
   return{...initial,status:'failed',code:persisted.error.code,reason:persisted.error.message};
  }
  head=persisted.value;
  state=applied.state;
  paused=null;
  pendingAttempt=null;
  ledger.set(proposal.id,{digest,epoch:options.epoch,head});
  versions.set(head.commit.hash,head);
  const commit:AcceptedCommit={kind:'commit',worldId:head.worldId,branchId:head.branchId,sessionId:options.sessionId,epoch:options.epoch,id:proposal.id,digest,parent,head,command:command.value,authorization:{identity,grant,proposal},objects:objects.map(object=>object.ref),bases:await basesOfState(applied.state),operations:prepared.operations,author:prepared.author};
  const replicas=await emit(commit);
  return {...initial,status:'accepted',head,rebased,actorId:authorized.value.actorId,sequence:command.value.sequence,cost:quote.cost,bases:commit.bases,replicas};
 }
 // A tick is the host's own command: the core orders it by the host actor's accepted sequence, exactly like any other.
 async function tick():Promise<WorldResult<Head>>{
  const live=state;
  if(!live)return failed('MALFORMED','A sessão não abriu esta ramificação');
  if(paused)return failed(paused.code,`Persistência pausada: ${paused.message}`);
  const parent=head;
  const actor=await actorId(options.identity.principal,options.hasher,options.codec);
  const command:Command={version:1,worldId:live.worldId,actorId:actor,sequence:(live.actors[actor]??0)+1,expectedRevision:live.revision,action:{type:'tick'}};
  const applied=applyCommand(live,command,[]);
  if(applied.status!=='applied')return failed('CONFLICT',applied.reason??'O núcleo recusou o tick');
  const id=tickRecord(options.epoch,parent.generation+1);
  const digest=(await options.hasher.ref(options.codec.encode(command as unknown as JsonValue))).hash;
  const persisted=await persist({id,expected:parent,state:applied.state,operations:[id],objects:[],author:options.identity.principal.id});
  if(!persisted.ok){paused=persisted.error;return persisted;}
  head=persisted.value;
  state=applied.state;
  versions.set(head.commit.hash,head);
  await emit({kind:'commit',worldId:head.worldId,branchId:head.branchId,sessionId:options.sessionId,epoch:options.epoch,id,digest,parent,head,command,authorization:{identity:options.identity},objects:[],bases:await basesOfState(applied.state),operations:[id],author:options.identity.principal.id});
  return ok(head);
 }
 function trafficOf(body:SessionBody):TrafficClass{
  if(body.kind==='commit')return 'durable';
  if(body.kind==='base-response'||body.kind==='commit-response')return 'object';
  return 'control';
 }
 const envelopeOf=(traffic:TrafficClass,id:string):WireEnvelope=>({worldProtocol:WORLD_PROTOCOL,wireVersion:WIRE_VERSION,kind:'message',class:traffic,worldId:head.worldId,branchId:head.branchId,sessionId:options.sessionId,epoch:options.epoch,id});
 async function send(peer:string,body:SessionBody,id?:string):Promise<string>{
  const messageId=id??`${options.peer}.${options.epoch}.${(counter+=1)}`;
  await options.transport.send(peer,{envelope:envelopeOf(trafficOf(body),messageId),body:body as unknown as JsonValue});
  return messageId;
 }
 // Announcing a commit is best effort on purpose: the durable confirmation is the device's receipt, and a transport
 // that fails only means the replicas will ask for what they are missing.
 async function emit(commit:AcceptedCommit):Promise<readonly string[]>{
  outbox.set(commit.head.commit.hash,commit);
  while(outbox.size>LIMIT.outbox){const oldest=outbox.keys().next().value;if(oldest===undefined)break;outbox.delete(oldest);}
  const sent:string[]=[];
  for(const peer of members){
   if(peer===options.peer)continue;
   try{await send(peer,{kind:'commit',commit});sent.push(peer);}
   catch{
    // The peers that did not answer are simply not listed as notified.
   }
  }
  return sent;
 }
 async function objectsFor(refs:readonly ObjectRef[]):Promise<WorldObject[]>{
  const objects:WorldObject[]=[];
  for(const ref of refs.slice(0,LIMIT.objects)){
   const found=published.get(ref.hash);
   if(found&&sameRef(found.ref,ref))objects.push(found);
  }
  return objects;
 }
 // A replica that lacks a frozen region asks for it by address; this host answers with the object it published for
 // that region, and never with something whose bytes do not hash to the address asked for.
 async function answerBases(peer:string,bases:readonly BaseRef[],foreign:readonly ObjectRef[]):Promise<void>{
  const objects:WorldObject[]=[];
  const live=state;
  if(live)for(const base of bases.slice(0,LIMIT.objects)){
   const chunk=live.chunks[base.id];
   if(!chunk)continue;
   const object=await baseObject(chunk.base);
   if(sameRef(object.ref,base.ref))objects.push(object);
  }
  for(const object of await objectsFor(foreign))objects.push(object);
  await send(peer,{kind:'base-response',objects});
 }
 async function answerCommits(peer:string,requested:Head,refs:readonly ObjectRef[]):Promise<void>{
  const commit=outbox.get(requested.commit.hash);
  await send(peer,{kind:'commit-response',commits:commit?[commit]:[],objects:await objectsFor(refs)});
 }
 function remember(envelope:WireEnvelope):void{
  seen.push(envelope);
  while(seen.length>LIMIT.seen)seen.shift();
 }
 // Control documents are read by the schema the world layer owns; anything else is a session body.
 async function handle(peer:string,message:WireMessage):Promise<void>{
  const envelope=message.envelope;
  if(envelope.worldId!==head.worldId||envelope.branchId!==head.branchId)return;
  const replay=replayOf(seen,envelope);
  if(replay==='replay')return;
  // A repeated frame is answered with the receipt it produced, unless that receipt was not durable: a device that
  // refused wrote nothing, so the frame is a pending attempt and is offered to the pipeline again.
  const previous=replay==='duplicate'?answers.get(envelope.id):undefined;
  if(previous&&previous.status!=='failed'){
   await send(peer,{kind:'proposal-receipt',receipt:previous},envelope.id);
   return;
  }
  if(replay==='new')remember(envelope);
  // A message from another session or a previous epoch is fenced: only the current epoch of this session writes.
  if(envelope.sessionId!==options.sessionId||envelope.epoch!==options.epoch)return;
  const control=controlFrom(message.body);
  if(control.ok){
   if(control.value.kind==='identity'){
    const identity=control.value.identity;
    if(identity.scope.worldId!==head.worldId||identity.scope.branchId!==head.branchId||identity.scope.sessionId!==options.sessionId)return;
    if(!await options.verifier.verify(identity,identityBytes(identity,options.codec)))return;
    identities.set(principalKey(identity.principal),identity);
    members.add(peer);
    return;
   }
   if(control.value.kind==='grant'){
    const grant=control.value.grant;
    if(grant.worldId!==head.worldId||grant.branchId!==head.branchId)return;
    if(!await options.verifier.verify(grant.proof,grantBytes(grant,options.codec)))return;
    // Holding the document is not holding the permission: the principal has to have presented its binding, or the
    // policy of this session has to have issued that exact grant.
    if(!identities.has(principalKey(grant.principal))&&!options.grants.some(known=>known.id===grant.id))return;
    grants.set(principalKey(grant.principal),grant);
    return;
   }
   if(control.value.kind==='proposal'){
    members.add(peer);
    const receipt=await submit(control.value.proposal);
    answers.set(envelope.id,receipt);
    while(answers.size>LIMIT.receipts){const oldest=answers.keys().next().value;if(oldest===undefined)break;answers.delete(oldest);}
    await send(peer,{kind:'proposal-receipt',receipt});
    return;
   }
   return;
  }
  const parsed=readBody(message.body);
  if(!parsed.ok)return;
  if(parsed.value.kind==='base-request'){members.add(peer);await answerBases(peer,parsed.value.bases,parsed.value.objects);return;}
  if(parsed.value.kind==='commit-request'){members.add(peer);await answerCommits(peer,parsed.value.head,parsed.value.objects);return;}
  if(parsed.value.kind==='replica-receipt'){
   confirmations.push(parsed.value.receipt);
   while(confirmations.length>LIMIT.receipts)confirmations.shift();
  }
 }
 // One queue, one worker: proposals and ticks are ordered by arrival, and a proposal is never applied on top of a
 // half-finished change. The session counts what it has accepted and not yet answered, so the bound is about the
 // work in the session and not about where a job happens to be in the queue at the moment it is asked.
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
      if(!opened.ok){
       if(job.kind==='proposal')job.answer({kind:'proposal-receipt',id:job.proposal.id,digest:'',status:'failed',parent:head,head,rebased:false,code:opened.error.code,reason:opened.error.message});
       else job.answer(opened);
       continue;
      }
      if(job.kind==='proposal')job.answer(await apply(job.proposal));
      else job.answer(await tick());
     }catch(error){
      const message=error instanceof Error&&error.message?error.message:'Falha desconhecida';
      if(job.kind==='proposal')job.answer({kind:'proposal-receipt',id:job.proposal.id,digest:'',status:'failed',parent:head,head,rebased:false,code:'QUOTA',reason:message});
      else job.answer(failed('QUOTA',message));
     }finally{inFlight-=1;}
    }
   }finally{working=false;}
  })();
 }
 function submit(proposal:Proposal):Promise<ProposalReceipt>{
  if(queued()>=limits.maxProposalQueue)return Promise.resolve<ProposalReceipt>({kind:'proposal-receipt',id:proposal.id,digest:'',status:'refused',parent:head,head,rebased:false,code:'LIMIT',reason:`Fila de propostas cheia (${limits.maxProposalQueue})`});
  const answer=deferred<ProposalReceipt>();
  inFlight+=1;
  jobs.push({kind:'proposal',proposal,answer:answer.resolve});
  start();
  return answer.promise;
 }
 function step():Promise<WorldResult<Head>>{
  if(queued()>=limits.maxProposalQueue)return Promise.resolve(failed<Head>('LIMIT',`Fila da sessão cheia (${limits.maxProposalQueue})`));
  const answer=deferred<WorldResult<Head>>();
  inFlight+=1;
  jobs.push({kind:'tick',answer:answer.resolve});
  start();
  return answer.promise;
 }
 // Every message is handled in arrival order, and `idle` is the point where a driver may look at the session: the
 // handlers have finished and the queue that they feed is empty. A transport that delivers frames synchronously would
 // otherwise leave the pipeline half-started.
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
  submit,
  step,
  head:()=>head,
  pending:queued,
  confirmations:()=>confirmations,
  idle,
  async checkpoint(){
   const opened_=await boot;
   if(!opened_.ok)throw new Error(opened_.error.message);
   const live=state;
   if(!live)throw new Error('A sessão não abriu esta ramificação');
   return {head,state:live};
  },
 };
}
