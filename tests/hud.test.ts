// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {beforeEach,expect,test,vi} from 'vitest';
import {EMPTY_ECONOMY} from '../src/core/model';
import type {CityEconomy,CityStats} from '../src/core/model';
import {createHud} from '../src/presentation/hud';
import type {HudCallbacks,HudInfo} from '../src/presentation/hud';
// The panels are painted by index.html: the tests mount that very markup instead of a hand-made copy.
const hudMarkup=new DOMParser().parseFromString(readFileSync('index.html','utf8'),'text/html').querySelector('#hud')?.outerHTML??'';
const element=<T extends HTMLElement>(id:string)=>{
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
const callbacks=()=>({onTool:vi.fn(),onPolicy:vi.fn(),onSpeed:vi.fn(),onPlace:vi.fn(),onRetryMap:vi.fn(),onOverwriteSave:vi.fn(),onOverview:vi.fn(),onZoomStep:vi.fn(),onNorth:vi.fn()}) satisfies HudCallbacks;
const tree=(selector:string,root:Document|HTMLElement=document)=>{
 const found=root.querySelector<HTMLElement>(selector);
 if(!found)throw new Error(`Elemento ausente no teste: ${selector}`);
 return found;
};
const body=(panel:string)=>tree(`#${panel} [data-panel-body]`);
const handle=(panel:string)=>tree(`#${panel} [data-drag-handle]`);
const collapse=(panel:string)=>tree(`#${panel} [data-collapse]`);
// A 1024x600 viewport with panels sized like the real ones: the layout is faked so the drag maths and the viewport
// clamp are exercised with real sizes.
const mount=()=>{
 document.body.innerHTML=hudMarkup;
 Object.defineProperty(window,'innerWidth',{value:1024,configurable:true});
 Object.defineProperty(window,'innerHeight',{value:600,configurable:true});
 stubRect(element('hud'),0,0,1024,600);
 stubRect(element('panel-stats'),8,8,320,100);
 stubRect(element('panel-tools'),8,450,250,140);
 stubRect(element('panel-places'),766,8,250,180);
 stubRect(element('panel-nav'),900,276,90,80);
 stubRect(element('panel-status'),696,500,320,92);
 return element('hud');
};
beforeEach(()=>{window.localStorage.clear();mount();});
test('dragging a header moves its panel and clamps it inside the viewport',()=>{
 const hud=createHud(element('hud'),callbacks());
 const tools=element('panel-tools');
 drag(handle('panel-tools'),[20,460],[120,300]);
 expect(tools.style.left).toBe('108px');
 expect(tools.style.top).toBe('290px');
 expect(tools.style.right).toBe('auto');
 expect(tools.style.bottom).toBe('auto');
 drag(handle('panel-tools'),[10,10],[9000,9000]);
 expect(tools.style.left).toBe('774px');
 expect(tools.style.top).toBe('460px');
 drag(handle('panel-tools'),[5000,5000],[-5000,-5000]);
 expect(tools.style.left).toBe('0px');
 expect(tools.style.top).toBe('0px');
 expect(JSON.parse(localStorage.getItem('open-sim:panels')??'null')).toEqual({tools:{x:0,y:0,collapsed:false}});
 hud.destroy();
});
test('a header drag leaves the other panels alone and a right click never starts one',()=>{
 const hud=createHud(element('hud'),callbacks());
 pointer(handle('panel-stats'),'pointerdown',20,20,2);
 pointer(window,'pointermove',400,400);
 pointer(window,'pointerup',400,400);
 expect(element('panel-stats').style.left).toBe('');
 drag(handle('panel-stats'),[20,20],[60,60]);
 expect(element('panel-stats').style.left).toBe('48px');
 expect(element('panel-stats').style.top).toBe('48px');
 expect(element('panel-tools').style.left).toBe('');
 expect(element('panel-tools').style.top).toBe('');
 hud.destroy();
});
test('a tool button still fires after its panel was dragged',()=>{
 const cb=callbacks(),hud=createHud(element('hud'),cb);
 drag(handle('panel-tools'),[20,460],[300,120]);
 expect(cb.onTool).not.toHaveBeenCalled();
 tree('#panel-tools [data-tool="road"]').click();
 expect(cb.onTool).toHaveBeenCalledTimes(1);
 expect(cb.onTool).toHaveBeenCalledWith('road');
 hud.destroy();
});
test('the collapse button hides the body, flips aria-expanded and survives a reload',()=>{
 const cb=callbacks(),hud=createHud(element('hud'),cb);
 expect(body('panel-stats').hidden).toBe(false);
 expect(collapse('panel-stats').getAttribute('aria-expanded')).toBe('true');
 pointer(collapse('panel-stats'),'pointerdown',20,20);
 pointer(window,'pointermove',400,400);
 pointer(window,'pointerup',400,400);
 expect(element('panel-stats').style.left).toBe('');
 collapse('panel-stats').click();
 expect(body('panel-stats').hidden).toBe(true);
 expect(element('panel-stats').classList.contains('collapsed')).toBe(true);
 expect(collapse('panel-stats').getAttribute('aria-expanded')).toBe('false');
 collapse('panel-stats').click();
 expect(body('panel-stats').hidden).toBe(false);
 expect(collapse('panel-stats').getAttribute('aria-expanded')).toBe('true');
 collapse('panel-stats').click();
 hud.destroy();
 const reloaded=createHud(mount(),cb);
 expect(body('panel-stats').hidden).toBe(true);
 expect(collapse('panel-stats').getAttribute('aria-expanded')).toBe('false');
 expect(element('panel-stats').style.left).toBe('8px');
 reloaded.destroy();
});
test('panel positions and collapsed state restore from a pre-filled localStorage',()=>{
 window.localStorage.setItem('open-sim:panels',JSON.stringify({tools:{x:100,y:200,collapsed:false},places:{x:5000,y:-40,collapsed:true},ghost:{x:10,y:10,collapsed:false},broken:{x:'nope',y:3},junk:null}));
 const hud=createHud(element('hud'),callbacks());
 expect(element('panel-tools').style.left).toBe('100px');
 expect(element('panel-tools').style.top).toBe('200px');
 expect(element('panel-places').style.left).toBe('774px');
 expect(element('panel-places').style.top).toBe('0px');
 expect(body('panel-places').hidden).toBe(true);
 expect(collapse('panel-places').getAttribute('aria-expanded')).toBe('false');
 expect(element('panel-nav').style.left).toBe('');
 drag(handle('panel-tools'),[100,200],[110,210]);
 const saved=JSON.parse(localStorage.getItem('open-sim:panels')??'null');
 expect(saved.tools).toEqual({x:110,y:210,collapsed:false});
 expect(saved.places).toEqual({x:774,y:0,collapsed:true});
 expect(saved.ghost).toBeUndefined();
 hud.destroy();
});
test('destroy stops listening to drags, collapses and clicks',()=>{
 const cb=callbacks(),hud=createHud(element('hud'),cb);
 drag(handle('panel-tools'),[20,460],[120,300]);
 const moved=element('panel-tools').style.left;
 hud.destroy();
 pointer(handle('panel-tools'),'pointerdown',500,500);
 pointer(window,'pointermove',0,0);
 pointer(window,'pointerup',0,0);
 expect(element('panel-tools').style.left).toBe(moved);
 collapse('panel-tools').click();
 expect(body('panel-tools').hidden).toBe(false);
 tree('#panel-tools [data-tool="park"]').click();
 expect(cb.onTool).not.toHaveBeenCalled();
});
test('the map panel steps the zoom and asks for north',()=>{
 const cb=callbacks(),hud=createHud(element('hud'),cb);
 element('hud-zoom-in').click();
 element('hud-zoom-out').click();
 element('hud-zoom-out').click();
 element('hud-north').click();
 element('hud-overview').click();
 expect(cb.onZoomStep.mock.calls).toEqual([[1],[-1],[-1]]);
 expect(cb.onNorth).toHaveBeenCalledTimes(1);
 expect(cb.onOverview).toHaveBeenCalledTimes(1);
 hud.destroy();
});
test('update writes the readouts and turns the compass with the camera',()=>{
 const hud=createHud(element('hud'),callbacks());
 hud.update(info({rotation:Math.PI/2,tool:'road',speed:2,place:'Lisboa',mapMessage:'Falha no mapa',notice:'Sem energia',saveStatus:{status:'error',blocked:true,message:'versão'},canOverwriteSave:true}));
 expect(element('hud-place').textContent).toBe('Lisboa');
 expect(element('hud-money').textContent).toBe((1234).toLocaleString('pt-BR'));
 expect(element('hud-energy').textContent).toBe('30/90');
 expect(element('hud-happiness').textContent).toBe('80%');
 expect(tree('#panel-tools [data-tool="road"]').getAttribute('aria-pressed')).toBe('true');
 expect(element('map-message').hidden).toBe(false);
 expect(element('save-overwrite').hidden).toBe(false);
 const turn=/rotate\((-?[\d.]+)rad\)/.exec(tree('#hud-compass-needle').style.transform);
 expect(turn).not.toBeNull();
 expect(Number(turn?.[1])).toBeCloseTo(Math.PI/2,9);
 hud.update(info({rotation:0,mapMessage:''}));
 expect(tree('#hud-compass-needle').style.transform).toBe('rotate(0rad)');
 expect(element('map-message').hidden).toBe(true);
 hud.destroy();
});

// The economy panel is the game's books: every line is read from the state, and a lever becomes one decision when the
// player lets go of it — not one per pixel of the drag.
test('the economy panel shows the books the world reports, and a lever is one decision',()=>{
 const cbs=callbacks();
 const hud=createHud(element('hud'),cbs);
 const economy:CityEconomy={taxPercent:15,servicesPercent:80,serviceLevel:0.56,demand:{residential:-40,commercial:12,industrial:200},landValueAverage:88,monthly:{revenue:640,expense:775,net:-135},debt:30_000,interestRate:8,rating:'C',crisis:null};
 hud.update(info({stats:{...stats,economy}}));
 expect(element('economy-revenue').textContent).toBe('640');
 expect(element('economy-expense').textContent).toBe('775');
 expect(element('economy-net').textContent).toBe('-135');
 expect(element<HTMLElement>('economy-net').classList.contains('negative')).toBe(true);
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
 // A loan is a decision with no slider behind it.
 element<HTMLButtonElement>('economy-borrow').click();
 expect(cbs.onPolicy).toHaveBeenLastCalledWith({borrow:10_000});
 // The crisis is the sentence the state carries, shown when the city is out of money.
 hud.update(info({stats:{...stats,economy:{...economy,monthly:{revenue:0,expense:775,net:-775},crisis:'O caixa acabou.'}}}));
 const crisis=element('economy-crisis');
 expect(crisis.hidden).toBe(false);
 expect(crisis.textContent).toBe('O caixa acabou.');
});
