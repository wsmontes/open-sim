import type {GameState} from '../core/model';
import type {ContentHasher,WorldCodec} from '../world/ports';
import type {DatasetTerm,Head,JsonValue,ObjectRef,WorldAddress,WorldBundle,WorldDefinition,WorldObject,WorldResult} from '../world/model';
import {MAX_OBJECT_BYTES,WIRE_VERSION,WORLD_PROTOCOL,failed,isRef,ok,sameRef} from '../world/model';
import {decodeUtf8,parseStrictJson,verifyBundle} from '../world/codec';
import {PROJECT_ACTOR} from '../world/changes';
import type {PreparedChange} from '../world/changes';
import {integrateProject} from '../world/city-profile';
import {sameHead} from './world-ports';
import type {ChangeReceipt,StoredObject,WorldStorage} from './world-ports';
import {isRecord} from '../core/guards';
// A world keeps its history the way the spec asks: immutable objects addressed by content, trees and commits that
// only reference them, and a branch reference that moves forward by comparing the head it expected with the one the
// device still has. The repository owns no bytes of its own — every read and every write goes through the storage
// port — so a branch or a fork that changes nothing inherits references instead of duplicating content.
//
// What a version is made of (spec §5.1):
//   `world-tree`   — identity of this branch (definition, origin, terms), the snapshot, the objects it depends on
//   `world-commit` — parents, the tree it produced, its generation, rules, data references and accepted operations
//   `city-state`   — the durable game state, never the camera
//   `base-chunk`   — a frozen region a checkpoint rests on, addressed so two worlds can share it
// The first parent is the line of application, and `generation` counts commits along it.
export type WorldTree = {kind:'world-tree';definition:WorldDefinition;terms:DatasetTerm[];state:ObjectRef;attached:ObjectRef[]};
export type WorldCommit = {kind:'world-commit';parents:ObjectRef[];tree:ObjectRef;generation:number;rules:{family:string;version:number};datasets:ObjectRef[];accepted:string[];author?:string};
// What a caller already validated and now wants recorded. `objects` travel with the change and stay reachable from
// the version it produced; `id` is the idempotency key of the delivery that produced it.
export type AcceptedChange = {id:string;state:GameState;operations:readonly string[];objects:readonly WorldObject[];author:string;datasets?:readonly ObjectRef[]};
export type BaseRef = {id:string;ref:ObjectRef};
export type Checkpoint = {
 head:Head;
 commit:WorldCommit;
 definition:WorldDefinition;
 terms:DatasetTerm[];
 tree:ObjectRef;
 stateRef:ObjectRef;
 state:GameState;
 bases:BaseRef[];
 receipts:string[];
 versions:{worldProtocol:number;wireVersion:number;rules:{family:string;version:number}};
};
export type WorldVersion = {head:Head;accepted:readonly string[]};
export type WorldRepository = {
 create(bundle:WorldBundle):Promise<WorldResult<Head>>;
 fork(head:Head,target:WorldAddress):Promise<WorldResult<Head>>;
 commit(expected:Head,change:AcceptedChange):Promise<WorldResult<Head>>;
 // A prepared change is committed against the version it was prepared against: a candidate based on an older head is
 // refused instead of landing on top of somebody else's work.
 commitPrepared(expected:Head,prepared:PreparedChange):Promise<WorldResult<Head>>;
 checkout(head:Head):Promise<WorldResult<Checkpoint>>;
 export(head:Head):Promise<WorldResult<WorldBundle>>;
 history(head:Head,limit?:number):Promise<WorldResult<WorldVersion[]>>;
 branches(worldId:string):Promise<WorldResult<Head[]>>;
};
export function createWorldRepository({storage,codec,hasher,memo=true}:{storage:WorldStorage;codec:WorldCodec;hasher:ContentHasher;memo?:boolean}):WorldRepository {
 // Objects come back from the device and from foreign packages through the same door, so a package is adopted
 // without a detour through bytes and a stored object is verified exactly like a received one.
 type Source = {read(ref:ObjectRef):Promise<WorldResult<JsonValue>>};
 type LoadedVersion = {commitRef:ObjectRef;commit:WorldCommit;commitValue:JsonValue;treeRef:ObjectRef;tree:WorldTree;treeValue:JsonValue;stateRef:ObjectRef;state:GameState};
 const refOf=(value:JsonValue|undefined):ObjectRef|null=>isRef(value)?{hash:value.hash,bytes:value.bytes}:null;
 const sameAddress=(a:WorldAddress,b:WorldAddress)=>a.worldId===b.worldId&&a.branchId===b.branchId;
 const known=(refs:readonly ObjectRef[]):ObjectRef[]=>{
  const seen=new Set<string>(),kept:ObjectRef[]=[];
  for(const ref of refs){if(seen.has(ref.hash))continue;seen.add(ref.hash);kept.push(ref);}
  return kept;
 };
 function refsOf(value:JsonValue|undefined):ObjectRef[]|null {
  if(!Array.isArray(value))return null;
  const found:ObjectRef[]=[];
  for(const entry of value){const ref=refOf(entry);if(!ref)return null;found.push(ref);}
  return found;
 }
 function textsOf(value:JsonValue|undefined):string[]|null {
  if(!Array.isArray(value)||!value.every(entry=>typeof entry==='string'))return null;
  return [...value] as string[];
 }
 // These objects are plain values inside a package, so the reader re-checks the fields it takes decisions on; the
 // codec owns the wire schema of envelopes, definitions and heads, not of what a version points at.
 function definitionOf(value:JsonValue):WorldDefinition|null {
  if(!isRecord(value))return null;
  const worldId=value['worldId'],branchId=value['branchId'],origin=value['origin'],profiles=value['profiles'],rules=value['rules'];
  if(typeof worldId!=='string'||!worldId||worldId.length>80||typeof branchId!=='string'||!branchId||branchId.length>80)return null;
  if(!isRecord(rules)||typeof rules['family']!=='string'||!rules['family']||!Number.isSafeInteger(rules['version'])||(rules['version'] as number)<1)return null;
  if(!isRecord(origin)||!['legacy-save','new','fork'].includes(String(origin['kind'])))return null;
  if(!Array.isArray(profiles)||profiles.some(profile=>typeof profile!=='string'||!profile))return null;
  const parsed:WorldDefinition={worldId,branchId,origin:{kind:origin['kind'] as WorldDefinition['origin']['kind']},profiles:[...profiles] as string[],rules:{family:rules['family'],version:rules['version'] as number}};
  if(typeof origin['note']==='string')parsed.origin.note=origin['note'];
  const parent=origin['parent'];
  if(parent!==undefined){
   if(!isRecord(parent)||typeof parent['worldId']!=='string'||!parent['worldId']||typeof parent['branchId']!=='string'||!parent['branchId'])return null;
   parsed.origin.parent={worldId:parent['worldId'],branchId:parent['branchId']};
  }
  return parsed;
 }
 function termsOf(value:JsonValue|undefined):DatasetTerm[]|null {
  if(!Array.isArray(value))return null;
  const terms:DatasetTerm[]=[];
  for(const entry of value){
   if(!isRecord(entry)||typeof entry['source']!=='string'||!entry['source'])return null;
   const term:DatasetTerm={source:entry['source']};
   if(entry['attribution']!==undefined){if(typeof entry['attribution']!=='string')return null;term.attribution=entry['attribution'];}
   if(entry['license']!==undefined){if(typeof entry['license']!=='string')return null;term.license=entry['license'];}
   terms.push(term);
  }
  return terms;
 }
 function treeOf(value:JsonValue):WorldResult<WorldTree> {
  if(!isRecord(value)||value['kind']!=='world-tree')return failed('MALFORMED','Árvore de mundo desconhecida');
  const definition=definitionOf(value['definition']);
  if(!definition)return failed('MALFORMED','Árvore sem definição de mundo');
  const state=refOf(value['state']),attached=refsOf(value['attached']),terms=termsOf(value['terms']);
  if(!state||!attached||!terms)return failed('MALFORMED','Árvore incompleta');
  return ok({kind:'world-tree',definition,terms,state,attached});
 }
 function commitOf(value:JsonValue):WorldResult<WorldCommit> {
  if(!isRecord(value)||value['kind']!=='world-commit')return failed('MALFORMED','Commit desconhecido');
  const parents=refsOf(value['parents']),tree=refOf(value['tree']),datasets=refsOf(value['datasets']),accepted=textsOf(value['accepted']),generation=value['generation'],rules=value['rules'];
  if(!parents||!tree||!datasets||!accepted)return failed('MALFORMED','Commit incompleto');
  if(!Number.isSafeInteger(generation)||(generation as number)<1)return failed('MALFORMED','Geração de commit inválida');
  if(!isRecord(rules)||typeof rules['family']!=='string'||!Number.isSafeInteger(rules['version']))return failed('MALFORMED','Commit sem regras');
  const commit:WorldCommit={kind:'world-commit',parents,tree,generation:generation as number,rules:{family:rules['family'],version:rules['version'] as number},datasets,accepted};
  if(value['author']!==undefined){if(typeof value['author']!=='string')return failed('MALFORMED','Autor inválido');commit.author=value['author'];}
  return ok(commit);
 }
 function stateOf(value:JsonValue):WorldResult<GameState> {
  if(!isRecord(value)||value['kind']!=='city-state'||!isRecord(value['state']))return failed('MALFORMED','Objeto de estado inválido');
  return ok(value['state'] as unknown as GameState);
 }
 // An object is addressed by its canonical bytes, and the core never mutates one: a frozen region keeps the same
 // object across versions and a caller may hand the same object back after a retry. The address is therefore
 // memoized by value identity, so a repeated encoding and SHA-256 happens once. `memo:false` recomputes every time,
 // which is the cache-free path the byte-identity test and the bench compare against; the bytes never differ.
 const addressed=new WeakMap<object,Promise<StoredObject>>();
 function objectOf(value:JsonValue):Promise<StoredObject>{
  const address=async():Promise<StoredObject>=>{
   const bytes=codec.encode(value);
   return {ref:await hasher.ref(bytes),bytes};
  };
  if(!memo||value===null||typeof value!=='object')return address();
  const container=value as object;
  const cached=addressed.get(container);
  if(cached)return cached;
  const pending=address().catch(error=>{addressed.delete(container);throw error;});
  addressed.set(container,pending);
  return pending;
 }
 async function stored(objects:readonly WorldObject[]):Promise<WorldResult<StoredObject[]>> {
  const kept:StoredObject[]=[];
  for(const object of objects){
   const addressedObject=await objectOf(object.value);
   if(!sameRef(addressedObject.ref,object.ref))return failed('HASH_MISMATCH',`Objeto ${object.ref.hash.slice(0,12)}… não corresponde ao conteúdo`);
   if(addressedObject.ref.bytes>MAX_OBJECT_BYTES)return failed('LIMIT',`Objeto de ${addressedObject.ref.bytes} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
   kept.push(addressedObject);
  }
  return ok(kept);
 }
 function staged(objects:readonly StoredObject[]):StoredObject[] {
  const seen=new Set<string>(),kept:StoredObject[]=[];
  for(const object of objects){if(seen.has(object.ref.hash))continue;seen.add(object.ref.hash);kept.push(object);}
  return kept;
 }
 const storageSource:Source={read:async ref=>{
  const bytes=await storage.object(ref);
  if(!bytes)return failed('NOT_FOUND',`Objeto ausente: ${ref.hash.slice(0,12)}…`);
  if(!sameRef(await hasher.ref(bytes),ref))return failed('HASH_MISMATCH',`Objeto ${ref.hash.slice(0,12)}… não corresponde ao conteúdo guardado`);
  const decoded=decodeUtf8(bytes);
  if(!decoded.ok)return decoded;
  return parseStrictJson(decoded.value);
 }};
 const packageSource=(bundle:WorldBundle):Source=>({read:async ref=>{
  const found=bundle.objects.find(object=>sameRef(object.ref,ref));
  return found?ok(found.value):failed('NOT_FOUND',`Objeto ausente: ${ref.hash.slice(0,12)}…`);
 }});
 const stateValues=new WeakMap<GameState,JsonValue>();
 const stateValue=(state:GameState):JsonValue=>{
  if(!memo)return {kind:'city-state',state:state as unknown as JsonValue};
  const cached=stateValues.get(state);
  if(cached)return cached;
  const value:JsonValue={kind:'city-state',state:state as unknown as JsonValue};
  stateValues.set(state,value);
  return value;
 };
 // The snapshot of a version is one object, as the plan allows for small worlds. The regions it froze are published
 // as content addresses anyway, so a fork in another world shares them by identity and a later partitioned tree can
 // store each one on its own without changing which bases a version rests on.
 async function baseRefs(state:GameState):Promise<BaseRef[]> {
  const bases:BaseRef[]=[];
  for(const id of Object.keys(state.chunks).sort())bases.push({id,ref:(await objectOf({kind:'base-chunk',base:state.chunks[id]!.base as unknown as JsonValue})).ref});
  return bases;
 }
 async function loadVersion(source:Source,head:Head):Promise<WorldResult<LoadedVersion>> {
  const commitRead=await source.read(head.commit);
  if(!commitRead.ok)return commitRead;
  const commit=commitOf(commitRead.value);
  if(!commit.ok)return commit;
  if(commit.value.generation!==head.generation)return failed('MALFORMED','Geração do commit não corresponde à cabeça');
  const treeRead=await source.read(commit.value.tree);
  if(!treeRead.ok)return treeRead;
  const tree=treeOf(treeRead.value);
  if(!tree.ok)return tree;
  if(!sameAddress(tree.value.definition,head))return failed('MALFORMED','A árvore pertence a outro mundo ou ramificação');
  const stateRead=await source.read(tree.value.state);
  if(!stateRead.ok)return stateRead;
  const state=stateOf(stateRead.value);
  if(!state.ok)return state;
  if(state.value.worldId!==head.worldId)return failed('MALFORMED','Estado de outro mundo nesta versão');
  // Base references are presentation/checkpoint metadata, not a prerequisite for applying a change. Hashing every
  // frozen region here made every commit pay O(number of managed chunks) before it could write one cell. Keep the
  // version loader about the immutable version graph; checkout materializes base refs only for callers that ask for
  // a checkpoint and therefore actually need them.
  return ok({commitRef:head.commit,commit:commit.value,commitValue:commitRead.value,treeRef:commit.value.tree,tree:tree.value,treeValue:treeRead.value,stateRef:tree.value.state,state:state.value});
 }
 function publish(expected:Head|null,next:Head,objects:StoredObject[],receipt:ChangeReceipt):Promise<WorldResult<Head>> {
  return storage.commit({expected,next,objects:staged(objects),receipt});
 }
 function addressValid(address:WorldAddress):boolean {
  return !!address.worldId&&address.worldId.length<=80&&!!address.branchId&&address.branchId.length<=80;
 }
 async function create(bundle:WorldBundle):Promise<WorldResult<Head>> {
  const verified=await verifyBundle(bundle,hasher,codec);
  if(!verified.ok)return verified;
  if(!bundle.completeness.complete)return failed('NOT_FOUND','Pacote parcial não abre sem os objetos que faltam');
  const address:WorldAddress={worldId:bundle.definition.worldId,branchId:bundle.definition.branchId};
  if(!addressValid(address))return failed('MALFORMED','Pacote com endereço de mundo inválido');
  let head:Head,objects:StoredObject[];
  if(bundle.head){
   // An exported copy carries its own history: what opens here is the version exported, not a new origin.
   const loaded=await loadVersion(packageSource(bundle),bundle.head);
   if(!loaded.ok)return loaded;
   head=bundle.head;
   const carried=await stored(bundle.objects);
   if(!carried.ok)return carried;
   objects=carried.value;
  }else{
   // A legacy save has no commit of its own; its snapshot becomes generation 1 and the origin says exactly that.
   const snapshots=bundle.objects.filter(object=>isRecord(object.value)&&object.value['kind']==='city-state');
   if(snapshots.length!==1)return failed('MALFORMED','Pacote precisa de exatamente um estado de mundo');
   const snapshot=snapshots[0]!,state=stateOf(snapshot.value);
   if(!state.ok)return state;
   if(state.value.worldId!==address.worldId)return failed('MALFORMED','Estado de outro mundo neste pacote');
   const tree:WorldTree={kind:'world-tree',definition:bundle.definition,terms:bundle.terms,state:snapshot.ref,attached:[]};
   const treeObject=await objectOf(tree as unknown as JsonValue);
   const commit:WorldCommit={kind:'world-commit',parents:[],tree:treeObject.ref,generation:1,rules:bundle.definition.rules,datasets:[],accepted:[]};
   const commitObject=await objectOf(commit as unknown as JsonValue);
   head={worldId:address.worldId,branchId:address.branchId,commit:commitObject.ref,generation:1};
   const carried=await stored(bundle.objects);
   if(!carried.ok)return carried;
   objects=[...carried.value,treeObject,commitObject];
  }
  const current=await storage.head(address);
  if(current){
   if(sameHead(current,head))return ok(current);
   return failed('CONFLICT',`Já existe uma versão em ${address.worldId}/${address.branchId}`);
  }
  return publish(null,head,objects,{id:`create-${head.commit.hash.slice(0,16)}`,digest:head.commit.hash,head});
 }
 async function fork(head:Head,target:WorldAddress):Promise<WorldResult<Head>> {
  if(!addressValid(target))return failed('MALFORMED','Endereço de destino inválido');
  if(sameAddress(target,head))return failed('CONFLICT','O destino já é esta versão');
  if(await storage.head(target))return failed('CONFLICT',`Já existe uma versão em ${target.worldId}/${target.branchId}`);
  const loaded=await loadVersion(storageSource,head);
  if(!loaded.ok)return loaded;
  const objects:StoredObject[]=[];
  let stateRef=loaded.value.stateRef;
  if(target.worldId!==head.worldId){
   // Recontextualising the world id is an explicit origin transition: the snapshot cannot keep the hash it had, but
   // the bases inside it are the same objects and stay shareable.
   const moved=await objectOf(stateValue({...loaded.value.state,worldId:target.worldId}));
   if(moved.ref.bytes>MAX_OBJECT_BYTES)return failed('LIMIT',`Estado de ${moved.ref.bytes} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
   stateRef=moved.ref;
   objects.push(moved);
  }
  const definition:WorldDefinition={
   worldId:target.worldId,
   branchId:target.branchId,
   origin:{kind:'fork',parent:{worldId:head.worldId,branchId:head.branchId}},
   profiles:[...loaded.value.tree.definition.profiles],
   rules:{...loaded.value.tree.definition.rules},
  };
  // Grants, a live session and an epoch belong to the origin and are deliberately not copied: the creator of the new
  // world sets its own policy.
  const tree:WorldTree={kind:'world-tree',definition,terms:loaded.value.tree.terms,state:stateRef,attached:[...loaded.value.tree.attached]};
  const treeObject=await objectOf(tree as unknown as JsonValue);
  const generation=head.generation+1;
  const commit:WorldCommit={kind:'world-commit',parents:[head.commit],tree:treeObject.ref,generation,rules:definition.rules,datasets:[...loaded.value.commit.datasets],accepted:[]};
  const commitObject=await objectOf(commit as unknown as JsonValue);
  const next:Head={worldId:target.worldId,branchId:target.branchId,commit:commitObject.ref,generation};
  objects.push(treeObject,commitObject);
  return publish(null,next,objects,{id:`fork-${next.commit.hash.slice(0,16)}`,digest:next.commit.hash,head:next});
 }
 async function commit(expected:Head,change:AcceptedChange):Promise<WorldResult<Head>> {
  if(!change.id||change.id.length>200)return failed('MALFORMED','Identificador de mudança inválido');
  if(change.state.worldId!==expected.worldId)return failed('MALFORMED','Estado de outro mundo nesta mudança');
  const snapshot=await objectOf(stateValue(change.state));
  if(snapshot.ref.bytes>MAX_OBJECT_BYTES)return failed('LIMIT',`Estado de ${snapshot.ref.bytes} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
  const digest=(await hasher.ref(codec.encode({kind:'world-change',id:change.id,state:snapshot.ref as unknown as JsonValue,operations:[...change.operations] as unknown as JsonValue}))).hash;
  // A repeated delivery carries the head it saw the first time, so the receipt is answered before the head is
  // compared: the same change produces the same version once, and a different one under the same id is refused.
  const delivery=await storage.receipt(expected,change.id);
  if(delivery){
   if(delivery.digest!==digest)return failed('CONFLICT',`A mudança ${change.id} já foi aceita com outro conteúdo`);
   return ok(delivery.head);
  }
  const current=await storage.head(expected);
  if(!current)return failed('NOT_FOUND',`Sem versão em ${expected.worldId}/${expected.branchId}`);
  if(!sameHead(current,expected))return failed('CONFLICT','A versão avançou desde a última leitura');
  const loaded=await loadVersion(storageSource,expected);
  if(!loaded.ok)return loaded;
  // Nothing durable changed: a version that repeats the current snapshot is not a new checkpoint.
  if(sameRef(snapshot.ref,loaded.value.stateRef))return ok(expected);
  const carried=await stored(change.objects);
  if(!carried.ok)return carried;
  const attached=known([...loaded.value.tree.attached,...carried.value.map(object=>object.ref)]).filter(ref=>!sameRef(ref,snapshot.ref));
  const tree:WorldTree={kind:'world-tree',definition:loaded.value.tree.definition,terms:loaded.value.tree.terms,state:snapshot.ref,attached};
  const treeObject=await objectOf(tree as unknown as JsonValue);
  const generation=expected.generation+1;
  const commit:WorldCommit={kind:'world-commit',parents:[expected.commit],tree:treeObject.ref,generation,rules:loaded.value.tree.definition.rules,datasets:known([...loaded.value.commit.datasets,...(change.datasets??[])]),accepted:[...change.operations]};
  if(change.author)commit.author=change.author;
  const commitObject=await objectOf(commit as unknown as JsonValue);
  const next:Head={worldId:expected.worldId,branchId:expected.branchId,commit:commitObject.ref,generation};
  return publish(expected,next,[snapshot,...carried.value,treeObject,commitObject],{id:change.id,digest,head:next});
 }
 // A prepared change is re-checked against the version it says it rests on, never against what its preview promised:
 // the head has to be the one it was prepared against, a composed state may not create money nor move the tick, and
 // the cost it approved has to be the cost the version actually paid. The change addresses itself, so delivering the
 // same prepared change twice answers the same version instead of merging it twice.
 async function commitPrepared(expected:Head,prepared:PreparedChange):Promise<WorldResult<Head>> {
  if(!sameHead(expected,prepared.target))return failed('CONFLICT','A versão avançou desde a prévia');
  const point=await checkout(expected);
  if(!point.ok)return point;
  const current=point.value.state;
  let state=current;
  if(prepared.state){
   const composed=prepared.state;
   if(composed.worldId!==expected.worldId)return failed('MALFORMED','O estado da prévia é de outro mundo');
   if(composed.formatVersion!==current.formatVersion||composed.rulesVersion!==current.rulesVersion)return failed('CONFLICT','O estado da prévia segue outras regras');
   if(composed.tick!==current.tick||composed.tick!==prepared.tick)return failed('CONFLICT','A prévia mudaria o tick: o tempo entra pelo relógio da sessão, não por um arquivo');
   if(composed.revision<current.revision)return failed('MALFORMED','A prévia não avança a revisão desta versão');
   if(composed.money>current.money)return failed('CONFLICT','A prévia criaria dinheiro a partir de dados que chegaram agora');
   if(current.money-composed.money!==prepared.cost)return failed('CONFLICT',`A prévia aprova o custo ${prepared.cost} e a mudança move ${current.money-composed.money}`);
   state=composed;
  }else{
   if(prepared.cost>current.money)return failed('CONFLICT',`O projeto custa ${prepared.cost} e esta versão tem ${current.money}`);
   const integrated=integrateProject(current,prepared);
   if(!integrated.ok)return integrated;
   state=integrated.value;
   if(state.tick!==prepared.tick)return failed('CONFLICT','A prévia mudaria o tick: o tempo entra pelo relógio da sessão, não por um arquivo');
   if(state.money!==prepared.moneyAfter)return failed('CONFLICT',`A prévia promete o saldo ${prepared.moneyAfter} e a integração chegou a ${state.money}`);
  }
  // The captures an update rests on stay reachable from the version it produced, and a version's data references are
  // how a later reader knows which revision its ground came from.
  const datasets=prepared.bases.filter(object=>isRecord(object.value)&&object.value['kind']==='capture').map(object=>object.ref);
  const operations=[...prepared.operations.map(operation=>operation.id),...(prepared.records??[])];
  const digest=(await hasher.ref(codec.encode({kind:'world-prepared',target:prepared.target as unknown as JsonValue,selection:[...prepared.selection],cost:prepared.cost,operations:[...operations]}))).hash;
  return commit(expected,{id:`prepared-${digest.slice(0,32)}`,state,operations,objects:prepared.bases,author:PROJECT_ACTOR,datasets});
 }
 async function checkout(head:Head):Promise<WorldResult<Checkpoint>> {
  const loaded=await loadVersion(storageSource,head);
  if(!loaded.ok)return loaded;
  return ok({
   head,
   commit:loaded.value.commit,
   definition:loaded.value.tree.definition,
   terms:loaded.value.tree.terms,
   tree:loaded.value.treeRef,
   stateRef:loaded.value.stateRef,
   state:loaded.value.state,
   bases:await baseRefs(loaded.value.state),
   receipts:await storage.receipts(head),
   versions:{worldProtocol:WORLD_PROTOCOL,wireVersion:WIRE_VERSION,rules:loaded.value.tree.definition.rules},
  });
 }
 // A complete package contains everything reachable from its head, ancestors included, so opening an exported copy
 // gives back the history and not only the last snapshot. Whatever the device no longer has is declared as missing
 // instead of being dropped silently, because a partial package is allowed to say what it cannot restore.
 async function exportVersion(head:Head):Promise<WorldResult<WorldBundle>> {
  const loaded=await loadVersion(storageSource,head);
  if(!loaded.ok)return loaded;
  const collected=new Map<string,WorldObject>(),missing:ObjectRef[]=[],visited=new Set<string>();
  collected.set(head.commit.hash,{ref:head.commit,value:loaded.value.commitValue});
  collected.set(loaded.value.treeRef.hash,{ref:loaded.value.treeRef,value:loaded.value.treeValue});
  const queue:ObjectRef[]=[loaded.value.tree.state,...loaded.value.tree.attached,...loaded.value.commit.parents];
  while(queue.length){
   const ref=queue.shift()!;
   if(visited.has(ref.hash))continue;
   visited.add(ref.hash);
   if(collected.has(ref.hash))continue;
   const read=await storageSource.read(ref);
   if(!read.ok){missing.push(ref);continue;}
   collected.set(ref.hash,{ref,value:read.value});
   if(isRecord(read.value)&&read.value['kind']==='world-commit'){
    const commit=commitOf(read.value);
    if(!commit.ok)return commit;
    queue.push(commit.value.tree,...commit.value.parents);
   }else if(isRecord(read.value)&&read.value['kind']==='world-tree'){
    const tree=treeOf(read.value);
    if(!tree.ok)return tree;
    queue.push(tree.value.state,...tree.value.attached);
   }
  }
  const complete=missing.length===0;
  return ok({
   envelope:{worldProtocol:WORLD_PROTOCOL,wireVersion:WIRE_VERSION,kind:'bundle'},
   definition:loaded.value.tree.definition,
   head,
   objects:complete?[...collected.values()]:[],
   terms:loaded.value.tree.terms,
   completeness:complete?{complete:true,missing:[]}:{complete:false,missing},
   extensions:{},
  });
 }
 async function history(head:Head,limit=64):Promise<WorldResult<WorldVersion[]>> {
  const versions:WorldVersion[]=[],visited=new Set<string>();
  let ref=head.commit,generation=head.generation;
  while(versions.length<limit&&!visited.has(ref.hash)){
   visited.add(ref.hash);
   const read=await storageSource.read(ref);
   if(!read.ok){
    // The head of the branch has to be readable; an older commit the device no longer has ends the list instead of
    // inventing the versions it lost.
    if(!versions.length)return read;
    break;
   }
   const commit=commitOf(read.value);
   if(!commit.ok)return commit;
   versions.push({head:{worldId:head.worldId,branchId:head.branchId,commit:ref,generation},accepted:commit.value.accepted});
   const parent=commit.value.parents[0];
   if(!parent)break;
   // The generation counts commits along the first parent, so the parent is exactly one less.
   ref=parent;
   generation=commit.value.generation-1;
  }
  return ok(versions);
 }
 return {
  create,
  fork,
  commit,
  commitPrepared,
  checkout,
  export:exportVersion,
  history,
  branches:async worldId=>ok(await storage.heads(worldId)),
 };
}
