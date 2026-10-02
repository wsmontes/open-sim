// The player-facing model of two futures side by side (plan Task 14), without a surface: a view in, a plain-data card
// out, so the client builds it and the canvas panel and the text surface read the same thing. The DOM panel lives in
// world-composition.ts; this module compiles without DOM, which is why the portable client may import it.
import type {ScenarioComparison,ScenarioIndicators,ScenarioRun} from '../world/composition';

export type ScenarioCardRow={label:string;value:string};
export type ScenarioCard={
 id:string;
 place:string;
 ground:string;
 interval:string;
 decisions:readonly string[];
 premises:readonly string[];
 rows:readonly ScenarioCardRow[];
 areas:readonly string[];
};
export type ScenarioDeltaRow={label:string;a:string;b:string;delta:string;direction:'a'|'b'|'same'};
export type ScenarioComparisonInfo={
 comparable:boolean;
 summary:string;
 reasons:readonly string[];
 declared:readonly string[];
 parameters:readonly string[];
 rows:readonly ScenarioDeltaRow[];
};
// `a` and `b` are absent until two futures were run; a message stands alone while there is nothing to compare.
export type CompositionInfo={a:ScenarioCard|null;b:ScenarioCard|null;comparison:ScenarioComparisonInfo|null;message:string};

const INDICATOR_LABELS:Record<keyof ScenarioIndicators,string>={money:'Saldo',population:'Moradores',jobs:'Empregos',energySupply:'Energia disponível',energyUsed:'Energia usada',happiness:'Felicidade',income:'Renda por ciclo',managed:'Trechos administrados',tick:'Tick'};
// The order the profile reports its indicators in, so a card and the deltas below it read the same way.
const INDICATOR_ORDER:readonly (keyof ScenarioIndicators)[]=['money','population','jobs','energySupply','energyUsed','happiness','income','managed','tick'];

// Grouping is written here instead of `toLocaleString`: the panel must read the same on every device, and a test must
// not depend on which ICU data the runtime was built with.
function quantity(value:number):string{
 const grouped=Math.abs(value).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g,'.');
 return value<0?`-${grouped}`:grouped;
}
function card(run:ScenarioRun):ScenarioCard{
 return {
  id:run.id,
  place:`${run.composition.worldId}/${run.composition.branchId}`,
  ground:`#${run.composition.base.commit.hash.slice(0,7)} · ${run.composition.base.bases.length} base(s) fixada(s)`,
  interval:`tick ${run.interval.fromTick} → ${run.interval.toTick}`,
  decisions:run.composition.layers.filter(layer=>layer.contract.effect==='durable').map(layer=>layer.contract.id),
  premises:[...run.premises],
  rows:INDICATOR_ORDER.map(key=>({label:INDICATOR_LABELS[key],value:quantity(run.indicators[key])})),
  areas:[...new Set(run.composition.layers.flatMap(layer=>layer.contract.areas))].sort(),
 };
}
export function describeScenarios(a:ScenarioRun,b:ScenarioRun,comparison:ScenarioComparison):CompositionInfo{
 return {
  a:card(a),
  b:card(b),
  comparison:{
   comparable:comparison.comparable,
   summary:comparison.comparable
    ? `Comparável: mesma base (${(comparison.baseCommit??'').slice(0,7)}), ${comparison.sharedBases.length} trecho(s) em comum, ${comparison.indicators.length} indicador(es) mudaram`
    : `Não comparável: ${comparison.reasons.join(' · ')}`,
   reasons:[...comparison.reasons],
   declared:comparison.declared.map(entry=>`${entry.side==='a'?a.id:b.id}: ${entry.premise}`),
   parameters:comparison.parameters.map(key=>`${key}: ${JSON.stringify(a.composition.parameters[key]??null)} → ${JSON.stringify(b.composition.parameters[key]??null)}`),
   rows:comparison.indicators.map(entry=>({
    label:INDICATOR_LABELS[entry.key],
    a:quantity(entry.a),
    b:quantity(entry.b),
    delta:entry.delta>0?`+${quantity(entry.delta)}`:quantity(entry.delta),
    direction:entry.delta>0?'b':entry.delta<0?'a':'same',
   })),
  },
  message:'',
 };
}
export function emptyComposition(message:string):CompositionInfo{return {a:null,b:null,comparison:null,message};}
