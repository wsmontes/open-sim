// Two futures of the same place, side by side (plan Task 14: "Mostrar cenários lado a lado com dados reais fixados,
// decisões e indicadores explicáveis"). The panel reads the ground both runs share, the durable decision each one
// applied, the hypotheses each one declared and the indicators that actually moved, so a difference between scenarios
// is read instead of guessed. Every string the player reads is Portuguese, and a comparison that is not comparable
// says why instead of showing a difference nobody can explain.
import type {CompositionInfo,ScenarioCard} from '../../presentation/world-composition-model';

export type {ScenarioCardRow,ScenarioCard,ScenarioDeltaRow,ScenarioComparisonInfo,CompositionInfo} from '../../presentation/world-composition-model';
export {describeScenarios,emptyComposition} from '../../presentation/world-composition-model';
export type CompositionActions={onCompare():void;onRegion(chunkId:string):void};
export type WorldCompositionPanel={update(info:CompositionInfo):void;destroy():void};

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
 panel.dataset.sheet='planejamento';
 panel.setAttribute('aria-label','Cenários comparados');
 panel.style.left='8px';
 panel.style.top='400px';
 panel.style.width='min(420px,calc(100vw - 16px))';
 const head=make('header','panel-head');
 head.dataset.dragHandle='';
 const title=make('h2','panel-title','Cenários');
 const collapse=button('▾','panel-collapse');
 collapse.dataset.close='';
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
