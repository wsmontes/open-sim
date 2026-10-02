import {encodeSave} from '../../core/snapshot';
import type {SavedGame} from '../../core/model';
import type {SaveStore} from '../../session/ports';
import {OPEN_TIMEOUT_MS,boundedDb,failure as fail} from './bounded-db';
const STORE = 'saves';
const DEFAULT_NAME = 'open-sim';
export function createIndexedDbStore(options: {name?: string; factory?: IDBFactory; timeoutMs?: number} = {}): SaveStore {
 const connect = boundedDb({
  name: options.name ?? DEFAULT_NAME,
  stores: [STORE],
  factory: options.factory ?? indexedDB,
  timeoutMs: options.timeoutMs ?? OPEN_TIMEOUT_MS,
  subject: 'O armazenamento local',
 });
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
