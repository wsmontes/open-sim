// Two futures of the same place, side by side (plan Task 14: "Mostrar cenários lado a lado com dados reais fixados,
// decisões e indicadores explicáveis"). The panel reads the ground both runs share, the durable decision each one
// applied, the hypotheses each one declared and the indicators that actually moved, so a difference between scenarios
// is read instead of guessed. Every string the player reads is Portuguese, and a comparison that is not comparable
// says why instead of showing a difference nobody can explain.
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
export type CompositionActions={onCompare():void;onRegion(chunkId:string):void};
export type WorldCompositionPanel={update(info:CompositionInfo):void;destroy():void};

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

export function createWorldComposition(root:HTMLElement,actions:CompositionActions):WorldCompositionPanel{
 const doc=root.ownerDocument;
 const make=(tag:string,className?:string,text?:string):HTMLElement=>{
  const node=doc.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
 };
 const button=(text:string,className?:string):HTMLButtonElement=>{
  const node=doc.createElement('button');
  node.type='button';
  node.textContent=text;
  if(className)node.className=className;
  return node;
 };
 const panel=make('section','panel');
 panel.id='panel-composition';
 panel.dataset.panel='composition';
 panel.setAttribute('aria-label','Cenários comparados');
 panel.style.left='8px';
 panel.style.top='400px';
 panel.style.width='min(420px,calc(100vw - 16px))';
 const head=make('header','panel-head');
 head.dataset.dragHandle='';
 const title=make('h2','panel-title','Cenários');
 const collapse=button('▾','panel-collapse');
 collapse.dataset.collapse='';
 collapse.setAttribute('aria-expanded','true');
 collapse.setAttribute('aria-label','Minimizar painel Cenários');
 collapse.title='Minimizar painel';
 head.append(title,collapse);
 const body=make('div','panel-body');
 body.dataset.panelBody='';
 const message=make('p');
 message.id='composition-message';
 message.setAttribute('role','status');
 const sides=make('div','composition-sides');
 // Two futures side by side: the grid keeps them in one row on a wide card and stacks them when the card is narrow.
 sides.style.display='grid';
 sides.style.gridTemplateColumns='repeat(auto-fit,minmax(150px,1fr))';
 sides.style.gap='6px';
 const trigger=button('Comparar futuros','composition-compare');
 const detail=make('div');
 detail.id='composition-detail';
 body.append(message,sides,trigger,detail);
 panel.append(head,body);
 root.append(panel);
 // A region of a scenario is a place the player can look at, so the button moves the camera instead of only naming it.
 const side=(read:ScenarioCard):HTMLElement=>{
  const node=make('article','composition-side');
  node.append(
   make('h3',undefined,read.id),
   make('p',undefined,`${read.place} · ${read.ground}`),
   make('p',undefined,read.interval),
   make('p',undefined,read.decisions.length?`Decisões: ${read.decisions.join(', ')}`:'Decisões: nenhuma'),
   make('p',undefined,read.premises.length?`Premissas: ${read.premises.join('; ')}`:'Premissas: não declaradas'),
  );
  const ledger=make('dl');
  for(const row of read.rows)ledger.append(make('dt',undefined,row.label),make('dd',undefined,row.value));
  node.append(ledger);
  const places=make('div','composition-places');
  for(const area of read.areas){
   const open=button(`Ver ${area}`);
   open.addEventListener('click',()=>actions.onRegion(area));
   places.append(open);
  }
  if(read.areas.length)node.append(places);
  return node;
 };
 const onCompare=()=>actions.onCompare();
 trigger.addEventListener('click',onCompare);
 return {
  update(info){
   message.textContent=info.message;
   message.hidden=!info.message;
   sides.replaceChildren();
   detail.replaceChildren();
   if(!info.a||!info.b||!info.comparison)return;
   sides.append(side(info.a),side(info.b));
   const read=info.comparison;
   const summary=make('p',undefined,read.summary);
   summary.id='composition-summary';
   detail.append(summary);
   for(const reason of read.reasons)detail.append(make('p','composition-reason',reason));
   if(read.rows.length){
    const table=make('table','composition-deltas');
    const header=make('tr');
    header.append(make('th',undefined,'Indicador'),make('th',undefined,info.a.id),make('th',undefined,info.b.id),make('th',undefined,'Δ'));
    table.append(header);
    for(const row of read.rows){
     const line=make('tr');
     const delta=make('td',row.direction==='same'?undefined:'composition-delta',row.delta);
     delta.setAttribute('data-direction',row.direction);
     line.append(make('td',undefined,row.label),make('td',undefined,row.a),make('td',undefined,row.b),delta);
     table.append(line);
    }
    detail.append(table);
   }
   for(const entry of read.declared)detail.append(make('p','composition-declared',`Premissa declarada — ${entry}`));
   for(const entry of read.parameters)detail.append(make('p','composition-parameter',`Parâmetro — ${entry}`));
  },
  destroy(){
   trigger.removeEventListener('click',onCompare);
   panel.remove();
  },
 };
}
