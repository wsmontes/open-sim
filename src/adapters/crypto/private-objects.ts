import {MAX_OBJECT_BYTES,failed,ok,sameRef} from '../../world/model';
import type {ObjectRef,WorldError,WorldErrorCode,WorldResult} from '../../world/model';
import type {ContentHasher,WorldCodec} from '../../world/ports';
import {decodeUtf8,parseStrictJson} from '../../world/codec';
import {createJcsCodec} from '../codec/jcs';
import type {ObjectStore} from '../blobs/direct';

// Private copies of world objects (spec §8.5). A group's world is encrypted before it reaches any provider, so the
// address a provider can see covers ciphertext only: the hash of the readable content stays in the private manifest
// that travels beside it, and keys travel through a channel nobody publishes. The AEAD is the one the runtime already
// ships (WebCrypto AES-GCM) — no hand-rolled cipher, no key derived here.
//
// Three things are structural rather than decorative:
//   * the nonce is unique per key, and the runtime refuses to hand out one it already issued instead of trusting luck;
//   * the authenticated context carries the format, the world and the key id, so a copy sealed for one world cannot be
//     re-labelled as another even by someone holding the key material, and a renewed key does not open old copies;
//   * the plaintext limit is checked against the ciphertext length before decryption, because GCM leaks nothing more
//     than the length — which is exactly what makes the limit checkable without decrypting anything hostile.
export const SEALED_FORMAT='AES-GCM-256';
export const SEALED_KIND='sealed-object';
const SEALED_VERSION='open-sim/sealed-object/1';
const HEADER_FIELDS:readonly string[]=['kind','format','world','keyId','nonce','ciphertext'];
const NONCE_BYTES=12,KEY_BYTES=32,NONCE_ATTEMPTS=8;
// Codes that answer about the bytes themselves: they outrank plain absence when no copy works.
const REFUSALS:readonly WorldErrorCode[]=['SIGNATURE','HASH_MISMATCH','MALFORMED','LIMIT','PERMISSION'];
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
// A distribution key of one world. `id` labels which key sealed a copy so a rotation is visible, `world` binds the
// copy to its world, and the material itself never leaves the private side of the exchange.
export type ObjectKey = {id:string;world:string;bytes:Uint8Array};
export type SealedObject = {
 kind:'sealed-object';
 format:typeof SEALED_FORMAT;
 world:string;
 keyId:string;
 nonce:Uint8Array;
 ciphertext:Uint8Array;
};
// The AEAD port. `nonce` is part of it because only the runtime can produce one that is unique per key, and `seal` and
// `open` throw on a key, a nonce or a ciphertext the algorithm refuses: authentication failure is not a value here.
export interface CryptoPort {
 nonce(keyId:string):Uint8Array;
 seal(key:ObjectKey,nonce:Uint8Array,plain:Uint8Array,context:Uint8Array):Promise<Uint8Array>;
 open(key:ObjectKey,nonce:Uint8Array,ciphertext:Uint8Array,context:Uint8Array):Promise<Uint8Array>;
}
// The consolidated runtime API, bounded to what this file needs. The set of issued nonces is kept per key so a repeat
// is refused rather than improbable; a generator that keeps repeating is an environment failure, and the caller hears
// about it instead of getting a second object sealed with the same nonce.
export function createWebCryptoPort(options:{random?:(bytes:number)=>Uint8Array}={}):CryptoPort {
 const random=options.random??((bytes:number)=>crypto.getRandomValues(new Uint8Array(bytes)));
 const issued=new Map<string,Set<string>>();
 return {
  nonce(keyId) {
   const taken=issued.get(keyId)??new Set<string>();
   issued.set(keyId,taken);
   for(let attempt=0;attempt<NONCE_ATTEMPTS;attempt+=1){
    const candidate=random(NONCE_BYTES);
    if(candidate.byteLength!==NONCE_BYTES)throw new Error(`Um nonce de ${SEALED_FORMAT} precisa de ${NONCE_BYTES} bytes`);
    const id=[...candidate].map(byte=>byte.toString(16).padStart(2,'0')).join('');
    if(taken.has(id))continue;
    taken.add(id);
    return candidate;
   }
   throw new Error('O gerador de nonces repetiu o mesmo valor: selar outra vez seria inseguro');
  },
  async seal(key,nonce,plain,context) {
   const imported=await importAeadKey(key,'encrypt');
   return new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:copy(nonce),additionalData:copy(context)},imported,copy(plain)));
  },
  async open(key,nonce,ciphertext,context) {
   const imported=await importAeadKey(key,'decrypt');
   return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:copy(nonce),additionalData:copy(context)},imported,copy(ciphertext)));
  },
 };
}
async function importAeadKey(key:ObjectKey,usage:'encrypt'|'decrypt'):Promise<CryptoKey> {
 if(key.bytes.byteLength!==KEY_BYTES)throw new Error(`Uma chave de objeto precisa de ${KEY_BYTES} bytes`);
 return crypto.subtle.importKey('raw',copy(key.bytes),{name:'AES-GCM'},false,[usage]);
}
// WebCrypto accepts only buffers it can own, and a view into a larger reply would otherwise be rejected or copied again.
const copy=(bytes:Uint8Array)=>bytes.slice();
// Canonical JSON for the authenticated context: two runtimes cannot disagree about the bytes the tag covers.
const contextCodec:WorldCodec=createJcsCodec();
export function sealedContext(sealed:Pick<SealedObject,'format'|'world'|'keyId'>):Uint8Array {
 return contextCodec.encode({sealed:SEALED_VERSION,format:sealed.format,world:sealed.world,keyId:sealed.keyId});
}
// The wire form of a sealed object: a four-byte header length, the canonical header, then the nonce and the ciphertext
// as the raw bytes they are. Bytes never become base64 on the way to a provider, so a 32 MiB object does not turn into
// 43 MiB of text and a store's own limit still measures the object it is asked to keep.
export function encodeSealed(sealed:SealedObject):Uint8Array {
 const header=contextCodec.encode({kind:sealed.kind,format:sealed.format,world:sealed.world,keyId:sealed.keyId,nonce:sealed.nonce.byteLength,ciphertext:sealed.ciphertext.byteLength});
 const bytes=new Uint8Array(4+header.byteLength+sealed.nonce.byteLength+sealed.ciphertext.byteLength);
 new DataView(bytes.buffer).setUint32(0,header.byteLength);
 bytes.set(header,4);
 bytes.set(sealed.nonce,4+header.byteLength);
 bytes.set(sealed.ciphertext,4+header.byteLength+sealed.nonce.byteLength);
 return bytes;
}
export function decodeSealed(bytes:Uint8Array):WorldResult<SealedObject> {
 if(bytes.byteLength<4)return failed('MALFORMED','Objeto selado sem cabeçalho');
 const start=4+new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
 if(start>bytes.byteLength)return failed('MALFORMED','Cabeçalho do objeto selado maior que os bytes');
 const text=decodeUtf8(bytes.subarray(4,start));
 if(!text.ok)return text;
 const parsed=parseStrictJson(text.value);
 if(!parsed.ok)return parsed;
 const value=parsed.value;
 if(!record(value))return failed('MALFORMED','Cabeçalho do objeto selado inválido');
 if(Object.keys(value).some(field=>!HEADER_FIELDS.includes(field)))return failed('MALFORMED','Cabeçalho do objeto selado com campo desconhecido');
 const nonceBytes=value['nonce'],cipherBytes=value['ciphertext'];
 if(value['kind']!==SEALED_KIND||value['format']!==SEALED_FORMAT)return failed('MALFORMED','Cabeçalho do objeto selado inválido');
 if(typeof value['world']!=='string'||!value['world']||typeof value['keyId']!=='string'||!value['keyId'])return failed('MALFORMED','Cabeçalho do objeto selado sem mundo ou chave');
 if(nonceBytes!==NONCE_BYTES||typeof cipherBytes!=='number'||!Number.isSafeInteger(cipherBytes)||cipherBytes<0)return failed('MALFORMED','Cabeçalho do objeto selado inválido');
 if(bytes.byteLength!==start+NONCE_BYTES+cipherBytes)return failed('MALFORMED','Objeto selado com bytes a mais ou a menos');
 if(cipherBytes>MAX_OBJECT_BYTES)return failed('LIMIT',`Objeto de ${cipherBytes} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
 return ok({kind:SEALED_KIND,format:SEALED_FORMAT,world:value['world'],keyId:value['keyId'],nonce:bytes.slice(start,start+NONCE_BYTES),ciphertext:bytes.slice(start+NONCE_BYTES)});
}
// Sealing a local object has no result channel in the contract: it transforms bytes the caller already holds, and the
// object limit belongs to whoever decides to keep them (the store, which refuses before hashing).
export async function sealObject(plain:Uint8Array,key:ObjectKey,crypto:CryptoPort):Promise<SealedObject> {
 const nonce=crypto.nonce(key.id);
 const header={kind:SEALED_KIND,format:SEALED_FORMAT,world:key.world,keyId:key.id} as const;
 return {...header,nonce,ciphertext:await crypto.seal(key,nonce,plain,sealedContext(header))};
}
// Every refusal that can be decided without touching the ciphertext is decided here, in the order that costs least: the
// shape, then the world and the key, then the limit, and only then the AEAD.
export async function openObject(sealed:SealedObject,key:ObjectKey,crypto:CryptoPort):Promise<WorldResult<Uint8Array>> {
 if(sealed.kind!==SEALED_KIND)return failed('MALFORMED','Objeto selado de tipo desconhecido');
 if(sealed.format!==SEALED_FORMAT)return failed('MALFORMED',`Formato de objeto selado desconhecido: ${String(sealed.format)}`);
 if(!sealed.world||sealed.world!==key.world)return failed('PERMISSION',`Este objeto selado pertence a ${sealed.world||'nenhum mundo'} e a chave é do mundo ${key.world}`);
 if(!sealed.keyId||sealed.keyId!==key.id)return failed('PERMISSION','A chave deste mundo foi renovada: peça uma cópia nova a quem a selou');
 if(key.bytes.byteLength!==KEY_BYTES)return failed('MALFORMED',`Uma chave de objeto precisa de ${KEY_BYTES} bytes`);
 if(sealed.nonce.byteLength!==NONCE_BYTES)return failed('MALFORMED',`Um nonce de ${SEALED_FORMAT} precisa de ${NONCE_BYTES} bytes`);
 // GCM ciphertext is the plaintext plus the tag, so the limit is provable from the length before decrypting anything.
 if(sealed.ciphertext.byteLength>MAX_OBJECT_BYTES)return failed('LIMIT',`Objeto de ${sealed.ciphertext.byteLength} bytes excede o limite de ${MAX_OBJECT_BYTES}`);
 try {
  return ok(await crypto.open(key,sealed.nonce,sealed.ciphertext,sealedContext(sealed)));
 }catch{
  return failed('SIGNATURE','O objeto selado não autentica com esta chave, este mundo e este formato');
 }
}
// The private manifest entry for one object: the address a provider holds (ciphertext) and the address of what it
// decrypts to (plaintext), plus which copies exist. The manifest carries no key, and the plaintext hash is what makes
// a copy verifiable after it comes back.
export type PrivateCopy = {
 kind:'private-copy';
 world:string;
 keyId:string;
 format:typeof SEALED_FORMAT;
 sealed:ObjectRef;
 plaintext:ObjectRef;
 stores:readonly string[];
};
export type PrivateCopyUpload = {copy:PrivateCopy;failed:readonly {store:string;error:WorldError}[]};
export type RestoredCopy = {plain:Uint8Array;store:string;plaintext:ObjectRef};
export type CopyStore = {id:string;store:ObjectStore};
export type PrivateCopies = {
 put(plain:Uint8Array):Promise<WorldResult<PrivateCopyUpload>>;
 get(copy:PrivateCopy):Promise<WorldResult<RestoredCopy>>;
};
// Writing the same sealed bytes to every configured provider is what makes two independent origins possible: the
// content address is the same everywhere, so a copy that disappears is replaced by any other without a manifest edit.
// A provider that refuses is reported by name — "copiado por 1 amigo" needs evidence, never the hope that a request
// was accepted — and when no copy was written at all the object is not stored, which is never reported as success.
export function createPrivateCopies(options:{world:string;key:ObjectKey;crypto:CryptoPort;hasher:ContentHasher;stores:readonly CopyStore[];maxBytes?:number}):PrivateCopies {
 const limit=options.maxBytes??MAX_OBJECT_BYTES;
 return {
  async put(plain) {
   if(options.key.world!==options.world)return failed('PERMISSION',`A chave é do mundo ${options.key.world} e a cópia é de ${options.world}`);
   if(options.key.bytes.byteLength!==KEY_BYTES)return failed('MALFORMED',`Uma chave de objeto precisa de ${KEY_BYTES} bytes`);
   if(plain.byteLength>limit)return failed('LIMIT',`Objeto de ${plain.byteLength} bytes excede o limite de ${limit}`);
   const sealed=await sealObject(plain,options.key,options.crypto);
   const sealedBytes=encodeSealed(sealed);
   const sealedRef=await options.hasher.ref(sealedBytes),plaintext=await options.hasher.ref(plain);
   const stores:string[]=[];
   const failures:{store:string;error:WorldError}[]=[];
   for(const candidate of options.stores){
    const written=await candidate.store.put(sealedBytes);
    if(!written.ok){failures.push({store:candidate.id,error:written.error});continue;}
    if(!sameRef(written.value,sealedRef)){failures.push({store:candidate.id,error:{code:'HASH_MISMATCH',message:`${candidate.id} guardou o objeto sob outro endereço`}});continue;}
    stores.push(candidate.id);
   }
   if(!stores.length)return failed(failures[0]?.error.code??'MISSING_OBJECT',failures[0]?.error.message??'Nenhuma cópia guardou o objeto');
   return ok({copy:{kind:'private-copy',world:options.world,keyId:options.key.id,format:SEALED_FORMAT,sealed:sealedRef,plaintext,stores},failed:failures});
  },
  async get(copy) {
   if(copy.kind!=='private-copy')return failed('MALFORMED','Cópia privada desconhecida');
   if(copy.format!==SEALED_FORMAT)return failed('MALFORMED',`Formato de cópia desconhecido: ${String(copy.format)}`);
   if(copy.world!==options.world||copy.keyId!==options.key.id)return failed('PERMISSION',`Esta cópia é de ${copy.world} com a chave ${copy.keyId}, e não deste mundo`);
   const attempts:{store:string;error:WorldError}[]=[];
   for(const id of copy.stores){
    const candidate=options.stores.find(entry=>entry.id===id);
    if(!candidate){attempts.push({store:id,error:{code:'NOT_FOUND',message:`A cópia está em ${id}, que não está configurado aqui`}});continue;}
    const read=await candidate.store.get(copy.sealed);
    if(!read.ok){attempts.push({store:id,error:read.error});continue;}
    const sealed=decodeSealed(read.value);
    if(!sealed.ok){attempts.push({store:id,error:sealed.error});continue;}
    const opened=await openObject(sealed.value,options.key,options.crypto);
    if(!opened.ok){attempts.push({store:id,error:opened.error});continue;}
    const address=await options.hasher.ref(opened.value);
    // The readable hash in the manifest is what a restored copy is checked against: a copy that decrypts to something
    // else is refused, and the next copy is tried.
    if(!sameRef(address,copy.plaintext)){attempts.push({store:id,error:{code:'HASH_MISMATCH',message:`A cópia de ${id} decifra para outro conteúdo`}});continue;}
    return ok({plain:opened.value,store:id,plaintext:address});
   }
   const summary=attempts.map(attempt=>`${attempt.store}: ${attempt.error.message}`).join(' ');
   // A refusal that is about the bytes themselves outranks plain absence: a key that does not fit or a copy that fails
   // authentication is a different answer from "no copy answered", and the caller acts on it differently.
   const refused=attempts.find(attempt=>REFUSALS.includes(attempt.error.code));
   if(refused)return failed(refused.error.code,`${refused.error.message} (${summary})`);
   return failed('MISSING_OBJECT',`Nenhuma cópia de ${copy.sealed.hash.slice(0,12)}… respondeu (${summary})`);
  },
 };
}
