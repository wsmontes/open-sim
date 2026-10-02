import {MAX_OBJECT_BYTES,failed,ok,sameRef} from '../../world/model';
import type {ContentHasher} from '../../world/ports';
import type {ObjectStore} from './direct';

// An object endpoint over plain HTTP: `GET /<hash>` and `PUT /<hash>`, the smallest service that can hold addressed
// bytes for a group. A server that does not exist yet is one file; the adapter never assumes a vendor, a bucket layout
// or any signed URL — the address in the path is the whole contract, and a response is only believed after the bytes
// are re-hashed against the address they came for.
// Every request is bounded in time: an endpoint that accepts a connection and never answers must fail this copy, not
// hang the save. A 413 and a 507 are the two answers a provider gives about capacity, and they are reported as the
// limit and the quota they are, never as a lost world.
export type HttpObjectConfig = {
 base:string;
 hasher:ContentHasher;
 fetcher?:typeof fetch;
 timeoutMs?:number;
 headers?:Readonly<Record<string,string>>;
 maxBytes?:number;
 label?:string;
};
export function createHttpObjectStore(config:HttpObjectConfig):ObjectStore {
 const fetcher=config.fetcher??fetch,limit=config.maxBytes??MAX_OBJECT_BYTES,timeoutMs=config.timeoutMs??8000;
 const label=config.label??config.base;
 async function request(path:string,init:RequestInit):Promise<Response> {
  const headers=new Headers({'accept':'application/octet-stream',...config.headers});
  new Headers(init.headers).forEach((value,name)=>headers.set(name,value));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
   return await fetcher(`${config.base}${path}`,{...init,headers,signal:controller.signal});
  } finally {
   clearTimeout(timer);
  }
 }
 const unreachable=(error:unknown)=>failed<never>('NOT_FOUND',`O provedor ${label} não respondeu (${error instanceof Error?error.message:'falha de rede'})`);
 return {
  async get(ref) {
   let response:Response;
   try { response=await request(`/${ref.hash}`,{method:'GET'}); }
   catch(error) { return unreachable(error); }
   if(response.status===404)return failed('MISSING_OBJECT',`${label} não tem o objeto ${ref.hash.slice(0,12)}…`);
   if(!response.ok)return failed('NOT_FOUND',`O provedor ${label} recusou a leitura (${response.status})`);
   const bytes=new Uint8Array(await response.arrayBuffer());
   // Bytes that do not match the address they were fetched for are refused here, before any of this reaches the game.
   if(bytes.byteLength!==ref.bytes)return failed('HASH_MISMATCH',`${label} devolveu ${bytes.byteLength} bytes onde o endereço pede ${ref.bytes}`);
   if(!sameRef(await config.hasher.ref(bytes),ref))return failed('HASH_MISMATCH',`O objeto devolvido por ${label} não corresponde ao endereço`);
   return ok(bytes);
  },
  async put(bytes) {
   if(bytes.byteLength>limit)return failed('LIMIT',`Objeto de ${bytes.byteLength} bytes excede o limite de ${limit}`);
   const ref=await config.hasher.ref(bytes);
   let response:Response;
   // A `fetch` body accepts any view; the DOM types only spell that alternative as `ArrayBufferView<ArrayBuffer>`, so
   // the view is rebuilt over the same buffer instead of copying megabytes to satisfy a type.
   const body:BodyInit=new Uint8Array(bytes.buffer as ArrayBuffer,bytes.byteOffset,bytes.byteLength);
   try { response=await request(`/${ref.hash}`,{method:'PUT',body,headers:{'content-type':'application/octet-stream'}}); }
   catch(error) { return unreachable(error); }
   if(response.status===413)return failed('LIMIT',`O provedor ${label} recusou um objeto de ${ref.bytes} bytes`);
   if(response.status===429||response.status===507)return failed('QUOTA',`O provedor ${label} não aceitou guardar este objeto agora`);
   if(!response.ok)return failed('NOT_FOUND',`O provedor ${label} recusou a escrita (${response.status})`);
   // The provider stores under the address it was given; what it actually holds is verified when the copy is read back.
   return ok(ref);
  },
 };
}
