// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {beforeEach,expect,test,vi} from 'vitest';
import {EMPTY_ECONOMY} from '../src/core/model';
import type {CityEconomy,CityStats} from '../src/core/model';
import {createHud} from '../src/surfaces/canvas/hud';
import {createWorldHistory} from '../src/surfaces/canvas/world-history';
import {createWorldComposition} from '../src/surfaces/canvas/world-composition';
import {createMultiplayerPanel} from '../src/surfaces/canvas/multiplayer-panel';
import {createSourceInspector} from '../src/surfaces/canvas/source-inspector';
import type {HudCallbacks,HudInfo} from '../src/surfaces/canvas/hud';
import type {LayoutMode} from '../src/presentation/layout';
// The shell is painted by index.html: the tests mount that very markup instead of a hand-made copy.
const hudMarkup=new DOMParser().parseFromString(readFileSync('index.html','utf8'),'text/html').querySelector('#hud')?.outerHTML??'';
const element=<T extends HTMLElement=HTMLElement>(id:string)=>{
 const found=document.getElementById(id);
 if(!found)throw new Error(`Elemento ausente no teste: ${id}`);
 return found as T;
};
const stubRect=(target:Element,left:number,top:number,width:number,height:number)=>{
 target.getBoundingClientRect=()=>({x:left,y:top,left,top,width,height,right:left+width,bottom:top+height,toJSON:()=>({})} as DOMRect);
};
const pointer=(target:EventTarget,type:string,x:number,y:number,button=0)=>target.dispatchEvent(new MouseEvent(type,{clientX:x,clientY:y,button,bubbles:true,cancelable:true}));
const drag=(handle:Element,from:readonly [number,number],to:readonly [number,number])=>{
 pointer(handle,'pointerdown',from[0],from[1]);
 pointer(window,'pointermove',to[0],to[1]);
 pointer(window,'pointerup',to[0],to[1]);
};
const stats:CityStats={money:1234,population:56,jobs:7,energySupply:90,energyUsed:30,happiness:80,income:12,managed:3,economy:EMPTY_ECONOMY};
const info=(over:Partial<HudInfo>={}):HudInfo=>({stats,tool:'explore',speed:1,place:'Vancouver',attribution:{text:'© OpenStreetMap contributors',url:'https://www.openstreetmap.org/copyright'},mapMessage:'',notice:'',saveStatus:{status:'idle',blocked:false},canOverwriteSave:false,rotation:0,...over});
const callbacks=()=>({onTool:vi.fn(),onPolicy:vi.fn(),onSpeed:vi.fn(),onPlace:vi.fn(),onRetryMap:vi.fn(),onOverwriteSave:vi.fn(),onOverview:vi.fn(),onZoomStep:vi.fn(),onRotateStep:vi.fn(),onNorth:vi.fn()}) satisfies HudCallbacks;
const tree=(selector:string,root:Document|HTMLElement=document)=>{
 const found=root.querySelector<HTMLElement>(selector);
 if(!found)throw new Error(`Elemento ausente no teste: ${selector}`);
 return found;
};
const DRESSER:LayoutMode={dock:'bottom',sheets:'drawer',inspector:'panel',floating:true,touch:false};
const SHEET:LayoutMode={dock:'bottom',sheets:'sheet',inspector:'card',floating:false,touch:true};
// A 1024x600 viewport with the screens sized like the real ones: the layout maths and the viewport clamp are exercised
// with real sizes rather than zeroes.
const mount=()=>{
 document.body.innerHTML=hudMarkup;
 Object.defineProperty(window,'innerWidth',{value:1024,configurable:true});
 Object.defineProperty(window,'innerHeight',{value:600,configurable:true});
 const hud=element('hud');
 stubRect(hud,0,0,1024,600);
 stubRect(element('panel-economy'),300,8,316,400);
 stubRect(element('panel-places'),700,52,280,300);
 return hud;
};
beforeEach(()=>{window.localStorage.clear();mount();});

test('the bar is always there, and it is the only thing that always is',()=>{
 const hud=createHud(element('hud'),callbacks());
 // Nothing is open until the player opens it: the city is the screen.
 expect(element('hud').dataset.sheet).toBeUndefined();
 expect(element('panel-economy').style.display).toBe('');
 hud.update(info());
 expect(element('hud-place').textContent).toBe('Vancouver');
 expect(element('hud-money').textContent).toBe('1.234');
 expect(element('hud-population').textContent).toBe('—');
 expect(element('economy-population').textContent).toBe('56');
 expect(element('hud-happiness').textContent).toBe('80%');
 expect(element('hud-energy').textContent).toBe('30/90');
 expect(element('hud-attribution').textContent).toContain('OpenStreetMap');
 hud.destroy();
});

test('Vancouver shows its dated real population instead of the 380 simulated residents',()=>{
 const hud=createHud(element('hud'),callbacks());
 hud.update(info({stats:{...stats,population:380},facts:{id:'Q24639',label:'Vancouver',population:662248,populationYear:2021,source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q24639',license:'CC0'}}}));
 expect(element('hud-population').textContent).toBe('662.248 · 2021');
 expect(element('hud-population').title).toContain('Wikidata');
 expect(element('hud-population').title).toContain('Vancouver');
 expect(element('economy-population').textContent).toBe('380');
 hud.destroy();
});

test('missing real demography never falls back to the simulated population',()=>{
 const hud=createHud(element('hud'),callbacks());
 hud.update(info({stats:{...stats,population:380},facts:null}));
 expect(element('hud-population').textContent).toBe('—');
 expect(element('hud-population').title).toContain('indisponível');
 hud.destroy();
});

test('travelling does not show Vancouver demography under the name Lisboa',()=>{
 const hud=createHud(element('hud'),callbacks());
 const facts={id:'Q24639',label:'Vancouver',population:662248,populationYear:2021,source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q24639',license:'CC0'}};
 hud.update(info({facts}));
 hud.update(info({place:'Lisboa',facts}));
 expect(element('hud-population').textContent).toBe('—');
 expect(element('hud-population').title).not.toContain('Vancouver');
 hud.destroy();
});

test('a screen opens from the dock, closes with its own button and with Escape, and only one is ever open',()=>{
 const hud=createHud(element('hud'),callbacks());
 const open=(sheet:string)=>tree(`button[data-sheet="${sheet}"]`);
 open('prefeitura').click();
 expect(element('hud').dataset.sheet).toBe('prefeitura');
 expect(open('prefeitura').getAttribute('aria-expanded')).toBe('true');
 // Opening another one replaces it: two screens over the city is the thing this shell exists to stop.
 open('lugares').click();
 expect(element('hud').dataset.sheet).toBe('lugares');
 expect(open('prefeitura').getAttribute('aria-expanded')).toBe('false');
 expect(hud.sheet()).toBe('lugares');
 // The screen's own button closes it, and so does Escape, which is the key that already means "back".
 tree('#panel-places [data-close]').click();
 expect(element('hud').dataset.sheet).toBeUndefined();
 expect(hud.sheet()).toBeNull();
 open('prefeitura').click();
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 expect(hud.sheet()).toBeNull();
 // And the menu of screens is a way in, not a place to stay.
 element('hud-more-toggle').click();
 expect(element('hud-more').hidden).toBe(false);
 open('prefeitura').click();
 expect(element('hud-more').hidden).toBe(true);
 hud.destroy();
});

test('every dynamic management screen has a shell address and reopens with its body intact',()=>{
 const root=element('hud'),noop=()=>{};
 const history=createWorldHistory(root,{onCreateVersion:noop,onExport:noop,onImport:noop,onBranch:noop,onCompare:noop,onRegion:noop});
 const composition=createWorldComposition(root,{onCompare:noop,onRegion:noop});
 const multiplayer=createMultiplayerPanel(root,{onCreate:noop,onJoin:noop,onInvite:noop,onLeave:noop,onContinueLocal:noop,onPause:noop,onTransfer:noop});
 const sources=createSourceInspector(root);
 const hud=createHud(root,callbacks());
 const screens:[string,string][]=[['historia','panel-history'],['planejamento','panel-composition'],['pessoas','panel-multiplayer'],['fontes','panel-source']];
 for(const [sheet,id] of screens){
  const panel=element(id),body=tree('[data-panel-body]',panel);
  expect(panel.dataset.sheet,id).toBe(sheet);
  hud.openSheet(sheet);
  expect(root.dataset.sheet,id).toBe(sheet);
  expect(hud.sheet(),id).toBe(sheet);
  expect(body.hidden,id).toBe(false);
  tree('[data-close]',panel).click();
  expect(hud.sheet(),id).toBeNull();
  hud.openSheet(sheet);
  expect(body.hidden,id).toBe(false);
 }
 hud.destroy();history.destroy();composition.destroy();multiplayer.destroy();sources.destroy();
});
test('a screen is dragged where dragging means something, and left to the stylesheet where it does not',()=>{
 const hud=createHud(element('hud'),callbacks());
 const economy=element('panel-economy');
 hud.setMode(DRESSER);
 hud.openSheet('prefeitura');
 drag(tree('#panel-economy [data-drag-handle]'),[320,20],[420,300]);
 expect(economy.style.left).toBe('400px');
 // The screen is 400 tall in a 600 viewport: the drag asks for 288 and the clamp gives what fits.
 expect(economy.style.top).toBe('200px');
 // A phone has no room for a window the player can lose: the same drag leaves nothing behind, inline or otherwise.
 hud.setMode(SHEET);
 expect(economy.style.left).toBe('');
 drag(tree('#panel-economy [data-drag-handle]'),[320,20],[520,500]);
 expect(economy.style.left).toBe('');
 expect(economy.style.top).toBe('');
 hud.destroy();
});

test('an arrangement is remembered where it can be, and forgotten when the layout changes',()=>{
 window.localStorage.setItem('open-sim:panels',JSON.stringify({economy:{x:120,y:90}}));
 const hud=createHud(element('hud'),callbacks());
 hud.setMode(DRESSER);
 expect(element('panel-economy').style.left).toBe('120px');
 // A rotation is not a reason to keep a screen where it was: the arrangement starts again from the stylesheet.
 hud.setMode(SHEET);
 expect(element('panel-economy').style.left).toBe('');
 hud.destroy();
});

test('destroy stops listening to drags, to the dock and to the keyboard',()=>{
 const hud=createHud(element('hud'),callbacks());
 const cbs=callbacks();
 const other=createHud(element('hud'),cbs);
 other.setMode(DRESSER);
 other.openSheet('prefeitura');
 other.destroy();
 const economy=element('panel-economy');
 drag(tree('#panel-economy [data-drag-handle]'),[320,20],[420,300]);
 expect(economy.style.left).toBe('');
 tree('button[data-tool="road"]').click();
 expect(cbs.onTool).not.toHaveBeenCalled();
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 expect(other.sheet()).toBe('prefeitura');
 hud.destroy();
});

test('the dock fires the tool, the speed, the places and the camera cluster',()=>{
 const cbs=callbacks();
 const hud=createHud(element('hud'),cbs);
 hud.update(info());
 tree('button[data-tool="avenue"]').click();
 expect(cbs.onTool).toHaveBeenCalledWith('avenue');
 tree('button[data-speed="2"]').click();
 expect(cbs.onSpeed).toHaveBeenCalledWith(2);
 tree('button[data-place="Lisboa"]').click();
 expect(cbs.onPlace).toHaveBeenCalledWith('Lisboa');
 tree('#hud-zoom-in').click();
 expect(cbs.onZoomStep).toHaveBeenCalledWith(1);
 tree('#hud-zoom-out').click();
 expect(cbs.onZoomStep).toHaveBeenLastCalledWith(-1);
 tree('#hud-rotate-left').click();
 expect(cbs.onRotateStep).toHaveBeenCalledWith(-1);
 tree('#hud-rotate-right').click();
 expect(cbs.onRotateStep).toHaveBeenLastCalledWith(1);
 tree('#hud-north').click();
 expect(cbs.onNorth).toHaveBeenCalled();
 tree('#hud-overview').click();
 expect(cbs.onOverview).toHaveBeenCalled();
 // The cost is on the button, so the price of a tool is where the player chooses it.
 expect(tree('button[data-tool="highway"] .tool-cost').textContent).toBe('60');
 // Exploring the city costs nothing, so it shows no price at all.
 expect(tree('button[data-tool="explore"]').querySelector('.tool-cost')).toBeNull();
 hud.destroy();
});

test('the readouts turn with the camera and report what the city is saying',()=>{
 const hud=createHud(element('hud'),callbacks());
 hud.update(info({rotation:.5,notice:'Nada a mudar',mapMessage:'Carregando mapa…',saveStatus:{status:'saving',blocked:false}}));
 expect(element('hud-compass-needle').style.transform).toBe('rotate(0.5rad)');
 expect(element('command-notice').hidden).toBe(false);
 expect(element('command-notice').textContent).toBe('Nada a mudar');
 expect(element('map-message').hidden).toBe(false);
 expect(element('map-retry').hidden).toBe(false);
 expect(element('save-status').textContent).toBe('Salvando…');
 // A refusal that is not there leaves nothing behind it.
 hud.update(info());
 expect(element('command-notice').hidden).toBe(true);
 expect(element('map-message').hidden).toBe(true);
 expect(element('save-status').textContent).toBe('');
 hud.destroy();
});

test('the economy screen shows the books the world reports, and a lever is one decision',()=>{
 const cbs=callbacks();
 const hud=createHud(element('hud'),cbs);
 const economy:CityEconomy={taxPercent:15,servicesPercent:80,serviceLevel:0.56,demand:{residential:-40,commercial:12,industrial:200},landValueAverage:88,monthly:{revenue:640,expense:775,net:-135},debt:30_000,interestRate:8,rating:'C',crisis:null};
 hud.update(info({stats:{...stats,economy}}));
 expect(element('economy-revenue').textContent).toBe('640');
 expect(element('economy-expense').textContent).toBe('775');
 expect(element('economy-net').textContent).toBe('-135');
 expect(element('economy-net').classList.contains('negative')).toBe(true);
 expect(element('economy-land').textContent).toBe('88');
 expect(element('economy-debt').textContent).toBe('30.000');
 expect(element('economy-interest').textContent).toBe('8% ao ano');
 expect(element('economy-rating').textContent).toBe('C');
 expect(element('economy-demand').textContent).toBe('-40 / 12 / 200');
 expect(element<HTMLInputElement>('economy-tax').value).toBe('15');
 expect(element('economy-tax-value').textContent).toBe('15%');
 // The services lever shows the budget that was set, not the level it produces.
 expect(element<HTMLInputElement>('economy-services').value).toBe('80');
 expect(element('economy-services-value').textContent).toBe('80%');
 // Dragging writes the number under the finger but sends nothing; letting go sends exactly one decision.
 const tax=element<HTMLInputElement>('economy-tax');
 tax.value='18';
 tax.dispatchEvent(new Event('input',{bubbles:true}));
 expect(element('economy-tax-value').textContent).toBe('18%');
 expect(cbs.onPolicy).not.toHaveBeenCalled();
 tax.dispatchEvent(new Event('change',{bubbles:true}));
 expect(cbs.onPolicy).toHaveBeenCalledExactlyOnceWith({tax:18});
 element<HTMLButtonElement>('economy-borrow').click();
 expect(cbs.onPolicy).toHaveBeenLastCalledWith({borrow:10_000});
 hud.update(info({stats:{...stats,economy:{...economy,monthly:{revenue:0,expense:775,net:-775},crisis:'O caixa acabou.'}}}));
 expect(element('economy-crisis').hidden).toBe(false);
 expect(element('economy-crisis').textContent).toBe('O caixa acabou.');
 hud.destroy();
});
test('sheet focus returns to its opener when dismissed',()=>{
 const hud=createHud(mount(),callbacks());const button=tree('button[data-sheet="lugares"]');button.focus();button.click();
 tree('#panel-places [data-close]').click();expect(document.activeElement).toBe(button);hud.destroy();
});

test('population credit follows the statistical measure instead of the encyclopedia identity',()=>{
 const root=mount(),hud=createHud(root,callbacks());hud.update(info({facts:{id:'Q24639',label:'Vancouver',population:662248,populationYear:2021,source:{dataset:'Wikidata',url:'https://www.wikidata.org/wiki/Q24639',license:'CC0'},measures:{population:{value:662248,unit:'people',source:{dataset:'Statistics Canada Census 2021',url:'https://www12.statcan.gc.ca/census-recensement/2021/',territoryId:'2021A00055915022',retrievedAt:'2026-10-03T00:00:00Z',observedYear:2021,method:'reported'}}}}}));expect(element('hud-population').title).toContain('Statistics Canada Census 2021');expect(element('hud-population').title).toContain('https://www12.statcan.gc.ca');hud.destroy();
});
test('source panel participates in responsive sheet layout',()=>{const root=mount(),panel=createSourceInspector(root);expect(element('panel-source').closest('#hud-sheets')).not.toBeNull();panel.destroy();});
test('source addresses are clickable without interpreting provider text as markup',()=>{const root=mount(),panel=createSourceInspector(root);panel.update({title:'Fonte',rows:[{label:'Origem',value:'2026 · CAD · https://example.test/source?q=1&year=2026'},{label:'Texto',value:'<img src=x onerror=alert(1)>'}],notes:[],message:''});const link=element('panel-source').querySelector('a');expect(link?.getAttribute('href')).toBe('https://example.test/source?q=1&year=2026');expect(element('panel-source').querySelector('img')).toBeNull();panel.destroy();});
test('reflow clamps floating panels after resize within the same layout mode',()=>{
 window.localStorage.setItem('open-sim:panels',JSON.stringify({'economy':{x:700,y:180}}));
 const hud=createHud(element('hud'),callbacks());hud.setMode(DRESSER);
 Object.defineProperty(window,'innerWidth',{value:700,configurable:true});
 hud.reflow();
 expect(Number.parseFloat(element('panel-economy').style.left)).toBeLessThanOrEqual(384);
 hud.destroy();
});
