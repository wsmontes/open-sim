// A recorded file of observations (spec §3.2: an input format is an adapter; §3.5: a run replays without consulting a
// service). The file declares its own provenance once, and every record keeps the unit and the times the source
// stated, so reading it needs no clock, no network and no interpretation.
//
// The envelope is this client's own format, so it is a closed registry: a top-level field this version does not
// define is refused instead of silently ignored. The payload of a record is the provider's data and stays open.
import {decodeUtf8,parseStrictJson} from '../../world/codec';
import {MAX_OBJECT_BYTES,failed,ok} from '../../world/model';
import type {JsonValue,WorldResult} from '../../world/model';
import type {CaptureTimes,SourceIdentity,SourceTerms} from '../../world/reality';
import type {ObservedKind,RawObservation} from '../../world/observations';
import {externalTimes} from '../../world/observations';

export const OBSERVATION_FILE_FORMAT='opensim-observations-v1';
export type RecordedObservations={source:SourceIdentity;terms?:SourceTerms;observations:readonly RawObservation[]};

const ENVELOPE=['format','source','terms','observations'],RECORD=['id','kind','unit','times','values','supersedes'];
const TERM_FIELDS=['attribution','license','url'],SOURCE_FIELDS=['id','dataset','url','providerRevision'];
const TIME_FIELDS=['retrievedAt','observedAt','publishedAt','interval'];

function plain(value:unknown):value is Record<string,unknown>{
 return !!value&&typeof value==='object'&&!Array.isArray(value);
}
function text(value:unknown,label:string):WorldResult<string>{
 return typeof value==='string'&&value.length?ok(value):failed('MALFORMED',`${label} ausente no arquivo de observações`);
}
function fields(value:Record<string,unknown>,known:readonly string[],label:string):WorldResult<null>{
 const unknown=Object.keys(value).filter(key=>!known.includes(key));
 return unknown.length?failed('MALFORMED',`${label} traz um campo que este formato não define: ${unknown[0]}`):ok(null);
}
function sourceOf(value:unknown):WorldResult<SourceIdentity>{
 if(!plain(value))return failed('MALFORMED','O arquivo de observações não declara a fonte');
 const shape=fields(value,SOURCE_FIELDS,'A fonte do arquivo de observações');
 if(!shape.ok)return shape;
 const id=text(value['id'],'Identificador da fonte'),dataset=text(value['dataset'],'Conjunto da fonte'),url=text(value['url'],'Endereço da fonte');
 if(!id.ok)return id;
 if(!dataset.ok)return dataset;
 if(!url.ok)return url;
 const source:SourceIdentity={id:id.value,dataset:dataset.value,url:url.value};
 // A revision nobody published is not invented for the file (spec §3.3).
 if(value['providerRevision']!==undefined){
  const revision=text(value['providerRevision'],'A revisão do fornecedor');
  if(!revision.ok)return revision;
  source.providerRevision=revision.value;
 }
 return ok(source);
}
function termsOf(value:unknown):WorldResult<SourceTerms|undefined>{
 if(value===undefined)return ok(undefined);
 if(!plain(value))return failed('MALFORMED','Os termos do arquivo de observações são inválidos');
 const shape=fields(value,TERM_FIELDS,'Os termos do arquivo de observações');
 if(!shape.ok)return shape;
 const terms:SourceTerms={};
 for(const field of TERM_FIELDS){
  if(value[field]===undefined)continue;
  const declared=text(value[field],`Termo ${field}`);
  if(!declared.ok)return declared;
  if(field==='attribution')terms.attribution=declared.value;
  else if(field==='license')terms.license=declared.value;
  else terms.url=declared.value;
 }
 return ok(terms);
}
function timesOf(value:unknown,label:string):WorldResult<CaptureTimes>{
 if(!plain(value))return failed('MALFORMED',`${label} não declara os tempos da observação`);
 const shape=fields(value,TIME_FIELDS,label);
 if(!shape.ok)return shape;
 const retrieved=text(value['retrievedAt'],`${label}: o momento de retirada`);
 if(!retrieved.ok)return retrieved;
 const times:CaptureTimes={retrievedAt:retrieved.value};
 if(value['observedAt']!==undefined){
  const observed=text(value['observedAt'],`${label}: o momento observado`);
  if(!observed.ok)return observed;
  times.observedAt=observed.value;
 }
 if(value['publishedAt']!==undefined){
  const published=text(value['publishedAt'],`${label}: o momento de publicação`);
  if(!published.ok)return published;
  times.publishedAt=published.value;
 }
 if(value['interval']!==undefined){
  if(!plain(value['interval']))return failed('MALFORMED',`${label} traz um período inválido`);
  const period=fields(value['interval'],['from','to'],`${label} (período)`);
  if(!period.ok)return period;
  const from=text(value['interval']['from'],`${label}: o início do período`),to=text(value['interval']['to'],`${label}: o fim do período`);
  if(!from.ok)return from;
  if(!to.ok)return to;
  times.interval={from:from.value,to:to.value};
 }
 // The rule lives in the world contract: a record whose instant cannot be re-read is refused here instead of being
 // carried into a run as a guess.
 return externalTimes(times);
}
function recordOf(value:unknown,source:SourceIdentity,index:number):WorldResult<RawObservation>{
 const label=`A observação ${index+1}`;
 if(!plain(value))return failed('MALFORMED',`${label} não é um registro`);
 const shape=fields(value,RECORD,label);
 if(!shape.ok)return shape;
 const id=text(value['id'],`${label} sem identificador`);
 if(!id.ok)return id;
 const unit=text(value['unit'],`${label} sem unidade`);
 if(!unit.ok)return unit;
 const kind=value['kind'];
 if(kind!=='observed'&&kind!=='forecast')return failed('MALFORMED',`${label} não é observação nem previsão: ${String(kind)}`);
 const times=timesOf(value['times'],label);
 if(!times.ok)return times;
 // A record that declares no value and one that declares `null` say the same thing: the source reported nothing, and
 // the policy is what answers for it (spec §3.5). Strict JSON already guarantees the payload is a JSON value.
 const values=value['values']===undefined?null:(value['values'] as JsonValue);
 const record:RawObservation={id:id.value,source:{...source},times:times.value,kind:kind as ObservedKind,unit:unit.value,values};
 if(value['supersedes']!==undefined){
  const supersedes=text(value['supersedes'],`${label}: a observação substituída`);
  if(!supersedes.ok)return supersedes;
  record.supersedes=supersedes.value;
 }
 return ok(record);
}
export function readObservationFile(bytes:Uint8Array):WorldResult<RecordedObservations>{
 // The same ceiling a world object has, checked before the text is even decoded: a recorded file that large is not an
 // observation file, and nothing is allocated for it.
 if(bytes.byteLength>MAX_OBJECT_BYTES)return failed('LIMIT',`O arquivo de observações tem ${bytes.byteLength} bytes, acima do limite de ${MAX_OBJECT_BYTES}`);
 const text=decodeUtf8(bytes);
 if(!text.ok)return text;
 const parsed=parseStrictJson(text.value);
 if(!parsed.ok)return parsed;
 if(!plain(parsed.value))return failed('MALFORMED','O arquivo de observações não é um objeto');
 const shape=fields(parsed.value,ENVELOPE,'O arquivo de observações');
 if(!shape.ok)return shape;
 if(parsed.value['format']!==OBSERVATION_FILE_FORMAT)return failed('MALFORMED',`Formato de arquivo desconhecido: ${String(parsed.value['format'])}`);
 const source=sourceOf(parsed.value['source']);
 if(!source.ok)return source;
 const terms=termsOf(parsed.value['terms']);
 if(!terms.ok)return terms;
 const declared=parsed.value['observations'];
 if(!Array.isArray(declared))return failed('MALFORMED','O arquivo de observações não traz uma lista de observações');
 const observations:RawObservation[]=[];
 const seen=new Set<string>();
 for(const entry of declared){
  const record=recordOf(entry,source.value,observations.length);
  if(!record.ok)return record;
  if(seen.has(record.value.id))return failed('MALFORMED',`A observação ${record.value.id} aparece duas vezes no arquivo`);
  seen.add(record.value.id);
  observations.push(record.value);
 }
 const recorded:RecordedObservations={source:source.value,observations};
 if(terms.value)recorded.terms=terms.value;
 return ok(recorded);
}
