// Publish only reviewed exact values: input JSON must carry source, annual period and reference.
import {readFile,writeFile} from 'node:fs/promises';
import {readVancouverFinance} from '../src/adapters/reality/vancouver';
const path=process.argv[2];if(!path)throw new Error('Usage: node --import tsx tools/vancouver-data.ts reviewed-capture.json');
const capture=JSON.parse(await readFile(path,'utf8'));
readVancouverFinance(capture);
await writeFile('src/adapters/reality/data/vancouver-finance-2026.json',JSON.stringify(capture,null,2)+'\n');
