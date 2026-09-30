// A real transit family (plan Task 15): a GTFS Schedule feed read from the archive a provider publishes, into declared
// stops, routes, a calendar, a timezone and the protocol entities a profile can attach to. Two things this file
// refuses to do are the point of it: it never invents a route geometry GTFS does not carry, and it never turns a
// schedule into a journey — there is no router here, and the dataset says so in its own capabilities.
//
// The archive is read with platform APIs only (`DecompressionStream('deflate-raw')`, no dependency). The central
// directory is parsed first, so an archive that declares more than this importer may expand is refused before a single
// entry is inflated, and a header that lies about its size is bounded while it expands as well as in the directory.
// `importTransit` is asynchronous because that inflater is a stream; the address of the normalized dataset comes from
// the injected port, exactly as `captureBase` takes it.
import {decodeUtf8} from '../../world/codec';
import type {JsonValue,WorldObject,WorldResult} from '../../world/model';
import {failed,ok} from '../../world/model';
import type {DatasetProvenance,FeedCoverage} from '../../world/observations';
import {datasetProvenance,externalEntityId} from '../../world/observations';
import {checkCoreComponent,entityUri} from '../../world/osim';
import type {ContentHasher} from '../../world/ports';
import type {CaptureContext,SourceClaim} from '../../world/reality';

// What this importer will expand, before it expands it. The archive and a single entry are bounded by the same numbers
// a world object is, and the sum of the files it actually reads is bounded separately, so a feed whose unused files
// are enormous is not refused for bytes this client never touches (spec §9.3, R13).
export const TRANSIT_LIMITS={archive:32*1024*1024,entry:16*1024*1024,expanded:64*1024*1024,entries:64,rows:200000};
export const GTFS_REQUIRED:readonly string[]=['agency.txt','stops.txt','routes.txt','trips.txt','stop_times.txt'];
export const GTFS_OPTIONAL:readonly string[]=['calendar.txt','calendar_dates.txt','feed_info.txt'];
const ZONE=/^[A-Za-z][A-Za-z0-9_+-]*\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/;
const CLOCK=/^([0-9]{1,2}):([0-9]{2}):([0-9]{2})$/;
const DATE=/^[0-9]{8}$/;
const WEEKDAYS:readonly string[]=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
const STOP_COLUMNS:readonly string[]=['stop_id','stop_name','stop_lat','stop_lon'];
const ROUTE_COLUMNS:readonly string[]=['route_id','route_short_name','route_long_name','route_type'];

export type TransitAgency={id?:string;name:string;url?:string;timezone:string};
// `label` is present only when the readable name is not one: a stop without a declared name keeps its provider id as a
// label and says so, so nothing about the source's own identifier is presented as a place name.
export type TransitStop={providerId:string;name:string;label?:'provider-id';lat:number;lon:number;rest?:Record<string,string>};
export type TransitStopTime={stopId:string;arrival:string;departure:string};
export type TransitTrip={id:string;serviceId:string;stops:readonly TransitStopTime[]};
export type TransitRoute={providerId:string;name:string;label?:'provider-id';shortName?:string;longName?:string;type:number;trips:readonly TransitTrip[];rest?:Record<string,string>};
export type TransitCalendar={serviceId:string;weekdays:readonly string[];startDate:string;endDate:string};
export type TransitException={serviceId:string;date:string;type:'added'|'removed'};
export type TransitEntity={uri:string;kind:'stop'|'route';providerId:string;components:Record<string,unknown>};
export type TransitCapabilities={routing:'not-computed';realtime:'not-included'};
export type TransitContent={
 timezone:string;
 agencies:readonly TransitAgency[];
 stops:readonly TransitStop[];
 routes:readonly TransitRoute[];
 calendars:readonly TransitCalendar[];
 exceptions:readonly TransitException[];
 entities:readonly TransitEntity[];
 capabilities:TransitCapabilities;
};
export type TransitDataset=TransitContent&{
 revision:DatasetProvenance;
 claims:readonly SourceClaim[];
 objects:readonly WorldObject[];
};

// --- the archive ------------------------------------------------------------------------------------------------
// A zip read from its central directory: name, method, declared sizes and the offset of the local header. Local headers
// repeat the name and the extra field, so the data starts after them instead of at a fixed distance.
type ZipEntry={name:string;method:number;compressed:number;uncompressed:number;offset:number};
type Zip={bytes:Uint8Array;entries:readonly ZipEntry[]};
const ZIP64=0xffffffff;

function u16(bytes:Uint8Array,at:number):number{return bytes[at]!|(bytes[at+1]!<<8);}
function u32(bytes:Uint8Array,at:number):number{return (bytes[at]!|(bytes[at+1]!<<8)|(bytes[at+2]!<<16)|(bytes[at+3]!<<24))>>>0;}
function readZip(bytes:Uint8Array):WorldResult<Zip>{
 if(bytes.byteLength>TRANSIT_LIMITS.archive)return failed('LIMIT',`O arquivo tem ${bytes.byteLength} bytes, acima do limite de ${TRANSIT_LIMITS.archive}`);
 // The end-of-central-directory record is the last thing in the file (its comment is not read), so it is found from the
 // end backwards and the whole directory is then walked once.
 let end=-1;
 for(let at=bytes.byteLength-22;at>=0&&at>=bytes.byteLength-22-65535;at-=1)if(u32(bytes,at)===0x06054b50){end=at;break;}
 if(end<0)return failed('MALFORMED','O arquivo não é um zip (registro final ausente)');
 if(u16(bytes,end+4)!==0||u16(bytes,end+6)!==0)return failed('MALFORMED','Um zip dividido em vários discos não é lido');
 const count=u16(bytes,end+10),directory=u32(bytes,end+12),offset=u32(bytes,end+16);
 if(count>TRANSIT_LIMITS.entries)return failed('LIMIT',`O zip traz ${count} arquivos, acima do limite de ${TRANSIT_LIMITS.entries}`);
 if(offset+directory>bytes.byteLength)return failed('MALFORMED','O zip termina antes do seu diretório');
 const entries:ZipEntry[]=[];
 let cursor=offset;
 for(let index=0;index<count;index+=1){
  if(cursor+46>bytes.byteLength||u32(bytes,cursor)!==0x02014b50)return failed('MALFORMED',`O diretório do zip termina na entrada ${index+1}`);
  const flags=u16(bytes,cursor+8),method=u16(bytes,cursor+10),compressed=u32(bytes,cursor+20),uncompressed=u32(bytes,cursor+24);
  const nameLength=u16(bytes,cursor+28),extraLength=u16(bytes,cursor+30),commentLength=u16(bytes,cursor+32),local=u32(bytes,cursor+42);
  if(flags&0x1)return failed('MALFORMED','O zip está cifrado: as entradas não podem ser lidas nem verificadas');
  if(compressed===ZIP64||uncompressed===ZIP64||local===ZIP64)return failed('LIMIT','Um zip ZIP64 declara tamanhos que este importador não lê');
  if(method!==0&&method!==8)return failed('MALFORMED',`O zip usa um método de compressão que este importador não lê (${method})`);
  const name=decodeUtf8(bytes.subarray(cursor+46,cursor+46+nameLength));
  if(!name.ok)return name;
  entries.push({name:name.value,method,compressed,uncompressed,offset:local});
  cursor+=46+nameLength+extraLength+commentLength;
 }
 return ok({bytes,entries});
}
// A stream that fails is a file that is not what it said it was, and a stream that grows past the declared or allowed
// size is stopped instead of being allocated.
// `DecompressionStream` is declared over `BufferSource` while a piped stream is typed over `Uint8Array`; the runtime
// contract is the one the standard states, so the pair is passed as the standard writes it and nothing is transformed.
function rawInflater():TransformStream<Uint8Array,Uint8Array>{
 return new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array,Uint8Array>;
}
async function inflate(data:Uint8Array,limit:number):Promise<WorldResult<Uint8Array>>{
 const reader=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(data);controller.close();}}).pipeThrough(rawInflater()).getReader();
 const parts:Uint8Array[]=[];
 let total=0;
 try{
  for(;;){
   const step=await reader.read();
   if(step.done)break;
   total+=step.value.byteLength;
   if(total>limit){await reader.cancel();return failed('LIMIT',`Um arquivo do zip expandiu além de ${limit} bytes`);}
   parts.push(step.value);
  }
 }catch(error){
  return failed('MALFORMED',`Um arquivo do zip não pôde ser expandido (${error instanceof Error?error.message:'fluxo inválido'})`);
 }
 const out=new Uint8Array(total);
 let written=0;
 for(const part of parts){out.set(part,written);written+=part.byteLength;}
 return ok(out);
}
async function readEntry(zip:Zip,entry:ZipEntry):Promise<WorldResult<string>>{
 const {bytes}=zip;
 if(entry.offset+30>bytes.byteLength||u32(bytes,entry.offset)!==0x04034b50)return failed('MALFORMED',`${entry.name} não tem cabeçalho local no zip`);
 const start=entry.offset+30+u16(bytes,entry.offset+26)+u16(bytes,entry.offset+28);
 if(start+entry.compressed>bytes.byteLength)return failed('MALFORMED',`${entry.name} é declarado com ${entry.compressed} bytes e o zip termina antes`);
 const raw=bytes.subarray(start,start+entry.compressed);
 const expanded=entry.method===0?ok(raw):await inflate(raw,Math.min(entry.uncompressed,TRANSIT_LIMITS.entry));
 if(!expanded.ok)return failed(expanded.error.code,`${entry.name}: ${expanded.error.message}`);
 // A stored entry that does not have the size it declared is a defective archive, and so is an inflated one.
 if(expanded.value.byteLength!==entry.uncompressed)return failed('MALFORMED',`${entry.name} declarou ${entry.uncompressed} bytes e trouxe ${expanded.value.byteLength}`);
 return decodeUtf8(expanded.value);
}

// --- CSV as GTFS states it (RFC 4180) --------------------------------------------------------------------------
// A quoted field may hold a comma, a newline and a doubled quote. A row whose width does not match the header is
// refused: guessing which column a value belongs to is exactly the silent repair this importer does not do.
type Row=Record<string,string>;
type Table={header:readonly string[];rows:readonly Row[]};

function csvRows(text:string,label:string):WorldResult<string[][]>{
 const body=text.startsWith('\uFEFF')?text.slice(1):text;
 const rows:string[][]=[];
 let row:string[]=[],field='',quoted=false;
 // A line separator is not a row: an empty line is dropped instead of being reported as a short one.
 const keep=(values:string[]):void=>{
  if(!(values.length===1&&values[0]===''))rows.push(values);
 };
 for(let index=0;index<body.length;index+=1){
  const character=body[index]!;
  if(quoted){
   if(character!=='"'){field+=character;continue;}
   if(body[index+1]==='"'){field+='"';index+=1;continue;}
   quoted=false;
   continue;
  }
  if(character==='"'){quoted=true;continue;}
  if(character!==','&&character!=='\n'&&character!=='\r'){field+=character;continue;}
  if(character==='\r'&&body[index+1]==='\n')index+=1;
  row.push(field);
  field='';
  if(character!==','){keep(row);row=[];}
  if(rows.length>TRANSIT_LIMITS.rows)return failed('LIMIT',`${label} tem mais de ${TRANSIT_LIMITS.rows} linhas`);
 }
 if(quoted)return failed('MALFORMED',`${label} termina com um campo entre aspas não fechado`);
 if(field.length||row.length)keep([...row,field]);
 if(rows.length>TRANSIT_LIMITS.rows)return failed('LIMIT',`${label} tem mais de ${TRANSIT_LIMITS.rows} linhas`);
 return ok(rows);
}
function tableOf(rows:string[][],label:string):WorldResult<Table>{
 if(!rows.length)return failed('MALFORMED',`${label} está vazio`);
 const header=rows[0]!;
 if(header.some(name=>!name.length))return failed('MALFORMED',`${label} tem uma coluna sem nome`);
 if(new Set(header).size!==header.length)return failed('MALFORMED',`${label} declara a mesma coluna duas vezes`);
 const table:Row[]=[];
 for(const values of rows.slice(1)){
  if(values.length!==header.length)return failed('MALFORMED',`${label} tem uma linha com ${values.length} valores e ${header.length} colunas`);
  const row:Row={};
  for(let at=0;at<header.length;at+=1)row[header[at]!]=values[at]!;
  table.push(row);
 }
 return ok({header,rows:table});
}
// The columns this importer does not model are the provider's data: they travel under `rest` instead of being dropped,
// and a blank field is undeclared rather than a value (protocol §2.3 applied to a provider format).
function restOf(row:Row,known:readonly string[]):Record<string,string>|undefined{
 const rest:Record<string,string>={};
 for(const key of Object.keys(row))if(!known.includes(key)&&row[key]!.length)rest[key]=row[key]!;
 return Object.keys(rest).length?rest:undefined;
}
function field(row:Row,name:string,label:string):WorldResult<string>{
 const value=row[name];
 return typeof value==='string'&&value.length?ok(value):failed('MALFORMED',`${label} não declara ${name}`);
}
function clock(value:string,label:string):WorldResult<string>{
 const parts=CLOCK.exec(value);
 // GTFS times are local to the feed's zone and may pass midnight: 24:15 is kept as written, and nothing is converted.
 const valid=parts&&Number(parts[2])<60&&Number(parts[3])<60;
 return valid?ok(value):failed('MALFORMED',`${label} ${value}, que não é um horário declarado (HH:MM:SS)`);
}
function calendarDate(value:string,label:string):WorldResult<string>{
 return DATE.test(value)?ok(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}`):failed('MALFORMED',`${label} ${value}, que não é uma data declarada (AAAAMMDD)`);
}
function coordinate(value:string,label:string,limit:number):WorldResult<number>{
 const number=Number(value);
 return value.length&&Number.isFinite(number)&&Math.abs(number)<=limit?ok(number):failed('MALFORMED',`A parada ${label} declara a coordenada ${value||'(vazia)'}, que não é um número no intervalo permitido`);
}
function integer(value:string,label:string,name:string):WorldResult<number>{
 return /^-?[0-9]+$/.test(value)?ok(Number(value)):failed('MALFORMED',`${label} não declara ${name} como um número inteiro (${value||'(vazio)'})`);
}

// --- the import -----------------------------------------------------------------------------------------------
// A feed is read as a whole: a stop_times row that names a line, a stop or a service the feed does not declare is a
// defective feed, and a partly imported one would be a second, invented network.
export async function importTransit(bytes:Uint8Array,context:CaptureContext,hash:ContentHasher):Promise<WorldResult<TransitDataset>>{
 const zip=readZip(bytes);
 if(!zip.ok)return zip;
 const wanted=[...GTFS_REQUIRED,...GTFS_OPTIONAL];
 const present=zip.value.entries.filter(entry=>wanted.includes(entry.name));
 const declared=present.reduce((sum,entry)=>sum+entry.uncompressed,0);
 if(declared>TRANSIT_LIMITS.expanded)return failed('LIMIT',`O zip declara ${declared} bytes expandidos para os arquivos lidos, acima do limite de ${TRANSIT_LIMITS.expanded}`);
 const oversized=present.find(entry=>entry.uncompressed>TRANSIT_LIMITS.entry);
 if(oversized)return failed('LIMIT',`${oversized.name} declara ${oversized.uncompressed} bytes, acima do limite de ${TRANSIT_LIMITS.entry} por arquivo`);
 for(const name of GTFS_REQUIRED)if(!present.some(entry=>entry.name===name))return failed('MALFORMED',`${name} não está no arquivo: um quadro de horários sem ele não é lido`);
 if(!present.some(entry=>entry.name==='calendar.txt'||entry.name==='calendar_dates.txt'))return failed('MALFORMED','O arquivo não declara calendário nem exceções: os serviços das viagens ficariam sem data');
 const tables:Record<string,Table>={};
 for(const entry of present){
  const text=await readEntry(zip.value,entry);
  if(!text.ok)return text;
  const rows=csvRows(text.value,entry.name);
  if(!rows.ok)return rows;
  const table=tableOf(rows.value,entry.name);
  if(!table.ok)return table;
  tables[entry.name]=table.value;
 }
 const agencies=agenciesOf(tables['agency.txt']!);
 if(!agencies.ok)return agencies;
 // GTFS puts every agency of a feed in one zone, and this importer keeps the declared name instead of converting it.
 if(new Set(agencies.value.map(agency=>agency.timezone)).size>1)return failed('MALFORMED','Os agentes do arquivo declaram fusos diferentes: o quadro de horários não tem um fuso só');
 const stops=stopsOf(tables['stops.txt']!);
 if(!stops.ok)return stops;
 const routes=routesOf(tables['routes.txt']!);
 if(!routes.ok)return routes;
 const services=servicesOf(tables['calendar.txt'],tables['calendar_dates.txt']);
 if(!services.ok)return services;
 const trips=tripsOf(tables['trips.txt']!,tables['stop_times.txt']!,routes.value,stops.value,services.value);
 if(!trips.ok)return trips;
 const published=entitiesOf(context.source.id,stops.value,trips.value);
 if(!published.ok)return published;
 const content:TransitContent={
  timezone:agencies.value[0]!.timezone,
  agencies:agencies.value,
  stops:stops.value,
  routes:trips.value,
  calendars:services.value.calendars,
  exceptions:services.value.exceptions,
  entities:published.value.entities,
  // What this import is not. A GTFS Schedule declares a network and a timetable; it gives no router, and its realtime
  // counterpart is another product (spec §3.2: física, horário publicado e disponibilidade observada são coisas
  // diferentes).
  capabilities:{routing:'not-computed',realtime:'not-included'},
 };
 const datasetValue={kind:'transit-dataset',dataset:content as unknown as JsonValue} as JsonValue;
 const entity=await hash.ref(context.codec.encode(datasetValue));
 const version=declaredVersion(tables['feed_info.txt']);
 const revision=datasetProvenance({
  source:context.source,
  times:context,
  terms:context.terms,
  transformation:context.transformation,
  entity,
  coverage:coverageOf(stops.value),
  format:{name:'GTFS Schedule',files:present.map(entry=>entry.name).sort(),...(version?{declaredVersion:version}:{})},
  ...(context.previous?{previous:context.previous}:{}),
  ...(context.extensions?{extensions:context.extensions}:{}),
 });
 if(!revision.ok)return revision;
 const claims=[...published.value.claims];
 const recordValue={kind:'capture',revision:revision.value,claims} as unknown as JsonValue;
 return ok({...content,revision:revision.value,claims,objects:[{ref:entity,value:datasetValue},{ref:await hash.ref(context.codec.encode(recordValue)),value:recordValue}]});
}

// The rectangle the declared positions cover, said to be exactly that: the stops a provider listed, not a service area.
function coverageOf(stops:readonly TransitStop[]):FeedCoverage{
 let west=Infinity,east=-Infinity,south=Infinity,north=-Infinity;
 for(const stop of stops){
  if(stop.lon<west)west=stop.lon;
  if(stop.lon>east)east=stop.lon;
  if(stop.lat<south)south=stop.lat;
  if(stop.lat>north)north=stop.lat;
 }
 return {kind:'declared-positions',crs:'EPSG:4326',unit:'degree',positions:stops.length,bounds:{west,east,south,north}};
}
function declaredVersion(table:Table|undefined):string|undefined{
 const value=table?.rows[0]?.['feed_version'];
 return value&&value.length?value:undefined;
}
function agenciesOf(table:Table):WorldResult<TransitAgency[]>{
 const agencies:TransitAgency[]=[];
 for(const row of table.rows){
  const name=field(row,'agency_name','Um agente do arquivo');
  if(!name.ok)return name;
  const zone=row['agency_timezone']??'';
  if(!zone.length)return failed('MALFORMED',`O agente ${name.value} não declara o fuso (agency_timezone) do quadro de horários`);
  // A named zone, never an offset: `UTC-3` does not say which offset a clock is read in during the other half of the
  // year, so it is refused instead of assumed.
  if(!ZONE.test(zone))return failed('MALFORMED',`O agente ${name.value} declara o fuso ${zone}, que não é uma zona nomeada`);
  const agency:TransitAgency={name:name.value,timezone:zone};
  if(row['agency_id']?.length)agency.id=row['agency_id']!;
  if(row['agency_url']?.length)agency.url=row['agency_url']!;
  agencies.push(agency);
 }
 return agencies.length?ok(agencies):failed('MALFORMED','O arquivo não declara nenhum agente');
}
function stopsOf(table:Table):WorldResult<TransitStop[]>{
 const stops:TransitStop[]=[];
 const seen=new Set<string>();
 for(const row of table.rows){
  const id=field(row,'stop_id','Uma parada do arquivo');
  if(!id.ok)return id;
  if(seen.has(id.value))return failed('MALFORMED',`A parada ${id.value} aparece duas vezes no arquivo`);
  seen.add(id.value);
  const lat=coordinate(row['stop_lat']??'',id.value,90),lon=coordinate(row['stop_lon']??'',id.value,180);
  if(!lat.ok)return lat;
  if(!lon.ok)return lon;
  const declared=row['stop_name']??'';
  const stop:TransitStop={providerId:id.value,name:declared.length?declared:id.value,lat:lat.value,lon:lon.value};
  if(!declared.length)stop.label='provider-id';
  const rest=restOf(row,STOP_COLUMNS);
  if(rest)stop.rest=rest;
  stops.push(stop);
 }
 return stops.length?ok(stops):failed('MALFORMED','O arquivo não declara nenhuma parada');
}
function routesOf(table:Table):WorldResult<TransitRoute[]>{
 const routes:TransitRoute[]=[];
 const seen=new Set<string>();
 for(const row of table.rows){
  const id=field(row,'route_id','Uma linha do arquivo'),type=integer(row['route_type']??'','Uma linha do arquivo','route_type');
  if(!id.ok)return id;
  if(!type.ok)return type;
  if(seen.has(id.value))return failed('MALFORMED',`A linha ${id.value} aparece duas vezes no arquivo`);
  seen.add(id.value);
  const short=row['route_short_name']?.length?row['route_short_name']:undefined;
  const long=row['route_long_name']?.length?row['route_long_name']:undefined;
  // The label is composed from what the provider wrote, never from a type number: naming a route is the provider's job.
  const route:TransitRoute={providerId:id.value,name:short&&long?`${short} · ${long}`:short??long??id.value,type:type.value,trips:[]};
  if(short)route.shortName=short;
  if(long)route.longName=long;
  if(!short&&!long)route.label='provider-id';
  const rest=restOf(row,ROUTE_COLUMNS);
  if(rest)route.rest=rest;
  routes.push(route);
 }
 return routes.length?ok(routes):failed('MALFORMED','O arquivo não declara nenhuma linha');
}
type Services={calendars:readonly TransitCalendar[];exceptions:readonly TransitException[];ids:ReadonlySet<string>};
function servicesOf(calendar:Table|undefined,exceptions:Table|undefined):WorldResult<Services>{
 const calendars:TransitCalendar[]=[],moves:TransitException[]=[],ids=new Set<string>();
 for(const row of calendar?.rows??[]){
  const id=field(row,'service_id','Um serviço do arquivo'),start=calendarDate(row['start_date']??'','Um serviço do arquivo declara a data'),end=calendarDate(row['end_date']??'','Um serviço do arquivo declara a data');
  if(!id.ok)return id;
  if(!start.ok)return start;
  if(!end.ok)return end;
  calendars.push({serviceId:id.value,weekdays:WEEKDAYS.filter(day=>row[day]==='1'),startDate:start.value,endDate:end.value});
  ids.add(id.value);
 }
 for(const row of exceptions?.rows??[]){
  const id=field(row,'service_id','Uma exceção do arquivo'),date=calendarDate(row['date']??'','Uma exceção do arquivo declara a data'),type=row['exception_type'];
  if(!id.ok)return id;
  if(!date.ok)return date;
  if(type!=='1'&&type!=='2')return failed('MALFORMED',`A exceção de ${id.value} declara o tipo ${String(type)}, que não é 1 (acrescentado) nem 2 (removido)`);
  moves.push({serviceId:id.value,date:date.value,type:type==='1'?'added':'removed'});
  ids.add(id.value);
 }
 return ok({calendars,exceptions:moves,ids});
}
type Leg=TransitStopTime&{sequence:number};
function tripsOf(trips:Table,stopTimes:Table,routes:readonly TransitRoute[],stops:readonly TransitStop[],services:Services):WorldResult<TransitRoute[]>{
 const lines=new Map(routes.map(route=>[route.providerId,route]));
 const named=new Set(stops.map(stop=>stop.providerId));
 const declared=new Map<string,{route:TransitRoute;serviceId:string;legs:Leg[]}>();
 for(const row of trips.rows){
  const id=field(row,'trip_id','Uma viagem do arquivo');
  if(!id.ok)return id;
  const routeId=field(row,'route_id',`A viagem ${id.value}`),serviceId=field(row,'service_id',`A viagem ${id.value}`);
  if(!routeId.ok)return routeId;
  if(!serviceId.ok)return serviceId;
  const route=lines.get(routeId.value);
  if(!route)return failed('MALFORMED',`A viagem ${id.value} referencia a linha ${routeId.value}, que o arquivo não declara`);
  if(!services.ids.has(serviceId.value))return failed('MALFORMED',`A viagem ${id.value} referencia o serviço ${serviceId.value}, que o arquivo não declara`);
  if(declared.has(id.value))return failed('MALFORMED',`A viagem ${id.value} aparece duas vezes no arquivo`);
  declared.set(id.value,{route,serviceId:serviceId.value,legs:[]});
 }
 for(const row of stopTimes.rows){
  const tripId=field(row,'trip_id','Uma passagem do arquivo'),stopId=field(row,'stop_id','Uma passagem do arquivo');
  if(!tripId.ok)return tripId;
  if(!stopId.ok)return stopId;
  const trip=declared.get(tripId.value);
  if(!trip)return failed('MALFORMED',`A passagem da viagem ${tripId.value} não corresponde a nenhuma viagem do arquivo`);
  if(!named.has(stopId.value))return failed('MALFORMED',`A viagem ${tripId.value} passa pela parada ${stopId.value}, que o arquivo não declara`);
  const sequence=integer(row['stop_sequence']??'',`A viagem ${tripId.value}`,'stop_sequence');
  if(!sequence.ok)return sequence;
  if(trip.legs.some(leg=>leg.sequence===sequence.value))return failed('MALFORMED',`A viagem ${tripId.value} repete a sequência ${sequence.value} de paradas`);
  const arrival=clock(row['arrival_time']??'',`A viagem ${tripId.value} declara o horário de chegada`),departure=clock(row['departure_time']??'',`A viagem ${tripId.value} declara o horário de partida`);
  if(!arrival.ok)return arrival;
  if(!departure.ok)return departure;
  trip.legs.push({stopId:stopId.value,arrival:arrival.value,departure:departure.value,sequence:sequence.value});
 }
 const byRoute=new Map<string,TransitTrip[]>();
 for(const [id,trip] of declared){
  // Rows are ordered by the sequence the feed declared, which is what GTFS means by the order of a trip; the file's own
  // line order is not a statement about the trip.
  const legs=[...trip.legs].sort((left,right)=>left.sequence-right.sequence);
  const list=byRoute.get(trip.route.providerId)??[];
  list.push({id,serviceId:trip.serviceId,stops:legs.map(leg=>({stopId:leg.stopId,arrival:leg.arrival,departure:leg.departure}))});
  byRoute.set(trip.route.providerId,list);
 }
 return ok(routes.map(route=>({...route,trips:byRoute.get(route.providerId)??[]})));
}
// Every core component is validated with the boundary's own check, so an entity this importer publishes is one the
// protocol accepts — and a core namespace this client does not implement would be carried, not judged.
function checkComponents(components:Record<string,unknown>,label:string):WorldResult<null>{
 for(const key of Object.keys(components)){
  const checked=checkCoreComponent(key,components[key]);
  if(!checked.ok)return failed(checked.error.code,`Em ${label}, ${key}: ${checked.error.message}`);
 }
 return ok(null);
}
// The protocol view of what was imported: a stop is an entity with the position the source declared, a route is an
// entity that names the stops it was declared to serve. GTFS declares no route geometry, so a route gets none, and the
// claim for each one carries the provider's own identifier and the revision that explains it.
function entitiesOf(sourceId:string,stops:readonly TransitStop[],routes:readonly TransitRoute[]):WorldResult<{entities:TransitEntity[];claims:SourceClaim[]}>{
 const entities:TransitEntity[]=[],claims:SourceClaim[]=[];
 const local=new Map<string,string>();
 for(const stop of stops){
  const id=externalEntityId('stop',sourceId,stop.providerId);
  if(!id.ok)return id;
  local.set(stop.providerId,id.value);
 }
 for(const stop of stops){
  const id=local.get(stop.providerId)!,uri=entityUri(id);
  const described:Record<string,JsonValue>={providerId:stop.providerId};
  if(stop.label)described['label']=stop.label;
  if(stop.rest)described['declared']=stop.rest;
  const components:Record<string,unknown>={
   'osim.transform':{space:'osim:space:earth',position:{lat:stop.lat,lon:stop.lon}},
   'osim.name':{default:stop.name},
   'transit.stop':described,
  };
  const checked=checkComponents(components,`a parada ${stop.providerId}`);
  if(!checked.ok)return checked;
  entities.push({uri,kind:'stop',providerId:stop.providerId,components});
  claims.push({subject:{kind:'capture'},values:{entity:uri,kind:'stop',providerId:stop.providerId,name:stop.name,lat:stop.lat,lon:stop.lon},sourceId:stop.providerId,method:'reported',extensions:{}});
 }
 for(const route of routes){
  const id=externalEntityId('route',sourceId,route.providerId);
  if(!id.ok)return id;
  const uri=entityUri(id.value);
  const relations:Record<string,JsonValue>={};
  for(const served of [...new Set(route.trips.flatMap(trip=>trip.stops.map(stop=>stop.stopId)))].sort()){
   const stop=local.get(served);
   if(!stop)return failed('MALFORMED',`A linha ${route.providerId} serve a parada ${served}, que o arquivo não declara`);
   relations[stop]=entityUri(stop);
  }
  const described:Record<string,JsonValue>={providerId:route.providerId,type:route.type,trips:route.trips.map(trip=>({id:trip.id,serviceId:trip.serviceId}))};
  if(route.shortName)described['shortName']=route.shortName;
  if(route.longName)described['longName']=route.longName;
  if(route.label)described['label']=route.label;
  if(route.rest)described['declared']=route.rest;
  const components:Record<string,unknown>={'osim.name':{default:route.name},'transit.route':described};
  // A line with no declared stop is not made to look like one that has none: the component appears only when the feed
  // said which stops the line serves.
  if(Object.keys(relations).length)components['osim.relations']=relations;
  const checked=checkComponents(components,`a linha ${route.providerId}`);
  if(!checked.ok)return checked;
  entities.push({uri,kind:'route',providerId:route.providerId,components});
  claims.push({subject:{kind:'capture'},values:{entity:uri,kind:'route',providerId:route.providerId,name:route.name,type:route.type},sourceId:route.providerId,method:'reported',extensions:{}});
 }
 return ok({entities,claims});
}

// --- comparing two packages of the same source ----------------------------------------------------------------
// Provider identifiers only mean something inside the source that issued them, so association across providers is
// refused instead of guessed — and so is a new identifier appearing exactly where an old one disappeared, which may be
// a rename or another stop (spec §3.4).
export type TransitStopMove={providerId:string;before:{lat:number;lon:number};after:{lat:number;lon:number}};
export type TransitAssociation={source:string;kept:number;moved:readonly TransitStopMove[];added:readonly string[];removed:readonly string[]};
export function associateTransit(before:TransitDataset,after:TransitDataset):WorldResult<TransitAssociation>{
 const source=before.revision.source.id;
 if(source!==after.revision.source.id)return failed('CONFLICT',`Os pacotes vêm de fornecedores diferentes (${source} e ${after.revision.source.id}): os identificadores de um não identificam o mesmo lugar no outro`);
 const was=new Map(before.stops.map(stop=>[stop.providerId,stop])),now=new Map(after.stops.map(stop=>[stop.providerId,stop]));
 const moved:TransitStopMove[]=[],added:string[]=[],removed:string[]=[];
 let kept=0;
 for(const [providerId,stop] of was){
  const current=now.get(providerId);
  if(!current){removed.push(providerId);continue;}
  kept+=1;
  if(stop.lat!==current.lat||stop.lon!==current.lon)moved.push({providerId,before:{lat:stop.lat,lon:stop.lon},after:{lat:current.lat,lon:current.lon}});
 }
 for(const providerId of now.keys())if(!was.has(providerId))added.push(providerId);
 for(const gone of [...removed].sort())for(const arrived of [...added].sort()){
  const left=was.get(gone)!,right=now.get(arrived)!;
  if(left.lat===right.lat&&left.lon===right.lon)return failed('CONFLICT',`Associação ambígua: a parada ${gone} saiu e ${arrived} entrou na mesma posição declarada; a correspondência precisa ser confirmada por uma regra revisável`);
 }
 return ok({source,kept,moved,added:[...added].sort(),removed:[...removed].sort()});
}
