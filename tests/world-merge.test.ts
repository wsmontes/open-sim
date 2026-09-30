import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {applyCommand,createGame} from '../src/core/commands';
import {cellIndex,coordAt} from '../src/core/coordinates';
import {adopt,getCell} from '../src/core/world';
import {integrateProject,prepareProject} from '../src/world/city-profile';
import {changeSetValue,combineChanges,describeChange,parseChangeSet} from '../src/world/changes';
import {decodeUtf8,parseStrictJson} from '../src/world/codec';
import {previewMerge,resolveMerge} from '../src/world/merge';
import type {MergePreview} from '../src/world/merge';
import {createWorldRepository} from '../src/session/world-repository';
import type {Checkpoint,WorldRepository} from '../src/session/world-repository';
import {importLegacy} from '../src/session/world-bundle';
import type {BaseChunk,Cell,CellCoord,Command,GameState,SavedGame,Tool,ViewState} from '../src/core/model';
import type {Head} from '../src/world/model';
import {blank,command} from './fixtures/world';
import fixtureA from './fixtures/federated-world/base-a.json';
import fixtureB from './fixtures/federated-world/base-b.json';

const codec=createJcsCodec(),hasher=bytesHasher();
const WORLD_ID='victoria';
const VIEW:ViewState={x:0,y:0,zoom:1,speed:0,place:'Victoria'};
const mapA=fixtureA as BaseChunk,mapB=fixtureB as BaseChunk;
const REGION='48557:74362',PARKED=330;
// The fixture region is a real grid address, so its cells are far from the origin of the synthetic regions.
const PARK=coordAt(REGION,PARKED),NEIGHBOUR=coordAt(REGION,PARKED+1),FREE=coordAt(REGION,165);
const device=()=>createWorldRepository({storage:createWorldMemoryStorage({}),codec,hasher});
const save=(state:GameState):SavedGame=>({version:1,state,view:VIEW});
async function open(worlds:WorldRepository,state:GameState):Promise<{head:Head;point:Checkpoint}>{
 const bundle=await importLegacy(save(state),hasher,codec);
 if(!bundle.ok)throw new Error(bundle.error.message);
 const created=await worlds.create(bundle.value);
 if(!created.ok)throw new Error(created.error.message);
 const point=await worlds.checkout(created.value);
 if(!point.ok)throw new Error(point.error.message);
 return {head:created.value,point:point.value};
}
// A second arm of the same world: a branch keeps the world identity, so a merge between two arms is a real three-way
// comparison and a merge against another world is asked for explicitly instead of smuggled in by a name.
async function arm(worlds:WorldRepository,from:Head,branchId:string,state:GameState,id:string):Promise<Checkpoint>{
 const forked=await worlds.fork(from,{worldId:from.worldId,branchId});
 if(!forked.ok)throw new Error(forked.error.message);
 const committed=await worlds.commit(forked.value,{id,state,operations:[],objects:[],author:'local-player'});
 if(!committed.ok)throw new Error(committed.error.message);
 const point=await worlds.checkout(committed.value);
 if(!point.ok)throw new Error(point.error.message);
 return point.value;
}
const built=(state:GameState,action:Command['action']):GameState=>{
 const applied=applyCommand(state,command(state,action),[]);
 expect(applied.status).toBe('applied');
 return applied.state;
};
const overlay=(state:GameState,chunkId:string,index:number,cell:Cell):GameState=>({
 ...state,
 chunks:{...state.chunks,[chunkId]:{...state.chunks[chunkId]!,edits:{...state.chunks[chunkId]!.edits,[index]:cell}}},
});
// A proposal as it travels: intentions through the world codec, read back by whoever received the file.
const proposalFile=(from:GameState,tool:Tool,cell:CellCoord)=>{
 const after=built(from,{type:'build',tool,cells:[cell]});
 const bytes=codec.encode(changeSetValue(describeChange(from,command(from,{type:'build',tool,cells:[cell]}),after)));
 const text=decodeUtf8(bytes);
 if(!text.ok)throw new Error(text.error.message);
 const parsed=parseStrictJson(text.value);
 if(!parsed.ok)throw new Error(parsed.error.message);
 const read=parseChangeSet(parsed.value);
 if(!read.ok)throw new Error(read.error.message);
 return read.value;
};
const chosenIds=(set:{operations:readonly {id:string}[]})=>set.operations.map(operation=>operation.id);
const choicesFor=(preview:MergePreview,choose:'target'|'source')=>preview.conflicts.filter(conflict=>conflict.choices.length).map(conflict=>({conflict:conflict.id,choose}));
const kinds=(preview:MergePreview)=>preview.conflicts.map(conflict=>conflict.kind);
const ids=(preview:MergePreview)=>preview.conflicts.map(conflict=>conflict.id);

test('a player park over a parking lot against a later real building conflicts, and preserving the park adopts the new ground',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,mapA);
 const {head,point:ancestor}=await open(worlds,shared);
 const ana=await arm(worlds,head,'ana',overlay(shared,REGION,PARKED,{terrain:'land',building:'park',stage:1,origin:'player'}),'parque-1');
 const real=await arm(worlds,head,'real',{...shared,chunks:{...shared.chunks,[REGION]:adopt(mapB)}},'base-b');
 const preview=previewMerge(ancestor,ana,real,[]);
 expect(preview.kind).toBe('merge');
 expect(kinds(preview)).toEqual(['overlay']);
 expect(ids(preview)).toEqual([`overlay:${REGION}#${PARKED}`]);
 const conflict=preview.conflicts[0]!;
 expect(conflict.at).toEqual({chunkId:REGION,index:PARKED,...PARK});
 expect(conflict.choices).toEqual(['target','source']);
 expect(conflict.target).toEqual({terrain:'land',building:'park',stage:1,origin:'player'});
 expect(conflict.source).toEqual({terrain:'land',building:'residential',stage:1,origin:'imported'});
 // the candidate keeps the player's work over the new ground, and the review sees what the ground brings before accepting it
 expect(preview.candidate.chunks[REGION]!.base.source).toBe(mapB.source);
 expect(getCell(preview.candidate,PARK)?.building).toBe('park');
 expect(preview.stats.before.population).toBe(0);
 // 31 of the 32 real buildings stand where the park does not: the park keeps one of them from being occupied
 expect(preview.stats.after.population).toBe(124);
 expect(preview.cost).toBe(0);
 expect(preview.moneyAfter).toBe(ana.state.money);
 expect(preview.tick).toBe(ana.state.tick);
 // nothing is decided by the preview, and the change is not applied to the version it was prepared against
 expect(getCell(ana.state,PARK)?.building).toBe('park');
 expect(ana.state.chunks[REGION]!.base.source).toBe(mapA.source);
 // preserving the park adopts the new origin and records the divergence from it
 const kept=resolveMerge(preview,choicesFor(preview,'target'));
 expect(kept.ok).toBe(true);
 if(!kept.ok)return;
 expect(kept.value.cost).toBe(0);
 expect(kept.value.moneyAfter).toBe(ana.state.money);
 expect(kept.value.records).toContain(`base-update:${REGION}@${real.bases.find(base=>base.id===REGION)!.ref.hash.slice(0,12)}`);
 expect(kept.value.records?.some(record=>record.startsWith(`base-divergence:${REGION}#${PARKED}`))).toBe(true);
 const preserved=integrateProject(ana.state,kept.value);
 expect(preserved.ok).toBe(true);
 if(!preserved.ok)return;
 expect(preserved.value.chunks[REGION]!.base.source).toBe(mapB.source);
 expect(getCell(preserved.value,PARK)).toEqual({terrain:'land',building:'park',stage:1,origin:'player'});
 expect(getCell(preserved.value,NEIGHBOUR)?.building).toBe('residential');
 expect(preserved.value.money).toBe(ana.state.money);
 expect(preserved.value.tick).toBe(ana.state.tick);
 // adopting the building instead resolves the park away, and then there is no divergence left to record
 const adopted=resolveMerge(preview,choicesFor(preview,'source'));
 expect(adopted.ok).toBe(true);
 if(!adopted.ok)return;
 expect(adopted.value.records?.some(record=>record.startsWith('base-divergence:'))).toBe(false);
 const replaced=integrateProject(ana.state,adopted.value);
 expect(replaced.ok).toBe(true);
 if(!replaced.ok)return;
 expect(getCell(replaced.value,PARK)).toEqual({terrain:'land',building:'residential',stage:1,origin:'imported'});
 expect(replaced.value.chunks[REGION]!.edits[String(PARKED)]).toBeUndefined();
});

test('two versions that built different things on one cell conflict, and the same value twice is deduplicated instead of charged',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const {head,point:ancestor}=await open(worlds,shared);
 const park=await arm(worlds,head,'ana',built(shared,{type:'build',tool:'park',cells:[{x:5,y:5}]}),'parque');
 const house=await arm(worlds,head,'real',built(shared,{type:'build',tool:'residential',cells:[{x:5,y:5}]}),'casa');
 const preview=previewMerge(ancestor,park,house,[`opaque@0:0#${cellIndex({x:5,y:5})}`]);
 expect(preview.actions.map(action=>action.id)).toEqual([`opaque@0:0#${cellIndex({x:5,y:5})}`]);
 expect(ids(preview)).toEqual([`field:0:0#${cellIndex({x:5,y:5})}/building`,`field:0:0#${cellIndex({x:5,y:5})}/stage`]);
 expect(preview.conflicts.map(conflict=>conflict.kind)).toEqual(['field','field']);
 expect(preview.conflicts.map(conflict=>conflict.field)).toEqual(['building','stage']);
 // the origin arrived at the same value on both sides: one fact, not questioned twice
 expect(preview.conflicts.some(conflict=>conflict.field==='origin')).toBe(false);
 // the conservative candidate keeps the park, so keeping it integrates nothing and produces no version
 expect(preview.cost).toBe(0);
 expect(preview.candidate).toEqual(park.state);
 const kept=resolveMerge(preview,choicesFor(preview,'target'));
 expect(kept.ok).toBe(false);
 if(kept.ok)return;
 expect(kept.error.code).toBe('MALFORMED');
 // adopting the building is priced by the destination's own table, never by the balance of the other version
 const adopted=resolveMerge(preview,choicesFor(preview,'source'));
 if(!adopted.ok)return;
 expect(adopted.value.cost).toBe(40);
 expect(adopted.value.moneyAfter).toBe(park.state.money-40);
 expect(getCell(adopted.value.state!,{x:5,y:5})?.building).toBe('residential');
 // both arms reached the same value: nothing to integrate and nothing to charge
 const twin=await arm(worlds,head,'twin',built(shared,{type:'build',tool:'park',cells:[{x:5,y:5}]}),'parque-2');
 const same=previewMerge(ancestor,park,twin,[`opaque@0:0#${cellIndex({x:5,y:5})}`]);
 expect(same.conflicts).toEqual([]);
 expect(same.cost).toBe(0);
 expect(same.candidate.money).toBe(park.state.money);
});

test('two selected changes that fit the balance separately are refused together',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const {head,point:ancestor}=await open(worlds,shared);
 const rich=await arm(worlds,head,'ana',built(built(shared,{type:'build',tool:'park',cells:[{x:1,y:0}]}),{type:'build',tool:'road',cells:[{x:2,y:0}]}),'obra');
 const poor=await arm(worlds,head,'poor',{...shared,money:35},'sem-saldo');
 const selection=[`opaque@0:0#${cellIndex({x:1,y:0})}`,`opaque@0:0#${cellIndex({x:2,y:0})}`];
 const preview=previewMerge(ancestor,poor,rich,selection);
 expect(preview.cost).toBe(40);
 expect(kinds(preview)).toEqual(['spend']);
 expect(preview.conflicts[0]!.choices).toEqual([]);
 expect(preview.conflicts[0]!.message).toContain('40');
 expect(preview.candidate.money).toBe(35);
 const refused=resolveMerge(preview,[]);
 expect(refused.ok).toBe(false);
 if(refused.ok)return;
 expect(refused.error.code).toBe('CONFLICT');
 // one of the two fits: the same preview integrated alone lands and is charged once
 const single=previewMerge(ancestor,poor,rich,[selection[0]!]);
 expect(single.conflicts).toEqual([]);
 expect(single.cost).toBe(30);
 const landed=resolveMerge(single,[]);
 expect(landed.ok).toBe(true);
 if(!landed.ok)return;
 expect(landed.value.moneyAfter).toBe(5);
 expect(getCell(landed.value.state!,{x:1,y:0})?.building).toBe('park');
});

test('a road and a building that depend on each other on the same cell are not composed silently',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const {head,point:ancestor}=await open(worlds,shared);
 const park=await arm(worlds,head,'ana',built(shared,{type:'build',tool:'park',cells:[{x:3,y:3}]}),'parque');
 const road=await arm(worlds,head,'bob',built(shared,{type:'build',tool:'road',cells:[{x:3,y:3}]}),'rua');
 const preview=previewMerge(ancestor,park,road,[`opaque@0:0#${cellIndex({x:3,y:3})}`]);
 expect(kinds(preview)).toEqual(['dependency']);
 expect(preview.conflicts[0]!.choices).toEqual(['target','source']);
 expect(preview.candidate).toEqual(park.state);
 // keeping the park composes nothing new, so the review lands on the version it already has
 const kept=resolveMerge(preview,choicesFor(preview,'target'));
 expect(kept.ok).toBe(false);
 if(kept.ok)return;
 expect(kept.error.code).toBe('MALFORMED');
 const adopted=resolveMerge(preview,choicesFor(preview,'source'));
 if(!adopted.ok)return;
 expect(getCell(adopted.value.state!,{x:3,y:3})?.road).toBe(true);
 expect(getCell(adopted.value.state!,{x:3,y:3})?.building).toBeUndefined();
});

test('a removal against an edit is an explicit conflict, never a last-writer-wins',async()=>{
 const worlds=device();
 const index=cellIndex({x:7,y:7});
 const shared=built(createGame(WORLD_ID,1,blank('0:0')),{type:'build',tool:'commercial',cells:[{x:7,y:7}]});
 const {head,point:ancestor}=await open(worlds,shared);
 const cleared=await arm(worlds,head,'ana',built(shared,{type:'demolish',cells:[{x:7,y:7}]}),'demoli');
 const rebuilt=await arm(worlds,head,'bob',overlay(shared,'0:0',index,{terrain:'land',building:'industrial',stage:0,origin:'player'}),'predio');
 const preview=previewMerge(ancestor,cleared,rebuilt,[`opaque@0:0#${index}`]);
 // the removal against the edit is one question about the cell: the stage the removal dropped belongs to the building
 // the other side changed, so the whole cell follows one side
 expect(kinds(preview)).toEqual(['remove-edit']);
 expect(preview.conflicts[0]!.target).toEqual({terrain:'land'});
 expect(preview.conflicts[0]!.source).toEqual({terrain:'land',building:'industrial',stage:0,origin:'player'});
 const kept=resolveMerge(preview,choicesFor(preview,'target'));
 expect(kept.ok).toBe(false);
 if(kept.ok)return;
 const restored=resolveMerge(preview,choicesFor(preview,'source'));
 expect(restored.ok).toBe(true);
 if(!restored.ok)return;
 expect(restored.value.cost).toBe(80);
 expect(getCell(restored.value.state!,{x:7,y:7})).toEqual({terrain:'land',building:'industrial',stage:0,origin:'player'});
});

test('a component relation this profile does not know is preserved and never adopted without a decision',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const {head,point:ancestor}=await open(worlds,shared);
 const wallet=await arm(worlds,head,'ana',built(shared,{type:'component',key:'lifesim.wallet',entity:'ana',value:{coins:7}}),'carteira');
 const preview=previewMerge(ancestor,ancestor,wallet,[]);
 expect(kinds(preview)).toEqual(['relation']);
 expect(preview.conflicts[0]!.key).toBe('lifesim.wallet');
 expect(preview.conflicts[0]!.entity).toBe('ana');
 expect(preview.conflicts[0]!.choices).toEqual(['target','source']);
 expect(preview.candidate.components['lifesim.wallet']).toBeUndefined();
 expect(preview.cost).toBe(0);
 const kept=resolveMerge(preview,choicesFor(preview,'target'));
 if(!kept.ok)return;
 expect(kept.value.state!.components['lifesim.wallet']).toBeUndefined();
 const adopted=resolveMerge(preview,choicesFor(preview,'source'));
 if(!adopted.ok)return;
 expect(adopted.value.state!.components['lifesim.wallet']!['ana']).toEqual({coins:7});
 // both sides changed the same relation: still a decision, never the later one winning
 const other=await arm(worlds,head,'bob',built(shared,{type:'component',key:'lifesim.wallet',entity:'ana',value:{coins:9}}),'carteira-2');
 const fought=previewMerge(ancestor,wallet,other,[]);
 expect(kinds(fought)).toEqual(['relation']);
 expect(fought.conflicts[0]!.target).toEqual({coins:7});
 expect(fought.conflicts[0]!.source).toEqual({coins:9});
 expect(fought.candidate.components['lifesim.wallet']!['ana']).toEqual({coins:7});
});

test('a merge without a common ancestor, against another world or with unknown rules is refused',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const {head,point:ancestor}=await open(worlds,shared);
 const ana=await arm(worlds,head,'ana',built(shared,{type:'build',tool:'park',cells:[{x:4,y:4}]}),'parque');
 const orphan=previewMerge(null,ana,ana,[]);
 expect(kinds(orphan)).toEqual(['ancestor']);
 expect(orphan.conflicts[0]!.choices).toEqual([]);
 expect(orphan.candidate).toEqual(ana.state);
 const refused=resolveMerge(orphan,[]);
 expect(refused.ok).toBe(false);
 if(refused.ok)return;
 expect(refused.error.code).toBe('MISSING_OBJECT');
 const other=device();
 const elsewhere=await open(other,createGame('outro',1,blank('0:0')));
 const foreign=previewMerge(ancestor,ana,elsewhere.point,[]);
 expect(kinds(foreign)).toEqual(['world']);
 const crossed=resolveMerge(foreign,[]);
 expect(crossed.ok).toBe(false);
 if(crossed.ok)return;
 expect(crossed.error.code).toBe('CONFLICT');
 // a selection that names something the source never changed is a caller error, not a silent no-op
 const unknown=previewMerge(ancestor,ancestor,ana,['opaque@0:0#999']);
 expect(kinds(unknown)).toEqual(['selection']);
 const wrong=resolveMerge(unknown,[]);
 expect(wrong.ok).toBe(false);
 if(wrong.ok)return;
 expect(wrong.error.code).toBe('MALFORMED');
});

test('two proposals that arrived as files are priced by the destination, and their joint price is refused instead of applied in part',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,blank('0:0'));
 const {point}=await open(worlds,shared);
 const road=proposalFile(shared,'road',{x:1,y:0}),park=proposalFile(shared,'park',{x:2,y:0});
 // each file is quoted by the rules and the balance of the version that received it, never by the one that wrote it
 const rich={...point,state:{...shared,money:1000}};
 const first=prepareProject(rich,road,chosenIds(road));
 expect(first.ok).toBe(true);
 if(!first.ok)return;
 expect(first.value.cost).toBe(10);
 expect(first.value.origins).toEqual([{worldId:WORLD_ID}]);
 const landed=integrateProject(rich.state,first.value);
 expect(landed.ok).toBe(true);
 if(!landed.ok)return;
 expect(landed.value.money).toBe(990);
 expect(getCell(landed.value,{x:1,y:0})?.road).toBe(true);
 const second=prepareProject({...point,state:landed.value},park,chosenIds(park));
 expect(second.ok).toBe(true);
 if(!second.ok)return;
 expect(second.value.cost).toBe(30);
 // the two files fit the balance separately, and together they are one refused project rather than one applied file
 const poor={...point,state:{...shared,money:35}};
 const together=prepareProject(poor,combineChanges(road,park),[...chosenIds(road),...chosenIds(park)]);
 expect(together.ok).toBe(false);
 if(together.ok)return;
 expect(together.error.code).toBe('CONFLICT');
 expect(together.error.message).toContain('40');
 expect(poor.state.money).toBe(35);
 expect(getCell(poor.state,{x:1,y:0})?.road).toBeUndefined();
});

test('a prepared merge is refused when the version moved since the preview, and lands exactly once otherwise',async()=>{
 const worlds=device();
 const shared=createGame(WORLD_ID,1,mapA);
 const {head,point:ancestor}=await open(worlds,shared);
 const ana=await arm(worlds,head,'ana',overlay(shared,REGION,PARKED,{terrain:'land',building:'park',stage:1,origin:'player'}),'parque');
 const real=await arm(worlds,head,'real',{...shared,chunks:{...shared.chunks,[REGION]:adopt(mapB)}},'base-b');
 const preview=previewMerge(ancestor,ana,real,[]);
 const prepared=resolveMerge(preview,choicesFor(preview,'target'));
 expect(prepared.ok).toBe(true);
 if(!prepared.ok)return;
 expect(prepared.value.target).toEqual(ana.head);
 const landed=await worlds.commitPrepared(ana.head,prepared.value);
 expect(landed.ok).toBe(true);
 if(!landed.ok)return;
 const point=await worlds.checkout(landed.value);
 if(!point.ok)throw new Error(point.error.message);
 expect(point.value.state.chunks[REGION]!.base.source).toBe(mapB.source);
 expect(getCell(point.value.state,PARK)?.building).toBe('park');
 expect(point.value.state.money).toBe(ana.state.money);
 expect(point.value.state.tick).toBe(ana.state.tick);
 expect(point.value.commit.parents).toEqual([ana.head.commit]);
 // the version moved: another tree, another snapshot, and the ground of the region is the new capture
 expect(point.value.head.commit.hash).not.toBe(ana.head.commit.hash);
 expect(point.value.stateRef.hash).not.toBe(ana.stateRef.hash);
 expect(point.value.bases.find(base=>base.id===REGION)!.ref.hash).not.toBe(ana.bases.find(base=>base.id===REGION)!.ref.hash);
 expect(point.value.commit.accepted.some(entry=>entry.startsWith('base-update:'))).toBe(true);
 expect(point.value.commit.accepted.some(entry=>entry.startsWith(`base-divergence:${REGION}#${PARKED}`))).toBe(true);
 const versions=await worlds.history(landed.value);
 expect(versions.ok).toBe(true);
 if(!versions.ok)return;
 // the merge commit, the park it built on, the fork and the origin of the world
 expect(versions.value.map(version=>version.accepted)).toEqual([[`base-update:${REGION}@${real.bases.find(base=>base.id===REGION)!.ref.hash.slice(0,12)}`,`base-divergence:${REGION}#${PARKED}`],[],[],[]]);
 // the version moved: a candidate prepared against the older head is refused instead of landing on top of it
 const moved=await worlds.commit(landed.value,{id:'depois',state:built(point.value.state,{type:'build',tool:'park',cells:[FREE]}),operations:['parque'],objects:[],author:'local-player'});
 if(!moved.ok)throw new Error(moved.error.message);
 const stale=await worlds.commitPrepared(moved.value,prepared.value);
 expect(stale.ok).toBe(false);
 if(stale.ok)return;
 expect(stale.error.code).toBe('CONFLICT');
 // the same prepared change delivered twice answers the same version instead of merging twice
 const again=await worlds.commitPrepared(ana.head,prepared.value);
 expect(again.ok).toBe(true);
 if(!again.ok)return;
 expect(again.value).toEqual(landed.value);
 const after=await worlds.history(landed.value);
 if(!after.ok)return;
 expect(after.value).toHaveLength(4);
 const versionsNow=await worlds.history(moved.value);
 if(!versionsNow.ok)return;
 expect(versionsNow.value).toHaveLength(5);
});
