// @vitest-environment jsdom
// Recorded external inputs (plan Task 15): a file that was captured once is replayed without a network, the instant a
// fact was true is never the instant this client downloaded it (protocol §13), and an observation that arrives late
// never rewrites a tick that already ran. The fixture is a synthetic file and says so in its own provenance.
import {expect,test} from 'vitest';
import {readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {OBSERVATION_FILE_FORMAT,readObservationFile} from '../src/adapters/reality/observation-file';
import type {RecordedObservations} from '../src/adapters/reality/observation-file';
import {createSourceInspector,describeExternalInput} from '../src/presentation/source-inspector';
import {applyCommand,createGame} from '../src/core/commands';
import type {GameState} from '../src/core/model';
import {createKernel} from '../src/world/kernel';
import {MAX_OBJECT_BYTES} from '../src/world/model';
import type {ExternalInput,ObservationPolicy,RawObservation} from '../src/world/observations';
import {OBSERVATION_KEY,applyExternalInput,normalizeObservation,observationComponent,observationEntity} from '../src/world/observations';
import {blank,command} from './fixtures/world';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const bytes=new Uint8Array(readFileSync(join(ROOT,'tests/fixtures/federated-world/weather-observations.json')));
const WORLD='fixture-world';
const POLICY:ObservationPolicy={version:2,timeline:'osim:timeline:earth-main',effectTick:2,units:['mm','mm/h'],missing:'hold',holdTicks:3};
const policyFor=(over:Partial<ObservationPolicy>={}):ObservationPolicy=>({...POLICY,...over});
const observation=(over:Partial<RawObservation>={}):RawObservation=>({
 id:'centro-0900',
 source:{id:'fixture-weather-v1',dataset:'Fixture sintética de observações (não é clima real)',url:'https://example.invalid/fixture/weather-observations.json',providerRevision:'2026-09-29T09:00:00Z'},
 times:{retrievedAt:'2026-09-29T09:05:00Z',observedAt:'2026-09-29T09:00:00Z'},
 kind:'observed',
 unit:'mm',
 values:{station:'centro',rain:12.5},
 ...over,
});
const normalize=(raw:RawObservation,policy:ObservationPolicy):ExternalInput=>{
 const result=normalizeObservation(raw,policy);
 if(!result.ok)throw new Error(`normalização recusada: ${result.error.message}`);
 return result.value;
};
const refusal=(raw:RawObservation,policy:ObservationPolicy)=>{
 const result=normalizeObservation(raw,policy);
 expect(result.ok,'esperava recusa na normalização').toBe(false);
 if(result.ok)throw new Error('sem recusa');
 return result.error;
};
const recorded=():RecordedObservations=>{
 const result=readObservationFile(bytes);
 if(!result.ok)throw new Error(`arquivo recusado: ${result.error.message}`);
 return result.value;
};
const tick=(state:GameState):GameState=>{
 const result=applyCommand(state,command(state,{type:'tick'}),[]);
 if(result.status!=='applied')throw new Error(`tick recusado: ${result.reason}`);
 return result.state;
};
// One run of three recorded observations, applied in the order they were learned and interleaved with the ticks the
// game itself owns. Nothing here reads a clock or asks a service.
function run():{state:GameState;inputs:ExternalInput[]}{
 const file=recorded();
 let state=createGame(WORLD,7,blank());
 const inputs=file.observations.map((raw,index)=>normalize(raw,policyFor({effectTick:2+2*index})));
 for(const input of inputs){
  while(state.tick<input.effectTick)state=tick(state);
  const applied=applyExternalInput(state,input);
  expect(applied.status,'entrada recusada no próprio tick').toBe('applied');
  state=applied.state;
 }
 return {state,inputs};
}

test('a recorded file declares its provenance and its unit, and no network is needed to read it',()=>{
 const file=recorded();
 expect(OBSERVATION_FILE_FORMAT).toBe('opensim-observations-v1');
 expect(file.source).toEqual({id:'fixture-weather-v1',dataset:'Fixture sintética de observações (não é clima real)',url:'https://example.invalid/fixture/weather-observations.json',providerRevision:'2026-09-29T09:00:00Z'});
 expect(file.terms).toEqual({attribution:'Fixture sintética de observações',license:'CC0-1.0'});
 // the file is the synthetic fixture it says it is: neither the provenance nor the payload is a real observation
 expect(file.source.dataset).toContain('Fixture sintética');
 expect(file.observations.map(entry=>entry.id)).toEqual(['centro-0900','norte-1000','centro-1200']);
 expect(file.observations[1]!.values).toBeNull();
 expect(file.observations[2]!.kind).toBe('forecast');
 // a file this client reads is a closed registry, and a missing value is not the same as a missing field
 const unknown=readObservationFile(new TextEncoder().encode('{"format":"opensim-observations-v1","source":{},"observations":[],"future":true}'));
 expect(unknown).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const duplicated=readObservationFile(new TextEncoder().encode('{"format":"opensim-observations-v1","source":{"id":"x","dataset":"y","url":"https://example.invalid/y"},"observations":[{"id":"a","kind":"observed","unit":"mm","times":{"retrievedAt":"2026-09-29T09:05:00Z"},"values":1},{"id":"a","kind":"observed","unit":"mm","times":{"retrievedAt":"2026-09-29T09:06:00Z"},"values":2}]}'));
 expect(duplicated).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const badTime=readObservationFile(new TextEncoder().encode('{"format":"opensim-observations-v1","source":{"id":"x","dataset":"y","url":"https://example.invalid/y"},"observations":[{"id":"a","kind":"observed","unit":"mm","times":{"retrievedAt":"ontem"},"values":1}]}'));
 expect(badTime).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 expect(readObservationFile(new TextEncoder().encode('{oops'))).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 // a recorded file is bounded before its text is decoded, the same way a world object is
 expect(readObservationFile(new Uint8Array(MAX_OBJECT_BYTES+1))).toMatchObject({ok:false,error:{code:'LIMIT'}});
});

test('the download instant never becomes the instant a fact was true (protocol §13)',()=>{
 const input=normalize(observation(),policyFor());
 // `time` is when this record was written, `observedTime` is when this client learned it, and `validTime` is claimed
 // only because the source named the instant the rain fell
 expect(input.time).toEqual({
  timeline:'osim:timeline:earth-main',
  time:'2026-09-29T09:05:00Z',
  observedTime:'2026-09-29T09:05:00Z',
  validTime:'2026-09-29T09:00:00Z',
 });
 expect(input.effectTick).toBe(2);
 expect(input.method).toBe('reported');
 expect(input.kind).toBe('observed');
 expect(input.payload).toEqual({station:'centro',rain:12.5});
 expect(input.absence).toBeNull();
 // a source that named a period keeps a period instead of being squeezed into an instant
 const ranged=normalize(observation({times:{retrievedAt:'2026-09-29T09:05:00Z',interval:{from:'2026-09-29T08:00:00Z',to:'2026-09-29T09:00:00Z'}}}),policyFor());
 expect(ranged.time.interval).toEqual({from:'2026-09-29T08:00:00Z',to:'2026-09-29T09:00:00Z'});
 expect('validTime' in ranged.time).toBe(false);
 const both={observedAt:'2026-09-29T09:00:00Z',interval:{from:'2026-09-29T08:00:00Z',to:'2026-09-29T09:00:00Z'}};
 expect(refusal(observation({times:{retrievedAt:'2026-09-29T09:05:00Z',...both}}),policyFor()).code).toBe('MALFORMED');
 expect(refusal(observation({times:{retrievedAt:'ontem'}}),policyFor()).code).toBe('MALFORMED');
 expect(refusal(observation({times:{retrievedAt:'2026-09-29T09:05:00Z',publishedAt:'2026-13-45T00:00:00Z'}}),policyFor()).code).toBe('MALFORMED');
 // the timeline is a temporal frame with a scheme, and the policy itself is declared, not improvised
 expect(refusal(observation(),policyFor({timeline:'earth-main'})).message).toContain('linha do tempo');
 expect(refusal(observation(),policyFor({units:[]})).message).toContain('unidades');
 expect(refusal(observation(),policyFor({version:0})).message).toContain('política');
 expect(refusal(observation(),policyFor({effectTick:-1})).message).toContain('tick');
});

test('a unit nobody declared is refused, and an absent value follows the policy instead of being invented',()=>{
 const wrong=refusal(observation({unit:'polegadas'}),policyFor());
 expect(wrong.code).toBe('MALFORMED');
 expect(wrong.message).toContain('polegadas');
 expect(wrong.message).toContain('mm');
 // the profile declared what it does about a source that reported nothing: hold the last value, for how long
 const held=normalize(observation({values:null}),policyFor({missing:'hold',effectTick:4}));
 expect(held.payload).toBeNull();
 expect(held.absence).toEqual({mode:'hold',policy:2,holdTicks:3});
 const paused=normalize(observation({values:null}),policyFor({missing:'pause'}));
 expect(paused.absence).toEqual({mode:'pause',policy:2});
 expect(paused.payload).toBeNull();
 // a scenario value is fiction and travels as fiction, never as a measurement
 const scenario=normalize(observation({values:null}),policyFor({missing:'scenario',scenario:{rain:0}}));
 expect(scenario.payload).toEqual({rain:0});
 expect(scenario.method).toBe('simulated');
 expect(scenario.absence).toEqual({mode:'scenario',policy:2});
 // and a scenario policy with no declared value cannot fill the hole either
 expect(refusal(observation({values:null}),policyFor({missing:'scenario'})).message).toContain('cenário');
});

test('the recorded run replays without a network and an input that arrives late changes nothing',()=>{
 const original=run();
 // the same recorded bytes, the same policy and the same order of operations: the same durable state, with no service
 // consulted during any tick
 const replay=run();
 expect(replay.state).toEqual(original.state);
 expect(replay.inputs).toEqual(original.inputs);
 expect(original.state.tick).toBe(6);
 expect(original.state.money).toBe(20000);
 const [first]=original.inputs;
 expect(first!.effectTick).toBe(2);
 // the run learned about these observations in the order it applied them, and each one named its own tick
 expect(original.inputs.map(input=>input.id)).toEqual([
  'observation-fixture_2d_weather_2d_v1-centro_2d_0900',
  'observation-fixture_2d_weather_2d_v1-norte_2d_1000',
  'observation-fixture_2d_weather_2d_v1-centro_2d_1200',
 ]);
 const stored=original.state.components[OBSERVATION_KEY]![first!.id]!;
 expect(stored).toEqual(observationComponent(first!));
 expect((stored as {time:{validTime:string}}).time.validTime).toBe('2026-09-29T09:00:00Z');
 // an observation for tick 2 that this run had never seen arrives when the game is at tick 6: it is refused, and the
 // refusal is not a rewrite — the state is the very object it was, down to `revision` and `actors`
 const late=applyExternalInput(original.state,normalize(observation({id:'sul-0100'}),policyFor({effectTick:2})));
 expect(late.status).toBe('rejected');
 expect(late.reason).toContain('tick 2');
 expect(late.state).toBe(original.state);
 // the one it did record is a repeat, not a late arrival, and a repeat costs nothing
 const repeated=applyExternalInput(original.state,first!);
 expect(repeated).toMatchObject({status:'duplicate',state:original.state});
 const other=applyExternalInput(original.state,normalize(observation({id:'sul-0800'}),policyFor({effectTick:6})));
 expect(other.status).toBe('applied');
 expect(other.state.revision).toBe(original.state.revision+1);
 expect(other.state.tick).toBe(original.state.tick);
 expect(other.state.money).toBe(original.state.money);
});

test('a corrected forecast is an entry of its own and never rewrites a tick that already ran',()=>{
 const forecast=normalize(observation({id:'centro-1200',kind:'forecast',values:{station:'centro',rain:2}}),policyFor({effectTick:12}));
 let state=createGame(WORLD,7,blank());
 while(state.tick<8)state=tick(state);
 const applied=applyExternalInput(state,forecast);
 expect(applied.status).toBe('applied');
 state=applied.state;
 while(state.tick<14)state=tick(state);
 const correction=normalize(observation({id:'centro-1200-r1',supersedes:'centro-1200',kind:'forecast',values:{station:'centro',rain:9},times:{retrievedAt:'2026-09-29T12:30:00Z',observedAt:'2026-09-29T12:00:00Z'}}),policyFor({effectTick:12}));
 // the correction names the forecast it replaces, and it is refused where it would rewrite a completed tick
 expect(correction.supersedes).toBe(forecast.id);
 const rewrite=applyExternalInput(state,correction);
 expect(rewrite).toMatchObject({status:'rejected',state});
 expect(rewrite.reason).toContain('tick 12');
 expect(state.components[OBSERVATION_KEY]![forecast.id]).toEqual(observationComponent(forecast));
 // a correction about a tick that has not run yet is recorded, with the forecast it supersedes
 const later=normalize(observation({id:'centro-1500',supersedes:'centro-1200',kind:'forecast',values:{station:'centro',rain:4}}),policyFor({effectTick:20}));
 const accepted=applyExternalInput(state,later);
 expect(accepted.status).toBe('applied');
 expect(accepted.state.components[OBSERVATION_KEY]![later.id]).toEqual(observationComponent(later));
 expect((accepted.state.components[OBSERVATION_KEY]![later.id] as {supersedes:string}).supersedes).toBe(forecast.id);
 // the same identifier with another payload is not a correction: it is a second, contradictory record
 const conflict=applyExternalInput(state,normalize(observation({id:'centro-1200',kind:'forecast',values:{station:'centro',rain:80}}),policyFor({effectTick:20})));
 expect(conflict.status).toBe('rejected');
 expect(conflict.reason).toContain('outro conteúdo');
 expect(applyExternalInput(state,forecast)).toMatchObject({status:'duplicate',state});
});

test('the observation is a protocol component, published like any other and queried by component',async()=>{
 const input=normalize(observation(),policyFor());
 const entity=observationEntity(input,'did:key:zStation');
 expect(entity).toMatchObject({ok:true});
 if(!entity.ok)return;
 expect(entity.value).toEqual({
  osim:'0.1',
  type:'entity',
  id:`osim:entity:${input.id}`,
  actor:'did:key:zStation',
  body:{components:{[OBSERVATION_KEY]:observationComponent(input)}},
 });
 // an actor without a scheme is not publishable, so the boundary refuses before a message exists
 expect(observationEntity(input,'estacao-centro')).toMatchObject({ok:false,error:{code:'MALFORMED'}});
 const kernel=createKernel();
 const published=await kernel.publish(entity.value);
 expect(published).toMatchObject({ok:true,status:'applied'});
 expect(kernel.query({components:[OBSERVATION_KEY]})).toMatchObject({ok:true,value:[`osim:entity:${input.id}`]});
 const resolved=kernel.resolve(`osim:entity:${input.id}`);
 expect(resolved).toMatchObject({ok:true,value:{type:'entity'}});
 if(!resolved.ok||!resolved.value)return;
 expect(resolved.value.components![OBSERVATION_KEY]).toEqual(observationComponent(input));
 // the component keeps field names the profile cares about and the coordinates the protocol asks for
 const component=observationComponent(input) as {time:{observedTime:string;validTime:string};kind:string;unit:string;effectTick:number;source:{dataset:string}};
 expect(component.time.observedTime).toBe('2026-09-29T09:05:00Z');
 expect(component.time.validTime).toBe('2026-09-29T09:00:00Z');
 expect(component.unit).toBe('mm');
 expect(component.effectTick).toBe(2);
 expect(component.source.dataset).toContain('Fixture sintética');
});

test('the player reads the input, its unit and its absence policy, and sees that no rule has used it',()=>{
 const input=normalize(observation({values:null}),policyFor({missing:'hold',effectTick:4}));
 const info=describeExternalInput(input);
 const row=(label:string)=>info.rows.find(entry=>entry.label===label)?.value;
 expect(info.title).toContain('Fixture sintética de observações');
 expect(row('Tipo')).toBe('Observação');
 expect(row('Método')).toBe('Sem valor: a política de ausência responde');
 expect(describeExternalInput(normalize(observation(),policyFor())).rows.find(entry=>entry.label==='Método')?.value).toBe('Relatado por uma fonte');
 expect(row('Unidade')).toBe('mm');
 expect(row('Tick de efeito')).toBe('4');
 expect(row('Válido em')).toBe('2026-09-29T09:00:00Z');
 expect(row('Observado em')).toBe('2026-09-29T09:05:00Z');
 expect(row('Conteúdo')).toContain('hold');
 expect(info.notes.join(' | ')).toContain('nenhuma regra versionada');
 expect(info.notes.join(' | ')).toContain('Previsão não é medição');
 // a rule that did consume the input is named, together with its version
 const applied=describeExternalInput(input,{rule:{family:'city',version:1}});
 expect(applied.notes.join(' | ')).toContain('city v1');
 const forecast=describeExternalInput(normalize(observation({id:'centro-1200',kind:'forecast'}),policyFor()));
 expect(forecast.rows.find(entry=>entry.label==='Tipo')?.value).toBe('Previsão do fornecedor');
 expect(forecast.notes.join(' | ')).toContain('Previsão não é medição');
 const root=document.createElement('div');
 const panel=createSourceInspector(root);
 panel.update(info);
 expect(root.querySelector('[data-panel="source"]')).not.toBeNull();
 expect(root.textContent).toContain('Fixture sintética de observações');
 expect(root.textContent).toContain('Unidade');
 expect(root.textContent).toContain('mm');
 panel.destroy();
 expect(root.querySelector('[data-panel="source"]')).toBeNull();
});
