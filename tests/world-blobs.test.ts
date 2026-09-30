import {expect,test} from 'vitest';
import {createJcsCodec} from '../src/adapters/codec/jcs';
import {bytesHasher,sha256Bytes} from '../src/adapters/hash/content';
import {createBlossomObjectStore} from '../src/adapters/blobs/blossom';
import {createDirectObjectStore} from '../src/adapters/blobs/direct';
import {createHttpObjectStore} from '../src/adapters/blobs/http';
import {SEALED_FORMAT,createPrivateCopies,createWebCryptoPort,decodeSealed,encodeSealed,openObject,sealObject,sealedContext} from '../src/adapters/crypto/private-objects';
import type {CryptoPort,ObjectKey,SealedObject} from '../src/adapters/crypto/private-objects';
import {createWorldMemoryStorage} from '../src/adapters/storage/world-memory';
import {importLegacy} from '../src/session/world-bundle';
import {createWorldRepository} from '../src/session/world-repository';
import {applyCommand,createGame} from '../src/core/commands';
import {decodeBundle,encodeBundle} from '../src/world/codec';
import {MAX_OBJECT_BYTES} from '../src/world/model';
import type {Head,ObjectRef} from '../src/world/model';
import type {ContentHasher} from '../src/world/ports';
import type {BaseChunk,CellCoord,GameState,SavedGame,ViewState} from '../src/core/model';
import {command} from './fixtures/world';

const codec=createJcsCodec(),hasher=bytesHasher();
const terms=[{source:'OpenStreetMap · Shortbread v1',attribution:'© OpenStreetMap contributors',license:'ODbL'}];
const view:ViewState={x:12.5,y:-4,zoom:1.5,speed:1,place:'Victoria',rotation:-0.75};
const oneCell=(id:string):BaseChunk=>({id,source:'synthetic-test',normalizerVersion:1,cells:[{terrain:'land'}]});
const here=(x:number,y:number):CellCoord=>({x:288+x,y:288+y});
const utf8=(text:string)=>new TextEncoder().encode(text);
const textOf=(bytes:Uint8Array)=>new TextDecoder().decode(bytes);
const hex=(bytes:Uint8Array)=>[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
// Only used on short buffers: the search is quadratic on purpose so the assertion stays readable.
const contains=(hay:Uint8Array,needle:Uint8Array)=>{outer:for(let i=0;i+needle.byteLength<=hay.byteLength;i+=1){for(let j=0;j<needle.byteLength;j+=1)if(hay[i+j]!==needle[j])continue outer;return true;}return false;};
const key=(world='victoria',id='k1'):ObjectKey=>({id,world,bytes:new Uint8Array(32).fill(7)});
function build(state:GameState,available:readonly BaseChunk[],cell:CellCoord):GameState{
 const applied=applyCommand(state,command(state,{type:'build',tool:'park',cells:[cell]}),available);
 if(applied.status!=='applied')throw new Error(applied.reason);
 return applied.state;
}
// The two ports this test counts: a refusal that happens "before decryption" or "before hashing" is only proven if
// the port that would do the work was never asked.
function countingCrypto(inner:CryptoPort){
 const counts={nonces:0,seals:0,opens:0};
 const port:CryptoPort={
  nonce:(id:string)=>{counts.nonces+=1;return inner.nonce(id);},
  seal:(...args:Parameters<CryptoPort['seal']>)=>{counts.seals+=1;return inner.seal(...args);},
  open:(...args:Parameters<CryptoPort['open']>)=>{counts.opens+=1;return inner.open(...args);},
 };
 return {port,counts};
}
function countingHasher(inner:ContentHasher){
 const counts={hashes:0};
 const port:ContentHasher={ref:async(bytes:Uint8Array)=>{counts.hashes+=1;return inner.ref(bytes);}};
 return {port,counts};
}
// A provider that answers like a small HTTP service: the address is the last path segment, or the body when the upload
// endpoint has no address of its own (Blossom). No daemon and no network: only the calls the adapter really makes.
type Call={method:string;url:string;authorization?:string};
function fakeServer(options:{addressFrom?:'path'|'body';fail?:'all';uploadStatus?:number;echo?:string}={}){
 const held=new Map<string,Uint8Array>(),calls:Call[]=[];
 const addressFrom=options.addressFrom??'path';
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input),method=init?.method??'GET';
  calls.push({method,url,authorization:new Headers(init?.headers).get('authorization')??undefined});
  if(options.fail==='all')throw new Error('sem rede');
  const path=url.slice(url.lastIndexOf('/')+1);
  if(method==='GET'){
   const bytes=held.get(path);
   return bytes?new Response(bytes.slice(),{status:200}):new Response(null,{status:404});
  }
  if(method==='HEAD')return new Response(null,{status:held.has(path)?200:404});
  const body=init?.body;
  if(!(body instanceof Uint8Array))throw new Error('corpo inesperado');
  if(options.uploadStatus!==undefined)return new Response(null,{status:options.uploadStatus});
  const written=await sha256Bytes(body);
  const address=addressFrom==='body'?written:path;
  held.set(address,body);
  return new Response(JSON.stringify({sha256:options.echo??address,size:body.byteLength}),{status:200,headers:{'content-type':'application/json'}});
 };
 return {fetcher,held,calls};
}
const statusOnly=(status:number):typeof fetch=>async()=>new Response(null,{status});
async function worldWithWork():Promise<{head:Head;bytes:Uint8Array;plain:ObjectRef}>{
 const storage=createWorldMemoryStorage(),worlds=createWorldRepository({storage,codec,hasher});
 const start=createGame('victoria',1,oneCell('9:9'));
 const save:SavedGame={version:1,state:start,view};
 const imported=await importLegacy(save,hasher,codec,terms);
 if(!imported.ok)throw new Error(imported.error.message);
 const created=await worlds.create(imported.value);
 if(!created.ok)throw new Error(created.error.message);
 const accepted=await worlds.commit(created.value,{id:'parque-1',state:build(start,[],here(0,0)),operations:['Parque em 1 célula'],objects:[],author:'local-player'});
 if(!accepted.ok)throw new Error(accepted.error.message);
 const exported=await worlds.export(accepted.value);
 if(!exported.ok)throw new Error(exported.error.message);
 expect(exported.value.completeness).toEqual({complete:true,missing:[]});
 const bytes=encodeBundle(exported.value,codec);
 return {head:accepted.value,bytes,plain:await hasher.ref(bytes)};
}
async function openEverywhere(bytes:Uint8Array):Promise<Head>{
 const decoded=decodeBundle(bytes);
 if(!decoded.ok)throw new Error(decoded.error.message);
 const storage=createWorldMemoryStorage(),worlds=createWorldRepository({storage,codec,hasher});
 const created=await worlds.create(decoded.value);
 if(!created.ok)throw new Error(created.error.message);
 return created.value;
}

test('the sealed bytes are addressed by the ciphertext while the readable hash stays in the private manifest',async()=>{
 const plain=utf8('a praça do grupo, ainda privada'),material=key();
 const first=await sealObject(plain,material,createWebCryptoPort());
 const sealedBytes=encodeSealed(first),address=await hasher.ref(sealedBytes),readable=await hasher.ref(plain);
 // The public address covers the ciphertext: it does not reveal, and does not equal, the hash of the words.
 expect(address.hash).not.toBe(readable.hash);
 expect(address.bytes).toBe(sealedBytes.byteLength);
 expect(textOf(sealedBytes)).not.toContain('praça');
 expect(contains(sealedBytes,material.bytes)).toBe(false);
 expect(contains(first.ciphertext,material.bytes)).toBe(false);
 // The framing is bounded: a truncated object, or one whose header promises more bytes than it carries, is refused
 // before any of it reaches the AEAD.
 expect(decodeSealed(new Uint8Array(3))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(decodeSealed(sealedBytes.subarray(0,sealedBytes.byteLength-1))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const decoded=decodeSealed(sealedBytes);
 expect(decoded).toMatchObject({ok:true});
 if(!decoded.ok)return;
 expect(decoded.value).toEqual(first);
 const opened=await openObject(decoded.value,material,createWebCryptoPort());
 expect(opened).toMatchObject({ok:true});
 if(!opened.ok)return;
 expect(textOf(opened.value)).toBe('a praça do grupo, ainda privada');
 // The same words seal differently every time: the nonce is fresh, so two copies are two objects.
 const second=await sealObject(plain,material,createWebCryptoPort());
 expect(second.nonce).not.toEqual(first.nonce);
 expect(hex(second.ciphertext)).not.toBe(hex(first.ciphertext));
 expect((await hasher.ref(encodeSealed(second))).hash).not.toBe(address.hash);
 // The manifest a friend receives names the ciphertext address and the readable hash, and carries no key.
 const local=createDirectObjectStore({hasher});
 const copies=createPrivateCopies({world:'victoria',key:material,crypto:createWebCryptoPort(),hasher,stores:[{id:'local',store:local}]});
 const uploaded=await copies.put(plain);
 expect(uploaded).toMatchObject({ok:true});
 if(!uploaded.ok)return;
 const copy=uploaded.value.copy;
 expect(copy.plaintext).toEqual(readable);
 expect(copy.sealed.hash).not.toBe(copy.plaintext.hash);
 expect(copy.stores).toEqual(['local']);
 // The provider holds the sealed bytes under that address, and the readable content address is nowhere to be seen.
 const heldSealed=await local.get(copy.sealed);
 expect(heldSealed).toMatchObject({ok:true});
 if(!heldSealed.ok)return;
 expect(contains(heldSealed.value,plain)).toBe(false);
 expect(JSON.stringify(copy)).not.toContain(hex(material.bytes));
 // A key without an identifier would seal a copy nobody could open again: the id says which key sealed it.
 const anonymous=createPrivateCopies({world:'victoria',key:{...material,id:''},crypto:createWebCryptoPort(),hasher,stores:[{id:'local',store:local}]});
 expect(await anonymous.put(plain)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const restored=await copies.get(copy);
 expect(restored).toMatchObject({ok:true,value:{store:'local',plaintext:readable}});
});

test('a changed nonce, a changed context and a changed ciphertext are all refused',async()=>{
 const plain=utf8('cidade privada'),material=key();
 const sealed=await sealObject(plain,material,createWebCryptoPort());
 const {port,counts}=countingCrypto(createWebCryptoPort());
 const tamperedNonce={...sealed,nonce:new Uint8Array(12).fill(3)};
 expect(await openObject(tamperedNonce,material,port)).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 const flipped=new Uint8Array(sealed.ciphertext);
 flipped[0]=(flipped[0]!+1)%256;
 expect(await openObject({...sealed,ciphertext:flipped},material,port)).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 expect(await openObject({...sealed,nonce:new Uint8Array(13).fill(1)},material,port)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 // What a foreign manifest can really contain: a format this client does not implement.
 const unknownFormat={...sealed,format:'AES-GCM-128'} as unknown as SealedObject;
 expect(await openObject(unknownFormat,material,port)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 // A copy of one world is not a copy of another, even with the same key material: the world is authenticated.
 const elsewhere=key('vitoria-do-norte','k1');
 expect(await openObject(sealed,elsewhere,port)).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 // A changed nonce and a changed ciphertext are refused by the tag itself, so those two did reach the AEAD; every
 // other refusal above was decided from the labels, the lengths and the limit, before any ciphertext was touched.
 expect(counts.opens).toBe(2);
 expect(sealedContext({format:SEALED_FORMAT,world:'victoria',keyId:'k1'})).not.toEqual(sealedContext({format:SEALED_FORMAT,world:'vitoria-do-norte',keyId:'k1'}));
 // The two cases a label check cannot decide are the ones where the declared world and key id match the key at hand:
 // there the tag itself has to refuse, which is what makes the context authenticated rather than merely compared.
 expect(await openObject({...sealed,world:'vitoria-do-norte'},elsewhere,port)).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 expect(await openObject({...sealed,keyId:'k2'},key('victoria','k2'),port)).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 expect(counts.opens).toBe(4);
});

test('a copy without its key, with a renewed key or with a key of another world is refused',async()=>{
 const plain=utf8('obra em andamento'),material=key();
 const sealed=await sealObject(plain,material,createWebCryptoPort());
 const port=createWebCryptoPort();
 expect(await openObject(sealed,{...material,bytes:new Uint8Array(32).fill(9)},port)).toMatchObject({ok:false,error:{code:'SIGNATURE'}});
 expect(await openObject(sealed,{...material,bytes:new Uint8Array(0)},port)).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(await openObject(sealed,key('victoria','k2'),port)).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 expect(await openObject(sealed,key('outro-mundo','k1'),port)).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 // A copy whose manifest names a world this key does not belong to is refused before any provider is asked.
 const copies=createPrivateCopies({world:'victoria',key:material,crypto:port,hasher,stores:[{id:'local',store:createDirectObjectStore({hasher})}]});
 const uploaded=await copies.put(plain);
 if(!uploaded.ok)throw new Error(uploaded.error.message);
 expect(await copies.get({...uploaded.value.copy,world:'outro-mundo'})).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 expect(await copies.get({...uploaded.value.copy,keyId:'k2'})).toMatchObject({ok:false,error:{code:'PERMISSION'}});
});

test('an unavailable provider falls back to the local copy and absence is never success',async()=>{
 const remote=fakeServer({fail:'all'});
 const shelf=new Map<string,Uint8Array>();
 const copies=createPrivateCopies({
  world:'victoria',key:key(),crypto:createWebCryptoPort(),hasher,
  stores:[
   {id:'nuvem',store:createHttpObjectStore({base:'https://exemplo.test/blobs',hasher,fetcher:remote.fetcher})},
   {id:'local',store:createDirectObjectStore({hasher,shelf})},
  ],
 });
 const plain=utf8('base congelada do grupo');
 const uploaded=await copies.put(plain);
 expect(uploaded).toMatchObject({ok:true});
 if(!uploaded.ok)return;
 // The cloud did not answer, so the copy that exists is the local one — and the failure is named, never hidden.
 expect(uploaded.value.copy.stores).toEqual(['local']);
 expect(uploaded.value.failed.map(entry=>entry.store)).toEqual(['nuvem']);
 expect(uploaded.value.failed[0]!.error.code).toBe('NOT_FOUND');
 const restored=await copies.get(uploaded.value.copy);
 expect(restored).toMatchObject({ok:true,value:{store:'local'}});
 if(!restored.ok)return;
 expect(textOf(restored.value.plain)).toBe('base congelada do grupo');
 // The local bytes are removed and the cloud still does not answer: the copy is gone, and both failures are named.
 shelf.delete(uploaded.value.copy.sealed.hash);
 const lost=await copies.get(uploaded.value.copy);
 expect(lost).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 if(lost.ok)return;
 expect(lost.error.message).toContain('local');
});

test('the same world comes back from either of two independent copies and after one of them is gone',async()=>{
 const world=await worldWithWork();
 const friendServer=fakeServer({addressFrom:'body'});
 const shelf=new Map<string,Uint8Array>();
 const copies=createPrivateCopies({
  world:'victoria',key:key(),crypto:createWebCryptoPort(),hasher,
  stores:[
   {id:'este-dispositivo',store:createDirectObjectStore({hasher,shelf})},
   {id:'servidor-do-amigo',store:createBlossomObjectStore({server:'https://blossom.test',hasher,fetcher:friendServer.fetcher,authorize:()=>'Nostr convite'})},
  ],
 });
 const uploaded=await copies.put(world.bytes);
 expect(uploaded).toMatchObject({ok:true});
 if(!uploaded.ok)return;
 const copy=uploaded.value.copy;
 expect(copy.stores).toEqual(['este-dispositivo','servidor-do-amigo']);
 expect(uploaded.value.failed).toEqual([]);
 expect(copy.plaintext).toEqual(world.plain);
 expect(copy.sealed.hash).not.toBe(copy.plaintext.hash);
 // Both providers hold the same sealed object, and neither of them can see the readable content address.
 expect([...shelf.keys()]).toEqual([copy.sealed.hash]);
 expect([...friendServer.held.keys()]).toEqual([copy.sealed.hash]);
 expect(friendServer.held.has(copy.plaintext.hash)).toBe(false);
 const fromThisDevice=await copies.get(copy);
 expect(fromThisDevice).toMatchObject({ok:true,value:{store:'este-dispositivo'}});
 if(!fromThisDevice.ok)return;
 expect(await openEverywhere(fromThisDevice.value.plain)).toEqual(world.head);
 const fromFriend=await copies.get(copy);
 if(!fromFriend.ok)throw new Error(fromFriend.error.message);
 // The second origin restores the very same world: same head, same hashes, no map provider involved.
 expect(await openEverywhere(fromFriend.value.plain)).toEqual(world.head);
 expect(fromFriend.value.plaintext).toEqual(world.plain);
 // One copy disappears; the other still restores the world and says which one answered.
 shelf.delete(copy.sealed.hash);
 const afterLoss=await copies.get(copy);
 expect(afterLoss).toMatchObject({ok:true,value:{store:'servidor-do-amigo'}});
 if(!afterLoss.ok)return;
 expect(await openEverywhere(afterLoss.value.plain)).toEqual(world.head);
 // With both copies gone the restore fails: absence never becomes a silent success.
 friendServer.held.delete(copy.sealed.hash);
 expect(await copies.get(copy)).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
});

test('an object over the size limit is refused before it is hashed or decrypted in bulk',async()=>{
 const {port,counts}=countingCrypto(createWebCryptoPort());
 const huge=new Uint8Array(MAX_OBJECT_BYTES+1);
 const sealed:SealedObject={kind:'sealed-object',format:SEALED_FORMAT,world:'victoria',keyId:'k1',nonce:new Uint8Array(12),ciphertext:huge};
 expect(await openObject(sealed,key(),port)).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(counts.opens).toBe(0);
 const {port:hashing,counts:hashed}=countingHasher(hasher);
 const shelf=new Map<string,Uint8Array>();
 expect(await createDirectObjectStore({hasher:hashing,shelf}).put(huge)).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(hashed.hashes).toBe(0);
 expect(shelf.size).toBe(0);
 // The private path refuses the same object before sealing it or handing it to any provider.
 const provider=fakeServer({});
 const pages=createPrivateCopies({world:'victoria',key:key(),crypto:port,hasher,stores:[{id:'nuvem',store:createHttpObjectStore({base:'https://exemplo.test/blobs',hasher,fetcher:provider.fetcher})}]});
 expect(await pages.put(huge)).toMatchObject({ok:false,error:{code:'LIMIT'}});
 expect(counts.nonces).toBe(0);
 expect(provider.calls).toEqual([]);
});

test('a store that answers distinguishes an absent object from an unavailable provider',async()=>{
 const absent=await hasher.ref(utf8('nada aqui'));
 expect(await createDirectObjectStore({hasher}).get(absent)).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 const down=createHttpObjectStore({base:'https://exemplo.test/blobs',hasher,fetcher:fakeServer({fail:'all'}).fetcher});
 expect(await down.get(absent)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
 const empty=fakeServer({});
 expect(await createHttpObjectStore({base:'https://exemplo.test/blobs',hasher,fetcher:empty.fetcher}).get(absent)).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 const lying=new Map<string,Uint8Array>([[absent.hash,utf8('outros bytes')]]);
 expect(await createDirectObjectStore({hasher,shelf:lying}).get(absent)).toMatchObject({ok:false,error:{code:'HASH_MISMATCH'}});
 const truncated=fakeServer({});
 truncated.held.set(absent.hash,utf8('outros bytes'));
 expect(await createHttpObjectStore({base:'https://exemplo.test/blobs',hasher,fetcher:truncated.fetcher}).get(absent)).toMatchObject({ok:false,error:{code:'HASH_MISMATCH'}});
 const tooBig=createHttpObjectStore({base:'https://exemplo.test/blobs',hasher,fetcher:statusOnly(413)});
 expect(await tooBig.put(utf8('x'))).toMatchObject({ok:false,error:{code:'LIMIT'}});
 const full=createHttpObjectStore({base:'https://exemplo.test/blobs',hasher,fetcher:statusOnly(507)});
 expect(await full.put(utf8('x'))).toMatchObject({ok:false,error:{code:'QUOTA'}});
 const store=createHttpObjectStore({base:'https://exemplo.test/blobs',hasher,fetcher:empty.fetcher});
 const stored=await store.put(utf8('base do amigo'));
 expect(stored).toMatchObject({ok:true});
 if(!stored.ok)return;
 const fetched=await store.get(stored.value);
 expect(fetched).toMatchObject({ok:true});
 if(!fetched.ok)return;
 expect(textOf(fetched.value)).toBe('base do amigo');
});

test('Blossom uploads carry the address back, require authorization and answer existence without downloading',async()=>{
 const server=fakeServer({addressFrom:'body'});
 const store=createBlossomObjectStore({server:'https://blossom.test',hasher,fetcher:server.fetcher,authorize:()=>'Nostr evento'});
 const uploaded=await store.put(utf8('checkpoint privado'));
 expect(uploaded).toMatchObject({ok:true});
 if(!uploaded.ok)return;
 expect(server.calls[0]).toMatchObject({method:'PUT',url:'https://blossom.test/upload',authorization:'Nostr evento'});
 expect(await store.has(uploaded.value)).toMatchObject({ok:true,value:true});
 expect(await store.get(uploaded.value)).toMatchObject({ok:true});
 const missing=await hasher.ref(utf8('nunca enviado'));
 expect(await store.has(missing)).toMatchObject({ok:true,value:false});
 expect(await store.get(missing)).toMatchObject({ok:false,error:{code:'MISSING_OBJECT'}});
 // A provider that answers another address did not store what was sent, and the upload is refused.
 const liar=fakeServer({addressFrom:'body',echo:'f'.repeat(64)});
 const lying=createBlossomObjectStore({server:'https://blossom.test',hasher,fetcher:liar.fetcher,authorize:()=>'Nostr evento'});
 expect(await lying.put(utf8('checkpoint privado'))).toMatchObject({ok:false,error:{code:'HASH_MISMATCH'}});
 // Without an authorizer the request is never made: a server that needs a signature gets none from here.
 const unsigned=fakeServer({addressFrom:'body'});
 const withoutSigner=createBlossomObjectStore({server:'https://blossom.test',hasher,fetcher:unsigned.fetcher,authorize:()=>{throw new Error('sem assinador');}});
 expect(await withoutSigner.put(utf8('checkpoint privado'))).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 const noToken=createBlossomObjectStore({server:'https://blossom.test',hasher,fetcher:unsigned.fetcher,authorize:()=>''});
 expect(await noToken.put(utf8('checkpoint privado'))).toMatchObject({ok:false,error:{code:'PERMISSION'}});
 expect(unsigned.calls).toEqual([]);
});

test('the runtime refuses to issue the same nonce twice for one key',async()=>{
 const fixed=createWebCryptoPort({random:()=>new Uint8Array(12).fill(9)});
 expect(fixed.nonce('k1')).toEqual(new Uint8Array(12).fill(9));
 expect(()=>fixed.nonce('k1')).toThrow(/nonce/i);
 expect(fixed.nonce('k2')).toEqual(new Uint8Array(12).fill(9));
 const port=createWebCryptoPort();
 const issued=new Set<string>(),material=key();
 for(let round=0;round<64;round+=1)issued.add(hex(port.nonce(material.id)));
 expect(issued.size).toBe(64);
 const plain=utf8('mesma obra');
 const first=await sealObject(plain,material,port),second=await sealObject(plain,material,port);
 expect(first.nonce).not.toEqual(second.nonce);
 expect(await openObject(first,material,port)).toMatchObject({ok:true});
 expect(await openObject(second,material,port)).toMatchObject({ok:true});
});
