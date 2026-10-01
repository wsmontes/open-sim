import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const raw=process.argv[2]??'http://127.0.0.1:4173/';
const pageUrl=new URL(raw);
pageUrl.searchParams.set('debug','1');
const candidates=[process.env.CHROME_BIN,'/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean);
const chrome=candidates.find(path=>existsSync(path));
if(!chrome)throw new Error('Chrome/Chromium not found. Set CHROME_BIN.');

const profile=await mkdtemp(join(tmpdir(),'open-sim-perf-'));
const port=9333;
const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','inherit']});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(url,options){
 let last;
 for(let i=0;i<100;i+=1){
  try{const response=await fetch(url,options);if(response.ok)return response.json();last=new Error(`${response.status} ${response.statusText}`);}catch(error){last=error;}
  await sleep(100);
 }
 throw last??new Error(`Cannot reach ${url}`);
}

let ws;
const pending=new Map();
let seq=0;
function send(method,params={}){
 const id=++seq;ws.send(JSON.stringify({id,method,params}));
 return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
}
async function evaluate(expression){
 const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
 if(result.exceptionDetails)throw new Error(result.exceptionDetails.text??'Runtime.evaluate failed');
 return result.result?.result?.value;
}
async function marks(timeoutMs=20000,required='first-frame'){
 const end=Date.now()+timeoutMs;
 while(Date.now()<end){const value=await evaluate('window.openSimPerf?.() ?? null');if(value&&value[required]!==undefined)return value;await sleep(50);}
 const value=await evaluate('window.openSimPerf?.() ?? null');
 throw new Error(`Timed out waiting for ${required}: ${JSON.stringify(value)}`);
}
async function waitForSave(){
 await evaluate("document.querySelector('[data-speed=\\\"0\\\"]')?.click(); true");
 const end=Date.now()+5000;
 while(Date.now()<end){const text=await evaluate("document.querySelector('#save-status')?.textContent ?? ''");if(/salv/i.test(text)&&!/salvando/i.test(text))return;await sleep(100);}
 await sleep(500);
}

try{
 const target=await json(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pageUrl.href)}`,{method:'PUT'});
 ws=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 ws.onmessage=event=>{const message=JSON.parse(String(event.data));if(!message.id)return;const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);message.error?waiter.reject(new Error(message.error.message)):waiter.resolve(message);};
 await send('Runtime.enable');
 await send('Page.enable');

 const cold=await marks(30000,'first-frame');
 const coldMap=await marks(30000,'map-visible-ready').catch(()=>cold);
 await waitForSave();
 await send('Page.reload',{ignoreCache:false});
 const warm=await marks(10000,'first-frame');
 const warmMap=await marks(15000,'map-visible-ready').catch(()=>warm);
 const navigation=await evaluate("(()=>{const n=performance.getEntriesByType('navigation')[0];return n?{responseStart:n.responseStart,domInteractive:n.domInteractive,loadEventEnd:n.loadEventEnd}:null})()");
 const report={url:pageUrl.href,cold,coldMap,warm,warmMap,navigation,budget:{warmFirstFrameMs:1200,warmSessionReadyMs:800}};
 console.log('OPEN_SIM_PERF '+JSON.stringify(report));
 if((warm['first-frame']??Infinity)>1200)throw new Error(`Warm first frame ${warm['first-frame']} ms exceeds 1200 ms`);
 if((warm['session-ready']??Infinity)>800)throw new Error(`Warm session-ready ${warm['session-ready']} ms exceeds 800 ms`);
}finally{
 try{ws?.close();}catch{}
 child.kill('SIGTERM');await sleep(100);child.kill('SIGKILL');
 await rm(profile,{recursive:true,force:true});
}