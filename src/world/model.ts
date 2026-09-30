// The portable world model (docs/superpowers/specs/2026-09-29-federated-world-design.md §5). Pure data: no I/O, no
// clock, no randomness, no platform. Everything here is JSON that another implementation can produce.
export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
// A content address: SHA-256 of the exact bytes, lowercase hex, with the byte length so a reader can refuse an
// object before allocating for it. Not an IPFS CID.
export type ObjectRef = {hash: string; bytes: number};
// A world and a branch are different things: a fork gets its own world, a branch stays inside one.
export type WorldAddress = {worldId: string; branchId: string};
export type Head = WorldAddress & {commit: ObjectRef; generation: number};
export type WorldErrorCode =
 | 'MALFORMED' | 'LIMIT' | 'WORLD_PROTOCOL_UNSUPPORTED' | 'WIRE_VERSION_UNSUPPORTED'
 | 'HASH_MISMATCH' | 'MISSING_OBJECT' | 'NOT_FOUND' | 'CONFLICT' | 'QUOTA' | 'SIGNATURE' | 'PERMISSION';
export type WorldError = {code: WorldErrorCode; message: string};
export type WorldResult<T> = {ok: true; value: T} | {ok: false; error: WorldError};
export const ok = <T>(value: T): WorldResult<T> => ({ok: true, value});
export const failed = <T>(code: WorldErrorCode, message: string): WorldResult<T> => ({ok: false, error: {code, message}});
// Objects travel addressed by content, and the value is what the address covers.
export type WorldObject = {ref: ObjectRef; value: JsonValue};
// What the objects are made of, so a bundle can say where its data came from and under which terms (spec R12).
export type DatasetTerm = {source: string; attribution?: string; license?: string};
export type WorldOrigin = {kind: 'legacy-save' | 'new' | 'fork'; note?: string; parent?: WorldAddress};
export type WorldDefinition = {
 worldId: string;
 branchId: string;
 origin: WorldOrigin;
 profiles: string[];
 rules: {family: string; version: number};
};
// A bundle is a self-describing file: envelope, identity, reachable objects, terms and how complete it is. A partial
// bundle lists what it is missing instead of pretending to be whole.
export type WorldBundle = {
 envelope: {worldProtocol: 2; wireVersion: 1; kind: 'bundle'};
 definition: WorldDefinition;
 head?: Head;
 objects: WorldObject[];
 terms: DatasetTerm[];
 completeness: {complete: boolean; missing: ObjectRef[]};
 extensions: Record<string, JsonValue>;
};
export const WORLD_PROTOCOL = 2, WIRE_VERSION = 1;
// Limits from the plan's global constraints, applied before parsing or hashing something hostile.
export const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_DEPTH = 32;
export const isRef = (value: unknown): value is ObjectRef => {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const ref = value as Record<string, unknown>;
 return typeof ref.hash === 'string' && /^[0-9a-f]{16,128}$/.test(ref.hash) && Number.isSafeInteger(ref.bytes) && (ref.bytes as number) >= 0;
};
export const sameRef = (a: ObjectRef, b: ObjectRef) => a.hash === b.hash && a.bytes === b.bytes;
