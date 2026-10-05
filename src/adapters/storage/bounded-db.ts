// Opening an IndexedDB database the way every store of this game needs it: once, lazily, and with a deadline.
//
// A tab that dies while holding a connection, or another tab mid-upgrade, makes indexedDB.open() sit on `blocked`
// forever. Without a deadline the game freezes on a blank map with no message, which is exactly what a stalled `open`
// looked like in practice, so the open is bounded and the blocked case is reported. A failed open is forgotten, so the
// next call tries again instead of replaying the old failure.
export const OPEN_TIMEOUT_MS = 8000;

export const failure = (message: string, cause: unknown): Error => (cause ?? new Error(message)) as Error;

export type BoundedDb = {
 name: string;
 stores: readonly string[];
 factory: IDBFactory;
 timeoutMs?: number;
 upgrade?: (db: IDBDatabase) => void;
 // How the player is told which storage is in trouble: "O armazenamento local", "O armazenamento das versões".
 subject: string;
};

export function boundedDb(options: BoundedDb): () => Promise<IDBDatabase> {
 const {name, stores, factory, timeoutMs = OPEN_TIMEOUT_MS, subject} = options;
 let handle: Promise<IDBDatabase> | null = null;
 return () => {
  if (handle) return handle;
  let request: IDBOpenDBRequest;
  try { request = factory.open(name, 1); } catch(error) { return Promise.reject(error); }
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
   let settled = false;
   const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    handle = null;
    reject(new Error(`${subject} não respondeu. Feche outras abas do jogo e recarregue a página.`));
   }, timeoutMs);
   const close = () => { settled = true; clearTimeout(timer); handle = null; };
   request.onupgradeneeded = () => {
    if(options.upgrade){options.upgrade(request.result);return;}
    const db = request.result;
    for (const store of stores) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
   };
   request.onsuccess = () => {
    const db = request.result;
    if (settled) { db.close(); return; }
    settled = true;
    clearTimeout(timer);
    // Another tab upgrading the schema must not be blocked by this connection.
    db.onversionchange = () => { db.close(); handle = null; };
    resolve(db);
   };
   request.onerror = () => {
    if (settled) return;
    close();
    reject(failure(`Falha ao abrir ${subject.replace(/^O /, 'o ')}`, request.error));
   };
   request.onblocked = () => {
    if (settled) return;
    close();
    reject(new Error(`${subject} está bloqueado por outra aba do jogo. Feche as outras abas e recarregue a página.`));
   };
  });
  handle = pending;
  return pending;
 };
}
