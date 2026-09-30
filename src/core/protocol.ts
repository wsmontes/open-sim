import type {GameState} from './model';

// The portable world contract (see docs/world-protocol.md): a manifest that identifies a world and its lineage, and
// a durable state that carries namespaced components. Nothing here touches a platform: the core only describes,
// validates and serializes, so any client (browser, desktop, another language) can implement the same contract.
export const PROTOCOL_VERSION = 1;
// Object keys sorted, no whitespace, trailing newline: the same text for the same value in any runtime. This is the
// serialization the portable contract is defined on, so it lives here and the save format builds on it.
export function canonicalJson(value: unknown): string {return canonical(value) + '\n';}
function canonical(value: unknown): string {
 if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
 if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if (typeof value === 'object') {
  const source = value as Record<string,unknown>;
  return `{${Object.keys(source).filter(k=>source[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonical(source[k])}`).join(',')}}`;
 }
 throw new Error('Valor não serializável');
}
const COMPONENT_KEY = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;
const ENTITY_ID = /^[-\w]{1,80}$/;
const RESERVED = ['__proto__', 'constructor', 'prototype'];
const MAX_NODES = 8192, MAX_DEPTH = 16;
// No namespace may contain a reserved word anywhere: `__proto__` because assigning it would rewrite a prototype, and
// `constructor`/`prototype` because reading one back would return an inherited function instead of a component.
export const isComponentKey = (key: string) => COMPONENT_KEY.test(key) && !key.split('.').some(part => RESERVED.includes(part));
export const isEntityId = (id: string) => ENTITY_ID.test(id) && !RESERVED.includes(id);

// Component payloads travel between clients that do not understand each other, so they may only carry plain JSON:
// no undefined, no non-finite numbers, no functions, and a bounded size so a hostile save cannot wedge a client.
export function assertJsonSafe(value: unknown, label: string): void {
 checkShape(value, label, 0, {nodes: 0});
}
function checkShape(value: unknown, label: string, depth: number, counter: {nodes: number}): void {
 counter.nodes += 1;
 if (counter.nodes > MAX_NODES) throw new Error(`${label} é grande demais`);
 if (depth > MAX_DEPTH) throw new Error(`${label} é profundo demais`);
 if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
 if (typeof value === 'number') {
  if (!Number.isFinite(value)) throw new Error(`${label} inválido`);
  return;
 }
 if (Array.isArray(value)) {
  for (const item of value) checkShape(item, label, depth + 1, counter);
  return;
 }
 if (typeof value !== 'object') throw new Error(`${label} inválido`);
 const source = value as Record<string, unknown>, proto = Object.getPrototypeOf(value);
 if (proto !== Object.prototype && proto !== null) throw new Error(`${label} inválido`);
 for (const key of Object.keys(source)) {
  if (RESERVED.includes(key)) throw new Error(`${label} inválido`);
  checkShape(source[key], label, depth + 1, counter);
 }
}
export const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// A profile declares which component namespaces it implements. `durable: false` marks an ephemeral namespace such as
// a live vehicle transform: it may be dropped without changing the world's durable identity.
export type ExtensionDeclaration = {key: string; version: number; durable: boolean};
export type WorldManifest = {
 protocol: 1;
 worldId: string;
 rules: {family: string; version: number};
 base: {source: string; normalizerVersion: number};
 snapshot?: {hash: string; bytes: number};
 parent?: {worldId: string; manifestHash?: string};
 authority: {kind: 'local' | 'host'; actorId?: string};
 extensions: ExtensionDeclaration[];
};
export function encodeManifest(manifest: WorldManifest): string {
 return canonicalJson(manifest);
}
export function decodeManifest(value: unknown): WorldManifest {
 if (!plain(value)) throw new Error('Manifesto inválido');
 if (value.protocol !== PROTOCOL_VERSION) throw new Error(`Versão de protocolo desconhecida: ${String(value.protocol)}`);
 if (typeof value.worldId !== 'string' || !value.worldId.length || value.worldId.length > 80) throw new Error('Mundo inválido');
 if (!plain(value.rules) || typeof value.rules.family !== 'string' || !value.rules.family.length || !Number.isSafeInteger(value.rules.version) || (value.rules.version as number) < 1) throw new Error('Regras inválidas');
 if (!plain(value.base) || typeof value.base.source !== 'string' || !value.base.source.length || value.base.normalizerVersion !== 1) throw new Error('Base inválida');
 if (!plain(value.authority) || (value.authority.kind !== 'local' && value.authority.kind !== 'host')) throw new Error('Autoridade inválida');
 if (value.authority.actorId !== undefined && !isEntityId(value.authority.actorId as string)) throw new Error('Ator da autoridade inválido');
 if (!Array.isArray(value.extensions)) throw new Error('Extensões inválidas');
 const extensions = value.extensions.map((entry: unknown, index: number) => extension(entry, `Extensão ${index + 1}`));
 const declared = extensions.map(entry => entry.key);
 if (new Set(declared).size !== declared.length) throw new Error('Extensão declarada duas vezes');
 const manifest: WorldManifest = {
  protocol: 1,
  worldId: value.worldId,
  rules: {...extras(value.rules, ['family', 'version']), family: value.rules.family, version: value.rules.version as number} as WorldManifest['rules'],
  base: {...extras(value.base, ['source', 'normalizerVersion']), source: value.base.source, normalizerVersion: 1} as WorldManifest['base'],
  authority: {...extras(value.authority, ['kind', 'actorId']), ...(value.authority.actorId === undefined ? {kind: value.authority.kind} : {kind: value.authority.kind, actorId: value.authority.actorId as string})} as WorldManifest['authority'],
  extensions,
 };
 if (value.snapshot !== undefined) manifest.snapshot = snapshotRef(value.snapshot);
 if (value.parent !== undefined) manifest.parent = parentRef(value.parent);
 return {...extras(value as Record<string, unknown>, ['protocol', 'worldId', 'rules', 'base', 'snapshot', 'parent', 'authority', 'extensions']), ...manifest};
}
function extension(value: unknown, label: string): ExtensionDeclaration {
 assertJsonSafe(value, label);
 if (!plain(value)) throw new Error(`${label}: declaração inválida`);
 if (!isComponentKey(String(value.key)) || !Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new Error(`${label}: declaração inválida`);
 if (value.durable !== undefined && typeof value.durable !== 'boolean') throw new Error(`${label}: durabilidade inválida`);
 const declaration = {key: value.key as string, version: value.version as number, durable: value.durable !== false};
 // Unknown fields survive, since another profile may have written them.
 return {...extras(value, ['key', 'version', 'durable']), ...declaration};
}
function snapshotRef(value: unknown): {hash: string; bytes: number} {
 assertJsonSafe(value, 'Snapshot');
 if (!plain(value) || typeof value.hash !== 'string' || !/^[0-9a-f]{16,128}$/.test(value.hash) || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) throw new Error('Snapshot inválido');
 return {...extras(value, ['hash', 'bytes']), hash: value.hash, bytes: value.bytes as number};
}
function parentRef(value: unknown): {worldId: string; manifestHash?: string} {
 assertJsonSafe(value, 'Mundo de origem');
 if (!plain(value) || typeof value.worldId !== 'string' || !value.worldId.length) throw new Error('Mundo de origem inválido');
 const parent: {worldId: string; manifestHash?: string} = {...extras(value, ['worldId', 'manifestHash']), worldId: value.worldId as string};
 if (value.manifestHash !== undefined) {
  if (typeof value.manifestHash !== 'string' || !/^[0-9a-f]{16,128}$/.test(value.manifestHash)) throw new Error('Hash do mundo de origem inválido');
  parent.manifestHash = value.manifestHash;
 }
 return parent;
}
function plain(value: unknown): value is Record<string, unknown> {
 return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function extras(source: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
 const kept: Record<string, unknown> = {};
 for (const key of Object.keys(source)) {
  if (known.includes(key) || RESERVED.includes(key)) continue;
  assertJsonSafe(source[key], `Campo ${key}`);
  kept[key] = cloneJson(source[key]);
 }
 return kept;
}

// The durable identity of a state: the canonical text with every ephemeral namespace removed. Two clients that agree
// on this text agree on the world, whatever transient data each one happens to hold.
export function durableJson(state: GameState, extensions: readonly ExtensionDeclaration[] = []): string {
 const ephemeral = extensions.filter(entry => !entry.durable).map(entry => entry.key);
 if (!ephemeral.length) return canonicalJson(state);
 const components: Record<string, Record<string, unknown>> = {};
 for (const key of Object.keys(state.components)) if (!ephemeral.includes(key)) components[key] = state.components[key];
 return canonicalJson({...state, components});
}
