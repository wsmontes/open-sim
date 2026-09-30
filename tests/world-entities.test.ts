import {expect,test} from 'vitest';
import {WORLD} from '../src/core/coordinates';
import {applyCommand,createGame} from '../src/core/commands';
import type {GameState} from '../src/core/model';
import {createKernel} from '../src/world/kernel';
import {
 ENTITY_INDEX_KEY,MAX_GEOMETRY_POSITIONS,emptyEntityIndex,entityIndexFrom,entityIndexValue,reconcileEntities,
} from '../src/world/entities';
import type {EntityEntry,EntityIndex,GeoGeometry,SourceEntity} from '../src/world/entities';
import type {CaptureTimes} from '../src/world/reality';
import {blank,command} from './fixtures/world';

const ACTOR='did:key:z6MkReconciler',OTHER='did:key:z6MkElsewhere',TIMELINE='osim:timeline:main';
const TIMES:CaptureTimes={retrievedAt:'2026-09-29T12:00:00Z',publishedAt:'2026-09-28T00:00:00Z'};
const rect=(west:number,south:number,east:number,north:number):GeoGeometry=>({type:'polygon',positions:[
 {lon:west,lat:south},{lon:east,lat:south},{lon:east,lat:north},{lon:west,lat:north},{lon:west,lat:south},
]});
const feature=(over:Partial<SourceEntity>={}):SourceEntity=>({
 kind:'building',
 source:'openstreetmap.shortbread',
 revision:`sha256:${'a'.repeat(64)}`,
 times:TIMES,
 geometry:{type:'point',positions:[{lon:0,lat:0}]},
 ...over,
});
const only=(index:EntityIndex):[string,EntityEntry]=>{
 const ids=Object.keys(index.entities);
 expect(ids).toHaveLength(1);
 return [ids[0]!,index.entities[ids[0]!]!];
};
const withComponent=(index:EntityIndex,id:string,key:string,value:unknown):EntityIndex=>({
 ...index,
 entities:{...index.entities,[id]:{...index.entities[id]!,components:{...index.entities[id]!.components,[key]:value}}},
});
const partsOf=(id:string)=>id.split(':').map(Number) as [number,number];
// What a profile does with the table: ordinary component commands under its own namespace.
function written(state:GameState,table:Record<string,unknown>):GameState {
 let next=state;
 for(const id of Object.keys(table).sort())next=applyCommand(next,command(next,{type:'component',key:ENTITY_INDEX_KEY,entity:id,value:table[id]}),[]).state;
 return next;
}

test('a feature crossing regions and the antimeridian is one entity with each index reference once',()=>{
 const way=feature({kind:'highway',sourceId:'way/1',geometry:{type:'line',positions:[{lon:179.9,lat:10},{lon:-179.9,lat:10}]}});
 const reconciliation=reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[way]);
 expect(reconciliation.refused).toEqual([]);
 expect(reconciliation.ambiguous).toEqual([]);
 const [id,entry]=only(reconciliation.index);
 // the geometry crosses the antimeridian: the two references sit on opposite sides of the seam, same row, and every
 // region of one feature is named once, so the entity is counted once
 expect(entry.chunks).toHaveLength(2);
 expect(new Set(entry.chunks).size).toBe(2);
 expect(new Set(entry.chunks.map(id=>partsOf(id)[1])).size).toBe(1);
 const columns=entry.chunks.map(id=>partsOf(id)[0]).sort((a,b)=>a-b);
 expect(columns[1]!-columns[0]!).toBeGreaterThan(WORLD/64);
 // the provider delivered the same way in two pieces, one per region: still one entity, with the pieces together
 const pieces=reconcileEntities(reconciliation.index,[
  {...way,geometry:{type:'line',positions:[{lon:179.9,lat:10},{lon:180,lat:10}]}},
  {...way,geometry:{type:'line',positions:[{lon:-180,lat:10},{lon:-179.9,lat:10}]}},
 ]);
 expect(Object.keys(pieces.index.entities)).toEqual([id]);
 expect(pieces.added).toEqual([]);
 expect(pieces.updated).toEqual([id]);
 const piecesEntry=pieces.index.entities[id]!;
 expect(piecesEntry.chunks.length).toBeGreaterThanOrEqual(2);
 expect(new Set(piecesEntry.chunks).size).toBe(piecesEntry.chunks.length);
 expect(piecesEntry.components['entity.geometry']).toMatchObject({type:'line'});
});

test('a redrawn feature keeps its identity, and an unstated correspondence is a new entity',()=>{
 const before=reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[feature({sourceId:'way/1',geometry:rect(0,0,2,2)})]);
 const [id]=only(before.index);
 const redraw=reconcileEntities(before.index,[feature({sourceId:'way/9',replaces:['way/1'],name:'Praça',geometry:rect(0,0,3,3)})]);
 expect(redraw.ambiguous).toEqual([]);
 expect(redraw.added).toEqual([]);
 expect(redraw.updated).toEqual([id]);
 const drawn=redraw.index.entities[id]!;
 expect(drawn.components['osim.name']).toEqual({default:'Praça'});
 expect(drawn.claims.map(claim=>claim.sourceId)).toEqual(['way/1','way/9']);
 expect(drawn.components['entity.geometry']).toMatchObject({type:'polygon'});
 // the same list without the relation statement is a new entity: this client does not guess correspondences
 const unrelated=reconcileEntities(before.index,[feature({sourceId:'way/9',geometry:rect(0,0,3,3)})]);
 expect(unrelated.added).toHaveLength(1);
 expect(Object.keys(unrelated.index.entities)).toHaveLength(2);
 // and a feature the revision no longer mentions is not a demolition
 const silent=reconcileEntities(before.index,[feature({sourceId:'way/7',geometry:rect(8,8,9,9)})]);
 expect(Object.keys(silent.index.entities)).toHaveLength(2);
 expect(silent.index.entities[id]!.components['osim.name']).toBeUndefined();
});

test('a split or a merge with an ambiguous association is reported instead of chosen',()=>{
 const first=reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[
  feature({sourceId:'way/1',geometry:rect(0,0,2,2)}),
  feature({sourceId:'way/2',geometry:rect(4,4,6,6)}),
 ]);
 const [a,b]=Object.keys(first.index.entities).sort() as [string,string];
 // one feature absorbing two of ours: which entity survives is a review, not a derivation
 const merged=reconcileEntities(first.index,[feature({sourceId:'way/3',replaces:['way/1','way/2'],geometry:rect(0,0,6,6)})]);
 expect(merged.ambiguous.map(entry=>entry.kind)).toEqual(['merge']);
 expect(merged.ambiguous[0]!.existing).toEqual([a,b]);
 expect(merged.ambiguous[0]!.message).toContain('revis');
 expect(merged.added).toEqual([]);
 expect(merged.updated).toEqual([]);
 expect(merged.index).toEqual(first.index);
 expect(merged.published).toEqual([]);
 // two features inheriting one of ours: neither gets to become it
 const split=reconcileEntities(first.index,[
  feature({sourceId:'way/4',replaces:['way/1'],geometry:rect(0,0,1,2)}),
  feature({sourceId:'way/5',replaces:['way/1'],geometry:rect(1,0,2,2)}),
 ]);
 expect(split.ambiguous.map(entry=>entry.kind)).toEqual(['split']);
 expect(split.ambiguous[0]!.existing).toEqual([a]);
 expect(split.added).toEqual([]);
 expect(split.index).toEqual(first.index);
});

test('identifiers come from the source, stay stable elsewhere and round-trip through the durable namespace',()=>{
 const first=reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[feature({sourceId:'way/1',geometry:rect(0,0,2,2)})]);
 const [id]=only(first.index);
 // a fork recontextualises the world; the entity it inherited keeps the name it had
 const elsewhere=reconcileEntities(emptyEntityIndex(OTHER,'osim:timeline:experimento'),[feature({sourceId:'way/1',geometry:rect(0,0,2,2)})]);
 expect(Object.keys(elsewhere.index.entities)).toEqual([id]);
 // a feature without a provider identifier still needs a stable name: the geometry gives it one in every client, and
 // nobody claims the result is the provider's identifier
 const anonymous=feature({sourceId:undefined,geometry:rect(0,0,2,2)});
 const derived=reconcileEntities(emptyEntityIndex(OTHER,'osim:timeline:experimento'),[anonymous]);
 const [derivedId,derivedEntry]=only(derived.index);
 expect(derivedId).not.toBe(id);
 expect(Object.keys(reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[anonymous]).index.entities)).toEqual([derivedId]);
 expect(derivedEntry.claims[0]!.sourceId).toBeUndefined();
 // the same table read again is the same table: `entity.index` is a namespace of the durable state, one entry per id
 const restored=entityIndexFrom(entityIndexValue(first.index),ACTOR,TIMELINE);
 expect(restored).toMatchObject({ok:true});
 if(restored.ok)expect(restored.value).toEqual(first.index);
 const state=written(createGame('w',1,blank()),entityIndexValue(first.index));
 expect(state.components[ENTITY_INDEX_KEY]?.[id]).toBeDefined();
 const readBack=entityIndexFrom(state.components[ENTITY_INDEX_KEY],ACTOR,TIMELINE);
 expect(readBack).toMatchObject({ok:true});
 if(readBack.ok)expect(readBack.value.entities[id]).toEqual(first.index.entities[id]);
 // a table from a client that wrote something this contract cannot read is refused instead of half adopted
 expect(entityIndexFrom({[id]:{kind:'building'}},ACTOR,TIMELINE)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('namespaces this client does not implement survive a source update and follow their author',()=>{
 const incoming=feature({
  kind:'park',
  sourceId:'way/7',
  geometry:rect(0,0,2,2),
  attributes:{'addr:street':'Rua A',surface:'grass'},
  extensions:{'org.openstreetmap.shortbread':{layer:'park'},'x.wander.flags':{camping:true}},
 });
 const first=reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[incoming]);
 const [id,entry]=only(first.index);
 expect(entry.components['x.wander.flags']).toEqual({camping:true});
 expect(entry.components['org.openstreetmap.shortbread']).toEqual({layer:'park'});
 expect(entry.claims[0]!.sourceId).toBe('way/7');
 expect(entry.claims[0]!.attributes).toEqual({'addr:street':'Rua A',surface:'grass'});
 // another profile writes on the same entity: its namespace is not the source's to take away
 const shared=withComponent(first.index,id,'lifesim.residence',{household:'h-1'});
 const redrawn=reconcileEntities(shared,[{...incoming,geometry:rect(0,0,3,3),extensions:{'org.openstreetmap.shortbread':{layer:'park'}}}]);
 expect(redrawn.updated).toEqual([id]);
 const after=redrawn.index.entities[id]!;
 expect(after.components['lifesim.residence']).toEqual({household:'h-1'});
 // the source stopped declaring x.wander.flags, so the value it had written goes with it
 expect(after.components['x.wander.flags']).toBeUndefined();
 expect(after.components['org.openstreetmap.shortbread']).toEqual({layer:'park'});
 // a feature without a provider identifier is identified by its geometry, so a redraw is a new entity and not a move
 const anonymous=reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[feature({geometry:rect(0,0,2,2)})]);
 const redrawnAnonymous=reconcileEntities(anonymous.index,[feature({geometry:rect(0,0,3,3)})]);
 expect(redrawnAnonymous.updated).toEqual([]);
 expect(redrawnAnonymous.added).toHaveLength(1);
 expect(Object.keys(redrawnAnonymous.index.entities)).toHaveLength(2);
});

test('impossible geometry and vocabulary are refused, and what is published applies to a kernel once',async()=>{
 const refused=reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[
  feature({geometry:{type:'point',positions:[{lon:181,lat:0}]}}),
  feature({geometry:{type:'line',positions:[{lon:0,lat:0}]}}),
  feature({extensions:{'osim.existence':{level:'imaginary'}}}),
  feature({geometry:{type:'polygon',positions:Array.from({length:MAX_GEOMETRY_POSITIONS+1},()=>({lon:0,lat:0}))}}),
 ]);
 expect([...refused.refused.map(problem=>problem.code)].sort()).toEqual(['LIMIT','MALFORMED','MALFORMED','MALFORMED']);
 expect(refused.refused.flatMap(problem=>[...problem.incoming]).sort((a,b)=>a-b)).toEqual([0,1,2,3]);
 expect(new Set(refused.refused.flatMap(problem=>[...problem.incoming])).size).toBe(4);
 expect(Object.keys(refused.index.entities)).toHaveLength(0);
 expect(refused.published).toEqual([]);
 const kernel=createKernel();
 const first=reconcileEntities(emptyEntityIndex(ACTOR,TIMELINE),[feature({sourceId:'way/1',geometry:rect(0,0,2,2)})]);
 const [id,entry]=only(first.index);
 expect(first.published).toHaveLength(1);
 expect(first.published[0]).toMatchObject({osim:'0.1',type:'entity',id:`osim:entity:${id}`,actor:ACTOR});
 for(const object of first.published)expect(await kernel.publish(object)).toMatchObject({ok:true,status:'applied'});
 expect(kernel.state().components['osim.transform']?.[id]).toEqual(entry.components['osim.transform']);
 expect(kernel.state().components['osim.existence']?.[id]).toEqual({level:'observed'});
 // an update is an event, and a repeated delivery does not apply twice (§16)
 const update=reconcileEntities(first.index,[feature({sourceId:'way/1',name:'Praça',geometry:rect(0,0,4,4)})]);
 const events=update.published.filter(object=>object.type==='event');
 expect(events.length).toBeGreaterThan(0);
 for(const event of events)expect(await kernel.publish(event)).toMatchObject({ok:true,status:'applied'});
 expect(kernel.state().components['osim.name']?.[id]).toEqual({default:'Praça'});
 for(const event of events)expect(await kernel.publish(event)).toMatchObject({ok:true,status:'duplicate'});
 // nothing changed, nothing is published, and the table does not move
 const quiet=reconcileEntities(update.index,[feature({sourceId:'way/1',name:'Praça',geometry:rect(0,0,4,4)})]);
 expect(quiet.published).toEqual([]);
 expect(quiet.updated).toEqual([]);
 expect(quiet.unchanged).toEqual([id]);
 expect(quiet.index).toEqual(update.index);
});
