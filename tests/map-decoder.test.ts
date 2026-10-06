import {expect,test,vi} from 'vitest';
import {createWorkerMapDecoder,type MapWorkerLike} from '../src/adapters/osm/map-decoder';
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
   const key=`${message.zoom}:${message.tileX}:${message.tileY}`;
   if(!message.bytes&&!this.tiles.has(key)){this.onmessage?.({data:{id:message.id,missing:true}} as MessageEvent);return;}
   const reused=this.tiles.has(key);this.tiles.add(key);
   this.onmessage?.({data:{id:message.id,chunk:blank(message.chunk),decodeMs:1,normalizeMs:1,reused}} as MessageEvent);
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
test('destroyed decoder never falls back and repopulates decoded state',async()=>{const decoder=createWorkerMapDecoder(()=>null);decoder.destroy!();await expect(decoder.decode(request('0:0',async()=>new Uint8Array()))).rejects.toThrow('disposed');});

test('normalizer worker jobs across different tiles are serialized before byte transfer',async()=>{const worker=new FakeWorker();worker.postMessage=function(message){this.messages.push(message);};const decoder=createWorkerMapDecoder(()=>worker);const first=decoder.decode(request('0:0',async()=>new Uint8Array())),second=decoder.decode({...request('1:0',async()=>new Uint8Array()),tileX:1});await new Promise(r=>setTimeout(r,0));expect(worker.messages).toHaveLength(1);worker.onmessage!({data:{id:worker.messages[0].id,chunk:blank('0:0')}} as MessageEvent);await first;await new Promise(r=>setTimeout(r,0));expect(worker.messages).toHaveLength(2);worker.onmessage!({data:{id:worker.messages[1].id,chunk:blank('1:0')}} as MessageEvent);await second;decoder.destroy!();});
test('a silent normalization worker times out into the bounded fallback',async()=>{vi.useFakeTimers();try{const worker=new FakeWorker();worker.postMessage=()=>{};const decoder=createWorkerMapDecoder(()=>worker,{timeoutMs:20});const result=decoder.decode(request('0:0',async()=>new Uint8Array()));await vi.advanceTimersByTimeAsync(25);await vi.runAllTimersAsync();expect((await result).id).toBe('0:0');expect(decoder.stats().path).toBe('main');decoder.destroy!();}finally{vi.useRealTimers();}});
