import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import type {WorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {importLegacy} from '../src/session/world-bundle';
import {createWorldRepository} from '../src/session/world-repository';
import type {Checkpoint,WorldRepository} from '../src/session/world-repository';
import {collectRetention,needsReconciliation,planReceiptCompaction,planRetention,readInventory} from '../src/session/world-retention';
import type {ObjectInventory,RetainedRoot} from '../src/session/world-retention';
import type {WorldStorage} from '../src/session/world-ports';
import {attachBases,changeSetValue,describeChange} from '../src/world/changes';
import {applyCommand,createGame} from '../src/core/commands';
import {ok,sameRef} from '../src/world/model';
import type {Head,JsonValue,ObjectRef,WorldObject} from '../src/world/model';
import type {BaseChunk,CellCoord,GameState,SavedGame,ViewState} from '../src/core/model';
import {blank,command} from './fixtures/world';

const codec=createJcsCodec(),hasher=bytesHasher();
const terms=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const view:ViewState={x:12.5,y:-4,zoom:1.5,speed:1,place:'Victoria',rotation:-0.75};
const MAIN={worldId:'victoria',branchId:'main'};
// Cells inside '9:9', whose origin is (288,288).
const here=(x:number,y:number):CellCoord=>({x:288+x,y:288+y});
const oneCell=(id:string):BaseChunk=>({id,source:'synthetic-test',normalizerVersion:1,cells:[{terrain:'land'}]});
const tiny=(worldId='victoria'):GameState=>createGame(worldId,1,oneCell('9:9'));
// A full synthetic region, so building at any of the cells this test names is a real edit and not an absent cell.
const city=(worldId='victoria'):GameState=>createGame(worldId,1,blank('9:9'));
const objectOf=async(value:JsonValue):Promise<WorldObject>=>({ref:await hasher.ref(codec.encode(value)),value});
const hashesOf=(refs:readonly ObjectRef[])=>refs.map(ref=>ref.hash).sort();
function device(bytes?:number){const storage=createWorldMemoryStorage(bytes===undefined?{}:{bytes});return {storage,worlds:createWorldRepository({storage,codec,hasher})};}
function build(state:GameState,available:readonly BaseChunk[],cell:CellCoord):GameState{
 const applied=applyCommand(state,command(state,{type:'build',tool:'park',cells:[cell]}),available);
 if(applied.status!=='applied')throw new Error(applied.reason);
 return applied.state;
}
async function open(worlds:WorldRepository,state:GameState){
 const save:SavedGame={version:1,state,view};
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error(imported.error.message);
 const created=await worlds.create(imported.value);
 if(!created.ok)throw new Error(created.error.message);
 return created.value;
}
async function restore(worlds:WorldRepository,head:Head):Promise<Checkpoint>{
 const result=await worlds.checkout(head);
 if(!result.ok)throw new Error(result.error.message);
 return result.value;
}
// Everything a device holds is what its versions reach: a complete export of every head it still points at is that
// device's inventory, and an export that is not complete is a defect of this test, not a retention fact.
async function heldRefs(worlds:WorldRepository,heads:readonly Head[]):Promise<ObjectRef[]>{
 const held=new Map<string,ObjectRef>();
 for(const head of heads){
  const exported=await worlds.export(head);
  if(!exported.ok)throw new Error(exported.error.message);
  if(!exported.value.completeness.complete)throw new Error('exportação incompleta durante o teste');
  for(const object of exported.value.objects)held.set(object.ref.hash,object.ref);
 }
 return [...held.values()];
}
function hiding(storage:WorldStorage,hidden:ObjectRef):WorldStorage{
 return {...storage,object:async ref=>sameRef(ref,hidden)?null:storage.object(ref)};
}
// One world with the shape retention has to respect: a retained main branch resting on a frozen region, and a second
// branch whose later work was abandoned although its fork commit stayed pinned as a checkpoint, carrying a region only
// that abandoned work attached and a frozen proposal that names the region it uses.
type Scenario={storage:WorldMemoryStorage;worlds:WorldRepository;main:Head;fork:Head;forkRef:ObjectRef;forkTree:ObjectRef;abandoned:Head;point:Checkpoint;base9:ObjectRef;base10:ObjectRef;proposal:ObjectRef;inventory:ObjectInventory;roots:RetainedRoot[]};
async function scenario():Promise<Scenario>{
 const {storage,worlds}=device();
 const start=city();
 const main=await open(worlds,start);
 const base9=await objectOf({kind:'base-chunk',base:start.chunks['9:9']!.base as unknown as JsonValue});
 const frozen=await worlds.commit(main,{id:'main-1',state:build(start,[],here(0,0)),operations:['Parque em 1 célula'],objects:[base9],author:'local-player'});
 if(!frozen.ok)throw new Error(frozen.error.message);
 const point=await restore(worlds,frozen.value);
 const forked=await worlds.fork(frozen.value,{worldId:'victoria',branchId:'experimento'});
 if(!forked.ok)throw new Error(forked.error.message);
 // A cell inside '10:0', so adopting the region is what this build really does.
 const widened=build(start,[blank('10:0')],{x:320,y:0});
 const base10=await objectOf({kind:'base-chunk',base:blank('10:0')});
 // A proposal nobody applied yet: the regions it uses travel with it, which is what a retained proposal keeps alive.
 const set=describeChange(start,command(start,{type:'build',tool:'park',cells:[here(2,0)]}),build(start,[],here(2,0)));
 const withBases=await attachBases(set,[start.chunks['9:9']!.base],hasher,codec);
 if(!withBases.ok)throw new Error(withBases.error.message);
 const proposal=await objectOf(changeSetValue(withBases.value));
 const abandoned=await worlds.commit(forked.value,{id:'experimento-1',state:widened,operations:['Aterro em 1 célula'],objects:[base10,proposal],author:'local-player'});
 if(!abandoned.ok)throw new Error(abandoned.error.message);
 // The regions a version rests on are the addresses its checkpoint names, not private copies of this test.
 expect(point.bases.find(entry=>entry.id==='9:9')!.ref).toEqual(base9.ref);
 expect((await restore(worlds,abandoned.value)).bases.find(entry=>entry.id==='10:0')!.ref).toEqual(base10.ref);
 const read=await readInventory(storage,await heldRefs(worlds,[frozen.value,abandoned.value]));
 if(!read.ok)throw new Error(read.error.message);
 const roots:RetainedRoot[]=[
  {kind:'branch-head',ref:frozen.value.commit,label:'main'},
  {kind:'checkpoint',ref:forked.value.commit,label:'experimento'},
  {kind:'base',ref:base9.ref,label:'base 9:9'},
  {kind:'base',ref:base10.ref,label:'base 10:0'},
  {kind:'proposal',ref:proposal.ref,label:'proposta da ciclovia'},
 ];
 const forkPoint=await restore(worlds,forked.value);
 return {storage,worlds,main:frozen.value,fork:forked.value,forkRef:forked.value.commit,forkTree:forkPoint.tree,abandoned:abandoned.value,point,base9:base9.ref,base10:base10.ref,proposal:proposal.ref,inventory:read.value,roots};
}
const withoutRoot=(roots:readonly RetainedRoot[],kind:RetainedRoot['kind'],ref:ObjectRef)=>roots.filter(root=>!(root.kind===kind&&sameRef(root.ref,ref)));

test('a retention pass keeps base, checkpoint, proposal and referenced objects, and collects only what nothing reaches',async()=>{
 const {worlds,main,fork,forkRef,forkTree,abandoned,point,base9,base10,proposal,inventory,roots}=await scenario();
 // The walker reads the frozen proposal as a proposal: the regions it uses travel with it and are reachable too.
 expect(inventory.objects.find(entry=>sameRef(entry.ref,proposal))!.references).toEqual([base9]);
 expect(inventory.missing).toEqual([]);
 const plan=planRetention(roots,inventory);
 expect(plan.incomplete).toBe(false);
 expect(plan.missing).toEqual([]);
 // Kept: the two pinned commits, their trees and snapshots, the ancestor line, and every object a retained version
 // reaches — the frozen regions, the object the branch attached and the retained proposal.
 const retained=[main.commit,forkRef,point.tree,point.stateRef,base9,base10,proposal];
 for(const ref of retained)expect(hashesOf(plan.collect)).not.toContain(ref.hash);
 for(const ref of retained)expect(hashesOf(plan.keep)).toContain(ref.hash);
 // Collected: exactly the abandoned version — its commit, its tree and its snapshot. The region it attached is kept
 // (it is a retained base), and the retained proposal is kept although only the abandoned tree attached it.
 const abandonedPoint=await restore(worlds,abandoned);
 const loose=[abandoned.commit,abandonedPoint.tree,abandonedPoint.stateRef];
 expect(hashesOf(plan.collect)).toEqual(hashesOf(loose));
 expect(plan.reclaimed).toBe(loose.reduce((sum,ref)=>sum+ref.bytes,0));
 expect(plan.keep.length+plan.collect.length).toBe(inventory.objects.length);
 // Every retained root is what keeps its object: dropping one from the list puts that object at risk.
 expect(hashesOf(planRetention(withoutRoot(roots,'proposal',proposal),inventory).collect)).toContain(proposal.hash);
 expect(hashesOf(planRetention(withoutRoot(roots,'base',base10),inventory).collect)).toContain(base10.hash);
 expect(hashesOf(planRetention(withoutRoot(roots,'checkpoint',forkRef),inventory).collect)).toEqual(hashesOf([...loose,forkRef,forkTree]));
 // A retained proposal keeps the region it carries even with no version retained at all.
 const proposalOnly=planRetention([{kind:'proposal',ref:proposal,label:'proposta'}],inventory);
 expect(hashesOf(proposalOnly.keep)).toEqual(hashesOf([proposal,base9]));
 expect(proposalOnly.collect).toHaveLength(inventory.objects.length-2);
 // Exporting the retained versions first is what makes the collection safe, and both exports are complete.
 for(const head of [main,fork])expect(await worlds.export(head)).toMatchObject({ok:true,value:{completeness:{complete:true,missing:[]}}});
 const removed:ObjectRef[][]=[];
 const applied=await collectRetention(plan,{remove:async refs=>{removed.push([...refs]);return ok(refs);}});
 expect(applied).toMatchObject({ok:true});
 expect(removed).toHaveLength(1);
 expect(hashesOf(removed[0]!)).toEqual(hashesOf(plan.collect));
});

test('a device that lost an object suspends the collection and the version that needs it is refused',async()=>{
 const {storage,worlds,main,abandoned,inventory,roots}=await scenario();
 const lost=await restore(worlds,abandoned);
 const broken=hiding(storage,lost.tree);
 const read=await readInventory(broken,await heldRefs(worlds,[abandoned]));
 expect(read).toMatchObject({ok:true});
 if(!read.ok)return;
 expect(hashesOf(read.value.missing)).toEqual([lost.tree.hash]);
 const plan=planRetention(roots,read.value);
 expect(plan.incomplete).toBe(true);
 expect(plan.collect).toEqual([]);
 expect(plan.reclaimed).toBe(0);
 expect(plan.missing.map(ref=>ref.hash)).toContain(lost.tree.hash);
 expect(plan.notes.length).toBeGreaterThan(0);
 // The collector never works from an inventory it cannot trust, and the version that needs the object is refused.
 let asked=0;
 expect(await collectRetention(plan,{remove:async refs=>{asked+=1;return ok(refs);}})).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 expect(asked).toBe(0);
 const elsewhere=createWorldRepository({storage:broken,codec,hasher});
 expect(await elsewhere.checkout(abandoned)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 // The retained version is intact: a loss in abandoned work does not stop this device from opening what it kept.
 expect(await worlds.checkout(main)).toMatchObject({ok:true,value:{head:main}});
 expect(hashesOf(inventory.objects.map(entry=>entry.ref))).toContain(lost.tree.hash);
});

test('a device over quota is told to export or branch instead of deleting reachable history',async()=>{
 const {storage,worlds,abandoned,inventory,roots}=await scenario();
 const used=storage.size();
 // Simulating an IndexedDB quota: the device reports less room than it is using, and the pass frees only loose bytes.
 const tight=planRetention(roots,inventory,{capacity:used-1,used});
 expect(tight.collect.length).toBeGreaterThan(0);
 expect(tight.pressure).toEqual({over:false,shortage:0});
 // Retaining the abandoned branch too makes every held object reachable: nothing may be collected to make room.
 const everything=[...roots,{kind:'branch-head' as const,ref:abandoned.commit,label:'experimento'}];
 const full=planRetention(everything,inventory,{capacity:used-1,used});
 expect(full.incomplete).toBe(false);
 expect(full.collect).toEqual([]);
 expect(full.keep.length).toBe(inventory.objects.length);
 expect(full.pressure).toMatchObject({over:true});
 expect(full.notes.join(' ')).toMatch(/export|ramific/i);
 // A device with almost no room refuses the change instead of freeing space by deleting history it still holds.
 const small=device(4096);
 const heldHead=await open(small.worlds,tiny());
 const room=small.storage.size();
 const refused=await small.worlds.commit(heldHead,{id:'regiao',state:build(tiny(),[blank('10:0')],{x:320,y:0}),operations:['Região nova'],objects:[],author:'local-player'});
 expect(refused).toMatchObject({ok:false,error:{code:'QUOTA'}});
 expect(small.storage.size()).toBe(room);
 const listing=await readInventory(small.storage,await heldRefs(small.worlds,[heldHead]));
 if(!listing.ok)throw new Error(listing.error.message);
 const tightSmall=planRetention([{kind:'branch-head',ref:heldHead.commit,label:'main'}],listing.value,{capacity:room-1,used:room});
 expect(tightSmall.incomplete).toBe(false);
 expect(tightSmall.collect).toEqual([]);
 expect(tightSmall.pressure).toMatchObject({over:true});
 expect(small.storage.object(heldHead.commit)).not.toBeNull();
});

test('compacted receipts leave a reconciliation mark instead of answering an old delivery as new',async()=>{
 const {storage,worlds}=device();
 const start=city();
 const head=await open(worlds,start);
 const parked=build(start,[],here(0,0));
 const first=await worlds.commit(head,{id:'a',state:parked,operations:['Parque em 1 célula'],objects:[],author:'local-player'});
 if(!first.ok)throw new Error(first.error.message);
 const paved=build(parked,[],here(1,0));
 const second=await worlds.commit(first.value,{id:'b',state:paved,operations:['Rua em 1 célula'],objects:[],author:'local-player'});
 if(!second.ok)throw new Error(second.error.message);
 const square=build(paved,[],here(2,0));
 const third=await worlds.commit(second.value,{id:'c',state:square,operations:['Praça em 1 célula'],objects:[],author:'local-player'});
 if(!third.ok)throw new Error(third.error.message);
 const ids=await storage.receipts(MAIN);
 const receipts=(await Promise.all(ids.map(async id=>storage.receipt(MAIN,id)))).flatMap(receipt=>receipt?[receipt]:[]);
 // The creation receipt of the branch is a receipt too, at generation 1.
 expect(receipts.map(receipt=>receipt.head.generation).sort((a,b)=>a-b)).toEqual([1,2,3,4]);
 const compacted=planReceiptCompaction(receipts,1);
 expect(compacted.kept.map(receipt=>receipt.id)).toEqual(['c']);
 expect(compacted.compacted.map(receipt=>receipt.head.generation)).toEqual([1,2,3]);
 expect(compacted.kept.length+compacted.compacted.length).toBe(receipts.length);
 expect(compacted.mark).toEqual({floor:4,note:expect.any(String)});
 // An unknown delivery older than the retained window can no longer be answered by a receipt and drops to
 // reconciliation; a delivery at the retained head is new, and a retained id is answered from its own receipt.
 expect(needsReconciliation('a',2,compacted.kept,compacted.mark)).toBe(true);
 expect(needsReconciliation('b',2,compacted.kept,compacted.mark)).toBe(true);
 expect(needsReconciliation('c',3,compacted.kept,compacted.mark)).toBe(false);
 expect(needsReconciliation('d',4,compacted.kept,compacted.mark)).toBe(false);
 // A window that covers every receipt compacts nothing and asks for no reconciliation at all.
 const whole=planReceiptCompaction(receipts,8);
 expect(whole.compacted).toEqual([]);
 expect(whole.mark).toBeNull();
 expect(needsReconciliation('a',2,whole.kept,whole.mark)).toBe(false);
 // The newest receipt is never compacted away: a session without an answerable receipt would refuse everything.
 expect(planReceiptCompaction(receipts,0).kept).toHaveLength(1);
 expect(planReceiptCompaction(receipts,0).mark).toMatchObject({floor:4});
});
