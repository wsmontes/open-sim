// Recorded external inputs (spec §3.5) and the provenance of an external dataset that is not a captured chunk (§3.3).
// Pure: the caller declares the clock, the timeline and the policy, so the same recorded bytes and the same
// declarations produce the same input in any client and a run replays with no service consulted.
//
// Protocol §13 decides the shape of the time here. `time` is when this client wrote the record, `observedTime` is when
// it learned the fact, and `validTime` is claimed only because the source named the instant: the download date is
// never passed off as the date of a fact, and a source that named a period keeps a period.
import type {Command,CommandResult,GameState} from '../core/model';
import {applyCommand} from '../core/commands';
import {assertJsonSafe,canonicalJson,isEntityId} from '../core/protocol';
import type {CaptureTimes,DatasetRevision,SourceIdentity,SourceMethod,SourceTerms,TransformationRef} from './reality';
import type {DatasetTerm,JsonValue,ObjectRef,WorldError,WorldResult} from './model';
import {failed,ok} from './model';
import type {OsimEnvelope,OsimTimeRef} from './osim';
import {entityUri,envelopeOf,osimTimeFrom,parseOsimUri} from './osim';

// The namespace the protocol itself names for a weather service (protocol §41).
export const OBSERVATION_KEY='weather.conditions';
// The actor an input is recorded under: not a player, because attributing a replay to a person would claim they did
// something they did not do.
const EXTERNAL_ACTOR='external-input';
const INSTANT=/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

// --- times (spec §3.5, protocol §13) ----------------------------------------------------------------------------
// The same rule a capture applies (`src/world/reality.ts`): an instant this client cannot re-read is not a time
// anybody recorded, a period and a single instant are not two answers to one question, and an unknown time stays
// absent instead of being filled with the instant the bytes arrived.
function instant(value:unknown,label:string):WorldResult<string>{
 return typeof value==='string'&&INSTANT.test(value)&&!Number.isNaN(Date.parse(value))?ok(value):failed('MALFORMED',`${label} não é um instante ISO-8601: ${String(value)}`);
}
export function externalTimes(times:CaptureTimes):WorldResult<CaptureTimes>{
 const retrieved=instant(times.retrievedAt,'Momento de retirada');
 if(!retrieved.ok)return retrieved;
 const checked:CaptureTimes={retrievedAt:times.retrievedAt};
 if(times.observedAt!==undefined){
  const observed=instant(times.observedAt,'Momento de observação');
  if(!observed.ok)return observed;
  checked.observedAt=times.observedAt;
 }
 if(times.publishedAt!==undefined){
  const published=instant(times.publishedAt,'Momento de publicação');
  if(!published.ok)return published;
  checked.publishedAt=times.publishedAt;
 }
 if(times.interval){
  if(times.observedAt!==undefined)return failed('MALFORMED','Um período representado não é afirmado junto de um instante observado');
  const from=instant(times.interval.from,'Início do período representado'),to=instant(times.interval.to,'Fim do período representado');
  if(!from.ok)return from;
  if(!to.ok)return to;
  if(Date.parse(times.interval.from)>Date.parse(times.interval.to))return failed('MALFORMED','O período representado termina antes de começar');
  checked.interval={from:times.interval.from,to:times.interval.to};
 }
 return ok(checked);
}

// --- external identifiers --------------------------------------------------------------------------------------
// An external identifier is not a local address: `stop:42` is not storable, and two providers may each call a stop
// `1`. A character outside `[A-Za-z0-9]` becomes `_<code point>_` and the fields are separated by `-`, which the
// escape never produces, so two clients derive the same entity id, the provider's own id stays where a reader can see
// it (the claim and the component), and nothing is invented for it.
export type ExternalKind='stop'|'route'|'observation';
function escape(value:string):string{
 let out='';
 for(const character of value)out+=/[A-Za-z0-9]/.test(character)?character:`_${character.codePointAt(0)!.toString(16)}_`;
 return out;
}
export function externalEntityId(kind:ExternalKind,sourceId:string,providerId:string):WorldResult<string>{
 if(typeof providerId!=='string'||!providerId.length)return failed('MALFORMED',`Identificador externo de ${kind} ausente`);
 const id=`${escape(kind)}-${escape(sourceId)}-${escape(providerId)}`;
 // A longer address would have to be truncated, and a truncated address is not the same address twice.
 if(!isEntityId(id))return failed('LIMIT',`O identificador ${providerId} não cabe num endereço local (${id.length} caracteres)`);
 return ok(id);
}

// --- provenance of a dataset that is not a chunk ---------------------------------------------------------------
// `DatasetRevision` (spec §3.3) describes a captured tile: a chunk id, a level and a zoom. A feed has none of those,
// and filling them in would put a false record in the durable history, so the shared fields are reused and the two
// that a feed really answers are declared instead: the rectangle of the positions it declares and the files it was
// read from. A field the provider never stated stays absent.
export type FeedCoverage={kind:'declared-positions';crs:'EPSG:4326';unit:'degree';positions:number;bounds:{west:number;south:number;east:number;north:number}};
export type DatasetProvenance=Omit<DatasetRevision,'coverage'|'capture'> & {
 coverage:FeedCoverage;
 format:{name:string;files:readonly string[];declaredVersion?:string};
};
export type ProvenanceRequest={
 source:SourceIdentity;
 times:CaptureTimes;
 terms:SourceTerms;
 transformation:TransformationRef;
 entity:ObjectRef;
 coverage:FeedCoverage;
 format:{name:string;files:readonly string[];declaredVersion?:string};
 previous?:readonly ObjectRef[];
 extensions?:Record<string,JsonValue>;
};
export function datasetProvenance(request:ProvenanceRequest):WorldResult<DatasetProvenance>{
 const times=externalTimes(request.times);
 if(!times.ok)return times;
 const provenance:DatasetProvenance={
  source:{...request.source},
  times:times.value,
  coverage:{...request.coverage,bounds:{...request.coverage.bounds}},
  terms:{...request.terms},
  transformation:{...request.transformation},
  entity:request.entity,
  previous:[...(request.previous??[])],
  extensions:{...(request.extensions??{})},
  format:{...request.format,files:[...request.format.files]},
 };
 try{
  assertJsonSafe(provenance,'Proveniência do conjunto');
 }catch(error){
  return failed('MALFORMED',error instanceof Error?error.message:'Proveniência inválida');
 }
 return ok(provenance);
}
// What a bundle carries next to the bytes it describes: the terms travel with the dataset, and a source that declared
// no redistribution licence says so by leaving the licence out (spec §3.6).
export function provenanceTerms(provenance:DatasetProvenance):DatasetTerm{
 const term:DatasetTerm={source:provenance.source.dataset};
 if(provenance.terms.attribution!==undefined)term.attribution=provenance.terms.attribution;
 if(provenance.terms.license!==undefined)term.license=provenance.terms.license;
 return term;
}

// --- what a source stated, and what the profile does with it ---------------------------------------------------
export type ObservedKind='observed'|'forecast';
// Exactly as the source or a recorded file stated it: a declared unit, the times the data is about, and the payload
// as it arrived. Nothing is derived here, and the difference between a measurement and a forecast is a declared field
// instead of an assumption (spec §3.2).
export type RawObservation={
 id:string;
 source:SourceIdentity;
 times:CaptureTimes;
 kind:ObservedKind;
 unit:string;
 values:JsonValue|null;
 supersedes?:string;
};
export type AbsenceMode='pause'|'hold'|'scenario';
// The profile's fixed, versioned answer to a source that reported nothing (spec §3.5): hold the last value — and for
// how many ticks — pause the dependency, or use a value that is explicitly a scenario. Changing this policy or the
// normalizer requires a new revision, which is why the version travels with every input.
export type ObservationPolicy={
 version:number;
 timeline:string;
 effectTick:number;
 units:readonly string[];
 missing:AbsenceMode;
 holdTicks?:number;
 scenario?:JsonValue;
};
export type ExternalInput={
 id:string;
 providerId:string;
 source:SourceIdentity;
 kind:ObservedKind;
 method?:SourceMethod;
 time:OsimTimeRef;
 unit:string;
 payload:JsonValue|null;
 absence:{mode:AbsenceMode;policy:number;holdTicks?:number}|null;
 effectTick:number;
 policy:{version:number;missing:AbsenceMode};
 supersedes?:string;
};

function policyProblem(policy:ObservationPolicy):WorldError|null{
 if(!Number.isSafeInteger(policy.version)||policy.version<1)return {code:'MALFORMED',message:'A política de observação precisa de uma versão'};
 if(!Number.isSafeInteger(policy.effectTick)||policy.effectTick<0)return {code:'MALFORMED',message:'A política de observação precisa de um tick de efeito'};
 if(!Array.isArray(policy.units)||!policy.units.length||policy.units.some(unit=>typeof unit!=='string'||!unit.length))return {code:'MALFORMED',message:'A política de observação precisa declarar as unidades que entende'};
 if(!['pause','hold','scenario'].includes(policy.missing))return {code:'MALFORMED',message:`Política de ausência desconhecida: ${String(policy.missing)}`};
 if(policy.missing==='hold'&&(!Number.isSafeInteger(policy.holdTicks)||(policy.holdTicks??0)<0))return {code:'MALFORMED',message:'Manter o último valor precisa dizer por quantos ticks'};
 if(policy.missing==='scenario'&&policy.scenario===undefined)return {code:'MALFORMED',message:'A política de cenário precisa declarar o valor de cenário'};
 try{
  const parsed=parseOsimUri(policy.timeline);
  if(parsed.scheme==='osim'&&parsed.kind!=='timeline')return {code:'MALFORMED',message:'A linha do tempo da observação precisa ser osim:timeline:…'};
 }catch{
  return {code:'MALFORMED',message:'A linha do tempo da observação precisa ser um identificador com esquema'};
 }
 return null;
}
// A scenario value is fiction and travels as fiction (R2): the method is the declared origin of the payload, so what
// this client made up is never read back as a measurement.
function missingValue(policy:ObservationPolicy):{payload:JsonValue|null;absence:ExternalInput['absence'];method?:SourceMethod}{
 if(policy.missing!=='scenario')return {payload:null,absence:policy.missing==='hold'?{mode:'hold',policy:policy.version,holdTicks:policy.holdTicks!}:{mode:'pause',policy:policy.version}};
 return {payload:policy.scenario!,absence:{mode:'scenario',policy:policy.version},method:'simulated'};
}
export function normalizeObservation(input:RawObservation,policy:ObservationPolicy):WorldResult<ExternalInput>{
 const policyFault=policyProblem(policy);
 if(policyFault)return failed(policyFault.code,policyFault.message);
 if(typeof input.id!=='string'||!input.id.length)return failed('MALFORMED','Observação sem identificador do fornecedor');
 if(input.kind!=='observed'&&input.kind!=='forecast')return failed('MALFORMED',`A observação ${input.id} não é observação nem previsão: ${String(input.kind)}`);
 if(typeof input.unit!=='string'||!policy.units.includes(input.unit))return failed('MALFORMED',`Unidade não declarada pela política: ${String(input.unit)} (a política entende ${policy.units.join(', ')})`);
 const times=externalTimes(input.times);
 if(!times.ok)return times;
 const id=externalEntityId('observation',input.source.id,input.id);
 if(!id.ok)return id;
 const missing=input.values===null||input.values===undefined?missingValue(policy):null;
 const supersedes=input.supersedes===undefined?null:externalEntityId('observation',input.source.id,input.supersedes);
 if(supersedes&&!supersedes.ok)return supersedes;
 const external:ExternalInput={
  id:id.value,
  providerId:input.id,
  source:{...input.source},
  kind:input.kind,
  time:osimTimeFrom(policy.timeline,times.value),
  unit:input.unit,
  payload:missing?missing.payload:input.values,
  absence:missing?missing.absence:null,
  method:missing?missing.method:input.kind==='observed'?'reported':'derived',
  effectTick:policy.effectTick,
  policy:{version:policy.version,missing:policy.missing},
 };
 if(supersedes)external.supersedes=supersedes.value;
 try{
  assertJsonSafe(observationComponent(external),`Observação ${input.id}`);
 }catch(error){
  return failed('MALFORMED',error instanceof Error?error.message:`Observação ${input.id} inválida`);
 }
 return ok(external);
}
// The component value a profile reads: the declared source and revision, what kind of statement it is, the unit, the
// payload, the time coordinates of §13, the tick it takes effect at, and the absence policy that was in force.
export function observationComponent(input:ExternalInput):JsonValue{
 const value:Record<string,JsonValue>={
  providerId:input.providerId,
  source:{...input.source} as unknown as JsonValue,
  kind:input.kind,
  unit:input.unit,
  payload:input.payload,
  time:input.time as unknown as JsonValue,
  effectTick:input.effectTick,
  policy:{version:input.policy.version,missing:input.policy.missing},
  absence:input.absence?{...input.absence}:null,
 };
 if(input.method!==undefined)value.method=input.method;
 if(input.supersedes!==undefined)value.supersedes=input.supersedes;
 return value;
}
// The protocol object for a recorded input: an entity whose component is the observation. Publishing it is the
// caller's decision (`kernel.publish`), and the time coordinates travel inside the component instead of in an envelope
// field the protocol does not define.
export function observationEntity(input:ExternalInput,actor:string):WorldResult<OsimEnvelope>{
 if(!isEntityId(input.id))return failed('MALFORMED',`Identificador da observação inválido: ${String(input.id)}`);
 try{
  return ok(envelopeOf('entity',entityUri(input.id),actor,{components:{[OBSERVATION_KEY]:observationComponent(input)}} as unknown as JsonValue));
 }catch(error){
  return failed('MALFORMED',error instanceof Error?error.message:'Envelope inválido');
 }
}
// Recording an input is not an effect. The city profile has no versioned rule that consumes a weather condition, so
// this writes the observation as a component — through the very command a profile would use — and moves nothing else:
// no money, no tick, no rule. When such a rule exists, its effect is that rule's own command, never an inference here.
export function applyExternalInput(state:GameState,input:ExternalInput):CommandResult{
 const reject=(reason:string):CommandResult=>({state,status:'rejected',reason});
 if(!isEntityId(input.id))return reject('Entrada externa sem identificador local');
 if(!Number.isSafeInteger(input.effectTick)||input.effectTick<0)return reject('A entrada externa não diz em que tick vale');
 if(input.payload===null&&input.absence===null)return reject(`A entrada ${input.id} não traz valor nem política de ausência`);
 const recorded=observationComponent(input);
 try{
  assertJsonSafe(recorded,`Entrada ${input.id}`);
 }catch(error){
  return reject(error instanceof Error?error.message:`Entrada ${input.id} inválida`);
 }
 const held=state.components[OBSERVATION_KEY]?.[input.id];
 if(held!==undefined&&canonicalJson(held)===canonicalJson(recorded))return {state,status:'duplicate'};
 if(held!==undefined)return reject(`A entrada ${input.id} já foi registrada com outro conteúdo; uma revisão é uma entrada nova`);
 if(input.effectTick<state.tick)return reject(`A entrada ${input.id} vale para o tick ${input.effectTick} e a partida já está no tick ${state.tick}: um tick simulado não é reescrito`);
 const command:Command={version:1,worldId:state.worldId,actorId:EXTERNAL_ACTOR,sequence:(state.actors[EXTERNAL_ACTOR]??0)+1,expectedRevision:state.revision,action:{type:'component',key:OBSERVATION_KEY,entity:input.id,value:recorded}};
 return applyCommand(state,command,[]);
}
