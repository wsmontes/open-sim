// Normalize reviewed source geometry, preserving explicit provenance and date windows.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readMaritimeCapture} from '../src/adapters/reality/maritime';
const [input,output='src/adapters/reality/data/vancouver-maritime.json']=process.argv.slice(2);if(!input)throw new Error('Usage: vancouver-maritime.ts reviewed-source-capture.json [output.json]');
const bytes=await readFile(input),capture=readMaritimeCapture(JSON.parse(bytes.toString()));
await writeFile(output,JSON.stringify(capture,null,2)+'\n');console.log(JSON.stringify({sourceSha256:createHash('sha256').update(bytes).digest('hex'),terminals:capture.terminals.length,routes:capture.routes.length,calls:capture.cruiseCalls.length}));
