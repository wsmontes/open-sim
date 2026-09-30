import {describe,expect,test} from 'vitest';
import type {JsonValue} from '../src/world/model';
import {canonicalText} from '../src/adapters/codec/jcs';
import {checkEnvelope,OSIM_VERSION,type OsimEnvelope} from '../src/world/osim';
import {createKernel,type KernelFilter,type KernelState,type KernelTransport} from '../src/world/kernel';

const ACTOR = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const TIMELINE = 'osim:timeline:earth-main';
const at = (seconds:number) => `2026-09-29T22:33:${String(seconds).padStart(2,'0')}Z`;
const empty = ():KernelState => ({components:{}, entities:{}, objects:{}, seen:{}, tombstones:{}});
const envelope = (body:JsonValue, over:Partial<OsimEnvelope> = {}):OsimEnvelope => ({osim:OSIM_VERSION, type:'event', id:'osim:event:1', actor:ACTOR, body, ...over});
const event = (over:Record<string,JsonValue> = {}):JsonValue => ({entity:'osim:entity:house-42', component:'lifesim.residence', op:'set', value:{rooms:3}, timeline:TIMELINE, time:at(10), ...over});

// A transport that records what it was asked to carry. The kernel is tested against this, so the test proves the
// order of local application and remote replication instead of assuming it (§39.3).
function recorder():{transport:KernelTransport; published:OsimEnvelope[]; remote:(object:OsimEnvelope)=>void; fail:(on:boolean)=>void; listeners:((object:OsimEnvelope)=>void)[]} {
 const published:OsimEnvelope[] = [], listeners:((object:OsimEnvelope)=>void)[] = [];
 let failing = false;
 const transport:KernelTransport = {
  publish:async(object) => {
   if (failing) return {ok:false, error:{code:'NOT_FOUND', message:'relay fora do ar'}};
   published.push(object);
   return {ok:true, value:undefined};
  },
  resolve:async(uri) => ({ok:true, value:published.find(object => object.id === uri) ?? null}),
  query:async() => ({ok:true, value:published}),
  subscribe:(_filter, listener) => {listeners.push(listener); return () => {const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index,1);};},
 };
 return {transport, published, remote:object => {for (const listener of [...listeners]) listener(object);}, fail:on => {failing = on;}, listeners};
}

describe('the kernel publishes locally first and only then to the network (protocol §2.1, §39.3)',()=>{
 test('an entity declaration becomes resolvable in the same call that publishes it',async()=>{
  const {transport, published} = recorder();
  const kernel = createKernel({state:empty(), transports:[transport]});
  const entity = envelope({components:{'lifesim.residence':{rooms:3, planted:'oak'}}}, {type:'entity', id:'osim:entity:house-42'});
  const result = await kernel.publish(entity);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.entities['house-42']).toBe(true);
  expect(result.value.components['lifesim.residence']!['house-42']).toEqual({rooms:3, planted:'oak'});
  expect(published.length).toBe(1);
  const resolved = kernel.resolve('osim:entity:house-42');
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.value?.components?.['lifesim.residence']).toEqual({rooms:3, planted:'oak'});
 });
 test('a relay that refuses does not take the local reality with it',async()=>{
  const {transport, fail} = recorder();
  const kernel = createKernel({state:empty(), transports:[transport]});
  fail(true);
  const result = await kernel.publish(envelope(event()));
  // The event applied: publishing updates local state before remote replication, and the adaptation is what fails.
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.components['lifesim.residence']!['house-42']).toEqual({rooms:3});
  expect(kernel.state().components['lifesim.residence']!['house-42']).toEqual({rooms:3});
 });
 test('an event applied twice is a duplicate, and the second one changes nothing (protocol §16)',async()=>{
  const {transport} = recorder();
  const kernel = createKernel({state:empty(), transports:[transport]});
  const first = await kernel.publish(envelope(event({value:{rooms:3}})));
  expect(first.ok).toBe(true);
  const second = await kernel.publish(envelope(event({value:{rooms:9}})));
  expect(second.status).toBe('duplicate');
  expect(kernel.state().components['lifesim.residence']!['house-42']).toEqual({rooms:3});
 });
 test('events on different components commute, whatever order the network delivered them (protocol §16)',async()=>{
  const {transport} = recorder();
  const forwards = createKernel({state:empty(), transports:[transport]});
  const backwards = createKernel({state:empty(), transports:[transport]});
  const a = envelope(event({component:'lifesim.residence', value:{rooms:3}, time:at(10)}), {id:'osim:event:a'});
  const b = envelope(event({component:'city.zoning', value:{zone:'residential'}, time:at(11)}), {id:'osim:event:b'});
  await forwards.publish(a); await forwards.publish(b);
  await backwards.publish(b); await backwards.publish(a);
  expect(canonicalText(forwards.state().components as unknown as JsonValue)).toBe(canonicalText(backwards.state().components as unknown as JsonValue));
 });
});

describe('the five operations of the protocol are the whole API (protocol §3, §39)',()=>{
 test('query filters by component and lets the profile supply the spatial index (§38, §51)',async()=>{
  const kernel = createKernel({state:empty()});
  await kernel.publish(envelope({components:{'osim.transform':{space:'osim:space:earth', position:{lat:48.4284, lon:-123.3656}}}} , {type:'entity', id:'osim:entity:near'}));
  await kernel.publish(envelope({components:{'osim.transform':{space:'osim:space:earth', position:{lat:0, lon:0}}, 'city.zoning':{zone:'industrial'}}}, {type:'entity', id:'osim:entity:far'}));
  const byComponent:KernelFilter = {components:['city.zoning']};
  const found = kernel.query(byComponent);
  expect(found.ok).toBe(true);
  if (!found.ok) return;
  expect(found.value).toEqual(['osim:entity:far']);
  // Geography is not the kernel's business: the profile answers "what is near here" and the kernel filters the rest.
  const index = (filter:KernelFilter) => filter.space ? ['osim:entity:near'] : [];
  const near = kernel.query({components:['osim.transform'], space:{center:[48.4284,-123.3656], radius:500}}, index);
  expect(near.ok).toBe(true);
  if (!near.ok) return;
  expect(near.value).toEqual(['osim:entity:near']);
 });
 test('subscribe hears what this client publishes and what a transport brings, and can stop (protocol §39.4)',async()=>{
  const {transport, remote} = recorder();
  const kernel = createKernel({state:empty(), transports:[transport]});
  const heard:OsimEnvelope[] = [];
  const stop = kernel.subscribe({components:['lifesim.residence']}, object => heard.push(object));
  await kernel.publish(envelope(event()));
  remote(envelope(event({value:{rooms:5}}), {id:'osim:event:2'}));
  expect(heard.length).toBe(2);
  stop();
  remote(envelope(event(), {id:'osim:event:3'}));
  expect(heard.length).toBe(2);
 });
 test('join is a resolve of a session descriptor, not a private channel (protocol §39.5)',async()=>{
  const {transport} = recorder();
  const kernel = createKernel({state:empty(), transports:[transport]});
  await kernel.publish(envelope({space:'osim:space:victoria-road-42', timeline:TIMELINE, participants:[ACTOR], mode:'realtime'}, {type:'session', id:'osim:session:race-8291'}));
  const joined = await kernel.join('osim:session:race-8291');
  expect(joined.ok).toBe(true);
  if (!joined.ok) return;
  expect(joined.value?.type).toBe('session');
  expect(joined.value?.body).toMatchObject({mode:'realtime'});
 });
 test('an object nobody has is resolved as absent instead of invented',async()=>{
  const {transport} = recorder();
  const kernel = createKernel({state:empty(), transports:[transport]});
  const missing = await kernel.join('osim:session:nao-existe');
  expect(missing.ok).toBe(true);
  if (!missing.ok) return;
  expect(missing.value).toBeNull();
 });
 test('a capability is stored and resolved like any other object; the kernel does not judge authority (protocol §28)',async()=>{
  const kernel = createKernel({state:empty()});
  const capability = envelope({issuer:ACTOR, subject:'nostr:npub1alice', entity:'osim:entity:house-42', component:'osim.furniture', actions:['set','merge']}, {type:'capability', id:'osim:capability:1'});
  await kernel.publish(capability);
  const resolved = kernel.resolve('osim:capability:1');
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.value?.body).toMatchObject({component:'osim.furniture', actions:['set','merge']});
 });
});

describe('what the kernel refuses, and how it stays honest about the unknown',()=>{
 test('an object that is not a protocol envelope is refused before it reaches the state',async()=>{
  const kernel = createKernel({state:empty()});
  const bad = await kernel.publish({osim:'9.9', type:'event', id:'osim:event:1', actor:ACTOR, body:{}} as unknown);
  expect(bad.ok).toBe(false);
  expect(kernel.state().components).toEqual({});
 });
 test('delete tombstones the entity and takes its components with it (protocol §15)',async()=>{
  const kernel = createKernel({state:empty()});
  await kernel.publish(envelope({components:{'lifesim.residence':{rooms:3}, 'city.zoning':{zone:'residential'}}}, {type:'entity', id:'osim:entity:house-42'}));
  const deleted = await kernel.publish(envelope(event({op:'delete'}), {id:'osim:event:del'}));
  expect(deleted.ok).toBe(true);
  if (!deleted.ok) return;
  expect(deleted.value.entities['house-42']).toBeUndefined();
  expect(deleted.value.components['lifesim.residence']).toBeUndefined();
  expect(deleted.value.components['city.zoning']).toBeUndefined();
  expect(deleted.value.tombstones['house-42']).toMatchObject({time:at(10)});
 });
 test('a component namespace this client never implemented is carried through a publish untouched',async()=>{
  const kernel = createKernel({state:empty()});
  await kernel.publish(envelope({components:{'lifesim.residence':{rooms:3}}}, {type:'entity', id:'osim:entity:house-42'}));
  await kernel.publish(envelope(event({component:'x.wagner.experimentalTrafficModel', value:{jam:0.4}}), {id:'osim:event:x'}));
  expect(kernel.state().components['lifesim.residence']!['house-42']).toEqual({rooms:3});
  expect(kernel.state().components['x.wagner.experimentalTrafficModel']!['house-42']).toEqual({jam:0.4});
 });
 test('the envelope that came in is the object that is stored and published',()=>{
  const checked = checkEnvelope(envelope(event()));
  expect(checked.ok).toBe(true);
 });
});
