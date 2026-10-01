import {RULES_VERSION} from '../src/core/model';
import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {applyCommand,createGame} from '../src/core/commands';
import {durableJson} from '../src/core/protocol';
import {summarize} from '../src/core/simulation';
import type {GameState,SavedGame} from '../src/core/model';
import {createWorldRepository} from '../src/session/world-repository';
import {importLegacy} from '../src/session/world-bundle';
import {decodeBundle,encodeBundle,verifyBundle} from '../src/world/codec';
import {isRef,sameRef} from '../src/world/model';
import type {JsonValue,ObjectRef,WorldBundle} from '../src/world/model';
import {materialize,materializedCount,populationOf,totalOf} from '../src/world/materialization';
import type {PreparedChange} from '../src/world/changes';
import {EXPLORER_EXTENSIONS,applyExplorerWrites} from '../src/profiles/explorer/commands';
import {explorerPending,runExplorer} from '../src/profiles/explorer/model';
import type {ExplorerPending} from '../src/profiles/explorer/model';
import {blank,command} from './fixtures/world';

const codec=createJcsCodec(),hasher=bytesHasher();
const WORLD='victoria',HOME='0:0#0',OWNER='did:key:z6MkWalker',OTHER='did:key:z6MkOther';
const TERMS=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const reserved={id:'walk-1',owner:OWNER,cell:HOME,count:4};

function cityState():GameState {
 const base=blank();
 for(let i=0;i<16;i++)base.cells[i]={terrain:'land',building:'residential',stage:1,origin:'player'};
 for(let i=16;i<20;i++)base.cells[i]={terrain:'land',road:true};
 const state=createGame(WORLD,42,base);
 // what this profile does not implement: a life simulator's household and a wanderer's own flags
 return {...state,components:{
  'lifesim.residence':{'house-1':{household:'Família A',residents:4}},
  'x.wander.flags':{'0_0_0':{camping:true}},
 }};
}
const save=(state:GameState):SavedGame=>({version:1,state,view:{x:0,y:0,zoom:1,speed:0,place:'Victoria'}});
// The city side derives the same person for the same slot: that is the point of a deterministic resolution.
function firstCharacter(state:GameState):string {
 const derived=materialize(populationOf(state),reserved);
 if(!derived.ok)throw new Error(derived.error.message);
 return derived.value.reservations[0]!.ids[0]!;
}

function recordOf(value:JsonValue|undefined):Record<string,JsonValue> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('O pacote não carrega este objeto');
 return value as Record<string,JsonValue>;
}
function refOf(value:JsonValue|undefined):ObjectRef {
 if(!isRef(value))throw new Error('O pacote carrega um endereço inválido');
 return value;
}
// The state the version points at, read the way another client would read the package: head, commit, tree, state.
function stateIn(bundle:WorldBundle):GameState {
 const at=(ref:ObjectRef)=>bundle.objects.find(object=>sameRef(object.ref,ref))?.value;
 const commit=recordOf(at(bundle.head!.commit));
 const tree=recordOf(at(refOf(commit['tree'])));
 const state=recordOf(at(refOf(tree['state'])))['state'];
 const game=recordOf(state);
 if(game['worldId']!==bundle.head!.worldId)throw new Error('Estado de outro mundo neste pacote');
 return state as unknown as GameState;
}
async function opened(state:GameState):Promise<WorldBundle> {
 const imported=await importLegacy(save(state),hasher,codec,TERMS);
 if(!imported.ok)throw new Error(imported.error.message);
 return imported.value;
}
async function commitExplorer(bundle:WorldBundle,pending:ExplorerPending) {
 const repository=createWorldRepository({storage:createWorldMemoryStorage(),codec,hasher});
 const created=await repository.create(bundle);
 if(!created.ok)throw new Error(created.error.message);
 const point=await repository.checkout(created.value);
 if(!point.ok)throw new Error(point.error.message);
 const saved=applyExplorerWrites(point.value.state,pending.components);
 if(!saved.ok)throw new Error(saved.error.message);
 const prepared:PreparedChange={
  origins:[{worldId:WORLD,branchId:'main'}],target:created.value,selection:[],operations:[],bases:[],
  cost:0,moneyAfter:saved.value.money,tick:saved.value.tick,requires:[],state:saved.value,records:[...pending.records],
 };
 return {repository,head:created.value,prepared,committed:await repository.commitPrepared(created.value,prepared)};
}

test('a city opens in the explorer and returns with the same total, history, provenance and unknown data',async()=>{
 const state=cityState();
 const bundle=await opened(state);
 const explorer=runExplorer(bundle,[
  {type:'materialize',...reserved},
  {type:'write',key:'x.explorer.character',entity:firstCharacter(state),value:{walking:true,hunger:0}},
  {type:'write',key:'x.explorer.motion',entity:'walker-1',value:{lon:1.5,lat:2.5}},
 ]);
 expect(explorer.ok).toBe(true);
 if(!explorer.ok)return;
 const explored=explorer.value;
 // the explorer did not rewrite the world it opened: every object keeps the address it was read with
 expect(explored.objects).toEqual(bundle.objects);
 expect(explored.terms).toEqual(bundle.terms);
 expect(explored.definition).toMatchObject({worldId:WORLD,branchId:'main',profiles:['city','explorer'],rules:{family:'city',version:RULES_VERSION}});
 expect(explored.definition.origin).toEqual(bundle.definition.origin);
 const pending=explorerPending(explored);
 expect(pending).toMatchObject({ok:true});
 if(!pending.ok)return;
 // what the explorer decided is the population it moved, expressed as the components the caller has to publish
 const walked=populationOf({...state,components:pending.value.components});
 expect(walked.aggregate).toBe(60);
 expect(totalOf(walked)).toBe(64);
 expect(pending.value.profile).toEqual({family:'explorer',version:1});
 expect(pending.value.records).toEqual([`materialize:${reserved.id}@${HOME}#4`,`write:x.explorer.character@${firstCharacter(state)}`,`write:x.explorer.motion@walker-1`]);
 expect(pending.value.components['osim.existence']).toHaveProperty(firstCharacter(state));
 expect(pending.value.components['x.explorer.character']?.[firstCharacter(state)]).toEqual({walking:true,hunger:0});
 // what the explorer declared is what it may write: another profile's namespace is not its to author
 expect(applyExplorerWrites(state,{'lifesim.residence':{'house-1':{household:'outra'}}})).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 expect(runExplorer(bundle,[{type:'write',key:'vehicle.transform',entity:'car-1',value:{}}])).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 // the explorer saves the way the repository commits: state, receipt and head published together
 const saved=await commitExplorer(bundle,pending.value);
 expect(saved.committed.ok).toBe(true);
 if(!saved.committed.ok)return;
 const exported=await saved.repository.export(saved.committed.value);
 expect(exported.ok).toBe(true);
 if(!exported.ok)return;
 const reopened=decodeBundle(encodeBundle(exported.value,codec));
 expect(reopened.ok).toBe(true);
 if(!reopened.ok)return;
 expect(await verifyBundle(reopened.value,hasher,codec)).toMatchObject({ok:true});
 expect(reopened.value.terms).toEqual(TERMS);
 expect(reopened.value.definition.origin.kind).toBe('legacy-save');
 expect(reopened.value.head).toMatchObject({generation:2});
 // the version the explorer started from is still in the package, so the history is the city's own
 const head=reopened.value.head!;
 const commit=recordOf(reopened.value.objects.find(object=>sameRef(object.ref,head.commit))?.value);
 const parents=commit['parents'] as JsonValue[];
 expect(parents).toHaveLength(1);
 expect(recordOf(reopened.value.objects.find(object=>sameRef(object.ref,refOf(parents[0])))?.value)['kind']).toBe('world-commit');
 // the city reloads: its own aggregate, the people the explorer materialized, and nothing it does not understand lost
 const received=stateIn(reopened.value);
 expect(summarize(received).population).toBe(60);
 expect(materializedCount(populationOf(received))).toBe(4);
 expect(totalOf(populationOf(received))).toBe(64);
 expect(received.components['lifesim.residence']).toEqual(state.components['lifesim.residence']);
 expect(received.components['x.wander.flags']).toEqual(state.components['x.wander.flags']);
 expect(received.components['x.explorer.character']).toEqual(pending.value.components['x.explorer.character']);
 expect(received.tick).toBe(state.tick);
 expect(received.money).toBe(state.money);
 // a walker moving is not history: only what the profile declares durable moves the world's identity
 const walking=applyCommand(received,command(received,{type:'component',key:'x.explorer.motion',entity:'walker-1',value:{lon:9,lat:9}}),[]).state;
 expect(durableJson(walking,EXPLORER_EXTENSIONS)).toBe(durableJson(received,EXPLORER_EXTENSIONS));
 expect(durableJson(walking)).not.toBe(durableJson(received));
 const wentHome=applyCommand(received,command(received,{type:'component',key:'x.explorer.character',entity:firstCharacter(state),value:{walking:false}}),[]).state;
 expect(durableJson(wentHome,EXPLORER_EXTENSIONS)).not.toBe(durableJson(received,EXPLORER_EXTENSIONS));
});

test('a world under rules the explorer does not implement is read, never written',async()=>{
 const bundle=await opened(cityState());
 const foreign:WorldBundle={...bundle,definition:{...bundle.definition,rules:{family:'driving',version:1}}};
 const explored=runExplorer(foreign,[{type:'materialize',id:'drive-1',owner:OWNER,cell:HOME,count:1}]);
 expect(explored).toMatchObject({ok:false,error:{code:'WORLD_PROTOCOL_UNSUPPORTED'}});
 if(explored.ok)return;
 expect(explored.error.message).toContain('driving v1');
 // reading stays possible: the package round-trips exactly as it arrived
 const read=decodeBundle(encodeBundle(foreign,codec));
 expect(read.ok).toBe(true);
 if(read.ok)expect(read.value).toEqual(foreign);
 expect(runExplorer(foreign,[])).toMatchObject({ok:true});
});

test('two explorers reserving the same slot derive the same people, so the total is four plus sixty',async()=>{
 const state=cityState();
 const bundle=await opened(state);
 const mine=runExplorer(bundle,[{type:'materialize',id:'walk-1',owner:OWNER,cell:HOME,count:4}]);
 const theirs=runExplorer(bundle,[{type:'materialize',id:'walk-2',owner:OTHER,cell:HOME,count:4}]);
 expect(mine.ok&&theirs.ok).toBe(true);
 if(!mine.ok||!theirs.ok)return;
 const myPending=explorerPending(mine.value),theirPending=explorerPending(theirs.value);
 expect(myPending.ok&&theirPending.ok).toBe(true);
 if(!myPending.ok||!theirPending.ok)return;
 expect(Object.keys(myPending.value.components['osim.transform']!).sort())
  .toEqual(Object.keys(theirPending.value.components['osim.transform']!).sort());
 // both copies landing on the city are the same four people, not eight
 const one=await commitExplorer(bundle,myPending.value);
 const other=createWorldRepository({storage:createWorldMemoryStorage(),codec,hasher});
 const created=await other.create(bundle);
 expect(created.ok).toBe(true);
 if(!created.ok)return;
 const point=await other.checkout(created.value);
 expect(point.ok).toBe(true);
 if(!point.ok)return;
 const saved=applyExplorerWrites(point.value.state,theirPending.value.components);
 expect(saved.ok).toBe(true);
 if(!saved.ok)return;
 // the second copy of the same people is not a second population
 const merged=applyExplorerWrites(saved.value,myPending.value.components);
 expect(merged).toMatchObject({ok:true});
 if(!merged.ok)return;
 expect(materializedCount(populationOf(merged.value))).toBe(4);
 expect(totalOf(populationOf(merged.value))).toBe(64);
 expect(summarize(merged.value).population).toBe(60);
 // and a version that advanced cannot be committed again as if nothing had happened
 const stale=await one.repository.commitPrepared(one.head,{...one.prepared,state:saved.value,records:[]});
 expect(one.committed.ok).toBe(true);
 expect(stale).toMatchObject({ok:false,error:{code:'CONFLICT'}});
});
