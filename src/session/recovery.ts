import type {Head,JsonValue,ObjectRef,WorldBundle,WorldResult} from '../world/model';
import {failed,ok,sameRef} from '../world/model';
import type {OsimEnvelope} from '../world/osim';
import type {Grant,Principal} from '../world/permissions';
import type {HostSession} from './host-session';
import type {WorldRepository} from './world-repository';

// Planned transfer and recovery of a player-hosted branch (plan Task 13; spec §7.5; OpenSim Protocol §27, §28, §39.5).
//
// A branch has exactly one writer, and that writer is an *epoch*, not a device: every host grant carries its epoch,
// and only frames of the current epoch are accepted. A planned transfer therefore pauses the epoch, replicates the
// last head to the successor and publishes the capability of the new one (§27) — the successor enters the session by
// `join` (§39.5) and writes only in the epoch the owner granted it. When the host is simply gone there is no election
// by timeout: the owner recovers from the last verifiable prefix that some copy retained, or the work continues as a
// personal fork. Authority in the protocol is scoped and never ordered by a clock (§28), so `recoverBranch` takes the
// decision from the caller and only checks that the decision is authorized, complete and not a silent regression.
//
// What this module does NOT promise: bytes nobody kept. A transfer whose package is incomplete says which objects are
// missing and adopts nothing, and a candidate no copy holds in full is refused instead of being filled in by guesswork.

// --- who may write the shared branch (spec §7.5) ---------------------------------------------------------------
// `epoch` is the only authority that writes: the successor of a valid transfer. `stopped` is a divergence nobody may
// integrate through, and `local` is a personal fork, which leaves the shared branch with no writer at all.
export type BranchAuthority=
 | {kind:'epoch';epoch:number;writer:Principal}
 | {kind:'stopped';epoch:number;reason:string}
 | {kind:'local';reason:string};
export const activeWritersForBranch=(authority:BranchAuthority):number=>authority.kind==='epoch'?1:0;
export const epochAuthority=(grant:EpochGrant):BranchAuthority=>({kind:'epoch',epoch:grant.epoch,writer:grant.successor});

// --- the handover (spec §7.5, protocol §27) --------------------------------------------------------------------
export type HandoverOffer={
 kind:'handover';
 worldId:string;
 branchId:string;
 sessionId:string;
 sessionUri:string;
 owner:Principal;
 successor:Principal;
 epoch:number;
 previousEpoch:number;
 head:Head;
 authority:BranchAuthority;
 bundle:WorldBundle;
 objects:readonly ObjectRef[];
 missing:readonly ObjectRef[];
 capability:OsimEnvelope;
 published:boolean;
};
// The owner's approval of the new epoch: it binds owner, successor, branch, session, epoch and the last head, and the
// grant it carries is the same document the successor presents to the new session.
export type EpochGrant={
 kind:'epoch-grant';
 id:string;
 owner:Principal;
 successor:Principal;
 worldId:string;
 branchId:string;
 sessionId:string;
 epoch:number;
 head:Head;
 grant:Grant;
};

// --- recovery (spec §7.5, protocol §28) -----------------------------------------------------------------------
// What one copy can say about the branch. `checked` facts are the copy's own: whether it holds every object the head
// rests on, and whether this device already showed that version as confirmed. `observedAt` is context, never an order.
export type RecoveryCandidate={
 head:Head;
 epoch:number;
 writer:Principal;
 grant?:Grant;
 complete:boolean;
 missing?:readonly ObjectRef[];
 confirmed:boolean;
 source:string;
 observedAt?:string;
};
export type RecoveryDecision=
 | {kind:'continue';candidateIndex:number;reason:string;acknowledgeRegression?:boolean}
 | {kind:'fork';candidateIndex:number;reason:string;acknowledgeRegression?:boolean}
 | {kind:'stop';reason:string};
export type RecoveryPlan={
 kind:'recovery';
 head:Head;
 epoch:number;
 mode:'continue'|'fork'|'stop';
 authority:BranchAuthority;
 regressed:boolean;
 evidence:readonly RecoveryCandidate[];
 missing:readonly ObjectRef[];
 reason:string;
};

const uriOf=(principal:Principal):string=>`${principal.scheme}:${principal.id}`;
const samePrincipal=(left:Principal,right:Principal):boolean=>left.scheme===right.scheme&&left.id===right.id;
const names=(refs:readonly ObjectRef[]):string=>refs.map(ref=>ref.hash.slice(0,12)).join(', ');
// The concession a candidate rests on: it has to be for this branch, this epoch and this writer, or it authorizes
// something else and the candidate has no authority at all.
function authorityGrant(candidate:RecoveryCandidate):Grant|null{
 const grant=candidate.grant;
 if(!grant)return null;
 if(grant.worldId!==candidate.head.worldId||grant.branchId!==candidate.head.branchId)return null;
 if(grant.epoch!==undefined&&grant.epoch!==candidate.epoch)return null;
 if(!samePrincipal(grant.principal,candidate.writer))return null;
 return grant;
}

// Pausing first is what makes the offer a statement about one known head: after the pause the epoch confirms nothing
// new, and the package the successor receives is exactly the version that was durable when the transfer started. A
// transfer that could not even compose its offer resumes the epoch, because nothing durable changed — and offering
// again is how a transfer whose package was incomplete is retried, since the epoch stays closed while it is prepared.
export async function prepareHandover(session:HostSession,successor:Principal):Promise<WorldResult<HandoverOffer>>{
 const seat=session.seat();
 if(samePrincipal(successor,seat.principal))return failed('MALFORMED','A transferência precisa de um sucessor diferente de quem hospeda');
 session.pause({code:'CONFLICT',message:`Transferência para ${uriOf(successor)}: a época ${seat.epoch} não confirma mais nada`});
 const point=await session.checkpoint();
 const bundle=await session.bundle();
 if(!bundle.ok){
  session.resume();
  return bundle;
 }
 const epoch=seat.epoch+1;
 const body:JsonValue={
  capability:'host',
  issuer:uriOf(seat.principal),
  successor:uriOf(successor),
  worldId:point.head.worldId,
  branchId:point.head.branchId,
  sessionId:seat.sessionId,
  epoch,
  previousEpoch:seat.epoch,
  head:point.head as unknown as JsonValue,
 };
 const capability=await session.publishCapability(body,`osim:capability:${seat.sessionId}.${epoch}`);
 if(!capability.ok){
  session.resume();
  return capability;
 }
 const missing=[...bundle.value.completeness.missing];
 return ok({
  kind:'handover',
  worldId:point.head.worldId,
  branchId:point.head.branchId,
  sessionId:seat.sessionId,
  sessionUri:seat.uri,
  owner:seat.principal,
  successor,
  epoch,
  previousEpoch:seat.epoch,
  head:point.head,
  authority:{kind:'epoch',epoch,writer:successor},
  bundle:bundle.value,
  objects:bundle.value.objects.map(object=>object.ref),
  missing,
  capability:capability.value.envelope,
  published:capability.value.published,
 });
}

// The successor accepts only what it can verify: the epoch grant the owner approved for exactly this offer, and a head
// it either already holds or can open from the package. An incomplete package is refused with the addresses that are
// missing, because adopting a partial prefix would be claiming a version nobody retained.
export async function acceptHandover(offer:HandoverOffer,grant:EpochGrant,repository:WorldRepository):Promise<WorldResult<Head>>{
 if(!samePrincipal(grant.successor,offer.successor))return failed('PERMISSION','A concessão não nomeia o sucessor desta oferta');
 if(!samePrincipal(grant.owner,offer.owner))return failed('PERMISSION','A concessão foi emitida por outro proprietário');
 if(grant.worldId!==offer.worldId||grant.branchId!==offer.branchId||grant.sessionId!==offer.sessionId)return failed('MALFORMED','A concessão é de outra sessão, mundo ou ramificação');
 if(grant.epoch!==offer.epoch)return failed('CONFLICT',`Concessão de época antiga: a oferta abre a época ${offer.epoch} e a concessão é da época ${grant.epoch}`);
 if(grant.head.commit.hash!==offer.head.commit.hash||grant.head.generation!==offer.head.generation)return failed('CONFLICT','A concessão aprova outro head: a oferta e a época têm de começar na mesma versão');
 const document=grant.grant;
 if(!samePrincipal(document.principal,grant.successor))return failed('PERMISSION','A concessão do sucessor não é do sucessor');
 if(document.worldId!==offer.worldId||document.branchId!==offer.branchId)return failed('MALFORMED','A concessão do sucessor é de outra ramificação');
 if(document.epoch!==undefined&&document.epoch!==grant.epoch)return failed('CONFLICT',`A concessão declara a época ${document.epoch} e a transferência abre a época ${grant.epoch}`);
 if(!document.actions.includes('host'))return failed('PERMISSION','Uma transferência exige a ação host do sucessor');
 const heads=await repository.branches(offer.worldId);
 if(!heads.ok)return heads;
 const current=heads.value.find(head=>head.branchId===offer.branchId)??null;
 if(current&&current.generation>offer.head.generation)return failed('CONFLICT',`Esta cópia já tem ${offer.branchId} na geração ${current.generation}: aceitar a oferta recuaria um head já confirmado`);
 const local=await repository.checkout(offer.head);
 if(local.ok)return ok(offer.head);
 // This copy does not have the offered version, so the package is the only way to open it — and only a whole package
 // is opened.
 if(!offer.bundle.completeness.complete)return failed('MISSING_OBJECT',offer.missing.length?`A transferência não tem todos os objetos e nenhuma cópia os reteve: faltam ${names(offer.missing)}; peça-os antes de aceitar`:'A transferência chegou declarada como incompleta; peça ao anfitrião um pacote inteiro antes de aceitar');
 const packaged=offer.bundle.head;
 if(!packaged||!sameRef(packaged.commit,offer.head.commit))return failed('MALFORMED','O pacote oferecido não é o head oferecido');
 if(!current){
  const opened=await repository.create(offer.bundle);
  if(!opened.ok)return opened;
  if(!sameRef(opened.value.commit,offer.head.commit))return failed('CONFLICT','A cópia aberta não é a versão oferecida');
  return ok(opened.value);
 }
 return failed('MISSING_OBJECT',`Esta cópia está na geração ${current.generation} e a transferência começa na ${offer.head.generation}: adote a versão oferecida pela sessão antes de aceitar`);
}

// The recovery is explicit on purpose. Nothing here compares timestamps: a candidate is chosen because the caller
// said so, and it is only accepted when it has authority, is complete, and does not silently walk back a version this
// device already showed as confirmed. Two concessions for one epoch are a divergence to present, not a coin to flip.
export function recoverBranch(candidates:readonly RecoveryCandidate[],decision:RecoveryDecision):WorldResult<RecoveryPlan>{
 if(!candidates.length)return failed('NOT_FOUND','Nenhuma cópia verificável desta ramificação: sem candidato não há recuperação');
 const first=candidates[0]!;
 for(const candidate of candidates){
  if(candidate.head.worldId!==first.head.worldId||candidate.head.branchId!==first.head.branchId)return failed('MALFORMED','Candidatos de mundos ou ramificações diferentes');
 }
 if(decision.kind==='stop'){
  // Stopping adopts nothing: the head already displayed as confirmed is kept, and every claim travels as evidence.
  const scored=[...candidates].sort((left,right)=>right.head.generation-left.head.generation);
  const kept=scored.find(candidate=>candidate.confirmed)??scored[0]!;
  return ok({kind:'recovery',head:kept.head,epoch:kept.epoch,mode:'stop',authority:{kind:'stopped',epoch:Math.max(...candidates.map(candidate=>candidate.epoch)),reason:decision.reason},regressed:false,evidence:[...candidates],missing:[...(kept.missing??[])],reason:decision.reason});
 }
 const chosen=candidates[decision.candidateIndex];
 if(!chosen)return failed('MALFORMED',`A decisão aponta para o candidato ${decision.candidateIndex}, que não existe`);
 if(!chosen.complete)return failed('MISSING_OBJECT',`A cópia de ${chosen.source} não tem todos os objetos da versão ${chosen.head.generation}: peça o que falta antes de ${decision.kind==='continue'?'continuar':'ramificar'}`);
 if(decision.kind==='continue'){
  const authority=authorityGrant(chosen);
  if(!authority)return failed('PERMISSION',`Sem concessão de recuperação para ${chosen.writer.id} na época ${chosen.epoch}: continue em fork pessoal ou pare a integração`);
  if(!authority.actions.includes('host'))return failed('PERMISSION','A concessão de recuperação não inclui hospedar esta ramificação');
  const rival=candidates.find((candidate,index)=>index!==decision.candidateIndex&&candidate.epoch===chosen.epoch&&(candidate.head.commit.hash!==chosen.head.commit.hash||!samePrincipal(candidate.writer,chosen.writer)));
  if(rival)return failed('CONFLICT',`Duas concessões concorrentes para a época ${chosen.epoch}: pare a integração e apresente as ramificações`);
 }
 // Going back past a version this device confirmed is allowed only as an explicit decision, and the version that was
 // confirmed stays in the plan as evidence.
 const regressed=candidates.some(candidate=>candidate.confirmed&&(candidate.head.generation>chosen.head.generation||(candidate.head.generation===chosen.head.generation&&candidate.head.commit.hash!==chosen.head.commit.hash)));
 if(regressed&&decision.acknowledgeRegression!==true)return failed('CONFLICT','A cópia escolhida é anterior a um head já confirmado neste dispositivo; recuperar assim exige decisão explícita');
 const authority:BranchAuthority=decision.kind==='continue'?{kind:'epoch',epoch:chosen.epoch,writer:chosen.writer}:{kind:'local',reason:decision.reason};
 return ok({kind:'recovery',head:chosen.head,epoch:chosen.epoch,mode:decision.kind,authority,regressed,evidence:[...candidates],missing:[...(chosen.missing??[])],reason:decision.reason});
}
