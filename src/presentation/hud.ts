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
};
function saveText(status:SaveStatus):string {
 if(status.status==='saving')return 'Salvando…';
 if(status.status==='saved')return 'Salvo';
 if(status.status==='error')return (status.blocked?'Save incompatível':'Falha ao salvar')+(status.message?`: ${status.message}`:'');
 return '';
}
export function createHud(root:HTMLElement,callbacks:HudCallbacks):{update(info:HudInfo):void;destroy():void} {
 const el=(selector:string)=>{
  const found=root.querySelector<HTMLElement>(selector);
  if(!found)throw new Error(`Elemento ausente: ${selector}`);
  return found;
 };
 const listeners:Array<{target:EventTarget;type:string;handler:EventListener}>=[];
 const on=(target:EventTarget,type:string,handler:EventListener)=>{target.addEventListener(type,handler);listeners.push({target,type,handler});};
 const place=el('#hud-place'),money=el('#hud-money'),population=el('#hud-population'),energy=el('#hud-energy'),happiness=el('#hud-happiness');
 const message=el('#map-message'),retry=el('#map-retry'),saveStatus=el('#save-status'),overwrite=el('#save-overwrite'),notice=el('#command-notice');
 const attribution=root.querySelector<HTMLAnchorElement>('#hud-attribution');
 const toolButtons=[...root.querySelectorAll<HTMLButtonElement>('[data-tool]')];
 const speedButtons=[...root.querySelectorAll<HTMLButtonElement>('[data-speed]')];
 for(const button of toolButtons){
  const tool=button.dataset.tool as SelectedTool,cost=button.querySelector('.tool-cost');
  if(cost)cost.textContent=tool==='explore'?'':String(COST[tool]);
  on(button,'click',()=>callbacks.onTool(tool));
 }
 for(const button of speedButtons)on(button,'click',()=>callbacks.onSpeed(Number(button.dataset.speed) as Speed));
 for(const button of root.querySelectorAll<HTMLButtonElement>('[data-place]'))on(button,'click',()=>callbacks.onPlace(button.dataset.place??''));
 on(retry,'click',()=>callbacks.onRetryMap());
 on(overwrite,'click',()=>callbacks.onOverwriteSave());
 on(el('#hud-overview'),'click',()=>callbacks.onOverview());
 return {
  update(info){
   place.textContent=info.place;
   money.textContent=info.stats.money.toLocaleString('pt-BR');
   population.textContent=info.stats.population.toLocaleString('pt-BR');
   energy.textContent=`${info.stats.energyUsed}/${info.stats.energySupply}`;
   energy.title='energia usada / fornecida';
   happiness.textContent=`${info.stats.happiness}%`;
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
   for(const {target,type,handler} of listeners)target.removeEventListener(type,handler);
   listeners.length=0;
  },
 };
}
