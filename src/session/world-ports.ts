import type {Head,ObjectRef,WorldAddress,WorldResult} from '../world/model';
import {sameRef} from '../world/model';

// What the session asks a device for. The repository never keeps its own copy of an object: it hands bytes to the
// device under their content address and reads them back by that address, so a version that inherited an object
// inherits the reference and not a second copy. Publishing is one entry point on purpose — objects, the receipt of
// the accepted change and the head advance happen in a single transaction, because a head that moved over objects
// nobody stored is worse than a change that was refused.
// Reading returns null for what the device does not have and rejects when the device itself is unavailable; only
// `commit` reports a refused change (a stale head or a full device) as a result, since that is a normal outcome.
export type StoredObject = {ref:ObjectRef;bytes:Uint8Array};
// A receipt is what lets a repeated delivery answer with the result it already produced instead of applying twice.
export type ChangeReceipt = {id:string;digest:string;head:Head};
export type StorageTransaction = {
 expected:Head|null;
 next:Head;
 objects:readonly StoredObject[];
 receipt:ChangeReceipt;
};
export interface WorldStorage {
 head(address:WorldAddress):Promise<Head|null>;
 heads(worldId:string):Promise<Head[]>;
 object(ref:ObjectRef):Promise<Uint8Array|null>;
 receipt(address:WorldAddress,id:string):Promise<ChangeReceipt|null>;
 receipts(address:WorldAddress):Promise<string[]>;
 commit(transaction:StorageTransaction):Promise<WorldResult<Head>>;
}
// The comparison the devices and the repository have to agree on: a head matches an expected one by address,
// generation and commit, and "no version yet" only matches "no version yet".
export function sameHead(current:Head|null,expected:Head|null):boolean {
 if(current===null||expected===null)return current===expected;
 return current.worldId===expected.worldId&&current.branchId===expected.branchId&&current.generation===expected.generation&&sameRef(current.commit,expected.commit);
}
