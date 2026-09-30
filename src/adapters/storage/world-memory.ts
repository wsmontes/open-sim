import {failed,ok,sameRef} from '../../world/model';
import type {Head,ObjectRef,WorldAddress,WorldResult} from '../../world/model';
import type {ChangeReceipt,WorldStorage} from '../../session/world-ports';

// A device that is only a dictionary: it keeps what it was given and forgets it on reload, which is exactly what a
// test needs. It implements the same transaction contract as IndexedDB — objects, receipt and head publish together
// or not at all — so nothing in the repository can depend on a device that is being forgiving. `bytes` is the
// capacity of the device: a full device refuses the whole change, because a head that moved over objects nobody
// stored is worse than a change that never happened.
export type WorldMemoryStorage = WorldStorage & {size(): number};
export function createWorldMemoryStorage(options: {bytes?: number} = {}): WorldMemoryStorage {
 const capacity = options.bytes ?? Infinity;
 const objects = new Map<string, Uint8Array>();
 const heads = new Map<string, Map<string, Head>>();
 const receipts = new Map<string, Map<string, Map<string, ChangeReceipt>>>();
 let used = 0;
 const branchesOf = <T>(store: Map<string, Map<string, T>>, worldId: string) => {
  const found = store.get(worldId);
  return found ?? new Map<string, T>();
 };
 const sameHead = (current: Head|null, expected: Head|null) =>
  current === null || expected === null
   ? current === expected
   : current.worldId === expected.worldId && current.branchId === expected.branchId && current.generation === expected.generation && sameRef(current.commit, expected.commit);
 return {
  size: () => used,
  async head(address: WorldAddress) {
   return branchesOf(heads, address.worldId).get(address.branchId) ?? null;
  },
  async heads(worldId: string) {
   return [...branchesOf(heads, worldId).values()].sort((a, b) => a.branchId.localeCompare(b.branchId));
  },
  async object(ref: ObjectRef) {
   return objects.get(ref.hash) ?? null;
  },
  async receipt(address: WorldAddress, id: string) {
   return branchesOf(branchesOf(receipts, address.worldId), address.branchId).get(id) ?? null;
  },
  async receipts(address: WorldAddress) {
   return [...branchesOf(branchesOf(receipts, address.worldId), address.branchId).keys()].sort();
  },
  async commit(transaction): Promise<WorldResult<Head>> {
   const current = branchesOf(heads, transaction.next.worldId).get(transaction.next.branchId) ?? null;
   if (!sameHead(current, transaction.expected)) return failed('CONFLICT', `A versão de ${transaction.next.worldId}/${transaction.next.branchId} mudou`);
   // Everything is written into a staging map first: the device publishes objects, receipt and head only after the
   // whole change fits, so a failed transaction leaves the previous version untouched and nothing orphaned.
   const staged = new Map<string, Uint8Array>();
   let added = 0;
   for (const object of transaction.objects) {
    if (object.bytes.byteLength !== object.ref.bytes) return failed('MALFORMED', 'Objeto com tamanho diferente do endereço');
    if (objects.has(object.ref.hash) || staged.has(object.ref.hash)) continue;
    staged.set(object.ref.hash, object.bytes);
    added += object.bytes.byteLength;
   }
   if (used + added > capacity) return failed('QUOTA', `Não há espaço neste dispositivo para ${added} bytes`);
   for (const [hash, bytes] of staged) objects.set(hash, bytes);
   used += added;
   const worldReceipts = receipts.get(transaction.next.worldId) ?? new Map<string, Map<string, ChangeReceipt>>();
   receipts.set(transaction.next.worldId, worldReceipts);
   const branchReceipts = worldReceipts.get(transaction.next.branchId) ?? new Map<string, ChangeReceipt>();
   worldReceipts.set(transaction.next.branchId, branchReceipts);
   branchReceipts.set(transaction.receipt.id, transaction.receipt);
   const worldHeads = heads.get(transaction.next.worldId) ?? new Map<string, Head>();
   heads.set(transaction.next.worldId, worldHeads);
   worldHeads.set(transaction.next.branchId, transaction.next);
   return ok(transaction.next);
  },
 };
}
