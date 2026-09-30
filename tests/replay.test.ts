import {expect,test} from 'vitest';
import {replayScenario} from '../src/core/replay';
import type {Scenario} from '../src/core/replay';
import {applyCommand} from '../src/core/commands';
import {COST} from '../src/core/model';
import type {SavedGame,ViewState} from '../src/core/model';
import {canonicalJson,decodeSave,encodeSave} from '../src/core/snapshot';
import fixture from './fixtures/portable-scenario.json';

// Synthetic scenario: invented streets and buildings, never a real city.
const scenario = fixture as unknown as Scenario;
const resentAt = scenario.commands.findIndex((c,i)=>i>0&&c.sequence===scenario.commands[i-1].sequence);

test('replay applies the synthetic scenario once, tolerating a resent envelope',()=>{
 expect(resentAt).toBeGreaterThan(0);
 const full = replayScenario(scenario);
 const withoutResend = replayScenario({...scenario,commands:scenario.commands.filter((_,i)=>i!==resentAt)});
 // Demolition, park, three new street cells, two residential zones, plus the net
 // maintenance the scenario leaves behind when the tick-30 accounting runs.
 const spend = COST.demolish + COST.park + 3 * COST.road + 2 * COST.residential;
 expect(full.money).toBe(20000 - spend - 5);
 expect(full.tick).toBe(30);
 expect(full.revision).toBe(scenario.commands.length - 1);
 expect(canonicalJson(full)).toBe(canonicalJson(withoutResend));
 const edits = full.chunks['0:0'].edits;
 expect(edits['356']).toEqual({terrain:'land',building:'park',stage:1,origin:'player'});
 expect(edits['330']).toEqual({terrain:'land',road:true,origin:'player'});
 expect(edits['362']).toEqual({terrain:'land',building:'residential',stage:1,origin:'player'});
 expect(edits['363']).toEqual({terrain:'land',building:'residential',stage:0,origin:'player'});
});

test('two replays of the same scenario are identical',()=>{
 expect(canonicalJson(replayScenario(scenario))).toBe(canonicalJson(replayScenario(scenario)));
});

test('malformed scenarios and stale commands are rejected',()=>{
 const cases: [string,unknown,RegExp][] = [
  ['unsupported version',{...scenario,version:2},/Versão de cenário/],
  ['missing world',{...scenario,worldId:''},/sem mundo/],
  ['fractional seed',{...scenario,seed:1.5},/Semente/],
  ['chunk without id',{...scenario,initial:{...scenario.initial,id:''}},/sem identificador/],
  ['chunk with 10 cells',{...scenario,initial:{...scenario.initial,cells:scenario.initial.cells.slice(0,10)}},/1024 células/],
  ['commands not an array',{...scenario,commands:'nada'},/sem lista de comandos/],
  ['malformed envelope',{...scenario,commands:[null]},/envelope inválido/],
  ['divergent world in command',{...scenario,commands:[{...scenario.commands[0],worldId:'outro'}]},/mundo diferente/],
  ['stale revision',{...scenario,commands:[scenario.commands[0],{...scenario.commands[1],expectedRevision:99}]},/Comando 2 rejeitado/],
 ];
 for (const [name,value,pattern] of cases) expect(()=>replayScenario(value),name).toThrow(pattern);
});

test('a save restored mid-scenario replays to the same canonical state',()=>{
 const view:ViewState={x:16,y:16,zoom:1,speed:1,place:'Cenário sintético'};
 const applied = scenario.commands.slice(0,10);
 let state = replayScenario({...scenario,commands:applied});
 expect(state.tick).toBe(5);
 const restored:SavedGame = decodeSave(encodeSave({version:1,state,view}));
 expect(restored.view).toEqual(view);
 state = restored.state;
 for (const command of scenario.commands.slice(applied.length)) {
  const result = applyCommand(state,command,[]);
  if (result.status === 'rejected') throw new Error(result.reason);
  state = result.state;
 }
 expect(canonicalJson(state)).toBe(canonicalJson(replayScenario(scenario)));
});
