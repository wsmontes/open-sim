import {MAX_OBJECT_BYTES,failed,ok,sameRef} from '../../world/model';
import type {ObjectRef,WorldResult} from '../../world/model';
import type {ContentHasher} from '../../world/ports';
import type {ObjectStore} from './direct';

// Blossom: blobs addressed by SHA-256 over a small HTTP surface — `GET`/`HEAD /<sha256>` and an upload endpoint that
// wants an `Authorization` value the caller signs (BUD-02, which newer servers also expose as `/media`). This port is
// deliberately thin: it does not sign, does not hold a key and does not decide who may read. The caller that owns the
// session key supplies the header, and no key ever enters a content address or a reference a provider can see.
// `HEAD` answers existence without downloading a checkpoint, which is how a group learns that a copy exists without
// pretending a sent message was a stored copy.
const UPLOAD_PATH='/upload';
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export type BlossomStore = ObjectStore & {has(ref:ObjectRef):Promise<WorldResult<boolean>>};
export type BlossomConfig = {
 server:string;
 hasher:ContentHasher;
 authorize:(ref:ObjectRef)=>Promise<string>|string;
 fetcher?:typeof fetch;
 timeoutMs?:number;
 uploadPath?:string;
 maxBytes?:number;
 label?:string;
};
export function createBlossomObjectStore(config:BlossomConfig):BlossomStore {
 const fetcher=config.fetcher??fetch,limit=config.maxBytes??MAX_OBJECT_BYTES,timeoutMs=config.timeoutMs??8000;
 const uploadPath=config.uploadPath??UPLOAD_PATH,label=config.label??config.server;
 async function request(path:string,init:RequestInit):Promise<Response> {
  const headers=new Headers(init.headers);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
   return await fetcher(`${config.server}${path}`,{...init,headers,signal:controller.signal});
  } finally {
   clearTimeout(timer);
  }
 }
 const unreachable=(error:unknown)=>failed<never>('NOT_FOUND',`O servidor Blossom ${label} não respondeu (${error instanceof Error?error.message:'falha de rede'})`);
 return {
  async get(ref) {
   let response:Response;
   try { response=await request(`/${ref.hash}`,{method:'GET'}); }
   catch(error) { return unreachable(error); }
   if(response.status===404)return failed('MISSING_OBJECT',`${label} não tem o objeto ${ref.hash.slice(0,12)}…`);
   if(!response.ok)return failed('NOT_FOUND',`O servidor Blossom ${label} recusou a leitura (${response.status})`);
   const bytes=new Uint8Array(await response.arrayBuffer());
   if(bytes.byteLength!==ref.bytes)return failed('HASH_MISMATCH',`${label} devolveu ${bytes.byteLength} bytes onde o endereço pede ${ref.bytes}`);
   if(!sameRef(await config.hasher.ref(bytes),ref))return failed('HASH_MISMATCH',`O objeto devolvido por ${label} não corresponde ao endereço`);
   return ok(bytes);
  },
  async has(ref) {
   let response:Response;
   try { response=await request(`/${ref.hash}`,{method:'HEAD'}); }
   catch(error) { return unreachable(error); }
   if(response.status===200)return ok(true);
   if(response.status===404)return ok(false);
   return failed('NOT_FOUND',`O servidor Blossom ${label} não confirmou a existência do objeto (${response.status})`);
  },
  async put(bytes) {
   if(bytes.byteLength>limit)return failed('LIMIT',`Objeto de ${bytes.byteLength} bytes excede o limite de ${limit}`);
   const ref=await config.hasher.ref(bytes);
   // Without an authorization value the request is not even made: a server that needs a signature gets none from here,
   // and the copy is reported as refused instead of silently absent.
   let authorization:string;
   try { authorization=await config.authorize(ref); }
   catch(error) { return failed('PERMISSION',`Sem autorização para enviar a ${label} (${error instanceof Error?error.message:'sem assinador'})`); }
   if(!authorization)return failed('PERMISSION',`Sem autorização para enviar a ${label}`);
   let response:Response;
   try { response=await request(uploadPath,{method:'PUT',body:bytes,headers:{'content-type':'application/octet-stream',authorization}}); }
   catch(error) { return unreachable(error); }
   if(response.status===401||response.status===403)return failed('PERMISSION',`${label} recusou a autorização do envio`);
   if(response.status===413)return failed('LIMIT',`O servidor Blossom ${label} recusou um objeto de ${ref.bytes} bytes`);
   if(response.status===402||response.status===507)return failed('QUOTA',`O servidor Blossom ${label} não aceitou guardar este objeto`);
   if(!response.ok)return failed('NOT_FOUND',`O servidor Blossom ${label} recusou a escrita (${response.status})`);
   // The server names the address it kept. A server that answers another one did not store what was sent, and a copy
   // that cannot be found again by this address is worse than a refused upload.
   let answer:unknown=null;
   try { answer=await response.json(); } catch { answer=null; }
   const named=record(answer)?answer['sha256']:undefined,kept=record(answer)?answer['size']:undefined;
   if(typeof named==='string'&&named!==ref.hash)return failed('HASH_MISMATCH',`${label} guardou o objeto sob outro endereço`);
   if(typeof kept==='number'&&kept!==ref.bytes)return failed('HASH_MISMATCH',`${label} guardou um objeto de outro tamanho`);
   return ok(ref);
  },
 };
}
