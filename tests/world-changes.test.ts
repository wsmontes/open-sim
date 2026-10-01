import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {applyCommand,createGame} from '../src/core/commands';
import {CHUNK,cellIndex,chunkId} from '../src/core/coordinates';
import {WORLD} from '../src/core/coordinates';
import {adopt,getCell} from '../src/core/world';
import {decodeUtf8,parseStrictJson} from '../src/world/codec';
import {attachBases,changeSetValue,combineChanges,describeChange,describeEdits,parseChangeSet,sameCell,verifyChangeSet} from '../src/world/changes';
import {integrateProject,prepareProject} from '../src/world/city-profile';
import {diffWorlds} from '../src/presentation/world-diff';
import {createWorldRepository} from '../src/session/world-repository';
import type {Checkpoint,WorldRepository} from '../src/session/world-repository';
import {createSession} from '../src/session/local-session';
import {createMemoryStore} from '../src/adapters/storage/memory';
import type {MapSource} from '../src/session/ports';
import {importLegacy} from '../src/session/world-bundle';
import type {BaseChunk,CellCoord,GameState,SavedGame,ViewState} from '../src/core/model';
import type {Head,JsonValue} from '../src/world/model';
import {blank,command} from './fixtures/world';
import fixtureA from './fixtures/federated-world/base-a.json';
import fixtureB from './fixtures/federated-world/base-b.json';
import legacy from './fixtures/federated-world/legacy.json';

const codec=createJcsCodec(),hasher=bytesHasher();
const WORLD_ID='victoria';
const VIEW:ViewState={x:0,y:0,zoom:1,speed:0,place:'Victoria'};
const mapA=fixtureA as BaseChunk,mapB=fixtureB as BaseChunk;
const legacySave=legacy as unknown as SavedGame;
// The synthetic map of the tests is a plain land region; the seam test also needs the region east of x=31 and the one
// that wraps around the antimeridian, so a road can cross both edges without being duplicated.
const pool=():readonly BaseChunk[]=>[blank('0:0'),blank('1:0'),blank(`${WORLD/CHUNK-1}:0`)];
const cityWith=(base:BaseChunk,worldId=WORLD_ID):GameState=>createGame(worldId,1,base);
const adopted=(id:string):GameState=>{const state=createGame(WORLD_ID,1,blank(id));return state;};
function device(){const storage=createWorldMemoryStorage({});return createWorldRepository({storage,codec,hasher});}
async function open(worlds:WorldRepository,state:GameState):Promise<{head:Head;point:Checkpoint}>{
 const bundle=await importLegacy({version:1,state,view:VIEW},hasher,codec);
 if(!bundle.ok)throw new Error(bundle.error.message);
 const created=await worlds.create(bundle.value);
 if(!created.ok)throw new Error(created.error.message);
 const point=await worlds.checkout(created.value);
 if(!point.ok)throw new Error(point.error.message);
 return {head:created.value,point:point.value};
}
const record=(value:JsonValue):Record<string,JsonValue>=>value as Record<string,JsonValue>;
const ids=(set:{operations:readonly {id:string}[]})=>set.operations.map(operation=>operation.id);
const textOf=(bytes:Uint8Array)=>{const decoded=decodeUtf8(bytes);if(!decoded.ok)throw new Error(decoded.error.message);return decoded.value;};
// A target the proposal can be prepared against: the same synthetic region, a different balance and a different tick,
// which is exactly what must not travel with the change. Each destination gets its own device, so two targets in one
// test are two different worlds instead of a name collision.
async function targetOf(over:Partial<GameState>={}):Promise<Checkpoint>{
 const state={...adopted('0:0'),...over};
 const opened=await open(device(),state);
 return opened.point;
}

test('a described change names the intent, the fields read and written and the base it rests on',()=>{
 const before=createGame(WORLD_ID,1,blank('0:0'));
 const build=command(before,{type:'build',tool:'park',cells:[{x:5,y:0}]});
 const applied=applyCommand(before,build,[]);
 expect(applied.status).toBe('applied');
 const set=describeChange(before,build,applied.state);
 expect(set.version).toBe(1);
 expect(set.origins).toEqual([{worldId:WORLD_ID}]);
 expect(set.operations).toHaveLength(1);
 const operation=set.operations[0]!;
 expect(operation.intent).toEqual({kind:'build',tool:'park'});
 expect(operation.places).toEqual([{chunkId:'0:0',index:cellIndex({x:5,y:0}),x:5,y:0}]);
 expect(operation.writes.map(field=>field.scope==='cell'?field.field:'')).toEqual(['building','stage','origin']);
 expect(operation.reads.map(field=>field.scope==='cell'?field.field:'')).toEqual(['terrain','road','building']);
 expect(operation.basedOn).toEqual([{chunkId:'0:0',source:'synthetic-test',normalizerVersion:1}]);
 expect(operation.requires.map(requirement=>requirement.kind)).toEqual(['chunk-base','cell-clear','cell-terrain']);
 expect(operation.after[0]).toEqual({terrain:'land',building:'park',stage:1,origin:'player'});
 // demolishing the same custom building names what it removes instead of a whole replacement
 const demolish=command(applied.state,{type:'demolish',cells:[{x:5,y:0}]});
 const removed=applyCommand(applied.state,demolish,[]);
 const undo=describeChange(applied.state,demolish,removed.state).operations[0]!;
 expect(undo.intent).toEqual({kind:'demolish'});
 expect(undo.writes.map(field=>field.scope==='cell'?field.field:'')).toEqual(['building','stage','origin']);
 expect(undo.requires.some(requirement=>requirement.kind==='cell-occupied')).toBe(true);
});

test('portable changes distinguish a street from an avenue and carry the road class',()=>{
 const before=createGame(WORLD_ID,1,blank('0:0'));
 const commandAvenue=command(before,{type:'build',tool:'avenue',cells:[{x:3,y:0}]});
 const applied=applyCommand(before,commandAvenue,[]);
 expect(applied.status).toBe('applied');
 const operation=describeChange(before,commandAvenue,applied.state).operations[0]!;
 expect(operation.intent).toEqual({kind:'build',tool:'avenue'});
 expect(operation.writes.map(field=>field.scope==='cell'?field.field:'')).toEqual(['road','roadClass','origin']);
 expect(operation.after[0]).toMatchObject({road:true,roadClass:'avenue'});
 expect(sameCell({terrain:'land',road:true},{terrain:'land',road:true,roadClass:'avenue'})).toBe(false);
});

test('ChangeSet parser refuses a build tool outside the current city schema',()=>{
 const before=createGame(WORLD_ID,1,blank('0:0'));
 const build=command(before,{type:'build',tool:'park',cells:[{x:4,y:0}]});
 const applied=applyCommand(before,build,[]);
 const value=structuredClone(changeSetValue(describeChange(before,build,applied.state))) as Record<string,unknown>;
 const operations=value['operations'] as Array<Record<string,unknown>>;
 operations[0]!.intent={kind:'build',tool:'teleporter'};
 expect(parseChangeSet(value as JsonValue)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('independent cells have no dependency and different fields, the same cell depends on the earlier operation',()=>{
 const before=createGame(WORLD_ID,1,blank('0:0'));
 const first=command(before,{type:'build',tool:'park',cells:[{x:1,y:0}]});
 const afterFirst=applyCommand(before,first,[]).state;
 const second=command(afterFirst,{type:'build',tool:'park',cells:[{x:2,y:0}]});
 const afterSecond=applyCommand(afterFirst,second,[]).state;
 const independent=combineChanges(describeChange(before,first,afterFirst),describeChange(afterFirst,second,afterSecond));
 expect(independent.operations).toHaveLength(2);
 expect(independent.operations[0]!.dependsOn).toEqual([]);
 expect(independent.operations[1]!.dependsOn).toEqual([]);
 const written=independent.operations.map(operation=>operation.writes.map(field=>field.scope==='cell'?`${field.at.chunkId}#${field.at.index}/${field.field}`:field.scope));
 expect(written[0]).not.toEqual(written[1]);
 // two operations over the same cell are ordered instead of being silently composed
 const reset=command(afterFirst,{type:'demolish',cells:[{x:1,y:0}]});
 const afterReset=applyCommand(afterFirst,reset,[]).state;
 const stacked=combineChanges(describeChange(before,first,afterFirst),describeChange(afterFirst,reset,afterReset));
 expect(stacked.operations).toHaveLength(2);
 expect(stacked.operations[0]!.id).not.toBe(stacked.operations[1]!.id);
 expect(stacked.operations[1]!.dependsOn).toEqual([stacked.operations[0]!.id]);
 // Carrying the same proposal twice renames the second copy, and its dependencies point inside that copy.
 const twice=combineChanges(stacked,stacked);
 expect(ids(twice)).toEqual([stacked.operations[0]!.id,stacked.operations[1]!.id,`${stacked.operations[0]!.id}~2`,`${stacked.operations[1]!.id}~2`]);
 expect(twice.operations[3]!.dependsOn).toEqual([`${stacked.operations[0]!.id}~2`]);
});

test('a road over a region seam and over the antimeridian stays one operation per cell',async()=>{
 const before=createGame(WORLD_ID,1,blank('0:0'));
 const edge=WORLD-1;
 const across=command(before,{type:'build',tool:'road',cells:[{x:31,y:0},{x:32,y:0},{x:0,y:0},{x:edge,y:0}]});
 const applied=applyCommand(before,across,pool());
 expect(applied.status).toBe('applied');
 const set=describeChange(before,across,applied.state);
 expect(set.operations.map(operation=>operation.places[0]!.chunkId)).toEqual(['0:0','1:0','0:0',`${WORLD/CHUNK-1}:0`]);
 expect(new Set(ids(set)).size).toBe(4);
 expect(set.operations.map(operation=>operation.places[0]!.index)).toEqual([31,0,0,31]);
 expect(set.operations.every(operation=>operation.basedOn[0]!.source==='synthetic-test')).toBe(true);
 // the destination quotes and replays the same road on both edges, and keeps its own balance and tick
 const target=await targetOf({money:1000,tick:7});
 const frozen=await attachBases(set,pool(),hasher,codec);
 expect(frozen.ok).toBe(true);
 if(!frozen.ok)return;
 const prepared=prepareProject(target,frozen.value,ids(frozen.value));
 expect(prepared.ok).toBe(true);
 if(!prepared.ok)return;
 expect(prepared.value.cost).toBe(40);
 const {money:targetMoney,tick:targetTick}=target.state;
 const importedProject=integrateProject(target.state,prepared.value);
 expect(importedProject.ok).toBe(true);
 if(!importedProject.ok)return;
 expect(importedProject.value.money).toBe(targetMoney-prepared.value.cost);
 expect(importedProject.value.tick).toBe(targetTick);
 for(const cell of [{x:31,y:0},{x:32,y:0},{x:0,y:0},{x:edge,y:0}])expect(getCell(importedProject.value,cell)?.road,`rua em ${cell.x}`).toBe(true);
 expect(getCell(importedProject.value,{x:1,y:0})?.road).toBeUndefined();
 expect(chunkId({x:edge,y:0})).toBe(`${WORLD/CHUNK-1}:0`);
});

test('an unknown namespace survives the proposal round trip and applying it',async()=>{
 const before=createGame(WORLD_ID,1,blank('0:0'));
 const write=command(before,{type:'component',key:'lifesim.residence',entity:'household-1',value:{residents:4,cell:{x:3,y:4}}});
 const applied=applyCommand(before,write,[]);
 expect(applied.status).toBe('applied');
 const set=describeChange(before,write,applied.state);
 expect(set.operations[0]!.intent).toEqual({kind:'component',key:'lifesim.residence',entity:'household-1'});
 expect(set.operations[0]!.reads).toEqual([{scope:'component',key:'lifesim.residence',entity:'household-1'}]);
 const bytes=codec.encode(changeSetValue(set));
 const parsed=parseStrictJson(textOf(bytes));
 expect(parsed.ok).toBe(true);
 if(!parsed.ok)return;
 const imported=parseChangeSet(parsed.value);
 expect(imported.ok).toBe(true);
 if(!imported.ok)return;
 expect(imported.value).toEqual({...set,bases:[]});
 expect(ids(imported.value)).toEqual(ids(set));
 // a proposal written by a later client keeps the fields this one does not know
 const foreign=parseChangeSet({...record(changeSetValue(set)),'future-proposal':{note:'written by a later client'}});
 expect(foreign.ok).toBe(true);
 if(!foreign.ok)return;
 expect(foreign.value.extensions['future-proposal']).toEqual({note:'written by a later client'});
 const target=await targetOf();
 const prepared=prepareProject(target,imported.value,ids(imported.value));
 expect(prepared.ok).toBe(true);
 if(!prepared.ok)return;
 const integrated=integrateProject(target.state,prepared.value);
 expect(integrated.ok).toBe(true);
 if(!integrated.ok)return;
 expect(integrated.value.components['lifesim.residence']!['household-1']).toEqual({residents:4,cell:{x:3,y:4}});
 expect(integrated.value.money).toBe(target.state.money);
});

test('city policy is a portable intention and its preview includes borrowing',async()=>{
 const source=createGame(WORLD_ID,1,blank('0:0'));
 const change=command(source,{type:'policy',tax:12,services:110,borrow:10_000});
 const applied=applyCommand(source,change,[]);
 expect(applied.status).toBe('applied');
 const set=describeChange(source,change,applied.state);
 expect(set.operations).toHaveLength(1);
 expect(set.operations[0]!.intent).toEqual({kind:'policy',tax:12,services:110,borrow:10_000});
 expect(set.operations[0]!.writes).toContainEqual({scope:'component',key:'city.economy',entity:'policy'});
 expect(set.operations[0]!.writes).toContainEqual({scope:'world',field:'money'});
 const encoded=codec.encode(changeSetValue(set)),parsed=parseStrictJson(textOf(encoded));
 if(!parsed.ok)throw new Error(parsed.error.message);
 const imported=parseChangeSet(parsed.value);
 expect(imported.ok).toBe(true);
 if(!imported.ok)return;
 const target=await targetOf({money:1234,tick:7});
 const prepared=prepareProject(target,imported.value,ids(imported.value));
 expect(prepared.ok).toBe(true);
 if(!prepared.ok)return;
 expect(prepared.value.cost).toBe(0);
 expect(prepared.value.moneyAfter).toBe(11_234);
 const integrated=integrateProject(target.state,prepared.value);
 expect(integrated.ok).toBe(true);
 if(!integrated.ok)return;
 expect(integrated.value.money).toBe(11_234);
 expect(integrated.value.components['city.economy']?.['policy']).toMatchObject({tax:12,services:110,debt:10_000});
 // The same policy again is not advertised as executable when the core would reject it as a no-op.
 const again=describeChange(integrated.value,command(integrated.value,{type:'policy',tax:12,services:110}),integrated.value);
 expect(again.operations).toEqual([]);
});

test('a legacy overlay edit is an opaque cell, never an invented build or demolish',async()=>{
 const set=describeEdits(legacySave.state,{worldId:legacySave.state.worldId,branchId:'main'});
 expect(set.operations).toHaveLength(1);
 const operation=set.operations[0]!;
 expect(operation.intent.kind).toBe('opaque');
 expect(operation.reads).toEqual([]);
 expect(operation.places).toEqual([{chunkId:'0:0',index:165,x:5,y:5}]);
 expect(operation.before[0]).toEqual({terrain:'land'});
 expect(operation.after[0]).toEqual({terrain:'land',building:'park',stage:1,origin:'player'});
 expect(operation.writes.map(field=>field.scope==='cell'?field.field:'')).toEqual(['building','stage','origin']);
 // and the destination must review it instead of replaying an intention nobody recorded
 const worlds=device();
 const target=await open(worlds,legacySave.state);
 const prepared=prepareProject(target.point,set,ids(set));
 expect(prepared.ok).toBe(false);
 if(prepared.ok)return;
 expect(prepared.error.code).toBe('CONFLICT');
});

test('a project is quoted by the destination and never imports the source balance or tick',async()=>{
 const worlds=device();
 const source=createGame(WORLD_ID,1,blank('0:0'));
 const build=command(source,{type:'build',tool:'park',cells:[{x:9,y:0}]});
 const applied=applyCommand(source,build,[]);
 expect(applied.state.money).toBe(source.money-30);
 const set=describeChange(source,build,applied.state);
 const frozen=await attachBases(set,[blank('0:0')],hasher,codec);
 expect(frozen.ok).toBe(true);
 if(!frozen.ok)return;
 const target=await targetOf({money:1234,tick:7});
 const prepared=prepareProject(target,frozen.value,ids(frozen.value));
 expect(prepared.ok).toBe(true);
 if(!prepared.ok)return;
 const acceptedCost=prepared.value.cost;
 expect(acceptedCost).toBe(30);
 expect(prepared.value.target).toEqual(target.head);
 expect(prepared.value.tick).toBe(target.state.tick);
 const importedProject=integrateProject(target.state,prepared.value,pool());
 expect(importedProject.ok).toBe(true);
 if(!importedProject.ok)return;
 expect(importedProject.value.money).toBe(target.state.money-acceptedCost);
 expect(importedProject.value.tick).toBe(target.state.tick);
 expect(importedProject.value.money).not.toBe(applied.state.money);
 // a destination that cannot pay refuses the whole project instead of applying part of it
 const poor=await targetOf({money:20,tick:7});
 const refused=prepareProject(poor,frozen.value,ids(frozen.value));
 expect(refused.ok).toBe(false);
 if(refused.ok)return;
 expect(refused.error.code).toBe('CONFLICT');
 expect(poor.state.money).toBe(20);
 // and a cell the destination already occupies is stale for every author nobody verified
 const occupied=adopted('0:0');
 occupied.chunks['0:0']={...occupied.chunks['0:0']!,edits:{[cellIndex({x:9,y:0})]:{terrain:'land',building:'park',stage:1,origin:'player'}}};
 const built=await open(worlds,occupied);
 const claimed=prepareProject(built.point,{...frozen.value,author:'prefeito'},ids(frozen.value));
 expect(claimed.ok).toBe(false);
 if(claimed.ok)return;
 expect(claimed.error.code).toBe('CONFLICT');
});

test('a carried base is what lets the destination use a region it never adopted',async()=>{
 const worlds=device();
 const source=createGame(WORLD_ID,1,blank('0:0'));
 const build=command(source,{type:'build',tool:'road',cells:[{x:3,y:0}]});
 const applied=applyCommand(source,build,[]);
 const set=describeChange(source,build,applied.state);
 const frozen=await attachBases(set,[blank('0:0')],hasher,codec);
 expect(frozen.ok).toBe(true);
 if(!frozen.ok)return;
 expect(frozen.value.bases).toHaveLength(1);
 expect(frozen.value.bases[0]!.value).toEqual({kind:'base-chunk',base:blank('0:0')});
 // the objects travel addressed: a tampered base or a dropped one is refused instead of adopted
 expect(await verifyChangeSet(frozen.value,hasher,codec)).toMatchObject({ok:true});
 const tampered={...frozen.value,bases:[{ref:frozen.value.bases[0]!.ref,value:{kind:'base-chunk',base:{...blank('0:0'),source:'outro-mapa'}}}]};
 const broken=await verifyChangeSet(tampered,hasher,codec);
 expect(broken.ok).toBe(false);
 const partial=await verifyChangeSet({...frozen.value,bases:[]},hasher,codec);
 expect(partial.ok).toBe(false);
 if(partial.ok)return;
 expect(partial.error.code).toBe('MISSING_OBJECT');
 // a destination without the region accepts it because the frozen base came along; one with a different map refuses
 const bare=await open(worlds,createGame('outra',1,blank('9:9')));
 const carried=prepareProject(bare.point,frozen.value,ids(frozen.value));
 expect(carried.ok).toBe(true);
 if(!carried.ok)return;
 const mapped=await open(worlds,{...adopted('0:0'),chunks:{'0:0':adopt({...blank('0:0'),source:'outro-mapa'})}});
 const conflict=prepareProject(mapped.point,frozen.value,ids(frozen.value));
 expect(conflict.ok).toBe(false);
 if(conflict.ok)return;
 expect(conflict.error.code).toBe('CONFLICT');
 const unknown=prepareProject(bare.point,set,ids(set));
 expect(unknown.ok).toBe(false);
 if(unknown.ok)return;
 expect(unknown.error.code).toBe('MISSING_OBJECT');
 const selected=prepareProject(bare.point,frozen.value,['nao-existe']);
 expect(selected.ok).toBe(false);
 if(selected.ok)return;
 expect(selected.error.code).toBe('MALFORMED');
});

test('the diff separates real data, player work, simulation and metadata',async()=>{
 const worlds=device();
 const other=createWorldRepository({storage:createWorldMemoryStorage({}),codec,hasher});
 const pointA=await open(worlds,cityWith(mapA));
 const pointB=await open(other,cityWith(mapB,'outra'));
 const mapDiff=diffWorlds(pointA.point,pointB.point);
 const region=mapDiff.regions.find(entry=>entry.chunkId==='48557:74362');
 expect(region).toBeDefined();
 expect(region!.real).toBe(32);
 expect(region!.player).toBe(0);
 expect(region!.baseChanged).toBe(true);
 expect(region!.source).toBe(mapB.source);
 expect(mapDiff.counts.real).toBe(32);
 expect(mapDiff.counts.player).toBe(0);
 expect(mapDiff.estimate.cost).toBe(0);
 // the map a later capture draws never shows up as work somebody did here
 expect(region!.cells.every(cell=>cell.layer==='real')).toBe(true);
 // and the player's own work never shows up as real data
 const built=adopted('0:0');
 const park={x:5,y:0};
 const action=command(built,{type:'build',tool:'park',cells:[park]});
 const applied=applyCommand(built,action,[]);
 const committed=await worlds.commit(pointA.head,{id:'local-1',state:applied.state,operations:['Parque em 1 célula(s)'],objects:[],author:'local-player'});
 expect(committed.ok).toBe(true);
 if(!committed.ok)return;
 const child=await worlds.checkout(committed.value);
 if(!child.ok)throw new Error(child.error.message);
 const workDiff=diffWorlds(pointA.point,child.value);
 expect(workDiff.counts.real).toBe(0);
 expect(workDiff.counts.player).toBe(1);
 expect(workDiff.estimate).toMatchObject({cost:30,built:1,removed:0});
 const work=workDiff.regions.find(entry=>entry.chunkId==='0:0')!;
 expect(work.player).toBe(1);
 expect(work.cells[0]!.origin).toBe('player');
 expect(work.cells[0]!.after?.building).toBe('park');
 expect(workDiff.simulation.money).toEqual({before:20000,after:19970});
 expect(workDiff.counts.simulation).toBe(1);
 expect(workDiff.metadata.actors).toEqual([{actorId:'local-player',before:0,after:1}]);
 expect(workDiff.metadata.revision).toEqual({before:0,after:1});
});

test('the session records the intention of the last accepted command and keeps it when one is refused',async()=>{
 const maps:MapSource={attribution:{text:'© OpenStreetMap',url:'https://www.openstreetmap.org/copyright'},loadChunk:async(id:string)=>blank(id)};
 const session=createSession({maps,saves:createMemoryStore(),worldId:WORLD_ID,seed:1});
 await session.initialize('0:0');
 expect(session.lastChange()).toBeNull();
 const applied=session.dispatch({type:'build',tool:'park',cells:[{x:4,y:0}]});
 expect(applied.status).toBe('applied');
 const described=session.lastChange();
 expect(described?.operations[0]?.intent).toEqual({kind:'build',tool:'park'});
 expect(session.dispatch({type:'build',tool:'park',cells:[{x:4,y:0}]}).status).toBe('rejected');
 // Nothing changed, so the record still describes the change that did happen instead of vanishing.
 expect(session.lastChange()).toBe(described);
});
