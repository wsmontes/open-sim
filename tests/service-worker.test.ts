import {expect,test} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('shell caching failure never discards a successful online response',async()=>{
 let handler:(event:unknown)=>void=()=>{};
 runInNewContext(readFileSync('public/sw.js','utf8'),{URL,Response,self:{location:new URL('https://example.test/game/sw.js'),addEventListener:(name:string,cb:typeof handler)=>{if(name==='fetch')handler=cb;}},caches:{open:async()=>({put:async()=>{throw new Error('quota');},match:async()=>undefined})},fetch:async()=>new Response('fresh',{status:200})});
 let promise:Promise<Response>|undefined;
 handler({request:{method:'GET',url:'https://example.test/game/assets/new.js',mode:'same-origin'},respondWith:(p:Promise<Response>)=>{promise=p;}});
 const response=await promise!;expect(response.status).toBe(200);expect(await response.text()).toBe('fresh');
});
test('offline shell lookup tolerates request Origin differences for same-origin assets',async()=>{
 let handler:(event:unknown)=>void=()=>{};
 runInNewContext(readFileSync('public/sw.js','utf8'),{URL,Response,self:{location:new URL('https://example.test/game/sw.js'),addEventListener:(name:string,cb:typeof handler)=>{if(name==='fetch')handler=cb;}},caches:{open:async()=>({match:async(_request:unknown,options?:{ignoreVary?:boolean})=>options?.ignoreVary?new Response('cached-module'):undefined})},fetch:async()=>{throw new Error('offline');}});
 let promise:Promise<Response>|undefined;handler({request:{method:'GET',url:'https://example.test/game/assets/app.js',mode:'cors'},respondWith:(p:Promise<Response>)=>{promise=p;}});
 const response=await promise!;expect(response.status).toBe(200);expect(await response.text()).toBe('cached-module');
});
