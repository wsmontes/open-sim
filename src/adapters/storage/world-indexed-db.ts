import {failed,ok} from '../../world/model';
import type {Head,ObjectRef,WorldAddress,WorldResult} from '../../world/model';
import {sameHead} from '../../session/world-ports';
import type {ChangeReceipt,WorldStorage} from '../../session/world-ports';
import {OPEN_TIMEOUT_MS,boundedDb,failure as fail} from './bounded-db';

// The durable device of the browser. Objects, the receipt of the accepted change and the head advance are written in
// one IndexedDB transaction over three stores, so a crash, a full disk or another tab upgrading the schema leaves the
// previous version exactly as it was: a head that moved over objects nobody stored would be worse than no save.
// Objects are keyed by their content address and the heads and receipts by the world, the branch and the change, so a
// branch that inherits an object rewrites nothing.
const OBJECTS='world-objects',HEADS='world-heads',RECEIPTS='world-receipts';
const DEFAULT_NAME='open-sim-world';
export function createIndexedDbWorldStorage(options:{name?:string;factory?:IDBFactory;timeoutMs?:number}={}):WorldStorage {
 const connect=boundedDb({
  name:options.name??DEFAULT_NAME,
  stores:[OBJECTS,HEADS,RECEIPTS],
  factory:options.factory??indexedDB,
  timeoutMs:options.timeoutMs??OPEN_TIMEOUT_MS,
  subject:'O armazenamento das versões',
 });
 function read<T>(store:string,key:IDBValidKey):Promise<T|undefined> {
  return connect().then(db=>new Promise<T|undefined>((resolve,reject)=>{
   const request=db.transaction(store,'readonly').objectStore(store).get(key);
   request.onsuccess=()=>resolve(request.result as T|undefined);
   request.onerror=()=>reject(fail('Falha ao ler o mundo guardado',request.error));
  }));
 }
 function readAll<T>(store:string):Promise<T[]> {
  return connect().then(db=>new Promise<T[]>((resolve,reject)=>{
   const request=db.transaction(store,'readonly').objectStore(store).getAll();
   request.onsuccess=()=>resolve(request.result as T[]);
   request.onerror=()=>reject(fail('Falha ao ler as versões guardadas',request.error));
  }));
 }
 return {
  async head(address:WorldAddress) {
   const stored=await read<Head>(HEADS,[address.worldId,address.branchId]);
   return stored??null;
  },
  async heads(worldId:string) {
   const stored=await readAll<Head>(HEADS);
   return stored.filter(head=>head.worldId===worldId).sort((a,b)=>a.branchId.localeCompare(b.branchId));
  },
  async object(ref:ObjectRef) {
   const stored=await read<Uint8Array>(OBJECTS,ref.hash);
   return stored??null;
  },
  async receipt(address:WorldAddress,id:string) {
   return (await read<ChangeReceipt>(RECEIPTS,[address.worldId,address.branchId,id]))??null;
  },
  async receipts(address:WorldAddress) {
   const stored=await readAll<ChangeReceipt>(RECEIPTS);
   return stored.filter(receipt=>receipt.head.worldId===address.worldId&&receipt.head.branchId===address.branchId).map(receipt=>receipt.id).sort();
  },
  async commit(transaction):Promise<WorldResult<Head>> {
   for(const object of transaction.objects)if(object.bytes.byteLength!==object.ref.bytes)return failed('MALFORMED','Objeto com tamanho diferente do endereço');
   const db=await connect();
   return new Promise<WorldResult<Head>>((resolve,reject)=>{
    const tx=db.transaction([OBJECTS,HEADS,RECEIPTS],'readwrite');
    const objects=tx.objectStore(OBJECTS),heads=tx.objectStore(HEADS),receipts=tx.objectStore(RECEIPTS);
    const key:IDBValidKey=[transaction.next.worldId,transaction.next.branchId];
    let conflict=false;
    const current=heads.get(key);
    current.onsuccess=()=>{
     const held=(current.result as Head|undefined)??null;
     // The expected head is compared inside the transaction that publishes the new one, so two writers cannot both
     // believe they moved the branch.
     if(!sameHead(held,transaction.expected)){conflict=true;tx.abort();return;}
     for(const object of transaction.objects)objects.put(object.bytes,object.ref.hash);
     receipts.put(transaction.receipt,[transaction.next.worldId,transaction.next.branchId,transaction.receipt.id]);
     heads.put(transaction.next,key);
    };
    current.onerror=()=>tx.abort();
    tx.oncomplete=()=>resolve(ok(transaction.next));
    tx.onabort=()=>{
     const reason=tx.error?.message;
     resolve(conflict
      ?failed('CONFLICT',`A versão de ${transaction.next.worldId}/${transaction.next.branchId} mudou`)
      :failed('QUOTA',`O dispositivo recusou guardar esta versão${reason?`: ${reason}`:''}`));
    };
   });
  },
 };
}
