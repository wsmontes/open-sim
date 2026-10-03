import type {CityStats} from '../../core/model';
export type {SelectedTool} from '../../presentation/tools';
import type {SelectedTool} from '../../presentation/tools';
import {economyPanel,netText,saveText} from '../../presentation/words';
import {BORROW_STEP,COST,SERVICES_MAX,SERVICES_MIN,TAX_MAX,TAX_MIN} from '../../core/model';
import type {LayoutMode} from '../../presentation/layout';
import type {Speed} from '../../presentation/clock';
import type {SaveStatus} from '../../session/local-session';
// The toolbar selects one of the domain tools, plain exploration, or demolition.
// What each tool does, in the words of the game: the hover hint of its button. Kept here rather than in the markup so
// the rules and their explanation are read side by side, and so the markup stays one short line per button.
export const TOOL_HINTS: Record<SelectedTool,string> = {
 explore:'Explorar a cidade (1)',
 road:'Rua (2): barata, e a cidade cresce até dois andares em volta dela',
 avenue:'Avenida (3): carrega mais tráfego, valoriza os lotes e é onde a cidade cresce para cima',
 highway:'Estrada (4): carrega o tráfego que a rua não carrega, mas o barulho afasta quem mora perto',
 residential:'Residencial (5): moradias, que crescem onde há rua, energia, serviços e um lugar agradável',
 commercial:'Comércio (6): empregos e clientes — o valor da terra em volta sobe',
 industrial:'Indústria (7): muitos empregos, e a vizinhança perde valor',
 park:'Parque (8): deixa o bairro mais valioso e mais feliz',
 power:'Usina (9): sem energia nada cresce',
 demolish:'Demolir (0)',
};
export type HudCallbacks = {
 onTool(tool:SelectedTool):void;
 // The city's levers. One call per decision, not per pixel: the panel sends what the player settled on.
 onPolicy(policy:{tax?:number;services?:number;borrow?:number}):void;
 onSpeed(speed:Speed):void;
 onPlace(place:string):void;
 onRetryMap():void;
 onOverwriteSave():void;
 onOverview():void;
 onZoomStep(direction:1|-1):void;
 // Turning the view is a camera move like zooming, and the cluster offers it the same way: a step per press, so a
 // player without a keyboard — or without knowing Q and E — can still turn the city.
 onRotateStep(direction:1|-1):void;
 onNorth():void;
};
export type HudInfo = {
 stats:CityStats;
 tool:SelectedTool;
 speed:Speed;
 place:string;
 attribution:{text:string;url:string};
 mapMessage:string;
 notice:string;
 saveStatus:SaveStatus;
 canOverwriteSave:boolean;
 rotation:number;
};
// The shell has three levels: the bar that is always there, the screen the player opened, and the notes the city is
// leaving. Everything the panels used to be — positions, collapse flags, whether they float — is decided by the layout
// mode the browser hands in, not by what the player last dragged.
export type Hud = {
 update(info:HudInfo):void;
 setMode(mode:LayoutMode):void;
 // Which management screen is open, or null for the city alone. Opened from the dock, closed by its own button.
 openSheet(sheet:string|null):void;
 sheet():string|null;
 destroy():void;
};
type Panel={id:string;sheet:string;node:HTMLElement;body:HTMLElement;close:HTMLButtonElement|null;label:string};
type PanelState={x:number;y:number};
const STORAGE_KEY='open-sim:panels';
function readPanels(storage:Storage|null):Record<string,PanelState> {
 if(!storage)return {};
 try{
  const raw=storage.getItem(STORAGE_KEY);
  if(!raw)return {};
  const parsed:unknown=JSON.parse(raw);
  if(!parsed||typeof parsed!=='object')return {};
  const panels:Record<string,PanelState>={};
  for(const [id,value] of Object.entries(parsed as Record<string,unknown>)){
   if(!value||typeof value!=='object')continue;
   const {x,y}=value as {x?:unknown;y?:unknown};
   if(typeof x!=='number'||typeof y!=='number'||!Number.isFinite(x)||!Number.isFinite(y))continue;
   panels[id]={x,y};
  }
  return panels;
 }catch{return {};}
}
function writePanels(storage:Storage|null,panels:Record<string,PanelState>):void {
 if(!storage)return;
 try{storage.setItem(STORAGE_KEY,JSON.stringify(panels));}catch{/* Private mode blocks the write; memory keeps the arrangement. */}
}
function storageOf(root:HTMLElement):Storage|null {
 try{return root.ownerDocument.defaultView?.localStorage??null;}catch{return null;}
}
export function createHud(root:HTMLElement,callbacks:HudCallbacks):Hud {
 const el=<T extends HTMLElement=HTMLElement>(selector:string)=>{
  const found=root.querySelector<T>(selector);
  if(!found)throw new Error(`Elemento ausente: ${selector}`);
  return found;
 };
 const listeners:Array<{target:EventTarget;type:string;handler:EventListener}>=[];
 const on=<E extends Event>(target:EventTarget,type:string,handler:(event:E)=>void)=>{
  const listener=handler as EventListener;
  target.addEventListener(type,listener);
  listeners.push({target,type,handler:listener});
 };
 const view=root.ownerDocument.defaultView,storage=storageOf(root),stored=readPanels(storage),placed:Record<string,PanelState>={};
 const panels:Panel[]=[];
 let mode:LayoutMode={dock:'bottom',sheets:'sheet',inspector:'card',floating:false,touch:false};
 let open:string|null=null;
 let opener:HTMLElement|null=null;
 let drag:{panel:Panel;pointerX:number;pointerY:number;x:number;y:number}|null=null;

 // A floating screen stays where the player put it; the others are arranged by the stylesheet. Clearing the inline
 // position is what lets the stylesheet win again when the layout changes underneath.
 const place=(panel:Panel,x:number,y:number)=>{
  const rect=panel.node.getBoundingClientRect(),width=view?view.innerWidth:0,height=view?view.innerHeight:0;
  const state={x:Math.max(0,Math.min(x,Math.max(0,width-rect.width))),y:Math.max(0,Math.min(y,Math.max(0,height-rect.height)))};
  panel.node.style.left=`${state.x}px`;
  panel.node.style.top=`${state.y}px`;
  panel.node.style.right='auto';
  panel.node.style.bottom='auto';
  placed[panel.id]=state;
 };
 const release=(panel:Panel)=>{
  panel.node.style.left='';
  panel.node.style.top='';
  panel.node.style.right='';
  panel.node.style.bottom='';
  delete placed[panel.id];
 };
 for(const node of root.querySelectorAll<HTMLElement>('[data-panel]')){
  const id=node.dataset.panel??'',sheet=node.dataset.sheet??'';
  const body=node.querySelector<HTMLElement>('[data-panel-body]'),close=node.querySelector<HTMLButtonElement>('[data-close]');
  if(!id||!body)throw new Error(`Painel incompleto: ${id||'sem data-panel'}`);
  const panel:Panel={id,sheet,node,body,close,label:node.querySelector('.panel-title')?.textContent?.trim()||id};
  panels.push(panel);
  const handle=node.querySelector<HTMLElement>('[data-drag-handle]');
  if(handle)on(handle,'pointerdown',(event:PointerEvent)=>{
   // Dragging is a workstation habit: on a phone a window dragged off the edge is a window the player cannot get back,
   // and in a sheet or a drawer the screen already belongs to the edge it came from.
   if(!mode.floating||event.button!==0||(event.target as Element|null)?.closest('[data-close]'))return;
   const rect=panel.node.getBoundingClientRect(),host=root.getBoundingClientRect();
   drag={panel,pointerX:event.clientX,pointerY:event.clientY,x:rect.left-host.left,y:rect.top-host.top};
   panel.node.classList.add('dragging');
   event.preventDefault();
  });
  if(close)on(close,'click',()=>openSheet(null));
 }
 const endDrag=()=>{
  if(!drag)return;
  drag.panel.node.classList.remove('dragging');
  drag=null;
  writePanels(storage,placed);
 };
 on(view??root.ownerDocument,'pointermove',(event:PointerEvent)=>{
  if(drag)place(drag.panel,drag.x+event.clientX-drag.pointerX,drag.y+event.clientY-drag.pointerY);
 });
 on(view??root.ownerDocument,'pointerup',endDrag);
 on(view??root.ownerDocument,'pointercancel',endDrag);

 const openSheet=(next:string|null)=>{
  const was=open;
  if(next&&!was)opener=root.ownerDocument.activeElement as HTMLElement|null;
  open=next;
  if(moreList&&moreList.hidden!==true){moreList.hidden=true;more?.setAttribute('aria-expanded','false');more?.classList.remove('selected');}
  // One attribute drives the whole level: the stylesheet shows the screen it names and hides the rest.
  if(next)root.dataset.sheet=next;else delete root.dataset.sheet;
  for(const button of root.querySelectorAll<HTMLElement>('[data-sheet]')){
   if(button.tagName!=='BUTTON')continue;
   button.setAttribute('aria-expanded',String(button.dataset.sheet===next));
   button.classList.toggle('selected',button.dataset.sheet===next);
  }
  if(next)panels.find(panel=>panel.sheet===next)?.close?.focus();
  else if(was){opener?.focus();opener=null;}
 };
 for(const button of root.querySelectorAll<HTMLButtonElement>('button[data-sheet]')){
  on(button,'click',()=>openSheet(open===button.dataset.sheet?null:(button.dataset.sheet??null)));
 }
 const more=root.querySelector<HTMLButtonElement>('#hud-more-toggle'),moreList=root.querySelector<HTMLElement>('#hud-more');
 if(more&&moreList)on(more,'click',()=>{
  const showing=moreList.hidden===true;
  moreList.hidden=!showing;
  more.setAttribute('aria-expanded',String(showing));
  more.classList.toggle('selected',showing);
 });
 // Escape leaves the screen, the same way it drops the tool: one key that always means "back".
 on(view??root.ownerDocument,'keydown',(event:KeyboardEvent)=>{
  if((event as KeyboardEvent).key!=='Escape'||!open)return;
  openSheet(null);
 });

 const placeLabel=el('#hud-place'),money=el('#hud-money'),population=el('#hud-population'),energy=el('#hud-energy'),happiness=el('#hud-happiness');
 const message=el('#map-message'),retry=el('#map-retry'),saveStatus=el('#save-status'),overwrite=el('#save-overwrite'),notice=el('#command-notice');
 const needle=el('#hud-compass-needle'),attribution=root.querySelector<HTMLAnchorElement>('#hud-attribution');
 const economyRevenue=el('#economy-revenue'),economyExpense=el('#economy-expense'),economyNet=el('#economy-net');
 const economyLand=el('#economy-land'),economyDebt=el('#economy-debt'),economyInterest=el('#economy-interest');
 const economyRating=el('#economy-rating'),economyDemand=el('#economy-demand'),economyCrisis=el('#economy-crisis');
 const taxInput=el<HTMLInputElement>('#economy-tax'),taxValue=el('#economy-tax-value');
 const servicesInput=el<HTMLInputElement>('#economy-services'),servicesValue=el('#economy-services-value');
 const borrowButton=el<HTMLButtonElement>('#economy-borrow');
 taxInput.min=String(TAX_MIN);taxInput.max=String(TAX_MAX);taxInput.step='1';
 servicesInput.min=String(SERVICES_MIN);servicesInput.max=String(SERVICES_MAX);servicesInput.step='5';
 // A lever is dragged while the player watches and sent when they let go: `input` moves the number under the finger,
 // `change` is the decision. Sending per pixel would spend a version of the world on every step of the drag.
 const lever=(input:HTMLInputElement,output:HTMLElement,send:(value:number)=>void)=>{
  const show=()=>{output.textContent=`${input.value}%`;};
  on(input,'input',show);
  on(input,'change',()=>{show();send(Number(input.value));});
 };
 lever(taxInput,taxValue,value=>callbacks.onPolicy({tax:value}));
 lever(servicesInput,servicesValue,value=>callbacks.onPolicy({services:value}));
 on(borrowButton,'click',()=>callbacks.onPolicy({borrow:BORROW_STEP}));
 let leverHeld=false;
 for(const input of [taxInput,servicesInput]){
  on(input,'pointerdown',()=>{leverHeld=true;});
  on(input,'pointerup',()=>{leverHeld=false;});
  on(input,'pointercancel',()=>{leverHeld=false;});
 }
 const toolButtons=[...root.querySelectorAll<HTMLButtonElement>('[data-tool]')];
 const speedButtons=[...root.querySelectorAll<HTMLButtonElement>('[data-speed]')];
 for(const button of toolButtons){
  const tool=button.dataset.tool as SelectedTool,cost=button.querySelector('.tool-cost');
  if(cost)cost.textContent=tool==='explore'?'':String(COST[tool]);
  button.title=TOOL_HINTS[tool];
  on(button,'click',()=>callbacks.onTool(tool));
 }
 for(const button of speedButtons)on(button,'click',()=>callbacks.onSpeed(Number(button.dataset.speed) as Speed));
 for(const button of root.querySelectorAll<HTMLButtonElement>('[data-place]'))on(button,'click',()=>callbacks.onPlace(button.dataset.place??''));
 for(const button of root.querySelectorAll<HTMLButtonElement>('[data-zoom]'))on(button,'click',()=>callbacks.onZoomStep(Number(button.dataset.zoom)===1?1:-1));
 for(const button of root.querySelectorAll<HTMLButtonElement>('[data-rotate]'))on(button,'click',()=>callbacks.onRotateStep(Number(button.dataset.rotate)===1?1:-1));
 on(el('#hud-north'),'click',()=>callbacks.onNorth());
 on(retry,'click',()=>callbacks.onRetryMap());
 on(overwrite,'click',()=>callbacks.onOverwriteSave());
 on(el('#hud-overview'),'click',()=>callbacks.onOverview());

 // Everything that has to sit above the dock needs to know how tall the dock actually is, which changes with the width
// of the screen, the length of the labels and whether the tools fit on one row. Measuring beats guessing, and the
// attribution in particular must never end up behind a row of buttons.
 const dock=root.querySelector<HTMLElement>('#hud-dock');
 const top=root.querySelector<HTMLElement>('#hud-top');
 const measure=()=>{
  // `--dock` is the room the actions take from the bottom edge, not the height of the box they are in: on a wide screen
  // they move to a rail down the side and take no room from the bottom at all, and a screen opened beside them must
  // still have the whole height of the window to open into.
  const rail=mode.dock==='rail';
  if(dock){
   const box=dock.getBoundingClientRect();
   root.style.setProperty('--dock',`${rail?0:Math.round(box.height)}px`);
   // On a wide screen the actions live down the side, so what the bottom edge has to clear is their width instead.
   root.style.setProperty('--rail',`${rail?Math.round(box.width):0}px`);
  }
  if(top)root.style.setProperty('--bar',`${Math.round(top.getBoundingClientRect().height)}px`);
 };
 const observer=typeof ResizeObserver==='function'?new ResizeObserver(measure):null;
 if(observer){if(dock)observer.observe(dock);if(top)observer.observe(top);}
 measure();
 const setMode=(next:LayoutMode)=>{
  mode=next;
  root.classList.toggle('touch',next.touch);
  root.classList.toggle('floating',next.floating);
  root.classList.toggle('sheets-sheet',next.sheets==='sheet');
  root.classList.toggle('sheets-drawer',next.sheets==='drawer');
  root.classList.toggle('dock-rail',next.dock==='rail');
  // What a dragged screen was arranged for is not what the screen it is on now can show, so the arrangement starts
  // again from the stylesheet: a rotation or a split view must never leave a screen off the edge.
  for(const panel of panels){
   if(next.floating&&stored[panel.id])place(panel,stored[panel.id]!.x,stored[panel.id]!.y);
   else release(panel);
  }
  measure();
 };
 return {
  setMode,
  openSheet,
  sheet:()=>open,
  update(info){
   placeLabel.textContent=info.place;
   money.textContent=info.stats.money.toLocaleString('pt-BR');
   population.textContent=info.stats.population.toLocaleString('pt-BR');
   energy.textContent=`${info.stats.energyUsed}/${info.stats.energySupply}`;
   energy.title='energia usada / fornecida';
   happiness.textContent=`${info.stats.happiness}%`;
   const economy=info.stats.economy;
   // The same words the terminal's "prefeitura" prints (src/presentation/words.ts): one formatting of each number.
   const panel=Object.fromEntries(economyPanel(economy));
   economyRevenue.textContent=panel['Receita/mês']!;
   economyExpense.textContent=panel['Despesa/mês']!;
   economyNet.textContent=netText(economy.monthly.net);
   economyNet.classList.toggle('negative',economy.monthly.net<0);
   economyLand.textContent=panel['Valor da terra']!;
   economyDebt.textContent=panel['Dívida']!;
   economyInterest.textContent=panel['Juros']!;
   economyRating.textContent=economy.rating;
   economyDemand.textContent=`${economy.demand.residential} / ${economy.demand.commercial} / ${economy.demand.industrial}`;
   economyDemand.title='moradia / comércio / indústria: o que a cidade está pedindo';
   economyCrisis.textContent=economy.crisis??'';
   economyCrisis.hidden=!economy.crisis;
   if(!leverHeld){
    taxInput.value=String(economy.taxPercent);taxValue.textContent=`${economy.taxPercent}%`;
    servicesInput.value=String(economy.servicesPercent);servicesValue.textContent=`${economy.servicesPercent}%`;
   }
   needle.style.transform=`rotate(${info.rotation}rad)`;
   for(const button of toolButtons){
    const active=button.dataset.tool===info.tool;
    button.classList.toggle('selected',active);
    button.setAttribute('aria-pressed',String(active));
   }
   for(const button of speedButtons){
    const active=Number(button.dataset.speed)===info.speed;
    button.classList.toggle('selected',active);
    button.setAttribute('aria-pressed',String(active));
   }
   message.textContent=info.mapMessage;
   message.hidden=!info.mapMessage;
   retry.hidden=!info.mapMessage;
   notice.textContent=info.notice;
   notice.hidden=!info.notice;
   saveStatus.textContent=saveText(info.saveStatus);
   overwrite.hidden=!info.canOverwriteSave;
   if(attribution){
    attribution.textContent=info.attribution.text;
    attribution.href=info.attribution.url;
   }
  },
  destroy(){
   drag=null;
   observer?.disconnect();
   for(const {target,type,handler} of listeners)target.removeEventListener(type,handler);
   listeners.length=0;
  },
 };
}
