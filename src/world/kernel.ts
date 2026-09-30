// The OpenSim kernel (docs/OpenSim-Protocol-0.1.txt §3, §39): six objects, five operations and four state
// operations, and nothing else. This is the reference implementation of the pseudocode in docs/kernel.md; a game in
// another language shares the pseudocode, not this file.
//
// Two rules shape it. Publishing is **local-first**: the state changes before the network is asked, so a relay that
// is down costs a retry and not the player's reality (§2.1). And the kernel never renders, routes, judges authority
// or knows geography — it resolves, queries, publishes, subscribes and joins; everything else is a profile.
import type {Components} from '../core/model';
import type {JsonValue,WorldError,WorldResult} from './model';
import {ok} from './model';
import {applyEvent,checkEnvelope,OSIM_VERSION,type OsimEnvelope} from './osim';

export type KernelTombstone = {timeline: string; time: string};
// The local world store (§32): components are the same namespaced map the durable save carries, so a kernel state
// can be persisted inside a world without inventing a second format.
export type KernelState = {
 components: Components;
 entities: Record<string, true>;
 objects: Record<string, JsonValue>;
 seen: Record<string, true>;
 tombstones: Record<string, KernelTombstone>;
};
// §38: what the caller is looking for. Geography is deliberately absent — the kernel has no geography — so a
// profile supplies the index that answers "what is near here".
export type KernelFilter = {
 components?: readonly string[];
 entity?: string;
 timeline?: string;
 space?: {center: readonly [number, number]; radius: number} | {space: string};
};
export type EntityIndex = (filter: KernelFilter) => readonly string[];
// An entity body carries its components as namespace -> value (§6); the local store keys them namespace -> entity ->
// value, and this is the one place that translates between the two shapes.
export type Resolved = OsimEnvelope & {components?: Record<string, unknown>};
export type PublishResult = {ok: true; status: 'applied' | 'duplicate'; value: KernelState; replication: WorldError[]} | {ok: false; status: 'rejected'; error: WorldError};
// §30: the conceptual interface every federation adapter implements. A client connects to several of these at once
// and none of them is required for the world to exist.
export interface KernelTransport {
 publish(object: OsimEnvelope): Promise<WorldResult<void>>;
 resolve(uri: string): Promise<WorldResult<OsimEnvelope | null>>;
 query(filter: KernelFilter): Promise<WorldResult<OsimEnvelope[]>>;
 subscribe(filter: KernelFilter, listener: (object: OsimEnvelope) => void): () => void;
}
export type Kernel = {
 state(): KernelState;
 resolve(uri: string): WorldResult<Resolved | null>;
 query(filter: KernelFilter, index?: EntityIndex): WorldResult<string[]>;
 publish(object: unknown): Promise<PublishResult>;
 subscribe(filter: KernelFilter, listener: (object: OsimEnvelope) => void): () => void;
 join(uri: string): Promise<WorldResult<Resolved | null>>;
};

export function emptyKernelState(): KernelState {
 return {components:{}, entities:{}, objects:{}, seen:{}, tombstones:{}};
}
const ENTITY_PREFIX = 'osim:entity:';

export function createKernel({state:initial, transports = []}: {state?: KernelState; transports?: readonly KernelTransport[]} = {}): Kernel {
 let state: KernelState = initial ?? emptyKernelState();
 const listeners: {filter: KernelFilter; listener: (object: OsimEnvelope) => void}[] = [];
 // Applying is what the local store does with an object: no network, no failure mode beyond refusal. Receiving
 // something from a transport and publishing something of our own both end here, which is why a remote event is
 // deduplicated exactly like a local one (§16).
 const apply = (object: OsimEnvelope): {status: 'applied' | 'duplicate' | 'rejected'; error?: WorldError} => {
  if (object.type === 'event') {
   if (state.seen[object.id]) return {status:'duplicate'};
   const body = object.body;
   if (!body || typeof body !== 'object' || Array.isArray(body)) return {status:'rejected', error:{code:'MALFORMED', message:'Evento sem corpo'}};
   const applied = applyEvent(state.components, {...(body as Record<string, unknown>), type:'event', id: object.id, actor: object.actor});
   if (!applied.ok) return {status:'rejected', error: applied.error};
   const entities = {...state.entities};
   if (applied.value.tombstone) {
    // §15: a deletion is a tombstone. The components go, the fact that it happened stays.
    const id = applied.value.tombstone.entity.slice(ENTITY_PREFIX.length);
    delete entities[id];
    state = {...state, components: applied.value.components, entities, seen: {...state.seen, [object.id]: true}, tombstones: {...state.tombstones, [id]: {timeline: applied.value.tombstone.timeline, time: applied.value.tombstone.time}}};
    return {status:'applied'};
   }
   for (const key of Object.keys(applied.value.components)) {
    for (const entity of Object.keys(applied.value.components[key]!)) entities[entity.slice(ENTITY_PREFIX.length)] = true;
   }
   state = {...state, components: applied.value.components, entities, seen: {...state.seen, [object.id]: true}};
   return {status:'applied'};
  }
  if (object.type === 'entity') {
   const body = object.body;
   const declared = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, JsonValue>)['components'] : undefined;
   const id = object.id.slice(ENTITY_PREFIX.length);
   const components: Components = declared && typeof declared === 'object' && !Array.isArray(declared)
    ? Object.fromEntries(Object.entries(declared as Record<string, JsonValue>).map(([key, value]) => [key, {[id]: value}]))
    : {};
   // A declaration is also the place a second entity appears: the local map gains the entity under every namespace
   // the declaration named, and nothing else is touched.
   const merged: Components = {...state.components};
   for (const key of Object.keys(components)) merged[key] = {...(merged[key] ?? {}), ...components[key]!};
   state = {...state, components: merged, entities: {...state.entities, [id]: true}, objects: {...state.objects, [object.id]: body}};
   return {status:'applied'};
  }
  // Timeline, snapshot, session and capability are objects like any other: stored, resolvable, not interpreted here.
  state = {...state, objects: {...state.objects, [object.id]: object as unknown as JsonValue}};
  if (object.type === 'component') {
   const body = object.body && typeof object.body === 'object' && !Array.isArray(object.body) ? object.body as Record<string, JsonValue> : {};
   if (typeof body['entity'] === 'string' && body['component'] !== undefined) {
    const applied = applyEvent(state.components, {type:'event', id: object.id, actor: object.actor, entity: body['entity'], component: String(body['component']), op:'set', value: body['value'] ?? null, timeline:'osim:timeline:local', time:'1970-01-01T00:00:00Z'});
    if (applied.ok) state = {...state, components: applied.value.components};
   }
  }
  return {status:'applied'};
 };
 const matches = (filter: KernelFilter, object: OsimEnvelope): boolean => {
  if (filter.entity && object.id !== filter.entity) {
   const body = object.body;
   const target = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, JsonValue>)['entity'] : undefined;
   if (target !== filter.entity) return false;
  }
  if (filter.timeline) {
   const body = object.body;
   const timeline = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, JsonValue>)['timeline'] : undefined;
   if (timeline !== undefined && timeline !== filter.timeline) return false;
  }
  if (filter.components?.length) {
   const body = object.body;
   if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
   const source = body as Record<string, JsonValue>;
   const named = object.type === 'entity' && source['components'] && typeof source['components'] === 'object'
    ? Object.keys(source['components'] as Record<string, JsonValue>)
    : typeof source['component'] === 'string' ? [source['component']] : [];
   if (!named.some(key => filter.components!.includes(key))) return false;
  }
  return true;
 };
 const notify = (object: OsimEnvelope): void => {
  for (const entry of [...listeners]) if (matches(entry.filter, object)) entry.listener(object);
 };
 const receive = (object: OsimEnvelope): void => {
  const outcome = apply(object);
  if (outcome.status === 'rejected') return;
  notify(object);
 };
 return {
  state: () => state,
  resolve(uri) {
   const stored = state.objects[uri];
   if (stored !== undefined && typeof stored === 'object' && !Array.isArray(stored) && (stored as Record<string, JsonValue>)['osim'] === OSIM_VERSION) {
    const object = stored as unknown as OsimEnvelope;
    if (object.type === 'entity') return ok({...object, components: componentsOf(state, uri.slice(ENTITY_PREFIX.length))});
    return ok(object);
   }
   if (!uri.startsWith(ENTITY_PREFIX)) return ok(null);
   const id = uri.slice(ENTITY_PREFIX.length);
   if (!state.entities[id]) return ok(null);
   // An entity that arrived only through events has no declaration; the projection is still the honest answer.
   return ok({osim: OSIM_VERSION, type:'entity', id: uri, actor:'', body:{}, components: componentsOf(state, id)});
  },
  query(filter, index) {
   const candidates = index ? [...index(filter)] : Object.keys(state.entities).map(id => `${ENTITY_PREFIX}${id}`);
   const found = candidates.filter(uri => {
    if (!uri.startsWith(ENTITY_PREFIX)) return false;
    const id = uri.slice(ENTITY_PREFIX.length);
    if (!state.entities[id]) return false;
    if (filter.entity && filter.entity !== uri) return false;
    if (!filter.components?.length) return true;
    return filter.components.some(key => state.components[key]?.[id] !== undefined);
   });
   return ok(found.sort());
  },
  async publish(object) {
   const checked = checkEnvelope(object);
   if (!checked.ok) return {ok:false, status:'rejected', error: checked.error};
   const outcome = apply(checked.value);
   if (outcome.status === 'rejected') return {ok:false, status:'rejected', error: outcome.error!};
   notify(checked.value);
   if (outcome.status === 'duplicate') return {ok:true, status:'duplicate', value: state, replication: []};
   // Replication comes after the local state changed, and a transport that refuses is reported without undoing it.
   const replication: WorldError[] = [];
   for (const transport of transports) {
    const sent = await transport.publish(checked.value);
    if (!sent.ok) replication.push(sent.error);
   }
   return {ok:true, status:'applied', value: state, replication};
  },
  subscribe(filter, listener) {
   const entry = {filter, listener};
   listeners.push(entry);
   const stopRemote = transports.map(transport => transport.subscribe(filter, receive));
   return () => {
    const index = listeners.indexOf(entry);
    if (index >= 0) listeners.splice(index, 1);
    for (const stop of stopRemote) stop();
   };
  },
  async join(uri) {
   const resolved = this.resolve(uri);
   if (!resolved.ok) return resolved;
   if (!resolved.value) {
    // Not local: the federation adapters are the ones who can answer (§30), and "nobody has it" is an answer.
    for (const transport of transports) {
     const found = await transport.resolve(uri);
     if (found.ok && found.value && found.value.type === 'session') return ok(found.value);
    }
    return ok(null);
   }
   return resolved.value.type === 'session' ? ok(resolved.value) : ok(null);
  },
 };
}

// The entity's own components, in the shape a protocol entity body uses: namespace -> value (§6).
function componentsOf(state: KernelState, id: string): Record<string, unknown> {
 const entity: Record<string, unknown> = {};
 for (const key of Object.keys(state.components)) {
  const value = state.components[key]?.[id];
  if (value !== undefined) entity[key] = value;
 }
 return entity;
}
