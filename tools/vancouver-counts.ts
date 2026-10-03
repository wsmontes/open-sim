// Import locally recorded, located traffic counts; never turn catalog pins into volumes.
import {readFile,writeFile} from 'node:fs/promises';
import {parseVancouverCounts} from '../src/adapters/reality/vancouver-counts';
import {readObservationFile,OBSERVATION_FILE_FORMAT} from '../src/adapters/reality/observation-file';
const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: vancouver-counts.ts normalized-counts.json output-observations.json');
const value=JSON.parse(await readFile(input,'utf8')),counts=parseVancouverCounts(value);
if(!counts.length)throw new Error('No validated, located, dated counts. Official unlocated records are unavailable for routing.');
const first=counts[0].source;if(counts.some(c=>c.source.dataset!==first.dataset||c.source.url!==first.url))throw new Error('One source per capture is required');
const file={format:OBSERVATION_FILE_FORMAT,source:{id:'vancouver-traffic-counts',dataset:first.dataset,url:first.url},terms:{license:first.license??'Source terms required before distribution',attribution:first.dataset,url:first.url},observations:counts.map(c=>({id:c.id,kind:'observed',unit:'count',times:{retrievedAt:c.source.retrievedAt,interval:{from:c.from,to:c.to}},values:c}))};
const bytes=new TextEncoder().encode(JSON.stringify(file)),result=readObservationFile(bytes);if(!result.ok)throw new Error(result.error.message);
await writeFile(output,bytes);console.log(JSON.stringify({accepted:counts.length,rejected:Array.isArray(value)?value.length-counts.length:0,status:'historical-observations',speedInferred:false}));
