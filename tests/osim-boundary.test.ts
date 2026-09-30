import {describe,expect,test} from 'vitest';
import type {Components} from '../src/core/model';
import {canonicalText} from '../src/adapters/codec/jcs';
import {applyEvent,checkCoreComponent,checkEnvelope,entityUri,osimTimeFrom,parseOsimUri,parseViewUri,viewUri,EXISTENCE_LEVELS,OSIM_VERSION,type OsimEvent} from '../src/world/osim';
import type {CaptureTimes} from '../src/world/reality';

const ACTOR = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
const TIME = {timeline:'osim:timeline:earth-main', time:'2026-09-29T22:33:18.402Z'};
const event = (over:Partial<OsimEvent> = {}):OsimEvent => ({type:'event', id:'osim:event:a92f', entity:'osim:entity:house-42', component:'lifesim.residence', op:'set', value:{rooms:3, note:'casa da esquina'}, actor:ACTOR, ...TIME, ...over}) as OsimEvent;

describe('the OpenSim 0.1 envelope is the boundary, and it is boring on purpose (protocol §48)',()=>{
 test('an envelope names what it is and refuses what it does not know',()=>{
  const good = checkEnvelope({osim:OSIM_VERSION, type:'event', id:'osim:event:a92f', actor:ACTOR, body:{op:'set'}});
  expect(good.ok).toBe(true);
  if (!good.ok) return;
  expect(good.value.type).toBe('event');
  // Known fields survive as they are; the envelope itself is closed, so a newer client cannot smuggle a field here.
  expect(checkEnvelope({osim:OSIM_VERSION, type:'event', id:'osim:event:a92f', actor:ACTOR, body:{}, extra:1}).ok).toBe(false);
  expect(checkEnvelope({osim:'0.2', type:'event', id:'osim:event:a92f', actor:ACTOR, body:{}}).ok).toBe(false);
  expect(checkEnvelope({osim:OSIM_VERSION, type:'dragon', id:'osim:event:a92f', actor:ACTOR, body:{}}).ok).toBe(false);
  expect(checkEnvelope({osim:OSIM_VERSION, type:'event', id:'osim:event:a92f', body:{}}).ok).toBe(false);
  // A body that is not plain JSON cannot travel: the same rule the local contract applies to a component.
  expect(checkEnvelope({osim:OSIM_VERSION, type:'event', id:'osim:event:a92f', actor:ACTOR, body:{bad:Number.NaN}}).ok).toBe(false);
  expect(checkEnvelope({osim:OSIM_VERSION, type:'event', id:'osim:event:a92f', actor:ACTOR, body:{bad:undefined}}).ok).toBe(false);
 });
 test('the kinds of the core are the ones the protocol names, and nothing else',()=>{
  for (const type of ['entity','component','event','timeline','snapshot','session','capability']) {
   expect(checkEnvelope({osim:OSIM_VERSION, type, id:`osim:${type}:x`, actor:ACTOR, body:{}}).ok).toBe(true);
  }
 });
});

describe('identifiers are URIs and a foreign URI is a first-class identifier (protocol §4)',()=>{
 test('an osim URI carries its kind and its identifier',()=>{
  expect(parseOsimUri('osim:entity:house-42')).toEqual({scheme:'osim', kind:'entity', id:'house-42'});
  expect(parseOsimUri('osim:timeline:earth-main')).toEqual({scheme:'osim', kind:'timeline', id:'earth-main'});
  expect(entityUri('house-42')).toBe('osim:entity:house-42');
  expect(parseOsimUri(entityUri('house-42'))).toEqual({scheme:'osim', kind:'entity', id:'house-42'});
 });
 test('another ecosystem keeps its own identifier instead of being rewritten',()=>{
  for (const uri of [ACTOR,'https://example.org/dataset/123','urn:uuid:1234','ipfs://bafy','nostr:npub1','sha256:6f29']) {
   expect(parseOsimUri(uri)).toEqual({scheme:'foreign', uri});
  }
 });
 test('an identifier that the local store cannot hold is refused before it becomes a URI',()=>{
  expect(()=>entityUri('')).toThrow();
  expect(()=>entityUri('a:b')).toThrow();
  expect(()=>entityUri('with space')).toThrow();
  expect(()=>entityUri('__proto__')).toThrow();
  expect(()=>entityUri('x'.repeat(81))).toThrow();
 });
});

describe('four event operations, and a client that does not understand a component still keeps it (protocol §2.3, §15)',()=>{
 const base:Components = {'lifesim.residence':{'house-42':{rooms:3, planted:'oak'}}, 'city.zoning':{'house-42':{zone:'residential'}}};
 test('set replaces one component and leaves every other namespace exactly as it was',()=>{
  const applied = applyEvent(base, event());
  expect(applied.ok).toBe(true);
  if (!applied.ok) return;
  expect(applied.value.components['lifesim.residence']!['house-42']).toEqual({rooms:3, note:'casa da esquina'});
  expect(applied.value.components['city.zoning']).toEqual(base['city.zoning']);
  expect(base['lifesim.residence']!['house-42']).toEqual({rooms:3, planted:'oak'});
 });
 test('merge keeps the fields this client does not understand',()=>{
  const applied = applyEvent(base, event({op:'merge', value:{rooms:4}}));
  expect(applied.ok).toBe(true);
  if (!applied.ok) return;
  // `planted` was written by a profile this client does not implement: it survives a merge it never asked for.
  expect(applied.value.components['lifesim.residence']!['house-42']).toEqual({rooms:4, planted:'oak'});
 });
 test('merge writes into a component that does not exist yet instead of failing',()=>{
  const applied = applyEvent(base, event({entity:'osim:entity:house-99', op:'merge', value:{rooms:1}}));
  expect(applied.ok).toBe(true);
  if (!applied.ok) return;
  expect(applied.value.components['lifesim.residence']!['house-99']).toEqual({rooms:1});
 });
 test('remove drops one component; delete tombstones the entity instead of rewriting history',()=>{
  const removed = applyEvent(base, event({op:'remove'}));
  expect(removed.ok).toBe(true);
  if (!removed.ok) return;
  expect(removed.value.components['lifesim.residence']).toBeUndefined();
  expect(removed.value.components['city.zoning']).toEqual(base['city.zoning']);
  const deleted = applyEvent(base, event({op:'delete'}));
  expect(deleted.ok).toBe(true);
  if (!deleted.ok) return;
  expect(deleted.value.components['lifesim.residence']).toBeUndefined();
  expect(deleted.value.components['city.zoning']).toBeUndefined();
  expect(deleted.value.tombstone).toEqual({entity:'osim:entity:house-42', timeline:TIME.timeline, time:TIME.time});
 });
 test('an event that breaks the rules is refused and changes nothing',()=>{
  expect(applyEvent(base, event({component:'not-a-namespace'})).ok).toBe(false);
  expect(applyEvent(base, event({entity:'__proto__'})).ok).toBe(false);
  expect(applyEvent(base, event({op:'set', value:undefined} as Partial<OsimEvent>)).ok).toBe(false);
  expect(applyEvent(base, event({op:'merge', value:{bad:Number.POSITIVE_INFINITY}})).ok).toBe(false);
  expect(applyEvent(base, event({timeline:'', time:'ontem'})).ok).toBe(false);
  expect(applyEvent(base, event({type:'dragon' as OsimEvent['type']})).ok).toBe(false);
  expect(applyEvent(base, event({actor:'sem esquema'})).ok).toBe(false);
 });
});

describe('the core component vocabulary is validated without rejecting what a newer client added (protocol §9)',()=>{
 test('osim.transform places something on a named space and keeps an unknown field',()=>{
  const transform = {space:'osim:space:earth', position:{lat:48.4284, lon:-123.3656, alt:14.2}, accuracy:5};
  const checked = checkCoreComponent('osim.transform', transform);
  expect(checked.ok).toBe(true);
  if (!checked.ok) return;
  expect(checked.value.accuracy).toBe(5);
  expect(checkCoreComponent('osim.transform', {space:'osim:space:earth', position:{lat:48.4}}).ok).toBe(false);
  expect(checkCoreComponent('osim.transform', {position:{lat:48.4, lon:-123.3}}).ok).toBe(false);
  expect(checkCoreComponent('osim.transform', {space:'osim:space:earth', position:{lat:91, lon:0}}).ok).toBe(false);
 });
 test('existence, name, bounds, relations and layer come from the protocol and nothing else',()=>{
  for (const level of EXISTENCE_LEVELS) expect(checkCoreComponent('osim.existence', {level}).ok).toBe(true);
  expect(checkCoreComponent('osim.existence', {level:'quantum'}).ok).toBe(false);
  expect(checkCoreComponent('osim.name', {default:'Johnson Street', translations:{pt:'Rua Johnson'}}).ok).toBe(true);
  expect(checkCoreComponent('osim.name', {translations:{pt:'Rua Johnson'}}).ok).toBe(false);
  expect(checkCoreComponent('osim.bounds', {shape:'sphere', radius:2.1}).ok).toBe(true);
  expect(checkCoreComponent('osim.bounds', {shape:'bbox', min:[-2.1, 0, -4.5], max:[2.1, 3.2, 4.5]}).ok).toBe(true);
  expect(checkCoreComponent('osim.bounds', {shape:'blob'}).ok).toBe(false);
  expect(checkCoreComponent('osim.relations', {inside:'osim:entity:building-32'}).ok).toBe(true);
  expect(checkCoreComponent('osim.relations', {inside:42}).ok).toBe(false);
  expect(checkCoreComponent('osim.layer', {source:'weather-provider', priority:20}).ok).toBe(true);
 });
 test('geometry and behavior are references, and a space says what its coordinates mean',()=>{
  expect(checkCoreComponent('osim.geometry', {asset:'sha256:6f29', mediaType:'model/gltf-binary'}).ok).toBe(true);
  expect(checkCoreComponent('osim.geometry', {asset:'6f29', mediaType:'model/gltf-binary'}).ok).toBe(false);
  expect(checkCoreComponent('osim.geometry', {asset:'sha256:6f29'}).ok).toBe(false);
  expect(checkCoreComponent('osim.behavior', {module:'sha256:a924', mediaType:'application/wasm', interface:'osim:door:1'}).ok).toBe(true);
  expect(checkCoreComponent('osim.behavior', {module:'sha256:a924', mediaType:'application/wasm', interface:'door'}).ok).toBe(false);
  expect(checkCoreComponent('osim.space', {referenceSystem:'EPSG:4978'}).ok).toBe(true);
  expect(checkCoreComponent('osim.space', {}).ok).toBe(false);
 });
 test('a namespace that is not the protocol is JSON and nothing more',()=>{
  expect(checkCoreComponent('lifesim.residence', {anything:{deep:[1,2,3]}}).ok).toBe(true);
  expect(checkCoreComponent('lifesim.residence', {f:()=>1}).ok).toBe(false);
  expect(checkCoreComponent('osim.unknown', {whatever:true}).ok).toBe(true);
 });
});

describe('time coordinates separate when a fact was true from when this client learned it (protocol §13)',()=>{
 test('a capture with an observation and a download keeps both meanings',()=>{
  const times:CaptureTimes = {retrievedAt:'2026-09-29T22:23:41Z', observedAt:'2026-09-29T22:20:00Z'};
  expect(osimTimeFrom('osim:timeline:earth-main', times)).toEqual({
   timeline:'osim:timeline:earth-main',
   time:'2026-09-29T22:23:41Z',
   validTime:'2026-09-29T22:20:00Z',
   observedTime:'2026-09-29T22:23:41Z',
  });
 });
 test('a represented period says so instead of pretending to be an instant',()=>{
  const times:CaptureTimes = {retrievedAt:'2026-09-29T22:23:41Z', interval:{from:'2026-01-01T00:00:00Z', to:'2026-12-31T00:00:00Z'}};
  const time = osimTimeFrom('osim:timeline:earth-main', times);
  expect(time.time).toBe('2026-09-29T22:23:41Z');
  expect(time.validTime).toBeUndefined();
  expect(time.interval).toEqual({from:'2026-01-01T00:00:00Z', to:'2026-12-31T00:00:00Z'});
  expect(time.observedTime).toBe('2026-09-29T22:23:41Z');
 });
});

describe('a view URI identifies what was asked for, not who answers (protocol §40)',()=>{
 test('a path with coordinates round-trips, and only the two known keys are accepted',()=>{
  const built = viewUri(['earth','ca','bc','victoria'], {timeline:'osim:timeline:earth-main', time:'2026-09-29T22:00:00Z'});
  expect(built).toBe('osim://earth/ca/bc/victoria?timeline=osim:timeline:earth-main&time=2026-09-29T22:00:00Z');
  expect(parseViewUri(built)).toEqual({ok:true, value:{path:['earth','ca','bc','victoria'], timeline:'osim:timeline:earth-main', time:'2026-09-29T22:00:00Z'}});
  expect(parseViewUri('osim://earth')).toEqual({ok:true, value:{path:['earth']}});
 });
 test('a view that nobody could answer is refused instead of half-read',()=>{
  expect(parseViewUri('https://earth').ok).toBe(false);
  expect(parseViewUri('osim://').ok).toBe(false);
  expect(parseViewUri('osim://earth?server=example.org').ok).toBe(false);
  expect(parseViewUri('osim://earth?time=ontem').ok).toBe(false);
  expect(parseViewUri('osim://earth?timeline=earth-main').ok).toBe(false);
 });
});

describe('the core compatibility checklist (protocol §47), as a test',()=>{
 test('this client can do the seven things a core-compatible implementation must do',()=>{
  // 1. parse the core envelope
  const envelope = checkEnvelope({osim:OSIM_VERSION, type:'event', id:'osim:event:1', actor:ACTOR, body:{kind:'event'}});
  expect(envelope.ok).toBe(true);
  // 2. identify entities
  expect(parseOsimUri('osim:entity:house-42')).toEqual({scheme:'osim', kind:'entity', id:'house-42'});
  // 3. retain unknown components
  const onlyCity:Components = {'city.zoning':{'house-42':{zone:'residential'}}};
  const received = applyEvent(onlyCity, event({component:'x.wagner.experimentalTrafficModel', value:{jam:0.4}}));
  expect(received.ok).toBe(true);
  if (!received.ok) return;
  expect(received.value.components['city.zoning']).toEqual(onlyCity['city.zoning']);
  // 4. process the four state operations
  for (const op of ['set','merge','remove','delete'] as const) expect(applyEvent(base(), event({op})).ok).toBe(true);
  // 5. identify timeline and time
  expect(applyEvent(base(), event()).ok).toBe(true);
  // 6. resolve a globally referenceable object
  expect(parseOsimUri(entityUri('house-42'))).toMatchObject({kind:'entity', id:'house-42'});
  // 7. publish and receive through a transport boundary: canonical bytes out, the same object back
  const published = canonicalText({osim:OSIM_VERSION, type:'event', id:'osim:event:1', actor:ACTOR, body:{component:'lifesim.residence'}});
  const receivedBack = checkEnvelope(JSON.parse(published));
  expect(receivedBack.ok).toBe(true);

  function base():Components {return {'lifesim.residence':{'house-42':{rooms:3}}};}
 });
});
