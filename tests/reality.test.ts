import {expect,test} from 'vitest';
import type {BaseChunk,Cell} from '../src/core/model';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {createOsmSource} from '../src/adapters/osm/provider';
import {createOsmRealitySource} from '../src/adapters/reality/osm-capture';
import {decodeBundle,encodeBundle,verifyBundle} from '../src/world/codec';
import type {JsonValue,WorldBundle} from '../src/world/model';
import {captureBase,termsOf} from '../src/world/reality';
import type {CaptureContext,CaptureRequest,CapturedBase} from '../src/world/reality';
import fixtureA from './fixtures/federated-world/base-a.json';
import fixtureB from './fixtures/federated-world/base-b.json';

const codec=createJcsCodec(),hasher=bytesHasher();
const ATTRIBUTION={attribution:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright',license:'ODbL'};
// The fixtures are synthetic on purpose: they stand for a parking lot that a later map draws as a building, and for a
// second map that declares no redistribution licence. Neither is a copy of OSM and neither may be passed off as one.
const parkA=fixtureA as BaseChunk, buildB=fixtureB as BaseChunk;
const PARK=364,WATER=643,GREEN=771,PLAIN=165;
// Everything a capture has to be told. The clock belongs to the caller: nothing here is read from the environment, so
// the same base and the same context always produce the same revision.
const context=(over:Partial<CaptureContext>={}):CaptureContext=>({
 codec,
 source:{id:'openstreetmap-shortbread-v1',dataset:'OpenStreetMap · Shortbread v1',url:'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt'},
 terms:{...ATTRIBUTION},
 transformation:{name:'osm-shortbread',version:1},
 capture:{level:'detail',zoom:14},
 retrievedAt:'2026-09-29T12:00:00Z',
 ...over,
});
const request=(over:Partial<CaptureRequest>={}):CaptureRequest=>({level:'detail',times:{retrievedAt:'2026-09-29T12:00:00Z'},...over});
// One claim per cell the source decided, so a test can ask about a single cell instead of scanning the array.
const claimOf=(captured:CapturedBase,index:number)=>{const claim=captured.claims.find(entry=>entry.subject.kind==='cell'&&entry.subject.index===index);expect(claim,`sem registro para a célula ${index}`).toBeDefined();return claim!;};
const bundleOf=(captured:CapturedBase):WorldBundle=>({
 envelope:{worldProtocol:2,wireVersion:1,kind:'bundle'},
 definition:{worldId:'victoria',branchId:'main',origin:{kind:'new'},profiles:['city'],rules:{family:'city',version:1}},
 objects:[...captured.objects],
 terms:[termsOf(captured)],
 completeness:{complete:true,missing:[]},
 extensions:{},
});

test('a capture leaves the base exactly as it was and addresses what it captured',async()=>{
 // taken before the call: if the capture rewrote a cell, this string would change
 const before=JSON.stringify(fixtureA);
 const captured=await captureBase(parkA,context(),hasher);
 expect(captured.base).toEqual(parkA);
 expect(JSON.stringify(fixtureA)).toBe(before);
 // the base is an object whose address covers its own bytes, and the revision points at that same entity
 const baseObject=captured.objects[0]!;
 expect(baseObject.value).toEqual({kind:'base-chunk',base:parkA});
 expect(await hasher.ref(codec.encode(baseObject.value))).toEqual(baseObject.ref);
 expect(captured.revision.entity).toEqual(baseObject.ref);
 // the capture record is an object too, and it carries the claims that explain the cells
 const record=captured.objects[1]!;
 expect(record.value).toEqual({kind:'capture',revision:captured.revision,claims:captured.claims});
 expect(await hasher.ref(codec.encode(record.value))).toEqual(record.ref);
 expect(await verifyBundle(bundleOf(captured),hasher,codec)).toMatchObject({ok:true});
});

test('coverage is the rectangle the grid actually addresses, in named coordinates',async()=>{
 const captured=await captureBase(parkA,context(),hasher);
 // São Paulo, one region of the city grid: the client declares the rectangle and the lattice it came from instead of
 // letting Web Mercator pass as the definition of the planet (spec §3.4).
 expect(captured.revision.coverage).toEqual({
  crs:'EPSG:4326',
  unit:'degree',
  bounds:{west:-46.63421630859375,south:-23.551398745203407,east:-46.6314697265625,north:-23.548880923858746},
  lattice:{name:'city-grid-v1',cellsPerSide:2**22,cellLonDegrees:360/2**22,maxLatitude:85.05112878},
 });
 // a body that is not a whole region cannot be described by a rectangle the grid does not cover
 await expect(captureBase({...parkA,cells:parkA.cells.slice(0,100)},context(),hasher)).rejects.toThrow();
});

test('a revision never passes the download instant off as when the fact was true',async()=>{
 const captured=await captureBase(parkA,context(),hasher);
 expect(captured.revision.times).toEqual({retrievedAt:'2026-09-29T12:00:00Z'});
 expect('observedAt' in captured.revision.times).toBe(false);
 expect('publishedAt' in captured.revision.times).toBe(false);
 expect('interval' in captured.revision.times).toBe(false);
 // a source that does date what it published keeps every time separate
 const dated=await captureBase(parkA,context({observedAt:'2026-09-28T03:00:00Z',publishedAt:'2026-09-28T05:30:00Z'}),hasher);
 expect(dated.revision.times).toEqual({retrievedAt:'2026-09-29T12:00:00Z',observedAt:'2026-09-28T03:00:00Z',publishedAt:'2026-09-28T05:30:00Z'});
 // a represented period replaces a single observation; claiming both would contradict itself
 const ranged=await captureBase(parkA,context({interval:{from:'2026-09-01T00:00:00Z',to:'2026-09-28T00:00:00Z'}}),hasher);
 expect(ranged.revision.times.interval).toEqual({from:'2026-09-01T00:00:00Z',to:'2026-09-28T00:00:00Z'});
 const both={observedAt:'2026-09-28T03:00:00Z',interval:{from:'2026-09-01T00:00:00Z',to:'2026-09-28T00:00:00Z'}};
 await expect(captureBase(parkA,context(both),hasher)).rejects.toThrow();
 // a time that is not an instant is refused rather than stored as a guess
 await expect(captureBase(parkA,context({retrievedAt:'ontem'}),hasher)).rejects.toThrow();
 await expect(captureBase(parkA,context({publishedAt:'2026-13-45T00:00:00Z'}),hasher)).rejects.toThrow();
});

test('a capture without a provider identifier declares the uncertainty instead of minting one',async()=>{
 const captured=await captureBase(parkA,context(),hasher);
 // the record is per normalized chunk, with the parameters that produced it: tiles served at different moments are
 // not one global snapshot of the provider (spec §3.5)
 expect(captured.revision.capture).toEqual({scope:'chunk',chunk:'48557:74362',level:'detail',zoom:14,featureIds:'unknown'});
 // only the cells the source decided are claimed, and every claim names what it asserts
 expect(captured.claims).toHaveLength(160);
 expect(claimOf(captured,PARK).subject).toEqual({kind:'cell',index:PARK});
 expect(claimOf(captured,PARK).values).toEqual({terrain:'land'});
 expect(claimOf(captured,WATER).values).toEqual({terrain:'water'});
 expect(claimOf(captured,GREEN).values).toEqual({terrain:'green'});
 expect(claimOf(captured,PARK).method).toBe('derived');
 expect('quality' in claimOf(captured,PARK)).toBe(false);
 expect(captured.claims.some(claim=>claim.subject.kind==='cell'&&claim.subject.index===PLAIN)).toBe(false);
 // the adapter has no stable feature id for what it normalized, so no claim cites one and none is derived from a
 // coordinate and presented as an OSM id (spec §3.3)
 expect(captured.claims.every(claim=>claim.sourceId===undefined)).toBe(true);
 expect(JSON.stringify(captured.objects)).not.toMatch(/osm:(way|node|relation)\//);
});

test('the source, its attribution and unknown fields survive the package',async()=>{
 const extras={'opensim.fixture':'sintético','opensim.more':{nested:[1,2,{three:3}]}};
 const captured=await captureBase(parkA,context({extensions:{...extras}}),hasher);
 expect(captured.revision.extensions).toEqual(extras);
 expect(captured.revision.terms).toEqual(ATTRIBUTION);
 const bundle=bundleOf(captured);
 bundle.extensions={'opensim.capture':'um cliente posterior pode guardar isto'};
 const decoded=decodeBundle(encodeBundle(bundle,codec));
 expect(decoded.ok).toBe(true);
 if(!decoded.ok)return;
 // the captured bytes travel whole: base, claims, source, attribution and the extension space
 expect(decoded.value.objects).toEqual(captured.objects);
 expect(decoded.value.terms).toEqual([termsOf(captured)]);
 expect(decoded.value.extensions).toEqual({'opensim.capture':'um cliente posterior pode guardar isto'});
 // a field this wire version does not define in a critical object is refused, not quietly kept
 const hostile={...bundle,definition:{...bundle.definition,future:true}} as unknown as JsonValue;
 expect(decodeBundle(codec.encode(hostile))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('the fixtures are synthetic, and a source change without a declared licence stays undeclared',async()=>{
 // neither fixture is presented as OSM, and they disagree about the same cells
 expect(parkA.source).toContain('Fixture sintética');
 expect(parkA.source).not.toContain('OpenStreetMap');
 expect(buildB.source).not.toContain('OpenStreetMap');
 expect((parkA.cells[PARK] as Cell).building).toBeUndefined();
 expect((buildB.cells[PARK] as Cell).building).toBe('residential');
 const parked=await captureBase(parkA,context(),hasher);
 const changed=await captureBase(buildB,context({
  source:{id:'fixture-b',dataset:buildB.source,url:'https://example.invalid/fixture-b/{z}/{x}/{y}.mvt'},
  terms:{attribution:'Fixture sintética'},
  previous:[parked.objects[1]!.ref],
 }),hasher);
 // the earlier capture is referenced instead of being overwritten by the newer revision
 expect(changed.revision.previous).toEqual([parked.objects[1]!.ref]);
 expect(parked.revision.previous).toEqual([]);
 expect(claimOf(parked,PARK).values).toEqual({terrain:'land'});
 expect(claimOf(changed,PARK).values).toEqual({terrain:'land',building:'residential',stage:1});
 // the second map declares no redistribution licence, and the capture borrows none for it (spec §3.6)
 expect('license' in changed.revision.terms).toBe(false);
 expect(termsOf(changed)).toEqual({source:buildB.source,attribution:'Fixture sintética'});
 expect(termsOf(parked)).toEqual({source:'OpenStreetMap · Shortbread v1',attribution:ATTRIBUTION.attribution,license:ATTRIBUTION.license});
});

test('a source that fails leaves no terrain behind',async()=>{
 let down=true;
 const maps=createOsmSource({fetcher:async()=>down?new Response('',{status:503}):new Response(new Uint8Array())});
 const reality=createOsmRealitySource({maps,hasher,codec});
 const result=await reality.capture({chunks:['48557:74362','48558:74362']},request());
 expect(result.ok).toBe(false);
 if(result.ok)return;
 expect(result.error.code).toBe('NOT_FOUND');
 expect('value' in result).toBe(false);
 expect(result.error.message).toContain('Fonte indisponível');
 // a failure is not cached as an empty region: the same region can be captured once the source answers, and an empty
 // tile claims nothing instead of turning into invented ground
 down=false;
 const retry=await reality.capture({chunks:['48557:74362','48558:74362']},request());
 expect(retry.ok).toBe(true);
 if(!retry.ok)return;
 expect(retry.value).toHaveLength(2);
 expect(retry.value[0]!.claims).toEqual([]);
 expect(retry.value[0]!.base.cells.every(cell=>cell.terrain==='land'&&!cell.building&&!cell.road)).toBe(true);
});

test('one unavailable region fails the whole capture instead of returning invented pieces',async()=>{
 // the first region answers, the second does not: a partial answer must not read as the requested region
 const maps=createOsmSource({fetcher:async input=>String(input).includes('/14/24278/37181.mvt')?new Response(new Uint8Array()):new Response('',{status:503})});
 const reality=createOsmRealitySource({maps,hasher,codec});
 const result=await reality.capture({chunks:['48557:74362','48558:74362']},request());
 expect(result).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
});

test('a region the client cannot address is refused before anything is fetched',async()=>{
 let requests=0;
 const maps=createOsmSource({fetcher:async()=>{requests++;return new Response(new Uint8Array())}});
 const reality=createOsmRealitySource({maps,hasher,codec});
 expect(await reality.capture({chunks:[]},request())).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(await reality.capture({chunks:['norte']},request())).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(requests).toBe(0);
});

test('a capture records the endpoint, the normalizer and the zoom the provider actually served',async()=>{
 let requests=0;
 const maps=createOsmSource({overviewZoom:11,fetcher:async()=>{requests++;return new Response(new Uint8Array());}});
 const reality=createOsmRealitySource({maps,hasher,codec});
 const detail=await reality.capture({chunks:['48557:74362','48558:74362']},request({terms:{attribution:'atribuição inventada por quem pediu'}}));
 expect(detail.ok).toBe(true);
 if(!detail.ok)return;
 // two regions of one tile cost one request: a capture never widens the area it was asked for and asks for nothing new
 expect(requests).toBe(1);
 const first=detail.value[0]!;
 expect(first.revision.source).toEqual({id:'openstreetmap-shortbread-v1',dataset:'OpenStreetMap · Shortbread v1',url:'https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt'});
 // the tiles state no supplier revision: the field stays absent instead of being filled with today's date
 expect('providerRevision' in first.revision.source).toBe(false);
 expect(first.revision.transformation).toEqual({name:'osm-shortbread',version:1});
 expect(first.revision.capture).toEqual({scope:'chunk',chunk:'48557:74362',level:'detail',zoom:14,featureIds:'unknown'});
 expect(first.revision.times).toEqual({retrievedAt:'2026-09-29T12:00:00Z'});
 // the chunk carries the label the provider gave it, and the attribution is the provider's, not the caller's
 expect(first.revision.source.dataset).toBe(first.base.source);
 expect(first.revision.terms).toEqual({attribution:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright'});
 // a licence the caller does declare travels with the capture
 const licensed=await reality.capture({chunks:['48557:74362']},request({terms:{license:'ODbL'}}));
 if(!licensed.ok)throw new Error('captura falhou');
 expect(licensed.value[0]!.revision.terms).toEqual({attribution:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright',license:'ODbL'});
 // a coarse level is recorded as what it is: an approximation of the same place, at the zoom really served
 const overview=await reality.capture({chunks:['48557:74362']},request({level:'overview'}));
 if(!overview.ok)throw new Error('captura falhou');
 expect(overview.value[0]!.revision.capture).toEqual({scope:'chunk',chunk:'48557:74362',level:'overview',zoom:11,featureIds:'unknown'});
 expect(overview.value[0]!.base.source).toContain('aproximação z11');
});
