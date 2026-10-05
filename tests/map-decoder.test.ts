import {expect,test,vi} from 'vitest';
import {createMainMapDecoder,createWorkerMapDecoder,type MapWorkerLike} from '../src/adapters/osm/map-decoder';
import type {BaseChunk} from '../src/core/model';

const blank=(id:string):BaseChunk=>({id,source:'fake',normalizerVersion:1,cells:Array.from({length:1024},()=>({terrain:'land'}))});

class FakeWorker implements MapWorkerLike{
 onmessage:((event:MessageEvent<any>)=>void)|null=null;
 onerror:((event:Event)=>void)|null=null;
 onmessageerror:((event:MessageEvent)=>void)|null=null;
 messages:any[]=[];tiles=new Set<string>();broken=false;
 postMessage(message:any){
  this.messages.push(message);
  queueMicrotask(()=>{
   if(this.broken){this.onerror?.(new Event('error'));return;}
   const key=`${message.kind}:${message.cacheSource??message.source}:${message.zoom}:${message.tileX}:${message.tileY}`;
   if(!message.bytes&&!this.tiles.has(key)){this.onmessage?.({data:{id:message.id,missing:true}} as MessageEvent);return;}
   const reused=this.tiles.has(key);this.tiles.add(key);
   this.onmessage?.({data:{id:message.id,...(message.kind==='visual'?{visual:{z:message.zoom,x:message.tileX,y:message.tileY,features:[]}}:{chunk:blank(message.chunk)}),decodeMs:1,normalizeMs:1,reused}} as MessageEvent);
  });
 }
 terminate(){}
}

const request=(id:string,bytes:()=>Promise<Uint8Array>)=>({id,source:'fake',zoom:14,tileX:0,tileY:0,bytes});

test('worker receives one byte transfer for many regions of the same tile',async()=>{
 const worker=new FakeWorker(),decoder=createWorkerMapDecoder(()=>worker);
 let reads=0;const bytes=async()=>{reads+=1;return new Uint8Array();};
 expect((await decoder.decode(request('0:0',bytes))).id).toBe('0:0');
 expect((await decoder.decode(request('1:0',bytes))).id).toBe('1:0');
 expect(reads).toBe(1);
 expect(decoder.stats()).toMatchObject({path:'worker',chunks:2,reused:1,transfers:1});
 expect(worker.messages).toHaveLength(2);
 expect(worker.messages[1].bytes).toBeNull();
});

test('worker failure falls back to the main decoder instead of breaking the map',async()=>{
 const worker=new FakeWorker();worker.broken=true;
 const decoder=createWorkerMapDecoder(()=>worker);
 const chunk=await decoder.decode(request('0:0',async()=>new Uint8Array()));
 expect(chunk.id).toBe('0:0');
 expect(chunk.cells).toHaveLength(1024);
 expect(decoder.stats().path).toBe('main');
});

test('a map request failure is not duplicated and does not permanently disable a healthy worker',async()=>{
 const worker=new FakeWorker(),decoder=createWorkerMapDecoder(()=>worker);
 let fail=true,reads=0;
 const bytes=async()=>{reads+=1;if(fail)throw new Error('offline');return new Uint8Array();};
 await expect(decoder.decode(request('0:0',bytes))).rejects.toThrow('offline');
 expect(reads).toBe(1);
 expect(decoder.stats().path).toBe('worker');
 fail=false;
 expect((await decoder.decode(request('0:0',bytes))).id).toBe('0:0');
 expect(reads).toBe(2);
 expect(decoder.stats().path).toBe('worker');
});

test('visual worker requests dedupe transfers and preserve tile geometry',async()=>{
 const worker=new FakeWorker(),decoder=createWorkerMapDecoder(()=>worker);
 let reads=0;const bytes=async()=>{reads++;return new Uint8Array();};
 const visual={source:'fake',zoom:14,tileX:0,tileY:0,bytes};
 const [a,b]=await Promise.all([decoder.decodeVisual(visual),decoder.decodeVisual(visual)]);
 expect(a).toEqual({z:14,x:0,y:0,features:[]});expect(b).toEqual(a);
 expect(reads).toBe(1);expect(decoder.stats()).toMatchObject({path:'worker',transfers:1,decodeMs:1});
});

test('visual fallback equals main decode and reads failed worker bytes only once',async()=>{
 const worker=new FakeWorker();worker.broken=true;
 const decoder=createWorkerMapDecoder(()=>worker);let reads=0;
 const visual=await decoder.decodeVisual({source:'fake',zoom:11,tileX:2,tileY:3,bytes:async()=>{reads++;return new Uint8Array();}});
 expect(visual).toEqual({z:11,x:2,y:3,features:[]});expect(reads).toBe(1);
 expect(decoder.stats()).toMatchObject({path:'main'});
});

test('same coordinates from distinct sources do not reuse decoded data',async()=>{
 const worker=new FakeWorker(),decoder=createWorkerMapDecoder(()=>worker);let reads=0;
 const bytes=async()=>{reads++;return new Uint8Array();};
 await decoder.decode(request('0:0',bytes));await decoder.decode({...request('0:0',bytes),source:'other'});
 expect(reads).toBe(2);
});

test('destroy rejects in-flight reads without posting or fallback work',async()=>{
 const worker=new FakeWorker(),decoder=createWorkerMapDecoder(()=>worker);let release!:(bytes:Uint8Array)=>void;
 const pending=decoder.decode(request('0:0',()=>new Promise(resolve=>{release=resolve;})));
 await Promise.resolve();decoder.destroy?.();release(new Uint8Array());
 await expect(pending).rejects.toThrow('encerrado');expect(worker.messages).toHaveLength(0);
});


test('real worker visual handler matches fallback geometry and rejects missing bytes',async()=>{
 const responses:any[]=[];const scope={onmessage:null as ((event:MessageEvent<any>)=>void)|null,postMessage:(message:any)=>responses.push(message)};
 vi.stubGlobal('self',scope);
 try{
  await import('../src/adapters/osm/map-worker');
  const message={id:'v',kind:'visual',chunk:'',source:'fixture',zoom:11,tileX:2,tileY:3,bytes:new ArrayBuffer(0)};
  scope.onmessage!({data:message} as MessageEvent);
  const expected=await createMainMapDecoder().decodeVisual({source:'fixture',zoom:11,tileX:2,tileY:3,bytes:async()=>new Uint8Array()});
  expect(responses[0].visual).toEqual(expected);expect(responses[0]).toMatchObject({kind:'visual',reused:false});
  expect(responses[0].decodeMs).toBeGreaterThanOrEqual(0);
  scope.onmessage!({data:{...message,id:'reuse',bytes:null}} as MessageEvent);
  expect(responses[1]).toMatchObject({visual:expected,reused:true});
  scope.onmessage!({data:{...message,id:'other',source:'other',bytes:null}} as MessageEvent);
  expect(responses[2]).toEqual({id:'other',missing:true});
 }finally{vi.unstubAllGlobals();}
});

test('visual request failure does not retry bytes or disable the worker',async()=>{
 const worker=new FakeWorker(),decoder=createWorkerMapDecoder(()=>worker);let reads=0;
 await expect(decoder.decodeVisual({source:'fake',zoom:11,tileX:0,tileY:0,bytes:async()=>{reads++;throw new Error('offline');}})).rejects.toThrow('offline');
 expect(reads).toBe(1);expect(decoder.stats().path).toBe('worker');
});
