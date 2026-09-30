import {encodeSave} from '../../core/snapshot';
import type {SavedGame} from '../../core/model';
import type {SaveStore} from '../../session/ports';
const STORE = 'saves';
const DEFAULT_NAME = 'open-sim';
const fail = (message: string, cause: unknown) => (cause ?? new Error(message)) as Error;
export function createIndexedDbStore(options: {name?: string; slot?: string} = {}): SaveStore {
 const name = options.name ?? DEFAULT_NAME;
 let handle: Promise<IDBDatabase>|null = null;
 function connect(): Promise<IDBDatabase> {
  if (handle) return handle;
  const request = indexedDB.open(name,1);
  const pending = new Promise<IDBDatabase>((resolve,reject)=>{
   request.onupgradeneeded = () => {const db = request.result;if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);};
   request.onsuccess = () => resolve(request.result);
   request.onerror = () => {handle = null;reject(fail('Falha ao abrir o armazenamento local',request.error));};
  });
  handle = pending;
  return pending;
 }
 return {
  async read(slot: string) {
   const db = await connect();
   return new Promise<unknown|null>((resolve,reject)=>{
    const request = db.transaction(STORE,'readonly').objectStore(STORE).get(slot);
    request.onsuccess = () => {
     const raw = request.result as unknown;
     if (raw === undefined || raw === null) {resolve(null);return;}
     if (typeof raw !== 'string') {resolve(raw);return;}
     try {resolve(JSON.parse(raw) as unknown);} catch {resolve(raw);}
    };
    request.onerror = () => reject(fail('Falha ao ler o save',request.error));
   });
  },
  async write(slot: string, data: SavedGame) {
   const db = await connect();
   await new Promise<void>((resolve,reject)=>{
    const transaction = db.transaction(STORE,'readwrite');
    transaction.objectStore(STORE).put(encodeSave(data),slot);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(fail('Falha ao gravar o save',transaction.error));
    transaction.onabort = () => reject(fail('Falha ao gravar o save',transaction.error));
   });
  },
 };
}
