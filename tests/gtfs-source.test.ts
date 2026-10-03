// Importing a real transit family (plan Task 15) and what it refuses. The synthetic feed here is the same content as
// the committed fixture `transit-small.zip`: it states its own provenance as a fixture, no stop or route is a copy of
// anyone's real operation, and the coordinates only need to be plausible for a bounding box.
import {RULES_VERSION} from '../src/core/model';
import {expect,test} from 'vitest';
import {readFileSync} from 'node:fs';
import {deflateRawSync} from 'node:zlib';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
import {TRANSIT_LIMITS,associateTransit,importTransit} from '../src/adapters/reality/gtfs';
import type {TransitDataset} from '../src/adapters/reality/gtfs';
import {describeTransitDataset} from '../src/surfaces/canvas/source-inspector';
import {decodeBundle,encodeBundle,verifyBundle} from '../src/world/codec';
import {createKernel} from '../src/world/kernel';
import type {JsonValue,WorldBundle} from '../src/world/model';
import {provenanceTerms} from '../src/world/observations';
import {checkCoreComponent,entityIdOf,parseOsimUri} from '../src/world/osim';
import type {CaptureContext} from '../src/world/reality';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const codec=createJcsCodec(),hasher=bytesHasher();
const TERMS={attribution:'Fixture sintética de transporte',license:'CC0-1.0'};
const SOURCE={id:'fixture-transit-v1',dataset:'Fixture sintética de transporte',url:'https://example.invalid/fixture/gtfs.zip',providerRevision:'2026-09-29'};
// Everything the importer has to be told. The clock belongs to the caller, so the same bytes and the same context
// always produce the same revision.
const context=(over:Partial<CaptureContext>={}):CaptureContext=>({
 codec,
 source:{...SOURCE},
 terms:{...TERMS},
 transformation:{name:'gtfs-schedule',version:1},
 capture:{level:'detail',zoom:14},
 retrievedAt:'2026-09-29T12:00:00Z',
 ...over,
});
const importFixture=(over:Partial<CaptureContext>={})=>imported(FEED,over);

// --- the synthetic feed, as text: the committed zip carries exactly these files -------------------------------
const FEED:Record<string,string>={
 'agency.txt':[
  'agency_id,agency_name,agency_url,agency_timezone',
  'FIX,"Fixture sintética de transporte, sem relação com uma operação real",https://example.invalid/fixture,Europe/Lisbon',
 ].join('\n'),
 'stops.txt':[
  'stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding',
  'P1,Praça do Relógio,-23.550100,-46.633000,1',
  'P2,Estação Central,-23.554000,-46.640000,',
  'P3,Parque Norte,-23.545000,-46.628000,0',
  'P4,Terminal Sul,-23.562000,-46.636000,2',
 ].join('\n'),
 'routes.txt':[
  'route_id,route_short_name,route_long_name,route_type',
  'L1,101,Linha Azul,3',
  'L2,202,Linha Verde,3',
 ].join('\n'),
 'trips.txt':['route_id,service_id,trip_id,shape_id','L1,WD,T1,','L2,WD,T2,','L2,WD,T3,'].join('\n'),
 'stop_times.txt':[
  'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
  'T1,08:00:00,08:00:00,P1,1',
  'T1,08:10:00,08:10:00,P2,2',
  'T1,08:25:00,08:25:00,P3,3',
  'T2,23:50:00,23:50:00,P2,1',
  'T2,24:15:00,24:15:00,P4,2',
  'T3,09:00:00,09:00:00,P3,1',
  'T3,09:20:00,09:20:00,P4,2',
 ].join('\n'),
 'calendar.txt':[
  'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
  'WD,1,1,1,1,1,0,0,20260101,20261231',
 ].join('\n'),
 'calendar_dates.txt':['service_id,date,exception_type','WD,20260501,2'].join('\n'),
 'feed_info.txt':['feed_publisher_name,feed_publisher_url,feed_lang,feed_version','Fixture sintética,https://example.invalid/fixture,pt,fixture-1'].join('\n'),
};

// --- a zip writer for the cases above: the fixture is deflated, the refusals are built here ---------------------
type ZipFile={name:string;text?:string;bytes?:Uint8Array;method?:0|8;declared?:number};
function buildZip(files:readonly ZipFile[]):Uint8Array{
 const encoder=new TextEncoder(),parts:Uint8Array[]=[],central:Uint8Array[]=[];
 let offset=0;
 for(const file of files){
  const name=encoder.encode(file.name);
  const raw=file.bytes??encoder.encode(file.text??'');
  const method=file.method??8;
  const data=file.bytes??(method===8?new Uint8Array(deflateRawSync(raw)):raw);
  const declared=file.declared??raw.byteLength;
  const local=new Uint8Array(30+name.length),view=new DataView(local.buffer);
  view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(8,method,true);
  view.setUint32(18,data.byteLength,true);view.setUint32(22,declared,true);view.setUint16(26,name.length,true);
  local.set(name,30);
  parts.push(local,data);
  const entry=new Uint8Array(46+name.length),head=new DataView(entry.buffer);
  head.setUint32(0,0x02014b50,true);head.setUint16(4,20,true);head.setUint16(6,20,true);head.setUint16(10,method,true);
  head.setUint32(20,data.byteLength,true);head.setUint32(24,declared,true);head.setUint16(28,name.length,true);
  head.setUint32(42,offset,true);
  entry.set(name,46);
  central.push(entry);
  offset+=local.length+data.byteLength;
 }
 const directory=central.reduce((sum,part)=>sum+part.byteLength,0);
 const end=new Uint8Array(22),tail=new DataView(end.buffer);
 tail.setUint32(0,0x06054b50,true);tail.setUint16(8,files.length,true);tail.setUint16(10,files.length,true);
 tail.setUint32(12,directory,true);tail.setUint32(16,offset,true);
 const zip=new Uint8Array(offset+directory+22);
 let cursor=0;
 for(const part of [...parts,...central,end]){zip.set(part,cursor);cursor+=part.byteLength;}
 return zip;
}
// The same files, with one replaced, removed or added — how a real feed drifts or breaks.
function feedWith(change:Record<string,string|undefined>):Record<string,string>{
 const next={...FEED};
 for(const [name,text] of Object.entries(change)){if(text===undefined)delete next[name];else next[name]=text;}
 return next;
}
const zipOf=(files:Record<string,string>=FEED,method:0|8=8):Uint8Array=>buildZip(Object.entries(files).map(([name,text])=>({name,text,method})));
const imported=async(files:Record<string,string>,over:Partial<CaptureContext>={})=>{
 const result=await importTransit(zipOf(files),context(over),hasher);
 if(!result.ok)throw new Error(`importação recusada: ${result.error.message}`);
 return result.value;
};
const refusal=async(files:Record<string,string>,over:Partial<CaptureContext>={})=>{
 const result=await importTransit(zipOf(files),context(over),hasher);
 expect(result.ok,`esperava recusa, veio um conjunto`).toBe(false);
 if(result.ok)throw new Error('sem recusa');
 return result.error;
};
const stopOf=(dataset:TransitDataset,providerId:string)=>dataset.stops.find(stop=>stop.providerId===providerId)!;
const entityOf=(dataset:TransitDataset,providerId:string)=>dataset.entities.find(entity=>entity.providerId===providerId)!;

test('a real feed becomes a scheduled dataset with its declared zones, times and provider ids',async()=>{
 const dataset=await imported(FEED);
 expect(dataset.agencies).toEqual([{id:'FIX',name:'Fixture sintética de transporte, sem relação com uma operação real',url:'https://example.invalid/fixture',timezone:'Europe/Lisbon'}]);
 expect(dataset.timezone).toBe('Europe/Lisbon');
 expect(dataset.stops.map(stop=>stop.providerId)).toEqual(['P1','P2','P3','P4']);
 expect(stopOf(dataset,'P1')).toMatchObject({name:'Praça do Relógio',lat:-23.5501,lon:-46.633});
 // a column this importer does not model is the provider's data: it travels with the stop instead of being dropped
 expect(stopOf(dataset,'P1').rest).toEqual({wheelchair_boarding:'1'});
 // a blank field is undeclared, not a value
 expect(stopOf(dataset,'P2').rest).toBeUndefined();
 expect(dataset.routes.map(route=>route.providerId)).toEqual(['L1','L2']);
 expect(dataset.routes[0]).toMatchObject({name:'101 · Linha Azul',shortName:'101',longName:'Linha Azul',type:3});
 // the declared clock, not a converted one: 24:15 is past midnight and stays exactly what the source wrote
 const trip=dataset.routes[1]!.trips.find(entry=>entry.id==='T2')!;
 expect(trip.stops.map(stop=>stop.stopId)).toEqual(['P2','P4']);
 expect(trip.stops.map(stop=>stop.departure)).toEqual(['23:50:00','24:15:00']);
 expect(trip.stops[1]!.arrival).toBe('24:15:00');
 expect(dataset.calendars).toEqual([{serviceId:'WD',weekdays:['monday','tuesday','wednesday','thursday','friday'],startDate:'2026-01-01',endDate:'2026-12-31'}]);
 expect(dataset.exceptions).toEqual([{serviceId:'WD',date:'2026-05-01',type:'removed'}]);
 // the importer has no router and says so instead of presenting a straight line between two stops as a journey
 expect(dataset.capabilities).toEqual({routing:'not-computed',realtime:'not-included'});
 expect('geometry' in dataset.routes[0]!).toBe(false);
 expect('journeys' in dataset.routes[0]!).toBe(false);
});

test('stops and routes are protocol entities: a stop has its declared transform, a route only its declared stops',async()=>{
 const dataset=await imported(FEED);
 const stop=entityOf(dataset,'P1'),route=entityOf(dataset,'L1');
 // two clients derive the same entity from the same provider ids, and the source keeps its own id readable
 expect(stop.uri).toBe('osim:entity:stop-fixture_2d_transit_2d_v1-P1');
 expect(route.uri).toBe('osim:entity:route-fixture_2d_transit_2d_v1-L1');
 expect(entityIdOf(stop.uri)).toBe('stop-fixture_2d_transit_2d_v1-P1');
 expect(checkCoreComponent('osim.transform',stop.components['osim.transform'])).toMatchObject({ok:true});
 expect(stop.components['osim.transform']).toEqual({space:'osim:space:earth',position:{lat:-23.5501,lon:-46.633}});
 expect(stop.components['osim.name']).toEqual({default:'Praça do Relógio'});
 expect(stop.components['transit.stop']).toEqual({providerId:'P1',declared:{wheelchair_boarding:'1'}});
 expect(checkCoreComponent('osim.relations',route.components['osim.relations'])).toMatchObject({ok:true});
 // GTFS declares no route geometry, so none is invented: the route names the stops it was declared to serve
 expect('osim.transform' in route.components).toBe(false);
 expect(route.components['osim.relations']).toEqual({
  'stop-fixture_2d_transit_2d_v1-P1':'osim:entity:stop-fixture_2d_transit_2d_v1-P1',
  'stop-fixture_2d_transit_2d_v1-P2':'osim:entity:stop-fixture_2d_transit_2d_v1-P2',
  'stop-fixture_2d_transit_2d_v1-P3':'osim:entity:stop-fixture_2d_transit_2d_v1-P3',
 });
 expect(parseOsimUri(route.uri)).toEqual({scheme:'osim',kind:'entity',id:'route-fixture_2d_transit_2d_v1-L1'});
 // one claim per declared feature, tied to the provider's own identifier and to the revision that carries it
 const claim=dataset.claims.find(entry=>entry.sourceId==='P1')!;
 expect(claim).toMatchObject({method:'reported',subject:{kind:'capture'}});
 expect(claim.values).toEqual({entity:stop.uri,kind:'stop',providerId:'P1',name:'Praça do Relógio',lat:-23.5501,lon:-46.633});
 expect(dataset.claims.filter(entry=>entry.sourceId!==undefined)).toHaveLength(6);
 // the published entities enter a kernel by `publish` and are found by component, like any other protocol object
 const kernel=createKernel();
 for(const entity of dataset.entities){
  const object={osim:'0.1',type:'entity',id:entity.uri,actor:'did:key:zFixture',body:{components:entity.components} as unknown as JsonValue} as const;
  expect(await kernel.publish(object)).toMatchObject({ok:true,status:'applied'});
 }
 const stopsFound=kernel.query({components:['transit.stop']});
 expect(stopsFound).toMatchObject({ok:true,value:[
  'osim:entity:stop-fixture_2d_transit_2d_v1-P1',
  'osim:entity:stop-fixture_2d_transit_2d_v1-P2',
  'osim:entity:stop-fixture_2d_transit_2d_v1-P3',
  'osim:entity:stop-fixture_2d_transit_2d_v1-P4',
 ]});
 expect(kernel.query({components:['transit.route'],entity:route.uri})).toMatchObject({ok:true,value:[route.uri]});
 expect(kernel.query({components:['transit.route']})).toMatchObject({ok:true,value:['osim:entity:route-fixture_2d_transit_2d_v1-L1','osim:entity:route-fixture_2d_transit_2d_v1-L2']});
 const resolved=kernel.resolve(stop.uri);
 expect(resolved).toMatchObject({ok:true,value:{type:'entity'}});
});

test('the revision is addressed, quoted and portable, and the same feed always addresses the same dataset',async()=>{
 const dataset=await importFixture();
 const content=dataset.objects[0]!,record=dataset.objects[1]!;
 expect(content.value).toEqual({kind:'transit-dataset',dataset:expect.anything()});
 expect(await hasher.ref(codec.encode(content.value))).toEqual(content.ref);
 expect(dataset.revision.entity).toEqual(content.ref);
 expect(record.value).toEqual({kind:'capture',revision:dataset.revision,claims:dataset.claims});
 expect(await hasher.ref(codec.encode(record.value))).toEqual(record.ref);
 expect(dataset.revision).toMatchObject({
  source:{id:'fixture-transit-v1',providerRevision:'2026-09-29'},
  times:{retrievedAt:'2026-09-29T12:00:00Z'},
  terms:TERMS,
  transformation:{name:'gtfs-schedule',version:1},
  previous:[],
  extensions:{},
 });
 // coverage is the rectangle of the declared positions, said to be exactly that
 expect(dataset.revision.coverage).toEqual({kind:'declared-positions',crs:'EPSG:4326',unit:'degree',positions:4,bounds:{west:-46.64,east:-46.628,south:-23.562,north:-23.545}});
 expect(dataset.revision.format).toEqual({name:'GTFS Schedule',files:['agency.txt','calendar.txt','calendar_dates.txt','feed_info.txt','routes.txt','stop_times.txt','stops.txt','trips.txt'],declaredVersion:'fixture-1'});
 const bundle:WorldBundle={
  envelope:{worldProtocol:2,wireVersion:1,kind:'bundle'},
  definition:{worldId:'victoria',branchId:'main',origin:{kind:'new'},profiles:['city'],rules:{family:'city',version:RULES_VERSION}},
  objects:[...dataset.objects],
  terms:[provenanceTerms(dataset.revision)],
  completeness:{complete:true,missing:[]},
  extensions:{},
 };
 expect(await verifyBundle(bundle,hasher,codec)).toMatchObject({ok:true});
 expect(decodeBundle(encodeBundle(bundle,codec))).toMatchObject({ok:true,value:{terms:[{source:'Fixture sintética de transporte',attribution:TERMS.attribution,license:TERMS.license}]}});
 // the committed fixture carries this feed: same bytes in, same address out
 const fixture=await importTransit(new Uint8Array(readFileSync(join(ROOT,'tests/fixtures/federated-world/transit-small.zip'))),context(),hasher);
 expect(fixture.ok).toBe(true);
 if(!fixture.ok)return;
 expect(fixture.value.revision.entity).toEqual(dataset.revision.entity);
 expect(fixture.value.agencies[0]!.name).toContain('Fixture sintética');
 // importing the same bytes twice is the same revision, and a newer revision references the one it replaces
 const again=await importFixture();
 expect(again.revision.entity.hash).toBe(dataset.revision.entity.hash);
 const newer=await importFixture({source:{...SOURCE,providerRevision:'2026-09-30'},previous:[dataset.objects[1]!.ref]});
 expect(newer.revision.previous).toEqual([record.ref]);
 expect(newer.revision.entity.hash).toBe(dataset.revision.entity.hash);
});

test('a feed that references a line, a stop or a service it does not declare is refused',async()=>{
 const missingStop=await refusal(feedWith({'stop_times.txt':FEED['stop_times.txt']!.replace(',P4,2',',P9,2')}));
 expect(missingStop.code).toBe('MALFORMED');
 expect(missingStop.message).toContain('P9');
 const missingRoute=await refusal(feedWith({'trips.txt':FEED['trips.txt']!.replace('L2,WD,T2','L9,WD,T2')}));
 expect(missingRoute.message).toContain('L9');
 const missingService=await refusal(feedWith({'calendar.txt':FEED['calendar.txt']!.replace('WD,','SU,'),'calendar_dates.txt':undefined}));
 expect(missingService.message).toContain('WD');
 const duplicated=await refusal(feedWith({'stops.txt':`${FEED['stops.txt']!}\nP1,Outra Praça,-23.5,-46.6,`}));
 expect(duplicated.message).toContain('P1');
 const repeatedSequence=await refusal(feedWith({'stop_times.txt':FEED['stop_times.txt']!.replace('T1,08:00:00,08:00:00,P1,1','T1,08:00:00,08:00:00,P1,2')}));
 expect(repeatedSequence.message).toContain('sequência');
 const absent=await refusal(feedWith({'stop_times.txt':undefined}));
 expect(absent.message).toContain('stop_times.txt');
 const noTimezone=await refusal(feedWith({'agency.txt':'agency_id,agency_name,agency_url,agency_timezone\nFIX,Fixture,https://example.invalid/fixture,'}));
 expect(noTimezone.message).toContain('fuso');
 const numericZone=await refusal(feedWith({'agency.txt':'agency_id,agency_name,agency_url,agency_timezone\nFIX,Fixture,https://example.invalid/fixture,UTC-3'}));
 expect(numericZone.message).toContain('fuso');
 const splitZones=await refusal(feedWith({'agency.txt':`${FEED['agency.txt']!}\nOTHER,Outra,https://example.invalid/other,America/Sao_Paulo`}));
 expect(splitZones.message).toContain('fusos');
 const badCoordinate=await refusal(feedWith({'stops.txt':FEED['stops.txt']!.replace('-23.550100','-91.5')}));
 expect(badCoordinate.message).toContain('P1');
 const badTime=await refusal(feedWith({'stop_times.txt':FEED['stop_times.txt']!.replace('08:00:00,08:00:00','8h,08:00:00')}));
 expect(badTime.message).toContain('horário');
});

test('a zip is bounded before anything is expanded, and the importer says which bound it hit',async()=>{
 // a directory entry that declares far more than the limit: the inflated bytes are never read, and the payload here
 // is not even a deflate stream, so a limit answer proves the refusal happened before expanding anything
 const bomb=buildZip([
  {name:'stops.txt',text:FEED['stops.txt']!},
  {name:'stop_times.txt',bytes:new Uint8Array([0xff,0xff,0xff,0xff]),method:8,declared:TRANSIT_LIMITS.expanded+1},
 ]);
 const tooBig=await importTransit(bomb,context(),hasher);
 expect(tooBig).toMatchObject({ok:false,error:{code:'LIMIT'}});
 if(tooBig.ok)return;
 expect(tooBig.error.message).toContain(`${TRANSIT_LIMITS.expanded}`);
 // the archive itself has the same ceiling a world object has, checked before the directory is even looked at
 expect((await importTransit(new Uint8Array(TRANSIT_LIMITS.archive+1),context(),hasher))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 const many=buildZip(Array.from({length:TRANSIT_LIMITS.entries+1},(_,index)=>({name:`file-${index}.txt`,text:'a'})));
 expect(await importTransit(many,context(),hasher)).toMatchObject({ok:false,error:{code:'LIMIT'}});
 // a stored (uncompressed) entry is read as such, and a truncated archive is a malformed one
 const stored=await importTransit(zipOf(FEED,0),context(),hasher);
 expect(stored.ok).toBe(true);
 expect(await importTransit(zipOf(FEED).slice(0,40),context(),hasher)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
});

test('a capture context that states no honest time or no licence stays that way',async()=>{
 expect(await importTransit(zipOf(),context({retrievedAt:'ontem'}),hasher)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const both={observedAt:'2026-09-28T03:00:00Z',interval:{from:'2026-09-01T00:00:00Z',to:'2026-09-28T00:00:00Z'}};
 expect(await importTransit(zipOf(),context(both),hasher)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const undeclared=await importTransit(zipOf(),context({terms:{attribution:'Fixture sintética'}}),hasher);
 expect(undeclared.ok).toBe(true);
 if(!undeclared.ok)return;
 // a source that declares no redistribution licence borrows none, not even from the fixture beside it
 expect('license' in undeclared.value.revision.terms).toBe(false);
 expect(provenanceTerms(undeclared.value.revision)).toEqual({source:'Fixture sintética de transporte',attribution:'Fixture sintética'});
});

test('the same provider id from two providers is two entities, and association across providers is refused',async()=>{
 const other=await imported(FEED,{source:{id:'outra-fonte',dataset:'Outra fixture sintética',url:'https://example.invalid/other/gtfs.zip'}});
 const first=await imported(FEED);
 const mine=entityOf(first,'P1'),theirs=entityOf(other,'P1');
 // one provider id, two providers: the local address names the provider, so the two stops are never one entity
 expect(mine.uri).not.toBe(theirs.uri);
 expect(theirs.uri).toBe('osim:entity:stop-outra_2d_fonte-P1');
 const acrossProviders=await associateTransit(first,other);
 expect(acrossProviders).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 if(acrossProviders.ok)return;
 expect(acrossProviders.error.message).toContain('fornecedores diferentes');
});

test('two packages of the same source are compared by provider id, and a guess between two stopped ids is refused',async()=>{
 const before=await imported(FEED);
 const moved=await imported(feedWith({'stops.txt':FEED['stops.txt']!.replace('P1,Praça do Relógio,-23.550100,-46.633000,1','P1,Praça do Relógio,-23.550200,-46.633100,1')}));
 const same=await associateTransit(before,moved);
 expect(same.ok).toBe(true);
 if(!same.ok)return;
 expect(same.value.moved).toEqual([{providerId:'P1',before:{lat:-23.5501,lon:-46.633},after:{lat:-23.5502,lon:-46.6331}}]);
 expect(same.value.kept).toBe(4);
 expect(same.value.added).toEqual([]);
 expect(same.value.removed).toEqual([]);
 const drifted=await imported(feedWith({
  'stops.txt':FEED['stops.txt']!.replace('P4,Terminal Sul,-23.562000,-46.636000,2','P5,Terminal Novo,-23.568000,-46.630000,'),
  'stop_times.txt':FEED['stop_times.txt']!.replaceAll('P4','P5'),
 }));
 const changed=await associateTransit(before,drifted);
 expect(changed).toMatchObject({ok:true,value:{added:['P5'],removed:['P4']}});
 // the same position under a new provider id may be a rename or another stop: the importer refuses to guess
 const ambiguous=await imported(feedWith({
  'stops.txt':FEED['stops.txt']!.replace('P4,Terminal Sul,-23.562000,-46.636000,2','P5,Terminal Novo,-23.562000,-46.636000,'),
  'stop_times.txt':FEED['stop_times.txt']!.replaceAll('P4','P5'),
 }));
 const guess=await associateTransit(before,ambiguous);
 expect(guess).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 if(guess.ok)return;
 expect(guess.error.message).toContain('ambígua');
});

test('the player reads where the data came from, under which terms and what it does not do',async()=>{
 const dataset=await imported(FEED);
 const info=describeTransitDataset(dataset);
 const row=(label:string)=>info.rows.find(entry=>entry.label===label)?.value;
 expect(row('Fonte')).toContain('Fixture sintética de transporte');
 expect(row('Licença')).toBe('CC0-1.0');
 expect(row('Atribuição')).toBe('Fixture sintética de transporte');
 expect(row('Fuso declarado')).toBe('Europe/Lisbon');
 expect(row('Paradas')).toBe('4');
 expect(row('Linhas')).toBe('2');
 expect(row('Retirado em')).toBe('2026-09-29T12:00:00Z');
 expect(row('Observado em')).toBe('não declarado');
 expect(info.notes.join(' | ')).toContain('não calcula rotas');
 expect(info.notes.join(' | ')).toContain('24 h');
});

test('shape points sort by declared sequence and trips preserve shape and direction references',async()=>{
 const feed={...FEED,'trips.txt':'route_id,service_id,trip_id,shape_id,direction_id\nL1,WD,T1,S1,0\nL2,WD,T2,,1\nL2,WD,T3,,0','shapes.txt':'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\nS1,-23.554,-46.640,2,100\nS1,-23.5501,-46.633,1,0'};
 const result=await imported(feed);
 expect(result.shapes[0].points.map(p=>p.sequence)).toEqual([1,2]);
 expect(result.routes[0].trips[0]).toMatchObject({shapeId:'S1',directionId:'0'});
});

test('a declared shape reference cannot silently point to missing geometry',async()=>{
 await refusal({...FEED,'trips.txt':FEED['trips.txt'].replace('T1,','T1,missing')});
});

test('bundled Vancouver capture retains official validity, shapes and bus/ferry mode separation',()=>{
 const capture=JSON.parse(readFileSync(join(ROOT,'src/adapters/reality/data/vancouver-transit.json'),'utf8'));
 expect(capture.capture.feedInfo[0]).toMatchObject({feed_start_date:'20260907',feed_end_date:'20270103',feed_version:'26SEP_20261002'});
 expect(capture.timezone).toBe('America/Vancouver');expect(capture.shapes).toHaveLength(408);expect(capture.routes).toHaveLength(73);expect(capture.routes.some((r:{type:number})=>r.type===4)).toBe(true);
 const line=capture.routes.find((r:{shortName:string})=>r.shortName==='019');
 expect(line.trips.find((t:{id:string})=>t.id==='15453276')).toMatchObject({shapeId:'321364',directionId:'0'});
 expect(line.trips.find((t:{id:string})=>t.id==='15453451')).toMatchObject({shapeId:'321373',directionId:'1'});
});

test('bundled normalized transit content agrees with its provenance content address',async()=>{
 const capture=JSON.parse(readFileSync(join(ROOT,'src/adapters/reality/data/vancouver-transit.json'),'utf8'));
 const {revision,capture:_capture,attribution:_attribution,...content}=capture;
 expect(await hasher.ref(codec.encode({kind:'transit-dataset',dataset:content}))).toEqual(revision.entity);
});
