// What the player reads about the data this world was built from (plan Task 15: "Perfil pode exibir esses dados antes
// de lhes dar efeito econômico"). The panel shows the source, its terms, the times the data is about and — the part
// that matters — what the importer did *not* do: a schedule declares stops and times, it does not give this client a
// router, and a forecast is not a measurement. Every string is Portuguese, and a field nobody declared reads as
// undeclared instead of borrowing the download instant.
//
// The view types below are what the panel reads, not the adapters' data types: presentation may not import an adapter
// (tests/architecture.test.ts), and a view that names exactly what it shows is what keeps the panel from growing a
// dependency on a provider format.
import type {ExternalInput} from '../../world/observations';
import type {DatasetProvenance} from '../../world/observations';

export type SourceRow={label:string;value:string};
export type SourceInfo={title:string;rows:readonly SourceRow[];notes:readonly string[];message:string};
export type TransitView={
 revision:DatasetProvenance;
 timezone:string;
 stops:readonly {providerId:string;name:string}[];
 routes:readonly {providerId:string;name:string}[];
 calendars:readonly {serviceId:string;startDate:string;endDate:string}[];
 capabilities:{routing:string;realtime:string};
};
export type SourceInspectorPanel={update(info:SourceInfo):void;destroy():void};

const UNDECLARED='não declarado';
const METHOD_LABELS:Record<string,string>={reported:'Relatado por uma fonte',derived:'Derivado pelo fornecedor',simulated:'Simulado (cenário declarado)'};
const ABSENCE_LABELS:Record<string,string>={pause:'pausar a dependência',hold:'manter o último valor',scenario:'usar um valor de cenário'};

// Grouping is written here instead of `toLocaleString`: the panel reads the same on every device, and a test must not
// depend on which ICU data the runtime was built with.
function quantity(value:number):string{
 const grouped=Math.abs(value).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g,'.');
 return value<0?`-${grouped}`:grouped;
}
function period(times:DatasetProvenance['times']):string{
 if(times.interval)return `${times.interval.from} → ${times.interval.to}`;
 return times.observedAt??UNDECLARED;
}
function terms(revision:DatasetProvenance):SourceRow[]{
 return [
  {label:'Atribuição',value:revision.terms.attribution??UNDECLARED},
  {label:'Licença',value:revision.terms.license??UNDECLARED},
  {label:'Endereço da fonte',value:revision.source.url},
  {label:'Revisão do fornecedor',value:revision.source.providerRevision??UNDECLARED},
  {label:'Transformação',value:`${revision.transformation.name} v${revision.transformation.version}`},
  {label:'Retirado em',value:revision.times.retrievedAt},
  {label:'Observado em',value:period(revision.times)},
  {label:'Publicado em',value:revision.times.publishedAt??UNDECLARED},
 ];
}
export function describeTransitDataset(view:TransitView):SourceInfo{
 const {revision}=view;
 const bounds=revision.coverage.bounds;
 return {
  title:revision.source.dataset,
  rows:[
   {label:'Fonte',value:`${revision.source.dataset} (${revision.source.id})`},
   ...terms(revision),
   {label:'Formato',value:`${revision.format.name} · ${quantity(revision.format.files.length)} arquivo(s)`},
   {label:'Fuso declarado',value:view.timezone},
   {label:'Paradas',value:quantity(view.stops.length)},
   {label:'Linhas',value:quantity(view.routes.length)},
   {label:'Serviços',value:quantity(view.calendars.length)},
   {label:'Horários declarados',value:`${quantity(view.calendars.length)} serviço(s) entre ${view.calendars[0]?.startDate??UNDECLARED} e ${view.calendars[0]?.endDate??UNDECLARED}`},
   {label:'Cobertura',value:`${quantity(revision.coverage.positions)} posição(ões) declaradas · oeste ${bounds.west} · sul ${bounds.south} · leste ${bounds.east} · norte ${bounds.north}`},
  ],
  notes:[
   `Este importador não calcula rotas: a ordem das paradas é a que a fonte declarou, e a linha reta entre duas paradas não é uma viagem planejada.`,
   `Os horários são os declarados pela fonte, no fuso declarado; 24 h ou mais significam depois da meia-noite e nada é convertido para UTC.`,
   `Dados em tempo real não são incluídos (${view.capabilities.realtime}) e serviços sem data declarada não recebem uma.`,
   `A cobertura é a caixa das posições declaradas, não uma área de serviço.`,
  ],
  message:'',
 };
}
export function describeExternalInput(input:ExternalInput,options:{rule?:{family:string;version:number}}={}):SourceInfo{
 const time=input.time;
 const rows:SourceRow[]=[
  {label:'Fonte',value:`${input.source.dataset} (${input.source.id})`},
  {label:'Revisão do fornecedor',value:input.source.providerRevision??UNDECLARED},
  {label:'Identificador da fonte',value:input.providerId},
  {label:'Tipo',value:input.kind==='observed'?'Observação':'Previsão do fornecedor'},
  {label:'Método',value:input.method===undefined?'Sem valor: a política de ausência responde':METHOD_LABELS[input.method]??input.method},
  {label:'Unidade',value:input.unit},
  {label:'Conteúdo',value:input.payload===null?`política ${input.absence?.mode??UNDECLARED} — o perfil sabe o que fazer com a falta`:JSON.stringify(input.payload)},
  {label:'Linha do tempo',value:time.timeline},
  {label:'Registrado em',value:time.time},
  {label:'Observado em',value:time.observedTime??UNDECLARED},
  {label:'Válido em',value:time.interval?`${time.interval.from} → ${time.interval.to}`:time.validTime??UNDECLARED},
  {label:'Tick de efeito',value:quantity(input.effectTick)},
  {label:'Política de ausência',value:`v${input.policy.version} · ${ABSENCE_LABELS[input.policy.missing]??input.policy.missing}`},
 ];
 const notes=[
  'Previsão não é medição: o que o fornecedor anunciou fica marcado como previsão e não substitui o que foi observado.',
  options.rule
   ?`Regra aplicada: ${options.rule.family} v${options.rule.version}. O efeito é dessa regra, não do adaptador.`
   :'Esta entrada está registrada e ainda sem efeito: nenhuma regra versionada a consome, então ela é exibida e não aplicada.',
 ];
 if(input.absence)notes.push(`A fonte não relatou valor e a política declarada foi ${ABSENCE_LABELS[input.absence.mode]??input.absence.mode}${input.absence.holdTicks===undefined?'':` por ${input.absence.holdTicks} tick(s)`}.`);
 if(input.supersedes!==undefined)notes.push(`Substitui a entrada ${input.supersedes}: a revisão nova vale do tick de efeito dela para a frente.`);
 return {title:input.source.dataset,rows,notes,message:''};
}

export function createSourceInspector(root:HTMLElement):SourceInspectorPanel{
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
 panel.id='panel-source';
 panel.dataset.panel='source';
 panel.dataset.sheet='fontes';
 panel.setAttribute('aria-label','Dados de origem');
 panel.style.left='8px';
 panel.style.top='660px';
 panel.style.width='min(420px,calc(100vw - 16px))';
 const head=make('header','panel-head');
 head.dataset.dragHandle='';
 const title=make('h2','panel-title','Dados de origem');
 const close=button('×','panel-close');
 close.dataset.close='';
 close.setAttribute('aria-label','Fechar Dados de origem');
 close.title='Fechar';
 head.append(title,close);
 const body=make('div','panel-body');
 body.dataset.panelBody='';
 const message=make('p');
 message.id='source-message';
 message.setAttribute('role','status');
 const subtitle=make('p','source-title');
 const ledger=make('dl','source-rows');
 const notes=make('ul','source-notes');
 body.append(message,subtitle,ledger,notes);
 panel.append(head,body);
 root.append(panel);
 return {
  update(info){
   message.textContent=info.message;
   message.hidden=!info.message;
   subtitle.textContent=info.title;
   ledger.replaceChildren();
   for(const row of info.rows)ledger.append(make('dt',undefined,row.label),make('dd',undefined,row.value));
   notes.replaceChildren();
   for(const note of info.notes)notes.append(make('li',undefined,note));
  },
  destroy(){
   panel.remove();
  },
 };
}
