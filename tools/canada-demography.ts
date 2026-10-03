// Capture only official endpoints; preserve raw SDMX columns for independent audits.
import {writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CITY_IDENTITIES} from '../src/client/source-selection';
import {readStatCanCapture} from '../src/adapters/reality/statcan';
import {readBcStatsCapture} from '../src/adapters/reality/bc-stats';
function csv(text:string):Record<string,string>[] {
 const records:string[][]=[];let row:string[]=[],field='',quoted=false;
 for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if(c==='\n'&&!quoted){row.push(field.replace(/\r$/,''));records.push(row);row=[];field='';}else field+=c;}
 if(field||row.length){row.push(field.replace(/\r$/,''));records.push(row);}
 const headers=records.shift()??[];return records.map(values=>Object.fromEntries(headers.map((h,i)=>[h,values[i]??''])));
}
const urls={statcan:'https://api.statcan.gc.ca/census-recensement/profile/sdmx/rest/data/STC_CP,DF_CSD,1.3/A5.2021A00055915022.1..1?format=csvfile',bcStats:'https://catalogue.data.gov.bc.ca/dataset/86839277-986a-4a29-9f70-fa9b1166f6cb/resource/0e15d04d-127c-457a-b999-20800c929927/download/municipality-population.csv'};
const selected=new Set(['1','8','35','36','37','50','56','229','2222','2229','2603','2604','2607','2608','2609','2610']);
const result:Record<string,unknown>={};
for(const [key,url] of Object.entries(urls)){
 const response=await fetch(url);if(!response.ok)throw new Error(`${key}: HTTP ${response.status}`);
 const text=await response.text();const raw=csv(text);
 const rows=key==='statcan'?raw.filter(r=>selected.has(r.CHARACTERISTIC)):raw.filter(r=>r.Region==='15022'&&r.Year==='2025'&&r.Gender==='T'&&r.Type==='Estimate');
 result[key]={source:{dataset:key==='statcan'?'Statistics Canada · Census Profile 2021':'BC Stats · Municipal population estimates',url,license:key==='statcan'?'Statistics Canada Open Licence':'Open Government Licence – British Columbia',retrievedAt:new Date().toISOString(),sha256:createHash('sha256').update(text).digest('hex')},rows};
}
const city=CITY_IDENTITIES.Q24639;
if(readStatCanCapture(result.statcan,city).find(o=>o.key==='population')?.value!==662248||!readBcStatsCapture(result.bcStats,city).length)throw new Error('Municipal capture failed validation');
await mkdir('src/adapters/reality/data',{recursive:true});
await writeFile('src/adapters/reality/data/vancouver-demography.json',JSON.stringify(result,null,2)+'\n');
