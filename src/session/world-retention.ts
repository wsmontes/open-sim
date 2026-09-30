import {failed,isRef,ok} from '../world/model';
import type {JsonValue,ObjectRef,WorldResult} from '../world/model';
import {decodeUtf8,parseStrictJson} from '../world/codec';
import {parseChangeSet} from '../world/changes';
import type {ChangeReceipt,WorldStorage} from './world-ports';

// Retention and resumption over the objects a device already holds (spec §5.5). A pass keeps heads, bases, pending
// proposals and pinned checkpoints, and collects only what no retained reference reaches. Two properties are
// structural rather than promised:
//   * the collector never works from a guess — an inventory that cannot prove what is unreachable suspends the
//     collection instead of freeing space by deleting history, and an object whose edges this client cannot read
//     suspends it while that object is reachable;
//   * a device under quota is answered with exporting or branching, never with a reachable object deleted to make
//     room, because a browser subject to quota is exactly where silent history loss would be easiest to hide.
//
// The repository is not changed to support this: the inventory reads through the storage port the repository already
// uses, and the two things that port does not offer — listing every held address and removing the collected ones — are
// declared here as narrow ports, so whoever owns the device satisfies them without this layer knowing how it stores.
export type RetainedRootKind='branch-head'|'base'|'proposal'|'checkpoint';
export type RetainedRoot={kind:RetainedRootKind;ref:ObjectRef;label?:string};
// What one held object is, and which addresses it needs. `references` is null when this client cannot read the edges
// of that kind: a foreign layer or a component of another profile reaches objects this pass cannot enumerate.
export type InventoryObject={ref:ObjectRef;references:readonly ObjectRef[]|null};
export type ObjectInventory={objects:readonly InventoryObject[];missing:readonly ObjectRef[]};
export type RetentionPressure={over:boolean;shortage:number};
export type RetentionPlan={
 keep:ObjectRef[];
 collect:ObjectRef[];
 missing:ObjectRef[];
 reclaimed:number;
 incomplete:boolean;
 pressure:RetentionPressure|null;
 notes:string[];
};
export type RetentionOptions={capacity?:number;used?:number};
// The device side of a collection: the collector announces addresses and the device removes them, answering which ones
// it actually removed. Nothing here reads bytes; a device that removes nothing is a device that answered nothing.
export type ObjectSink={remove(refs:readonly ObjectRef[]):Promise<WorldResult<readonly ObjectRef[]>>};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const LEAF_KINDS:readonly string[]=['city-state','base-chunk'];
const refOf=(value:JsonValue|undefined):ObjectRef|null=>isRef(value)?{hash:value.hash,bytes:value.bytes}:null;
function refsOf(value:JsonValue|undefined):ObjectRef[]|null {
 if(!Array.isArray(value))return null;
 const refs:ObjectRef[]=[];
 for(const entry of value){const ref=refOf(entry);if(!ref)return null;refs.push(ref);}
 return refs;
}
// The object kinds this client stores, and the addresses each one needs. Anything else is opaque on purpose: a wrong
// guess here would let the collector drop bytes that only a kind it does not know still reaches.
function referencesOf(value:JsonValue):ObjectRef[]|null {
 if(!record(value))return null;
 const kind=value['kind'];
 if(typeof kind!=='string'){
  // A frozen change set is the one object this contract carries without a `kind`: a proposal has to be nameable by
  // another world, and the regions it uses are the addresses it must keep.
  const proposal=parseChangeSet(value);
  return proposal.ok?proposal.value.bases.map(object=>object.ref):null;
 }
 if(LEAF_KINDS.includes(kind))return [];
 if(kind==='world-tree'){
  const state=refOf(value['state']),attached=refsOf(value['attached']);
  return state&&attached?[state,...attached]:null;
 }
 if(kind==='world-commit'){
  const tree=refOf(value['tree']),parents=refsOf(value['parents']),datasets=refsOf(value['datasets']);
  return tree&&parents&&datasets?[tree,...parents,...datasets]:null;
 }
 if(kind==='capture'){
  const revision=value['revision'];
  if(!record(revision))return null;
  const entity=refOf(revision['entity']);
  const previous=revision['previous']===undefined?[]:refsOf(revision['previous']);
  return entity&&previous?[entity,...previous]:null;
 }
 return null;
}
function pressureOf(options:RetentionOptions,reclaimed:number):RetentionPressure|null {
 if(options.capacity===undefined||options.used===undefined)return null;
 const leftover=options.used-reclaimed-options.capacity;
 return leftover>0?{over:true,shortage:leftover}:{over:false,shortage:0};
}
export function planRetention(roots:readonly RetainedRoot[],inventory:ObjectInventory,options:RetentionOptions={}):RetentionPlan {
 const held=new Map<string,InventoryObject>();
 for(const entry of inventory.objects)if(!held.has(entry.ref.hash))held.set(entry.ref.hash,entry);
 const keep:ObjectRef[]=[],keepHashes=new Set<string>(),missing:ObjectRef[]=[],missingHashes=new Set<string>(),opaque:ObjectRef[]=[];
 const notes:string[]=[],noted=new Set<string>();
 const rememberMissing=(ref:ObjectRef)=>{
  if(missingHashes.has(ref.hash))return;
  missingHashes.add(ref.hash);
  missing.push(ref);
 };
 for(const ref of inventory.missing)rememberMissing(ref);
 // The walk follows what a retained reference needs, not what points at it: a head needs its commit, which needs its
 // tree and first parent. So a successor that was abandoned does not keep its ancestors alive, which is exactly what
 // makes an abandoned branch collectable while everything it inherited from a retained version stays.
 const queue:RetainedRoot[]=roots.map(root=>({...root}));
 while(queue.length){
  const root=queue.shift()!;
  if(keepHashes.has(root.ref.hash))continue;
  const entry=held.get(root.ref.hash);
  if(!entry){
   rememberMissing(root.ref);
   const label=root.label??root.kind;
   if(!noted.has(label)){noted.add(label);notes.push(`${label}: a referência retida não está neste dispositivo; peça outra cópia antes de coletar.`);}
   continue;
  }
  keepHashes.add(entry.ref.hash);
  keep.push(entry.ref);
  if(entry.references===null){opaque.push(entry.ref);continue;}
  for(const next of entry.references)queue.push({kind:root.kind,ref:next});
 }
 for(const ref of opaque)notes.push(`Objeto de tipo desconhecido ${ref.hash.slice(0,12)}… é alcançável: a coleta fica suspensa até esta versão saber que objetos ele carrega.`);
 const incomplete=missing.length>0||opaque.length>0;
 const collect=incomplete?[]:inventory.objects.filter(entry=>!keepHashes.has(entry.ref.hash)).map(entry=>entry.ref);
 const reclaimed=collect.reduce((sum,ref)=>sum+ref.bytes,0);
 if(incomplete)notes.push('Nada foi coletado: o inventário não prova quais objetos são inalcançáveis.');
 else if(collect.length)notes.push(`${collect.length} objeto(s) fora de qualquer versão retida podem ser coletados; exporte antes se quiser guardá-los.`);
 else notes.push('Tudo o que este dispositivo guarda é alcançável pelas versões retidas.');
 const pressure=pressureOf(options,reclaimed);
 if(pressure)notes.push(pressure.over
  ?`Mesmo depois de coletar, este dispositivo fica ${pressure.shortage} bytes acima da quota: exporte ou crie uma versão regional, sem apagar histórico alcançável.`
  :`A coleta libera os ${reclaimed} bytes que faltavam.`);
 return {keep,collect,missing,reclaimed,incomplete,pressure,notes};
}
// Reading the inventory through the storage port the repository already uses. The caller supplies the addresses the
// device holds — the port has no listing of its own — and everything they point at is read back and decoded so the
// graph is known before a single byte is proposed for removal.
export async function readInventory(storage:WorldStorage,refs:readonly ObjectRef[]):Promise<WorldResult<ObjectInventory>> {
 const objects:InventoryObject[]=[],missing:ObjectRef[]=[],seen=new Set<string>();
 for(const ref of refs){
  if(seen.has(ref.hash))continue;
  seen.add(ref.hash);
  const bytes=await storage.object(ref);
  if(!bytes){missing.push(ref);continue;}
  const text=decodeUtf8(bytes);
  if(!text.ok)return text;
  const parsed=parseStrictJson(text.value);
  if(!parsed.ok)return parsed;
  // The bytes are kept exactly as the device handed them; their address is verified by the repository when a version
  // is opened, which is where a wrong address has to be refused.
  objects.push({ref,references:referencesOf(parsed.value)});
 }
 return ok({objects,missing});
}
// Performing the collection the plan proposed, and only that: an incomplete inventory reaches no device at all, and a
// plan with nothing to collect asks nothing.
export async function collectRetention(plan:RetentionPlan,sink:ObjectSink):Promise<WorldResult<readonly ObjectRef[]>> {
 if(plan.incomplete)return failed('MISSING_OBJECT','A retenção não remove nada enquanto o inventário estiver incompleto: peça as cópias que faltam');
 if(!plan.collect.length)return ok([]);
 return sink.remove(plan.collect);
}
// Receipts are the only thing that lets a repeated delivery answer with the result it already produced, so compacting
// them is not free. The window is measured in the generation each receipt advanced to, the newest receipt is never
// dropped — a window with nothing to answer from would refuse every delivery — and the mark tells a later attempt that
// a compacted id can no longer be answered from memory: it asks for reconciliation instead of being applied as new.
export type ReceiptWindow={floor:number;note:string};
export type ReceiptCompaction={kept:ChangeReceipt[];compacted:ChangeReceipt[];mark:ReceiptWindow|null};
export function planReceiptCompaction(receipts:readonly ChangeReceipt[],keep:number):ReceiptCompaction {
 const window=Math.max(1,Math.floor(keep));
 const ordered=[...receipts].sort((a,b)=>a.head.generation-b.head.generation);
 const kept=ordered.slice(Math.max(0,ordered.length-window)),compacted=ordered.slice(0,Math.max(0,ordered.length-window));
 if(!compacted.length)return {kept,compacted:[],mark:null};
 const floor=kept[0]!.head.generation;
 return {kept,compacted,mark:{floor,note:`Um reenvio com cabeça anterior à geração ${floor} não encontra mais recibo: reconcilie com o histórico em vez de aplicar a mudança de novo.`}};
}
export function needsReconciliation(id:string,observedGeneration:number,retained:readonly ChangeReceipt[],mark:ReceiptWindow|null):boolean {
 if(retained.some(receipt=>receipt.id===id))return false;
 // Conservative on purpose: an unknown delivery older than the retained window may already have been accepted, and
 // asking for reconciliation costs a comparison while re-applying it would charge the world twice.
 return mark!==null&&observedGeneration<mark.floor;
}
