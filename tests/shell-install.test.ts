import {expect,test} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

function shell(options:{offline?:boolean;failAsset?:boolean;clients?:Array<{id:string;url:string;postMessage(value:unknown):void}>}={}){
 const origin='https://example.test/game/',data=new Map<string,Map<string,Response>>();
 const prior=new Map<string,Response>();prior.set(origin+'assets/old.js',new Response('old'));
 data.set('open-sim-shell-old',prior);
 const handlers=new Map<string,(event:any)=>void>(),requests:string[]=[];
 const absolute=(value:string|{url:string})=>new URL(typeof value==='string'?value:value.url,origin).href;
 const caches={
  keys:async()=>[...data.keys()],delete:async(name:string)=>data.delete(name),
  open:async(name:string)=>{
   const entries=data.get(name)??new Map<string,Response>();data.set(name,entries);
   return {
    async add(value:string){const response=await fetcher(absolute(value));entries.set(absolute(value),response);},
    async addAll(values:string[]){
     const next=await Promise.all(values.map(async value=>{const r=await fetcher(absolute(value));if(!r.ok)throw new Error('bad asset');return [absolute(value),r] as const;}));
     for(const [url,response] of next)entries.set(url,response);
    },
    put:async(value:string|{url:string},r:Response)=>{entries.set(absolute(value),r);},
    match:async(value:string|{url:string})=>entries.get(absolute(value))?.clone(),
    keys:async()=>[...entries.keys()].map(url=>({url})),
   };
  },
 };
 const fetcher=async(value:string|{url:string})=>{
  const url=absolute(value);requests.push(url);
  if(options.offline||options.failAsset&&url.endsWith('app.js'))throw new Error('offline');
  return new Response(url.endsWith('app.js')?'app':'home');
 };
 const source=readFileSync('public/sw.js','utf8').replace('/* shell-assets */ []',JSON.stringify(['./','./assets/app.js']));
 runInNewContext(source,{URL,Response,Set,Map,Promise,fetch:fetcher,caches,self:{location:new URL(origin+'sw.js'),clients:{matchAll:async()=>options.clients??[],claim:async()=>{}},addEventListener:(name:string,fn:(event:any)=>void)=>handlers.set(name,fn)}});
 const run=async(name:string,extra:Record<string,unknown>={})=>{
  let promise:Promise<unknown>=Promise.resolve();
  handlers.get(name)!({...extra,waitUntil:(p:Promise<unknown>)=>{promise=p;},respondWith:(p:Promise<unknown>)=>{promise=p;}});
  return promise;
 };
 return {run,data,requests,options};
}

test('installation precaches the entire build and offline navigation and assets never await network',async()=>{
 const h=shell();await h.run('install');h.options.offline=true;
 const response=await h.run('fetch',{request:{method:'GET',url:'https://example.test/game/assets/app.js',mode:'cors'}}) as Response;
 expect(await response.text()).toBe('app');
 const home=await h.run('fetch',{request:{method:'GET',url:'https://example.test/game/',mode:'navigate'}}) as Response;
 expect(await home.text()).toBe('home');
 expect(h.requests).toHaveLength(2);
});

test('an incomplete build cannot finish installation or replace the prior shell',async()=>{
 const h=shell({failAsset:true});
 await expect(h.run('install')).rejects.toThrow('offline');
 expect(h.data.get('open-sim-shell-old')?.size).toBe(1);
});

test('activation clears unused prior builds when no page still needs them',async()=>{
 const h=shell();await h.run('install');await h.run('activate');
 expect(h.data.has('open-sim-shell-old')).toBe(false);
});

test('activation preserves unknown live pages until their shell is identified',async()=>{
 const h=shell({clients:[{id:'old-page',url:'https://example.test/game/',postMessage:()=>{}}]});
 await h.run('install');await h.run('activate');
 expect(h.data.has('open-sim-shell-old')).toBe(true);
});

test('a retained older page can load its own hashed assets offline after activation',async()=>{
 const h=shell({clients:[{id:'old-page',url:'https://example.test/game/',postMessage:()=>{}}]});
 await h.run('install');await h.run('activate');
 await h.run('message',{source:{id:'old-page'},data:{type:'shell-identify',scripts:['https://example.test/game/assets/old.js']}});
 h.options.offline=true;
 const asset=await h.run('fetch',{request:{method:'GET',url:'https://example.test/game/assets/old.js',mode:'cors'},clientId:'old-page'}) as Response|undefined;
 expect(asset).toBeDefined();expect(await asset?.text()).toBe('old');
});
