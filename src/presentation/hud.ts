import type {CityStats,Tool} from '../core/model';
import {COST} from '../core/model';
import type {Speed} from './clock';
import type {SaveStatus} from '../session/local-session';
// The toolbar selects one of the domain tools, plain exploration, or demolition.
export type SelectedTool = Tool|'explore'|'demolish';
export type HudCallbacks = {
 onTool(tool:SelectedTool):void;
 onSpeed(speed:Speed):void;
 onPlace(place:string):void;
 onRetryMap():void;
 onOverwriteSave():void;
 onOverview():void;
 onZoomStep(direction:1|-1):void;
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
// Panels are painted by index.html and dragged by their header. Position and collapsed flag live in localStorage so a
// reload keeps the arrangement the player chose: {id:{x,y,collapsed}}.
type PanelState = {x:number;y:number;collapsed:boolean};
const STORAGE_KEY='open-sim:panels';
function saveText(status:SaveStatus):string {
 if(status.status==='saving')return 'Salvando…';
 if(status.status==='saved')return 'Salvo';
 if(status.status==='error')return (status.blocked?'Save incompatível':'Falha ao salvar')+(status.message?`: ${status.message}`:'');
 return '';
}
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
   const {x,y,collapsed}=value as {x?:unknown;y?:unknown;collapsed?:unknown};
   if(typeof x!=='number'||typeof y!=='number'||!Number.isFinite(x)||!Number.isFinite(y))continue;
   panels[id]={x,y,collapsed:collapsed===true};
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
export function createHud(root:HTMLElement,callbacks:HudCallbacks):{update(info:HudInfo):void;destroy():void} {
 const el=(selector:string)=>{
  const found=root.querySelector<HTMLElement>(selector);
  if(!found)throw new Error(`Elemento ausente: ${selector}`);
  return found;
 };
 const listeners:Array<{target:EventTarget;type:string;handler:EventListener}>=[];
 const on=<E extends Event>(target:EventTarget,type:string,handler:(event:E)=>void)=>{
  const listener=handler as EventListener;
  target.addEventListener(type,listener);
  listeners.push({target,type,handler:listener});
 };
 type Panel={id:string;node:HTMLElement;body:HTMLElement;toggle:HTMLButtonElement;label:string;state:PanelState|null};
 const view=root.ownerDocument.defaultView,storage=storageOf(root),stored=readPanels(storage),placed:Record<string,PanelState>={};
 const panels:Panel[]=[];
 let drag:{panel:Panel;pointerX:number;pointerY:number;x:number;y:number;collapsed:boolean}|null=null;
 // Keeps a panel inside the viewport and remembers its position; the anchors pinned by the stylesheet are cleared.
 const place=(panel:Panel,x:number,y:number,collapsed:boolean):PanelState=>{
  const rect=panel.node.getBoundingClientRect(),width=view?view.innerWidth:0,height=view?view.innerHeight:0;
  const state=panel.state??{x:0,y:0,collapsed};
  state.x=Math.max(0,Math.min(x,Math.max(0,width-rect.width)));
  state.y=Math.max(0,Math.min(y,Math.max(0,height-rect.height)));
  state.collapsed=collapsed;
  panel.node.style.left=`${state.x}px`;
  panel.node.style.top=`${state.y}px`;
  panel.node.style.right='auto';
  panel.node.style.bottom='auto';
  panel.state=state;
  placed[panel.id]=state;
  if(panel.body.hidden!==collapsed){
   panel.node.classList.toggle('collapsed',collapsed);
   panel.body.hidden=collapsed;
   panel.toggle.setAttribute('aria-expanded',String(!collapsed));
   panel.toggle.textContent=collapsed?'▸':'▾';
   panel.toggle.setAttribute('aria-label',`${collapsed?'Expandir':'Minimizar'} painel ${panel.label}`);
   panel.toggle.title=`${collapsed?'Expandir':'Minimizar'} painel`;
  }
  return state;
 };
 // Where the panel is on screen right now, relative to the hud layer: the dragged anchors win, the stylesheet default
 // is measured.
 const anchor=(panel:Panel)=>{
  const {style}=panel.node,left=parseFloat(style.left),top=parseFloat(style.top);
  if(Number.isFinite(left)&&Number.isFinite(top))return {x:left,y:top};
  const rect=panel.node.getBoundingClientRect(),host=root.getBoundingClientRect();
  return {x:rect.left-host.left,y:rect.top-host.top};
 };
 for(const node of root.querySelectorAll<HTMLElement>('[data-panel]')){
  const id=node.dataset.panel??'',handle=node.querySelector<HTMLElement>('[data-drag-handle]');
  const body=node.querySelector<HTMLElement>('[data-panel-body]'),toggle=node.querySelector<HTMLButtonElement>('[data-collapse]');
  if(!id||!handle||!body||!toggle)throw new Error(`Painel incompleto: ${id||'sem data-panel'}`);
  const panel:Panel={id,node,body,toggle,label:node.querySelector('.panel-title')?.textContent?.trim()||id,state:null};
  panels.push(panel);
  on(handle,'pointerdown',(event:PointerEvent)=>{
   if(event.button!==0||(event.target as Element|null)?.closest('[data-collapse]'))return;
   const at=anchor(panel);
   drag={panel,pointerX:event.clientX,pointerY:event.clientY,x:at.x,y:at.y,collapsed:panel.body.hidden===true};
   panel.node.classList.add('dragging');
   event.preventDefault();
  });
  on(toggle,'click',()=>{
   const at=anchor(panel);
   place(panel,at.x,at.y,!panel.body.hidden);
   writePanels(storage,placed);
  });
 }
 const endDrag=()=>{
  if(!drag)return;
  drag.panel.node.classList.remove('dragging');
  drag=null;
  writePanels(storage,placed);
 };
 on(view??root.ownerDocument,'pointermove',(event:PointerEvent)=>{
  if(drag)place(drag.panel,drag.x+event.clientX-drag.pointerX,drag.y+event.clientY-drag.pointerY,drag.collapsed);
 });
 on(view??root.ownerDocument,'pointerup',endDrag);
 on(view??root.ownerDocument,'pointercancel',endDrag);
 const placeLabel=el('#hud-place'),money=el('#hud-money'),population=el('#hud-population'),energy=el('#hud-energy'),happiness=el('#hud-happiness');
 const message=el('#map-message'),retry=el('#map-retry'),saveStatus=el('#save-status'),overwrite=el('#save-overwrite'),notice=el('#command-notice');
 const needle=el('#hud-compass-needle'),attribution=root.querySelector<HTMLAnchorElement>('#hud-attribution');
 const toolButtons=[...root.querySelectorAll<HTMLButtonElement>('[data-tool]')];
 const speedButtons=[...root.querySelectorAll<HTMLButtonElement>('[data-speed]')];
 for(const button of toolButtons){
  const tool=button.dataset.tool as SelectedTool,cost=button.querySelector('.tool-cost');
  if(cost)cost.textContent=tool==='explore'?'':String(COST[tool]);
  on(button,'click',()=>callbacks.onTool(tool));
 }
 for(const button of speedButtons)on(button,'click',()=>callbacks.onSpeed(Number(button.dataset.speed) as Speed));
 for(const button of root.querySelectorAll<HTMLButtonElement>('[data-place]'))on(button,'click',()=>callbacks.onPlace(button.dataset.place??''));
 for(const button of root.querySelectorAll<HTMLButtonElement>('[data-zoom]'))on(button,'click',()=>callbacks.onZoomStep(Number(button.dataset.zoom)===1?1:-1));
 on(el('#hud-north'),'click',()=>callbacks.onNorth());
 on(retry,'click',()=>callbacks.onRetryMap());
 on(overwrite,'click',()=>callbacks.onOverwriteSave());
 on(el('#hud-overview'),'click',()=>callbacks.onOverview());
 for(const panel of panels){
  const state=stored[panel.id];
  if(state)place(panel,state.x,state.y,state.collapsed);
 }
 return {
  update(info){
   placeLabel.textContent=info.place;
   money.textContent=info.stats.money.toLocaleString('pt-BR');
   population.textContent=info.stats.population.toLocaleString('pt-BR');
   energy.textContent=`${info.stats.energyUsed}/${info.stats.energySupply}`;
   energy.title='energia usada / fornecida';
   happiness.textContent=`${info.stats.happiness}%`;
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
   for(const {target,type,handler} of listeners)target.removeEventListener(type,handler);
   listeners.length=0;
  },
 };
}
