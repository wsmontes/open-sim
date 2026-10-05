// Run the bounded Python extractor first, then normalize its selected official feed through the existing importer.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {importTransit} from '../src/adapters/reality/gtfs';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher} from '../src/adapters/hash/content';
const [archivePath,reportPath]=process.argv.slice(2);if(!archivePath||!reportPath)throw new Error('Usage: vancouver-transit.ts selected.zip extraction-report.json');
const bytes=new Uint8Array(await readFile(archivePath)),report=JSON.parse(await readFile(reportPath,'utf8'));
const termsUrl='https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data';
const attribution='Route and arrival data used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the accuracy or currency of the Data used in this product or service.';
const retrievedAt=new Date().toISOString(),feed=report.feedInfo[0];
const imported=await importTransit(bytes,{codec:createJcsCodec(),source:{id:'translink-gtfs',dataset:'TransLink GTFS Schedule · Vancouver capture',url:'https://gtfs-static.translink.ca/gtfs/google_transit.zip',providerRevision:feed.feed_version},terms:{attribution,license:'TransLink GTFS Terms and Conditions',url:termsUrl},retrievedAt,capture:{level:'detail',zoom:14},transformation:{name:'vancouver-representative-route-patterns',version:1}},bytesHasher());
if(!imported.ok)throw new Error(imported.error.message);
const {objects:_objects,claims:_claims,...dataset}=imported.value;
// Preserve normalized content exactly; protocol object envelopes can be reproduced locally.
const capture={...dataset,capture:{...report,retrievedAt,selectedArchiveSha256:createHash('sha256').update(bytes).digest('hex'),scope:'Capture box; not a municipal administrative boundary',realtime:false,fullTimetable:false},attribution};
await writeFile('src/adapters/reality/data/vancouver-transit.json',JSON.stringify(capture)+'\n');
console.log(JSON.stringify({routes:dataset.routes.length,shapes:dataset.shapes.length,stops:dataset.stops.length,trips:dataset.routes.reduce((n,r)=>n+r.trips.length,0)}));
