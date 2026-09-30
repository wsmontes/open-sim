import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {importLegacy} from '../src/session/world-bundle';
import {createWorldRepository} from '../src/session/world-repository';
import type {Checkpoint,WorldRepository} from '../src/session/world-repository';
import {decodeBundle,encodeBundle} from '../src/world/codec';
import {applyCommand,createGame} from '../src/core/commands';
import {blank,command} from './fixtures/world';
import type {BaseChunk,CellCoord,GameState,SavedGame,ViewState} from '../src/core/model';
import type {Head,JsonValue,WorldBundle} from '../src/world/model';

const codec=createJcsCodec(),hasher=bytesHasher();
const terms=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const MAIN={worldId:'victoria',branchId:'main'};
const view:ViewState={x:12.5,y:-4,zoom:1.5,speed:1,place:'Victoria',rotation:-0.75};
// Cells inside '9:9', whose origin is (288,288); the full synthetic region holds 1024 of them.
const here=(x:number,y:number):CellCoord=>({x:288+x,y:288+y});
const oneCell=(id:string):BaseChunk=>({id,source:'synthetic-test',normalizerVersion:1,cells:[{terrain:'land'}]});
const city=(worldId='victoria'):GameState=>createGame(worldId,1,blank('9:9'));
const tiny=(worldId='victoria'):GameState=>createGame(worldId,1,oneCell('9:9'));
// A snapshot is stored as canonical JSON, where a negative zero is not representable; comparing both sides through
// the same codec keeps the assertion about the world instead of about a sign the wire cannot carry.
const durable=(state:GameState):GameState=>{
 const stored=JSON.parse(new TextDecoder().decode(codec.encode({kind:'city-state',state:state as unknown as JsonValue}))) as {state:GameState};
 return stored.state;
};
function device(bytes?:number){const storage=createWorldMemoryStorage(bytes===undefined?{}:{bytes});return {storage,worlds:createWorldRepository({storage,codec,hasher})};}
async function bundleOf(state:GameState):Promise<WorldBundle>{
 const save:SavedGame={version:1,state,view};
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error(imported.error.message);
 return imported.value;
}
async function open(worlds:WorldRepository,state:GameState){
 const created=await worlds.create(await bundleOf(state));
 if(!created.ok)throw new Error(created.error.message);
 return created.value;
}
async function restore(worlds:WorldRepository,head:Head):Promise<Checkpoint>{
 const result=await worlds.checkout(head);
 if(!result.ok)throw new Error(result.error.message);
 return result.value;
}
async function versionsOf(worlds:WorldRepository,worldId:string){
 const result=await worlds.branches(worldId);
 if(!result.ok)throw new Error(result.error.message);
 return result.value;
}
async function historyOf(worlds:WorldRepository,head:Head,limit?:number){
 const result=await worlds.history(head,limit);
 if(!result.ok)throw new Error(result.error.message);
 return result.value;
}
function build(state:GameState,available:readonly BaseChunk[],cell:CellCoord,tool:'park'|'road'='park'):GameState{
 const applied=applyCommand(state,command(state,{type:'build',tool,cells:[cell]}),available);
 if(applied.status!=='applied')throw new Error(applied.reason);
 return applied.state;
}
const textOf=(bytes:Uint8Array)=>new TextDecoder().decode(bytes);
const stateRefOf=(state:GameState)=>hasher.ref(codec.encode({kind:'city-state',state:state as unknown as JsonValue}));

test('a fork shares the objects it did not change instead of copying equal bytes',async()=>{
 const {storage,worlds}=device();
 const start=city();
 const parent=await open(worlds,start);
 const parentPoint=await restore(worlds,parent);
 const before=storage.size();
 const forked=await worlds.fork(parent,{worldId:'victoria',branchId:'experimento'});
 expect(forked.ok).toBe(true);
 if(!forked.ok)return;
 const childPoint=await restore(worlds,forked.value);
 // The plan's acceptance: the base the child rests on is the base the parent already stored.
 const parentBaseHash=parentPoint.bases[0]!.ref.hash,childBaseHash=childPoint.bases[0]!.ref.hash;
 expect(childBaseHash).toBe(parentBaseHash);
 expect(childPoint.bases).toEqual(parentPoint.bases);
 expect(childPoint.stateRef).toEqual(parentPoint.stateRef);
 expect(childPoint.state).toEqual(parentPoint.state);
 expect(childPoint.head.commit.hash).not.toBe(parentPoint.head.commit.hash);
 expect(childPoint.commit.parents).toEqual([parent.commit]);
 expect(childPoint.definition.branchId).toBe('experimento');
 expect(childPoint.definition.origin).toEqual({kind:'fork',parent:{worldId:'victoria',branchId:'main'}});
 // Only a tree and a commit were added: a copied snapshot would be a quarter of the stored snapshot at least.
 expect(storage.size()-before).toBeLessThan(parentPoint.stateRef.bytes/4);
});

test('work accepted on the child leaves the parent exactly as it was',async()=>{
 const {storage,worlds}=device();
 const start=city();
 const parent=await open(worlds,start);
 const forked=await worlds.fork(parent,{worldId:'victoria',branchId:'experimento'});
 if(!forked.ok)throw new Error(forked.error.message);
 const changed=build(start,[],here(0,0));
 const accepted=await worlds.commit(forked.value,{id:'parque-1',state:changed,operations:['Parque em 1 célula'],objects:[],author:'local-player'});
 expect(accepted.ok).toBe(true);
 if(!accepted.ok)return;
 const childPoint=await restore(worlds,accepted.value);
 expect(childPoint.state.money).toBe(start.money-30);
 expect(childPoint.state.revision).toBe(start.revision+1);
 const parentAfter=await restore(worlds,parent);
 expect(parentAfter.state).toEqual(durable(start));
 expect(parentAfter.head).toEqual(parent);
 expect(await storage.head(MAIN)).toEqual(parent);
});

test('a stale head is refused and an accepted change answers the same receipt without charging twice',async()=>{
 const {storage,worlds}=device();
 const start=city();
 const head=await open(worlds,start);
 const park=build(start,[],here(0,0));
 const first=await worlds.commit(head,{id:'a',state:park,operations:['Parque em 1 célula'],objects:[],author:'local-player'});
 expect(first.ok).toBe(true);
 if(!first.ok)return;
 const stale=await worlds.commit(head,{id:'b',state:build(start,[],here(1,0)),operations:['Parque em 1 célula'],objects:[],author:'local-player'});
 expect(stale).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(await storage.head(MAIN)).toEqual(first.value);
 const replay=await worlds.commit(head,{id:'a',state:park,operations:['Parque em 1 célula'],objects:[],author:'local-player'});
 expect(replay).toMatchObject({ok:true,value:first.value});
 const reuse=await worlds.commit(head,{id:'a',state:build(start,[],here(1,0)),operations:['Outra obra'],objects:[],author:'local-player'});
 expect(reuse).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(await storage.head(MAIN)).toEqual(first.value);
});

test('a device that runs out of space advances nothing and leaves no object or receipt behind',async()=>{
 const {storage,worlds}=device(4096);
 const start=tiny();
 const head=await open(worlds,start);
 const before=storage.size();
 // A whole new region does not fit on this device: the transaction must refuse the change as a whole.
 const wide=build(start,[blank('10:0')],{x:320,y:0});
 const refused=await worlds.commit(head,{id:'regiao',state:wide,operations:['Região nova'],objects:[],author:'local-player'});
 expect(refused).toMatchObject({ok:false,error:{code:'QUOTA'}});
 expect(await storage.head(MAIN)).toEqual(head);
 expect(await storage.receipt(MAIN,'regiao')).toBeNull();
 expect(storage.size()).toBe(before);
 expect(await storage.object(await stateRefOf(wide))).toBeNull();
 const still=await restore(worlds,head);
 expect(still.state.revision).toBe(start.revision);
});

test('an exported copy opens on a device with no map source and keeps the same head',async()=>{
 const {worlds}=device();
 const start=city();
 const head=await open(worlds,start);
 const built=build(start,[],here(0,0));
 const accepted=await worlds.commit(head,{id:'parque-1',state:built,operations:['Parque em 1 célula'],objects:[],author:'local-player'});
 if(!accepted.ok)throw new Error(accepted.error.message);
 const exported=await worlds.export(accepted.value);
 expect(exported.ok).toBe(true);
 if(!exported.ok)return;
 const bytes=encodeBundle(exported.value,codec);
 expect(exported.value.completeness).toEqual({complete:true,missing:[]});
 expect(exported.value.head).toEqual(accepted.value);
 // The camera and the place of the local view are presentation, never part of the world (spec R11).
 expect(textOf(bytes)).not.toContain('"zoom"');
 expect(textOf(bytes)).not.toContain('Victoria');
 // A different device, offline: the only thing available is the package itself.
 let mapRequests=0;
 const maps={loadChunk:async()=>{mapRequests+=1;throw new Error('sem rede');},attribution:{text:'OpenStreetMap',url:'https://www.openstreetmap.org/copyright'}};
 const elsewhere=device();
 const decoded=decodeBundle(bytes);
 expect(decoded.ok).toBe(true);
 if(!decoded.ok)return;
 const imported=await elsewhere.worlds.create(decoded.value);
 expect(imported.ok).toBe(true);
 if(!imported.ok)return;
 expect(imported.value).toEqual(accepted.value);
 const restored=await restore(elsewhere.worlds,imported.value);
 expect(restored.head.commit.hash).toBe(accepted.value.commit.hash);
 expect(restored.state).toEqual(durable(built));
 expect(restored.state.chunks['9:9']!.base).toEqual(start.chunks['9:9']!.base);
 expect(restored.bases.map(entry=>entry.id)).toEqual(['9:9']);
 expect(mapRequests).toBe(0);
 expect(maps.attribution.url).toBe('https://www.openstreetmap.org/copyright');
 // The checkpoint carries no camera at all.
 expect(JSON.stringify(restored)).not.toContain('"zoom"');
 expect(JSON.stringify(restored)).not.toContain('Victoria');
});

test('a fork into another world recontextualises the world id and inherits no grant or live session',async()=>{
 const {storage,worlds}=device();
 const start=city();
 const parent=await open(worlds,start);
 const parentPoint=await restore(worlds,parent);
 const forked=await worlds.fork(parent,{worldId:'vitoria-do-norte',branchId:'main'});
 expect(forked.ok).toBe(true);
 if(!forked.ok)return;
 const point=await restore(worlds,forked.value);
 expect(point.head.worldId).toBe('vitoria-do-norte');
 expect(point.state.worldId).toBe('vitoria-do-norte');
 expect(point.definition.worldId).toBe('vitoria-do-norte');
 expect(point.definition.origin).toEqual({kind:'fork',parent:{worldId:'victoria',branchId:'main'}});
 // The frozen regions stay shareable across worlds; only the snapshot that named the old world was rewritten.
 expect(point.bases.map(entry=>entry.ref.hash)).toEqual(parentPoint.bases.map(entry=>entry.ref.hash));
 expect(point.state.chunks).toEqual(durable(start).chunks);
 const tree=await storage.object(point.tree);
 expect(tree).not.toBeNull();
 const durableTree=textOf(tree!);
 expect(durableTree).not.toContain('grant');
 expect(durableTree).not.toContain('session');
 expect(durableTree).not.toContain('epoch');
 // The origin world is untouched and still belongs to victoria.
 expect((await restore(worlds,parent)).state.worldId).toBe('victoria');
 expect(await storage.head(MAIN)).toEqual(parent);
});

test('every world and branch gets its own slot and an invitation never overwrites the personal one',async()=>{
 const {storage,worlds}=device();
 const personal=await open(worlds,city());
 const invitedBundle=await bundleOf(tiny('vizinho'));
 const invited=await worlds.create(invitedBundle);
 expect(invited.ok).toBe(true);
 if(!invited.ok)return;
 expect(await storage.head(MAIN)).toEqual(personal);
 expect(await storage.head({worldId:'vizinho',branchId:'main'})).toEqual(invited.value);
 expect((await versionsOf(worlds,'vizinho')).map(entry=>entry.branchId)).toEqual(['main']);
 expect((await versionsOf(worlds,'victoria')).map(entry=>entry.branchId)).toEqual(['main']);
 // Opening the very same package again is the same version, not a second copy.
 expect(await worlds.create(invitedBundle)).toMatchObject({ok:true,value:invited.value});
 // The same address with a different history is refused instead of replacing what is already here.
 const clash=await worlds.create(await bundleOf(build(tiny('vizinho'),[blank('10:0')],{x:320,y:0})));
 expect(clash).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(await storage.head({worldId:'vizinho',branchId:'main'})).toEqual(invited.value);
 // And a fork cannot take an address that already has a version.
 expect(await worlds.fork(personal,{worldId:'victoria',branchId:'main'})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 expect(await storage.head(MAIN)).toEqual(personal);
});

test('the history of a branch walks its first parents and reports what each version accepted',async()=>{
 const {worlds}=device();
 const start=city();
 const head=await open(worlds,start);
 const parked=build(start,[],here(0,0));
 const first=await worlds.commit(head,{id:'a',state:parked,operations:['Parque em 1 célula'],objects:[],author:'local-player'});
 if(!first.ok)throw new Error(first.error.message);
 const second=await worlds.commit(first.value,{id:'b',state:build(parked,[],here(1,0)),operations:['Rua em 1 célula'],objects:[],author:'local-player'});
 if(!second.ok)throw new Error(second.error.message);
 const versions=await worlds.history(second.value);
 expect(versions.ok).toBe(true);
 if(!versions.ok)return;
 expect(versions.value.map(version=>version.head.generation)).toEqual([3,2,1]);
 expect(versions.value.map(version=>version.accepted)).toEqual([['Rua em 1 célula'],['Parque em 1 célula'],[]]);
 expect(versions.value[0]!.head).toEqual(second.value);
 expect((await historyOf(worlds,second.value,2)).map(version=>version.head.generation)).toEqual([3,2]);
});
