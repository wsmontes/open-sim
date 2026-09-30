import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {applyCommand,createGame} from '../src/core/commands';
import {CHUNK,cellIndex,chunkId,coordAt} from '../src/core/coordinates';
import {summarize} from '../src/core/simulation';
import {adopt,getCell} from '../src/core/world';
import {applyBaseUpdate,baseDisagreements} from '../src/core/base-update';
import type {ApprovedBaseUpdate} from '../src/core/base-update';
import {integrateProject} from '../src/world/city-profile';
import {prepareCompensation,previewBaseUpdate,resolveMerge} from '../src/world/merge';
import type {MergePreview} from '../src/world/merge';
import {captureBase} from '../src/world/reality';
import type {CaptureContext,CapturedBase} from '../src/world/reality';
import {createWorldRepository} from '../src/session/world-repository';
import type {Checkpoint,WorldRepository} from '../src/session/world-repository';
import {importLegacy} from '../src/session/world-bundle';
import type {BaseChunk,Cell,Command,GameState,ViewState} from '../src/core/model';
import type {Head,JsonValue} from '../src/world/model';
import {blank,command} from './fixtures/world';
import fixtureA from './fixtures/federated-world/base-a.json';
import fixtureB from './fixtures/federated-world/base-b.json';

const codec=createJcsCodec(),hasher=bytesHasher();
const WORLD_ID='victoria';
const VIEW:ViewState={x:0,y:0,zoom:1,speed:0,place:'Victoria'};
const mapA=fixtureA as BaseChunk,mapB=fixtureB as BaseChunk;
const REGION='48557:74362',PARKED=330,PLAIN=165;
// The fixture region is a real grid address: its cells are the ones the repository reads back.
const PARK=coordAt(REGION,PARKED),NEIGHBOUR=coordAt(REGION,PARKED+1);
// The synthetic region of the plan's example: a parking lot that the player turns into a park and a second map that
// draws a building on the same ground. Neither fixture is OSM, and no test below opens a network.
const context=(over:Partial<CaptureContext>={}):CaptureContext=>({
 codec,
 source:{id:'fixture-b',dataset:mapB.source,url:'https://example.invalid/fixture-b/{z}/{x}/{y}.mvt'},
 terms:{attribution:'Fixture sintética'},
 transformation:{name:'osm-shortbread',version:1},
 capture:{level:'detail',zoom:14},
 retrievedAt:'2026-09-29T12:00:00Z',
 ...over,
});
const device=()=>createWorldRepository({storage:createWorldMemoryStorage({}),codec,hasher});
async function open(worlds:WorldRepository,state:GameState):Promise<{head:Head;point:Checkpoint}>{
 const bundle=await importLegacy({version:1,state,view:VIEW},hasher,codec);
 if(!bundle.ok)throw new Error(bundle.error.message);
 const created=await worlds.create(bundle.value);
 if(!created.ok)throw new Error(created.error.message);
 const point=await worlds.checkout(created.value);
 if(!point.ok)throw new Error(point.error.message);
 return {head:created.value,point:point.value};
}
const built=(state:GameState,action:Command['action']):GameState=>{
 const applied=applyCommand(state,command(state,action),[]);
 expect(applied.status).toBe('applied');
 return applied.state;
};
const baseRefOf=(point:Checkpoint,id:string)=>point.bases.find(base=>base.id===id)!.ref;
// The captured revision supersedes exactly the base this version rests on, which is what a real update has to prove.
async function updateOf(point:Checkpoint,base:BaseChunk,over:Partial<CaptureContext>={}):Promise<CapturedBase>{
 return captureBase(base,context({previous:[baseRefOf(point,base.id)],...over}),hasher);
}
const choicesFor=(preview:MergePreview,choose:'target'|'source')=>preview.conflicts.filter(conflict=>conflict.choices.length).map(conflict=>({conflict:conflict.id,choose}));
const kinds=(preview:MergePreview)=>preview.conflicts.map(conflict=>conflict.kind);
const ids=(preview:MergePreview)=>preview.conflicts.map(conflict=>conflict.id);

test('the preview shows the decisions and the resulting capacity before a real update is accepted',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,mapA);
 const {head,point}=await open(worlds,shared);
 const ana=await worlds.fork(head,{worldId:WORLD_ID,branchId:'ana'});
 if(!ana.ok)throw new Error(ana.error.message);
 const parked={terrain:'land',building:'park',stage:1,origin:'player'} as Cell;
 const committed=await worlds.commit(ana.value,{id:'parque',state:{...shared,chunks:{...shared.chunks,[REGION]:{...shared.chunks[REGION]!,edits:{[PARKED]:parked}}}},operations:['Parque'],objects:[],author:'ana'});
 if(!committed.ok)throw new Error(committed.error.message);
 const target=await worlds.checkout(committed.value);
 if(!target.ok)throw new Error(target.error.message);
 const captured=await updateOf(point,mapB);
 const preview=previewBaseUpdate(target.value,[captured]);
 expect(preview.kind).toBe('base');
 expect(kinds(preview)).toEqual(['overlay']);
 expect(ids(preview)).toEqual([`overlay:${REGION}#${PARKED}`]);
 expect(preview.conflicts[0]!.at).toEqual({chunkId:REGION,index:PARKED,...PARK});
 expect(preview.conflicts[0]!.target).toEqual(parked);
 expect(preview.conflicts[0]!.source).toEqual({terrain:'land',building:'residential',stage:1,origin:'imported'});
 // the 31 real cells the player never touched are real data: they change the ground without a question
 expect(preview.updates).toHaveLength(1);
 expect(preview.updates[0]!.base).toEqual(mapB);
 expect(preview.stats.before.population).toBe(0);
 // the candidate keeps the park, so one of the 32 real buildings stays unoccupied until the review decides
 expect(preview.stats.after.population).toBe(124);
 expect(preview.stats.after.energyUsed).toBe(summarize(preview.candidate).energyUsed);
 expect(preview.stats.after.population).toBe(summarize(preview.candidate).population);
 // no retroactive income and no time travel: the preview promises the balance and the tick the version already has
 expect(preview.candidate.money).toBe(target.value.state.money);
 expect(preview.moneyAfter).toBe(target.value.state.money);
 expect(preview.tick).toBe(target.value.state.tick);
 expect(preview.candidate.tick).toBe(target.value.state.tick);
 // preserving the park adopts the new ground and records that the overlay diverges from it
 const kept=resolveMerge(preview,choicesFor(preview,'target'));
 expect(kept.ok).toBe(true);
 if(!kept.ok)return;
 expect(kept.value.cost).toBe(0);
 expect(kept.value.bases).toEqual(captured.objects);
 expect(kept.value.records?.some(record=>record.startsWith(`base-divergence:${REGION}#${PARKED}`))).toBe(true);
 const preserved=integrateProject(target.value.state,kept.value);
 expect(preserved.ok).toBe(true);
 if(!preserved.ok)return;
 expect(preserved.value.chunks[REGION]!.base.source).toBe(mapB.source);
 expect(getCell(preserved.value,PARK)).toEqual(parked);
 expect(getCell(preserved.value,NEIGHBOUR)?.building).toBe('residential');
 expect(preserved.value.money).toBe(target.value.state.money);
 expect(preserved.value.tick).toBe(target.value.state.tick);
 expect(summarize(preserved.value).population).toBe(124);
 // adopting the building resolves the park away and there is no divergence left
 const adopted=resolveMerge(preview,choicesFor(preview,'source'));
 expect(adopted.ok).toBe(true);
 if(!adopted.ok)return;
 expect(adopted.value.records?.some(record=>record.startsWith('base-divergence:'))).toBe(false);
 const replaced=integrateProject(target.value.state,adopted.value);
 if(!replaced.ok)return;
 expect(getCell(replaced.value,PARK)).toEqual({terrain:'land',building:'residential',stage:1,origin:'imported'});
 expect(summarize(replaced.value).population).toBe(128);
 expect(replaced.value.chunks[REGION]!.edits[String(PARKED)]).toBeUndefined();
 // the durable path: the choice produces a version with B referenced as data and A still reachable from history
 const durable=await worlds.commitPrepared(committed.value,kept.value);
 expect(durable.ok).toBe(true);
 if(!durable.ok)return;
 const version=await worlds.checkout(durable.value);
 if(!version.ok)throw new Error(version.error.message);
 expect(version.value.state.chunks[REGION]!.base.source).toBe(mapB.source);
 expect(getCell(version.value.state,PARK)).toEqual(parked);
 expect(version.value.state.money).toBe(target.value.state.money);
 expect(version.value.state.tick).toBe(target.value.state.tick);
 expect(version.value.commit.parents).toEqual([committed.value.commit]);
 expect(version.value.commit.datasets.map(ref=>ref.hash)).toContain(captured.objects[1]!.ref.hash);
 expect(version.value.commit.accepted.some(entry=>entry.startsWith('base-update:'))).toBe(true);
 const earlier=await worlds.checkout(committed.value);
 if(!earlier.ok)throw new Error(earlier.error.message);
 expect(earlier.value.bases.find(base=>base.id===REGION)!.ref.hash).not.toBe(version.value.bases.find(base=>base.id===REGION)!.ref.hash);
 // the ground the earlier version rests on is still readable, and the new one is what its version carries
 expect(earlier.value.state.chunks[REGION]!.base.source).toBe(mapA.source);
 const exported=await worlds.export(durable.value);
 expect(exported.ok).toBe(true);
 if(!exported.ok)return;
 expect(exported.value.objects.some(object=>object.ref.hash===version.value.bases.find(base=>base.id===REGION)!.ref.hash)).toBe(true);
 // an undecided conflict is refused instead of resolved by the last layer that arrived
 const undecided=resolveMerge({...preview,conflicts:preview.conflicts},[]);
 expect(undecided.ok).toBe(false);
 if(undecided.ok)return;
 expect(undecided.error.code).toBe('CONFLICT');
});

test('applying a real update recalculates the capacity and the balance of the region and keeps every other decision',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const other={terrain:'land',building:'commercial',stage:1,origin:'player'} as Cell;
 const edited={...shared,chunks:{...shared.chunks,'0:0':{...shared.chunks['0:0']!,edits:{[PLAIN]:other}}},money:777,tick:12};
 const {head,point}=await open(worlds,edited);
 const grown={...blank('0:0'),source:'fixture-c'} as BaseChunk;
 const cells=[...grown.cells];
 cells[200]={terrain:'land',building:'power',stage:1,origin:'imported'};
 cells[201]={terrain:'water'};
 const captured=await updateOf(point,{...grown,cells});
 const preview=previewBaseUpdate(point,[captured]);
 // the player's building is not challenged by the new ground, so nothing is asked and the update composes
 expect(preview.conflicts).toEqual([]);
 expect(baseDisagreements(point.state.chunks['0:0']!,{...grown,cells})).toEqual([]);
 const resolved=resolveMerge(preview,[]);
 expect(resolved.ok).toBe(true);
 if(!resolved.ok)return;
 const applied=applyBaseUpdate(point.state,{...preview.updates[0]!,expectedRevision:point.state.revision});
 expect(applied.status).toBe('applied');
 const next=applied.state,present=next.chunks['0:0']!;
 expect(present.base.source).toBe('fixture-c');
 expect(present.baseEnergy).toBe(adopt({...grown,cells}).baseEnergy);
 expect(present.balanceAdjustment).toBe(adopt({...grown,cells}).balanceAdjustment);
 expect(present.edits[PLAIN]).toEqual(other);
 expect(next.money).toBe(777);
 expect(next.tick).toBe(12);
 expect(next.revision).toBe(point.state.revision+1);
 expect(summarize(next).energySupply).toBeGreaterThan(summarize(point.state).energySupply);
 expect(next.components).toEqual(point.state.components);
 expect(next.actors).toEqual(point.state.actors);
 // a resolution for a cell the two sides never disagreed about would silently drop the player's work
 const invented=applyBaseUpdate(point.state,{...preview.updates[0]!,resolutions:[{at:coordAt('0:0',PLAIN),choose:'base'}],expectedRevision:point.state.revision});
 expect(invented.status).toBe('rejected');
 // an incomplete review is refused too
 const incomplete:ApprovedBaseUpdate={...preview.updates[0]!,resolutions:[],expectedRevision:point.state.revision};
 const parked={terrain:'land',building:'park',stage:1,origin:'player'} as Cell;
 const tampered={...edited,chunks:{...edited.chunks,'0:0':{...edited.chunks['0:0']!,edits:{...edited.chunks['0:0']!.edits,[201]:parked}}}};
 const withDisagreement=baseDisagreements(tampered.chunks['0:0']!,{...grown,cells});
 expect(withDisagreement).toEqual([201]);
 expect(applyBaseUpdate(tampered,{...incomplete,resolutions:[]}).status).toBe('rejected');
 expect(applyBaseUpdate(tampered,{...incomplete,resolutions:[{at:coordAt('0:0',201),choose:'player'}],expectedRevision:tampered.revision}).status).toBe('applied');
 // an update approved against another revision, or for a region this version never adopted, is refused
 const stale=applyBaseUpdate({...point.state,revision:point.state.revision+1},{...preview.updates[0]!,expectedRevision:point.state.revision});
 expect(stale.status).toBe('rejected');
 const wrongBase={...preview.updates[0]!,expect:{source:'outro-mapa',normalizerVersion:1 as const}};
 expect(applyBaseUpdate(point.state,{...wrongBase,expectedRevision:point.state.revision}).status).toBe('rejected');
 const absent={...preview.updates[0]!,chunkId:'9:9',base:{...grown,cells,id:'9:9'}};
 expect(applyBaseUpdate(point.state,{...absent,expectedRevision:point.state.revision}).status).toBe('rejected');
 expect(point.state.chunks['0:0']!.base.source).toBe('synthetic-test');
});

test('a capture that does not supersede the base of this version, or does not match its own address, is refused',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,mapA);
 const {point}=await open(worlds,shared);
 const foreign=await captureBase(mapB,context(),hasher);
 const unknown=previewBaseUpdate(point,[{...foreign,base:{...mapB,source:'outra-captura'}}]);
 // the objects it carries address the region it captured, so a base swapped under the same objects never opens
 expect(kinds(unknown)).toEqual(['captured']);
 const refused=resolveMerge(unknown,[]);
 expect(refused.ok).toBe(false);
 if(refused.ok)return;
 expect(refused.error.code).toBe('CONFLICT');
 // a revision whose `previous` is not this version's base is not an update of it
 const ahead=await captureBase(mapB,context({previous:[{hash:'0'.repeat(64),bytes:1}]}),hasher);
 const late=previewBaseUpdate(point,[ahead]);
 expect(kinds(late)).toEqual(['revision']);
 expect(late.updates).toEqual([]);
 const lastRefused=resolveMerge(late,[]);
 expect(lastRefused.ok).toBe(false);
 // a capture of the ground this version already has changes nothing and says so instead of quietly doing nothing
 const noChange=await updateOf(point,mapA);
 const same=previewBaseUpdate(point,[noChange]);
 expect(kinds(same)).toEqual(['captured']);
 expect(same.conflicts[0]!.message).toContain('não muda nada');
});

test('undoing a power plant that already paid income charges the current price of a demolition and pays nothing back',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const {head}=await open(worlds,shared);
 const planted=built(shared,{type:'build',tool:'power',cells:[{x:9,y:9}]});
 const plantId=`build:power@0:0#${cellIndex({x:9,y:9})}`;
 expect(planted.money).toBe(shared.money-500);
 const plantHead=await worlds.commitPrepared(head,{origins:[],target:head,selection:[],operations:[],bases:[],cost:500,moneyAfter:planted.money,tick:planted.tick,requires:[],state:planted,records:[plantId]});
 expect(plantHead.ok).toBe(true);
 if(!plantHead.ok)return;
 const builtPoint=await worlds.checkout(plantHead.value);
 if(!builtPoint.ok)throw new Error(builtPoint.error.message);
 // the plant fed the city for a while: the ticks were paid, and the balance moved with them
 const ticked={...planted,money:planted.money+90,tick:planted.tick+31};
 const tickedHead=await worlds.commit(plantHead.value,{id:'tick-31',state:ticked,operations:['tick@31'],objects:[],author:'local-player'});
 if(!tickedHead.ok)throw new Error(tickedHead.error.message);
 const current=await worlds.checkout(tickedHead.value);
 if(!current.ok)throw new Error(current.error.message);
 const compensation=prepareCompensation(current.value,builtPoint.value.commit);
 expect(compensation.ok).toBe(true);
 if(!compensation.ok)return;
 expect(compensation.value.cost).toBe(5);
 expect(compensation.value.moneyAfter).toBe(ticked.money-5);
 expect(compensation.value.tick).toBe(ticked.tick);
 expect(compensation.value.operations.map(operation=>operation.id)).toEqual([`demolish@0:0#${cellIndex({x:9,y:9})}`]);
 expect(compensation.value.operations[0]!.intent).toEqual({kind:'demolish'});
 expect(compensation.value.records).toEqual([`compensation:${plantId}`]);
 const undone=await worlds.commitPrepared(tickedHead.value,compensation.value);
 expect(undone.ok).toBe(true);
 if(!undone.ok)return;
 const after=await worlds.checkout(undone.value);
 if(!after.ok)throw new Error(after.error.message);
 expect(getCell(after.value.state,{x:9,y:9})).toEqual({terrain:'land'});
 expect(getCell(after.value.state,{x:9,y:9})?.building).toBeUndefined();
 // the plant that was already used pays nothing back, and the shared history keeps both versions
 expect(after.value.state.money).toBe(ticked.money-5);
 expect(after.value.state.tick).toBe(ticked.tick);
 expect(after.value.commit.parents).toEqual([tickedHead.value.commit]);
 const versions=await worlds.history(undone.value);
 expect(versions.ok).toBe(true);
 if(!versions.ok)return;
 expect(versions.value.map(version=>version.accepted)).toEqual([
  [`demolish@0:0#${cellIndex({x:9,y:9})}`,`compensation:${plantId}`],
  ['tick@31'],
  [plantId],
  [],
 ]);
});

test('an undo of something the commit does not record as an intention is refused instead of guessed',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const {head,point}=await open(worlds,shared);
 const parked=built(shared,{type:'build',tool:'park',cells:[{x:2,y:2}]});
 // a version recorded by a client that wrote a sentence instead of the operation it accepted
 const label=await worlds.commitPrepared(head,{origins:[],target:head,selection:[],operations:[],bases:[],cost:30,moneyAfter:parked.money,tick:parked.tick,requires:[],state:parked,records:['Parque em 1 célula(s)']});
 expect(label.ok).toBe(true);
 if(!label.ok)return;
 const labelled=await worlds.checkout(label.value);
 if(!labelled.ok)throw new Error(labelled.error.message);
 const unlabelled=prepareCompensation(labelled.value,labelled.value.commit);
 expect(unlabelled.ok).toBe(false);
 if(unlabelled.ok)return;
 expect(unlabelled.error.code).toBe('MALFORMED');
 // a recorded demolition cannot be restored by a compensating operation, and the refusal names the operation
 const commit=await worlds.commit(label.value,{id:'demoli',state:built(parked,{type:'demolish',cells:[{x:2,y:2}]}),operations:[`demolish@0:0#${cellIndex({x:2,y:2})}`],objects:[],author:'local-player'});
 if(!commit.ok)throw new Error(commit.error.message);
 const demolished=await worlds.checkout(commit.value);
 if(!demolished.ok)throw new Error(demolished.error.message);
 const restore=prepareCompensation(demolished.value,demolished.value.commit);
 expect(restore.ok).toBe(false);
 if(restore.ok)return;
 expect(restore.error.message).toContain('demolish@0:0#66');
 // a version that already lost the work has nothing to compensate, and a plan that cannot pay is refused
 const gone=prepareCompensation(demolished.value,{accepted:[`build:park@0:0#${cellIndex({x:2,y:2})}`]});
 expect(gone.ok).toBe(false);
 if(gone.ok)return;
 expect(gone.error.message).toContain('já não está');
 const poor={...labelled.value,state:{...labelled.value.state,money:3}};
 const unpaid=prepareCompensation(poor,{accepted:[`build:park@${chunkId({x:2,y:2})}#${cellIndex({x:2,y:2})}`]});
 expect(unpaid.ok).toBe(false);
 if(unpaid.ok)return;
 expect(unpaid.error.code).toBe('CONFLICT');
});
