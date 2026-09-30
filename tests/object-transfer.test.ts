// The object port of a live session (docs/superpowers/specs/2026-09-29-federated-world-design.md §7.3, §9.3;
// OpenSim Protocol §21–22): a frozen base or a checkpoint travels in segments addressed by the object hash, the
// receiver asks from the cursor it already holds, and bytes only enter the store after the whole object matches its
// address. Everything runs over a fake channel — no network, no browser, no public provider — and what stops a stream
// is the platform buffer, never a timeout, so the assertions wait on the pump's own state instead of on elapsed time.
import {expect,test} from 'vitest';
import {createDirectObjectStore} from '../src/adapters/blobs/direct';
import type {ObjectStore} from '../src/adapters/blobs/direct';
import {bytesHasher} from '../src/adapters/hash/content';
import {
 BUFFER_AGREEMENT,createObjectBudget,createPartialShelf,narrowerBackpressure,readFrame,serveObjects,transferObject,writeFrame,
} from '../src/adapters/network/object-transfer';
import type {ObjectBudget,ObjectFrame,ObjectLink,PartialShelf,ServedObject,TransferPorts} from '../src/adapters/network/object-transfer';
import {sameRef} from '../src/world/model';
import type {ObjectRef,WorldError,WorldResult} from '../src/world/model';
import {NETWORK_LIMITS,narrowerLimits} from '../src/world/wire';
import type {Limits} from '../src/world/wire';

const hasher=bytesHasher();
// Bytes that are not a run of one value, so a flipped byte in the middle is a real difference and not a coincidence.
const bytesOf=(length:number,seed=7)=>{const bytes=new Uint8Array(length);for(let i=0;i<length;i+=1)bytes[i]=(i*31+seed)%251;return bytes;};
// The narrower of both sides is what this device may allocate: a test states the agreement, the port narrows it.
const agreed=(over:Partial<Limits>):Limits=>narrowerLimits(NETWORK_LIMITS,{...NETWORK_LIMITS,...over});
const SMALL=agreed({maxSegmentBytes:4*1024,maxObjectBytes:64*1024});
type Shelf={bytes:Map<string,Uint8Array>;store:ObjectStore};
const storeOf=():Shelf=>{const bytes=new Map<string,Uint8Array>();return {bytes,store:createDirectObjectStore({hasher,shelf:bytes})};};
// Asking whether a megabyte of bytes is the object is a question about its address: comparing two 2 MiB buffers element
// by element is the slow way to ask it.
const addressed=async(bytes:Uint8Array|undefined,ref:ObjectRef)=>!!bytes&&sameRef(await hasher.ref(bytes),ref);
const received=(result:WorldResult<Uint8Array>,ref:ObjectRef)=>result.ok?addressed(result.value,ref):Promise.resolve(false);
type PortsOptions={link:ObjectLink;store?:ObjectStore;limits?:Limits;budget?:ObjectBudget;resume?:PartialShelf;backpressure?:{highWaterBytes:number;lowWaterBytes:number};refused?:WorldError[]};
function transferPorts(options:PortsOptions):TransferPorts{
 return {
  links:{get:peer=>peer==='bob'?options.link:null},
  hasher,
  budget:options.budget??createObjectBudget(),
  store:options.store,
  limits:options.limits??SMALL,
  resume:options.resume,
  backpressure:options.backpressure,
  onRefused:options.refused?error=>options.refused!.push(error):undefined,
 };
}

// A pair of ends that share one wire. `send` hands the frame to the other end at once, `drop` empties the platform
// buffer the way a data channel does while it drains, and `close` takes the channel away from both ends — a real
// channel reports the same loss on either side of it.
type End={receivers:Set<(frame:Uint8Array)=>void>;closures:Set<()=>void>;bytes:number;floor:number;waiting:(()=>void)|null;closed:boolean;sent:Uint8Array[]};
type FakeLink=ObjectLink&{buffered():number;drop(bytes:number):void;close():void;sentCount():number};
function linkPair():{ana:FakeLink;bob:FakeLink}{
 const end=():End=>({receivers:new Set(),closures:new Set(),bytes:0,floor:0,waiting:null,closed:false,sent:[]});
 const ends:{ana:End;bob:End}={ana:end(),bob:end()};
 const handle=(self:'ana'|'bob'):FakeLink=>{
  const mine=ends[self],other=ends[self==='ana'?'bob':'ana'];
  const release=()=>{if(mine.waiting&&mine.bytes<mine.floor){const wake=mine.waiting;mine.waiting=null;wake();}};
  return {
   peer:self,
   send(frame){if(mine.closed)throw new Error('Canal de objeto fechado');mine.sent.push(frame);mine.bytes+=frame.byteLength;for(const listener of [...other.receivers])listener(frame.slice());},
   bufferedAmount:()=>mine.bytes,
   drain(below){mine.floor=below;if(mine.bytes<below)return Promise.resolve();return new Promise<void>(wake=>{mine.waiting=wake;});},
   receive(listener){mine.receivers.add(listener);return()=>{mine.receivers.delete(listener);};},
   closed(listener){mine.closures.add(listener);return()=>{mine.closures.delete(listener);};},
   close(){for(const side of [mine,other]){side.closed=true;for(const listener of [...side.closures])listener();}},
   buffered:()=>mine.bytes,
   drop(bytes){mine.bytes=Math.max(0,mine.bytes-bytes);release();},
   sentCount:()=>mine.sent.length,
  };
 };
 return {ana:handle('ana'),bob:handle('bob')};
}
// The pump hashes with WebCrypto, so it advances in turns of the event loop and not only in microtasks. This waits for
// the next turn without binding the test to any duration — no sleep, no wall clock — which is what lets a real platform
// callback run between two assertions about the buffer.
const turn=()=>new Promise<void>(resolve=>{setImmediate(resolve);});
// The pump works in real turns of the event loop (the store hashes with WebCrypto), so a test waits on the pump's own
// state: blocked on the buffer is exactly the moment an assertion about the buffer can be made.
async function settle(predicate:()=>boolean,served:ServedObject):Promise<void>{
 for(let round=0;round<400&&!predicate();round+=1){await served.idle();await turn();}
}
async function serveToEnd(link:FakeLink,served:ServedObject,pending:Promise<unknown>):Promise<void>{
 let finished=false;
 void pending.then(()=>{finished=true;});
 // The first burst may not have started when a test gets here, so waiting for the buffer to fill is what makes a drop
 // land on a suspended pump instead of on nothing.
 for(let round=0;round<400&&!finished;round+=1){
  await settle(()=>link.buffered()>0||finished,served);
  if(finished)break;
  link.drop(link.buffered());
 }
 await pending;
}
// The peer that answers a request: this is where a test states what the other side puts on the wire.
function responder(link:FakeLink,answer:(request:ObjectFrame)=>void,asked:number[]=[]):()=>void{
 return link.receive(frame=>{
  const read=readFrame(frame);
  if(!read.ok||read.value.tag!=='request')return;
  asked.push(read.value.offset);
  answer(read.value);
 });
}
const stream=(send:(frame:Uint8Array)=>void,bytes:Uint8Array,ref:ObjectRef,from:number,segment:number)=>{
 for(let offset=from;offset<ref.bytes;offset+=segment){
  const end=Math.min(offset+segment,ref.bytes);
  send(writeFrame({tag:'segment',ref,offset,payload:bytes.subarray(offset,end)}));
 }
 send(writeFrame({tag:'complete',ref,offset:ref.bytes}));
};

test('an object arrives whole, verified by address, and only then reaches the store',async()=>{
 const {ana,bob}=linkPair();
 const bytes=bytesOf(40*1024),ref=await hasher.ref(bytes);
 const source=storeOf();
 await source.store.put(bytes);
 const served=serveObjects({link:bob,store:source.store,limits:SMALL});
 const sink=storeOf();
 const got=await transferObject(ref,'bob',transferPorts({link:ana,store:sink.store}));
 expect(got).toEqual({ok:true,value:bytes});
 expect(sink.bytes.get(ref.hash)).toEqual(bytes);
 served.stop();
});

test('a truncated stream is refused by address and nothing enters the store',async()=>{
 const {ana,bob}=linkPair();
 const bytes=bytesOf(40*1024),ref=await hasher.ref(bytes);
 // A peer that answers with the head of the object and then declares the stream finished.
 responder(bob,()=>{
  bob.send(writeFrame({tag:'segment',ref,offset:0,payload:bytes.subarray(0,4*1024)}));
  bob.send(writeFrame({tag:'complete',ref,offset:4*1024}));
 });
 const sink=storeOf();
 const got=await transferObject(ref,'bob',transferPorts({link:ana,store:sink.store}));
 expect(got).toMatchObject({ok:false,error:{code:'HASH_MISMATCH'}});
 expect(sink.bytes.size).toBe(0);
});

test('a flipped byte inside one segment is refused by the address of the object',async()=>{
 const {ana,bob}=linkPair();
 const bytes=bytesOf(40*1024),ref=await hasher.ref(bytes);
 const corrupted=bytes.slice();
 corrupted[9*1024]^=0x40;
 responder(bob,()=>stream(frame=>bob.send(frame),corrupted,ref,0,4*1024));
 const sink=storeOf();
 const got=await transferObject(ref,'bob',transferPorts({link:ana,store:sink.store}));
 expect(got).toMatchObject({ok:false,error:{code:'HASH_MISMATCH'}});
 expect(sink.bytes.size).toBe(0);
});

test('a connection that drops mid-object keeps what arrived and the resume asks only for the rest',async()=>{
 const bytes=bytesOf(40*1024),ref=await hasher.ref(bytes);
 const first=linkPair();
 first.bob.receive(frame=>{
  const read=readFrame(frame);
  if(!read.ok||read.value.tag!=='request')return;
  first.bob.send(writeFrame({tag:'segment',ref,offset:0,payload:bytes.subarray(0,4*1024)}));
  first.bob.send(writeFrame({tag:'segment',ref,offset:4*1024,payload:bytes.subarray(4*1024,8*1024)}));
  first.bob.close();
 });
 const shelf=createPartialShelf(),budget=createObjectBudget();
 const lost=await transferObject(ref,'bob',transferPorts({link:first.ana,store:storeOf().store,resume:shelf,budget}));
 expect(lost).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 expect(lost.ok?'':lost.error.message).toContain(String(8*1024));
 expect(shelf.get(ref)).toHaveLength(8*1024);
 // A new connection whose peer sends only the tail: the bytes of the first attempt are what make this succeed.
 const second=linkPair();
 const asked:number[]=[];
 responder(second.bob,()=>stream(frame=>second.bob.send(frame),bytes,ref,8*1024,4*1024),asked);
 const sink=storeOf();
 const got=await transferObject(ref,'bob',transferPorts({link:second.ana,store:sink.store,resume:shelf,budget}));
 expect(got).toEqual({ok:true,value:bytes});
 expect(asked).toEqual([8*1024]);
 expect(shelf.get(ref)).toBeUndefined();
 expect(sink.bytes.get(ref.hash)).toEqual(bytes);
});

test('sending suspends at the agreed ceiling and only resumes below the agreed floor',async()=>{
 const {ana,bob}=linkPair();
 const bytes=bytesOf(2*1024*1024),ref=await hasher.ref(bytes);
 const source=storeOf();
 await source.store.put(bytes);
 const limits=agreed({maxObjectBytes:2*1024*1024});
 const served=serveObjects({link:bob,store:source.store,limits});
 const sink=storeOf();
 const pending=transferObject(ref,'bob',transferPorts({link:ana,store:sink.store,limits}));
 await settle(()=>bob.buffered()>0,served);
 // A frame adds its 41-byte header, so the pump stops on the first frame that puts the buffer at or above the ceiling.
 const ceiling=Math.ceil(BUFFER_AGREEMENT.highWaterBytes/limits.maxSegmentBytes);
 expect(bob.sentCount()).toBe(ceiling);
 expect(bob.buffered()).toBeGreaterThanOrEqual(BUFFER_AGREEMENT.highWaterBytes);
 expect(bob.buffered()).toBeLessThan(BUFFER_AGREEMENT.highWaterBytes+limits.maxSegmentBytes+41);
 // Sitting exactly on the floor is still not below it: the agreement is what resumes the pump.
 bob.drop(bob.buffered()-BUFFER_AGREEMENT.lowWaterBytes);
 expect(bob.buffered()).toBe(BUFFER_AGREEMENT.lowWaterBytes);
 expect(bob.sentCount()).toBe(ceiling);
 bob.drop(1);
 await settle(()=>bob.sentCount()>ceiling,served);
 expect(bob.sentCount()).toBeGreaterThan(ceiling);
 await serveToEnd(bob,served,pending);
 expect(await received(await pending,ref)).toBe(true);
 expect(await addressed(sink.bytes.get(ref.hash),ref)).toBe(true);
 served.stop();
});

test('a peer that announces a bigger buffer never raises what this device allocates',async()=>{
 const {ana,bob}=linkPair();
 const bytes=bytesOf(2*1024*1024),ref=await hasher.ref(bytes);
 const source=storeOf();
 await source.store.put(bytes);
 const limits=agreed({maxObjectBytes:2*1024*1024});
 const generous={highWaterBytes:4*1024*1024,lowWaterBytes:3*1024*1024};
 expect(narrowerBackpressure(BUFFER_AGREEMENT,generous)).toEqual(BUFFER_AGREEMENT);
 const served=serveObjects({link:bob,store:source.store,limits,backpressure:generous});
 const pending=transferObject(ref,'bob',transferPorts({link:ana,store:storeOf().store,limits,backpressure:generous}));
 await settle(()=>bob.buffered()>0,served);
 // The peer announced a 4 MiB buffer; this device still stops at its own ceiling.
 expect(bob.sentCount()).toBe(Math.ceil(BUFFER_AGREEMENT.highWaterBytes/limits.maxSegmentBytes));
 expect(bob.buffered()).toBeLessThan(BUFFER_AGREEMENT.highWaterBytes+limits.maxSegmentBytes+41);
 await serveToEnd(bob,served,pending);
 expect(await received(await pending,ref)).toBe(true);
 served.stop();
});

test('a tighter agreement of the peer is what the channel really uses',async()=>{
 const {ana,bob}=linkPair();
 const bytes=bytesOf(1024*1024),ref=await hasher.ref(bytes);
 const source=storeOf();
 await source.store.put(bytes);
 const limits=agreed({maxObjectBytes:1024*1024});
 const tight={highWaterBytes:512*1024,lowWaterBytes:128*1024};
 const served=serveObjects({link:bob,store:source.store,limits,backpressure:tight});
 const pending=transferObject(ref,'bob',transferPorts({link:ana,store:storeOf().store,limits,backpressure:tight}));
 await settle(()=>bob.buffered()>0,served);
 expect(bob.sentCount()).toBe(Math.ceil(512*1024/limits.maxSegmentBytes));
 expect(bob.buffered()).toBeLessThan(512*1024+limits.maxSegmentBytes+41);
 await serveToEnd(bob,served,pending);
 expect(await received(await pending,ref)).toBe(true);
 served.stop();
});

test('an object over the ceiling is refused before a segment is asked for',async()=>{
 const {ana}=linkPair();
 const over:ObjectRef={hash:'ab'.repeat(32),bytes:NETWORK_LIMITS.maxObjectBytes+1};
 const sink=storeOf();
 const got=await transferObject(over,'bob',transferPorts({link:ana,store:sink.store}));
 expect(got).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(ana.sentCount()).toBe(0);
 expect(sink.bytes.size).toBe(0);
});

test('a segment over the negotiated ceiling, or one that skips ahead, is refused',async()=>{
 const bytes=bytesOf(40*1024),ref=await hasher.ref(bytes);
 const cases:{name:string;frame:()=>Uint8Array}[]=[
  {name:'oversized',frame:()=>writeFrame({tag:'segment',ref,offset:0,payload:bytes.subarray(0,20*1024)})},
  {name:'skipping ahead',frame:()=>writeFrame({tag:'segment',ref,offset:8*1024,payload:bytes.subarray(8*1024,12*1024)})},
 ];
 for(const one of cases){
  const {ana,bob}=linkPair();
  responder(bob,()=>bob.send(one.frame()));
  const refused:WorldError[]=[];
  const sink=storeOf();
  const got=await transferObject(ref,'bob',transferPorts({link:ana,store:sink.store,refused}));
  expect(got,one.name).toMatchObject({ok:false});
  expect(sink.bytes.size,one.name).toBe(0);
  expect(refused.length,one.name).toBeGreaterThan(0);
 }
});

test('a frame that was never meant for this transfer is ignored and never reaches a receiver',async()=>{
 const {ana,bob}=linkPair();
 const bytes=bytesOf(40*1024),ref=await hasher.ref(bytes);
 const other=bytesOf(1024,3),otherRef=await hasher.ref(other);
 responder(bob,()=>{
  bob.send(new Uint8Array(9));
  bob.send(writeFrame({tag:'segment',ref:otherRef,offset:0,payload:other}));
  bob.send(writeFrame({tag:'complete',ref:otherRef,offset:otherRef.bytes}));
  stream(frame=>bob.send(frame),bytes,ref,0,4*1024);
 });
 const refused:WorldError[]=[];
 const sink=storeOf();
 const got=await transferObject(ref,'bob',transferPorts({link:ana,store:sink.store,refused}));
 expect(got).toEqual({ok:true,value:bytes});
 expect(refused.map(error=>error.code)).toEqual(['MALFORMED','MALFORMED','MALFORMED']);
 expect(sink.bytes.get(ref.hash)).toEqual(bytes);
});

test('an object the peer does not have comes back as a named absence',async()=>{
 const {ana,bob}=linkPair();
 const missing:ObjectRef={hash:'cd'.repeat(32),bytes:4096};
 const served=serveObjects({link:bob,store:storeOf().store,limits:SMALL});
 const got=await transferObject(missing,'bob',transferPorts({link:ana,store:storeOf().store}));
 expect(got).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 served.stop();
});

test('two transfers in flight share the budget instead of over-allocating',async()=>{
 const bytes=bytesOf(2*1024*1024),ref=await hasher.ref(bytes);
 const limits=agreed({maxObjectBytes:2*1024*1024,maxInflightObjectBytes:3*1024*1024});
 const budget=createObjectBudget(limits.maxInflightObjectBytes);
 const first=linkPair();
 const source=storeOf();
 await source.store.put(bytes);
 const served=serveObjects({link:first.bob,store:source.store,limits});
 const inFlight=transferObject(ref,'bob',transferPorts({link:first.ana,store:storeOf().store,limits,budget}));
 const second=linkPair();
 const refused=await transferObject(ref,'bob',transferPorts({link:second.ana,store:storeOf().store,limits,budget}));
 expect(refused).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(second.ana.sentCount()).toBe(0);
 await serveToEnd(first.bob,served,inFlight);
 expect(await received(await inFlight,ref)).toBe(true);
 // The budget came back with the transfer that ended, so the same peer can send the same object again.
 const again=serveObjects({link:second.bob,store:source.store,limits});
 const retried=transferObject(ref,'bob',transferPorts({link:second.ana,store:storeOf().store,limits,budget}));
 await serveToEnd(second.bob,again,retried);
 expect(await received(await retried,ref)).toBe(true);
 again.stop();
 served.stop();
});

test('the concurrent ceiling of the session is 64 MiB and it is reserved before any allocation',()=>{
 const budget=createObjectBudget(NETWORK_LIMITS.maxInflightObjectBytes);
 expect(budget.available()).toBe(64*1024*1024);
 expect(budget.reserve(32*1024*1024)).toBe(true);
 expect(budget.reserve(32*1024*1024)).toBe(true);
 expect(budget.reserve(1)).toBe(false);
 expect(budget.available()).toBe(0);
 budget.release(32*1024*1024);
 expect(budget.reserve(1)).toBe(true);
});

test('a peer that is not connected has no channel to ask',async()=>{
 const {ana}=linkPair();
 const bytes=bytesOf(1024),ref=await hasher.ref(bytes);
 const got=await transferObject(ref,'carlos',transferPorts({link:ana}));
 expect(got).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
});
