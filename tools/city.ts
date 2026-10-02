// JSON-lines terminal adapter: every request goes through the browser's LocalSession/core rules.
import {readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {decodeSave} from '../src/core/snapshot';
import {canonicalJson} from '../src/core/protocol';
import {createSession} from '../src/session/local-session';
import {createMemoryStore} from '../src/adapters/storage/memory';
import {executeCityRequest} from '../src/session/city-agent';
import {createOsmSource} from '../src/adapters/osm/provider';
import {createMainMapDecoder} from '../src/adapters/osm/map-decoder';
import {toCell,chunkId} from '../src/core/coordinates';
const [input,output]=process.argv.slice(2);
const saved=input?decodeSave(readFileSync(input,'utf8')):null;
const maps=createOsmSource({decoder:createMainMapDecoder()});
const saves=createMemoryStore(saved?{'open-sim':canonicalJson(saved)}:{});
const session=createSession({maps,saves,worldId:saved?.state.worldId??'open-sim',seed:saved?.state.seed??1});
await session.initialize(Object.keys(saved?.state.chunks??{})[0]??chunkId(toCell(49.2827,-123.1207)));
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of lines){
 if(!line.trim())continue;
 let raw:unknown;
 try{raw=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({ok:false,error:{code:'INVALID_JSON',message:'JSON inválido'}})+'\n');continue;}
 const response=await executeCityRequest(session,raw);process.stdout.write(canonicalJson(response)+'\n');
 if(output&&response.ok&&raw&&typeof raw==='object'&&(raw as {op?:string}).op==='save')writeFileSync(output,canonicalJson(response.result));
}
maps.destroy();
