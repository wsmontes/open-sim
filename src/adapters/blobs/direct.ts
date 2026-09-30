import {MAX_OBJECT_BYTES,failed,ok,sameRef} from '../../world/model';
import type {ObjectRef,WorldResult} from '../../world/model';
import type {ContentHasher} from '../../world/ports';

// What the world asks a place for bytes (spec §9.1). Two calls only: hand bytes over and get them back by a verifiable
// address. The contract separates two failures that look alike and are not — the store answered that it does not have
// the object, or the store itself is unavailable — because the caller's reaction differs: try another copy, or stop
// pretending this provider is a copy. Nothing here implies a daemon: a shelf in memory, a folder, a peer that already
// handed the bytes over and a remote service all satisfy the same two calls. IPFS stays a later adapter on purpose —
// a CID is another address format and pinning is a provider capability, so it earns its place after these contracts are
// proven instead of imposing a daemon on a game that must open offline.
export interface ObjectStore {
 get(ref:ObjectRef):Promise<WorldResult<Uint8Array>>;
 put(bytes:Uint8Array):Promise<WorldResult<ObjectRef>>;
}
// Where a store that owns no protocol keeps its bytes. A map satisfies it, so a test can delete one copy and prove that
// the second one is what restores the world.
export type BlobShelf = {get(hash:string):Uint8Array|undefined;set(hash:string,bytes:Uint8Array):unknown};
// The copy the player holds without asking anyone: the bytes a peer just sent over a data channel, or the ones this
// device already keeps. It is the fallback the spec requires when every provider is down, so it is also the first copy
// a private object is written to.
export function createDirectObjectStore(options:{hasher:ContentHasher;shelf?:BlobShelf;maxBytes?:number;label?:string}):ObjectStore {
 const shelf=options.shelf??new Map<string,Uint8Array>();
 const limit=options.maxBytes??MAX_OBJECT_BYTES;
 const label=options.label??'A cópia local';
 return {
  async get(ref) {
   const bytes=shelf.get(ref.hash);
   if(!bytes)return failed('MISSING_OBJECT',`${label} não tem o objeto ${ref.hash.slice(0,12)}…`);
   if(bytes.byteLength!==ref.bytes)return failed('HASH_MISMATCH',`O objeto guardado em ${label.toLowerCase()} tem outro tamanho`);
   if(!sameRef(await options.hasher.ref(bytes),ref))return failed('HASH_MISMATCH',`O objeto guardado em ${label.toLowerCase()} não corresponde ao endereço`);
   return ok(bytes);
  },
  async put(bytes) {
   // The limit is checked before hashing: a huge object must be refused before the device spends time on it.
   if(bytes.byteLength>limit)return failed('LIMIT',`Objeto de ${bytes.byteLength} bytes excede o limite de ${limit}`);
   const ref=await options.hasher.ref(bytes);
   // The address is the content, so bytes already held under it are the same bytes and writing again changes nothing.
   if(!shelf.get(ref.hash))shelf.set(ref.hash,bytes);
   return ok(ref);
  },
 };
}
