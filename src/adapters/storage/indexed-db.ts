import {encodeSave} from '../../core/snapshot';
import type {SavedGame} from '../../core/model';
import type {SaveStore} from '../../session/ports';
const STORE = 'saves';
const DEFAULT_NAME = 'open-sim';
// A tab that dies while holding a connection, or another tab mid-upgrade, makes indexedDB.open() sit on `blocked`
// forever. Without a deadline the game freezes on a blank map with no message, which is exactly what a stalled
// `open` looked like in practice, so the open is bounded and the blocked case is reported.
const OPEN_TIMEOUT_MS = 8000;
const fail = (message: string, cause: unknown) => (cause ?? new Error(message)) as Error;
export function createIndexedDbStore(options: {name?: string; factory?: IDBFactory; timeoutMs?: number} = {}): SaveStore {
 const name = options.name ?? DEFAULT_NAME;
 const factory = options.factory ?? indexedDB;
 const timeoutMs = options.timeoutMs ?? OPEN_TIMEOUT_MS;
 let handle: Promise<IDBDatabase>|null = null;
 function connect(): Promise<IDBDatabase> {
  if (handle) return handle;
  const request = factory.open(name,1);
  const pending = new Promise<IDBDatabase>((resolve,reject)=>{
   let settled = false;
   const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    handle = null;
    reject(new Error('O armazenamento local não respondeu. Feche outras abas do jogo e recarregue a página.'));
   },timeoutMs);
   const close = () => {settled = true;clearTimeout(timer);handle = null;};
   request.onupgradeneeded = () => {const db = request.result;if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);};
   request.onsuccess = () => {
    const db = request.result;
    if (settled) {db.close();return;}
    settled = true;clearTimeout(timer);
    // Another tab upgrading the schema must not be blocked by this connection.
    db.onversionchange = () => db.close();
    resolve(db);
   };
   request.onerror = () => {if (settled) return;close();reject(fail('Falha ao abrir o armazenamento local',request.error));};
   request.onblocked = () => {if (settled) return;close();reject(new Error('O armazenamento local está bloqueado por outra aba do jogo. Feche as outras abas e recarregue a página.'));};
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
