// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
import {createSceneSurface} from '../src/browser/scene-surface';
const hooks=vi.hoisted(()=>({lost:()=>{},failed:()=>{},publish:(_result:unknown,_view:unknown)=>{},available:true,created:0,fallbackDraw:vi.fn()}));
vi.mock('../src/browser/scene-worker-client',()=>({staticSceneKey:()=>'',createSceneWorkerClient:(_factory:unknown,failed:()=>void,publish:typeof hooks.publish)=>{hooks.created++;hooks.available=true;hooks.failed=()=>{hooks.available=false;failed();};hooks.publish=publish;return {available:()=>hooks.available,ready:()=>true,submit(){},status:()=>({}),dispose(){}};}}));
vi.mock('../src/surfaces/canvas/gpu-presenter',()=>({createGpuPresenter:(_canvas:unknown,lost:()=>void)=>{hooks.lost=lost;return {upload(){},draw(){},dispose(){},bytes:()=>0};}}));
vi.mock('../src/surfaces/canvas/navigation-renderer',()=>({cameraReprojection:()=>[1,0,0,1,0,0],createNavigationRenderer:()=>({draw:hooks.fallbackDraw,pending:()=>false,dispose(){}})}));
vi.mock('../src/surfaces/canvas/geographic-renderer',()=>({drawInteractionOverlay(){},resetGeographicComposition(){}}));
const view:WorldView={camera:{x:0,y:0,zoom:1,rotation:0},viewport:{width:400,height:300},state:createGame('fixture',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0};
it('forces a paused unchanged scene to repaint after GPU loss and worker failure',()=>{hooks.available=true;hooks.fallbackDraw.mockClear();const canvas=document.createElement('canvas');document.body.append(canvas);const drawImage=vi.fn(),ctx=new Proxy({canvas,drawImage},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}}) as unknown as CanvasRenderingContext2D,surface=createSceneSurface(ctx,()=>{});surface.draw(view,0);hooks.publish({bitmap:{width:400,height:300,close(){}},staticReady:true},view);surface.draw(view,1);expect(surface.draw(view,2)).toBe(false);hooks.lost();expect(surface.pending()).toBe(true);expect(surface.draw(view,3)).toBe(true);expect(drawImage).toHaveBeenCalledOnce();hooks.failed();expect(surface.pending()).toBe(true);surface.draw(view,4);expect(hooks.fallbackDraw).toHaveBeenCalledOnce();surface.dispose();canvas.remove();});
it('reports actual published worker cost and owned bytes to adaptive detail',()=>{
 hooks.available=true;const observe=vi.fn(),canvas=document.createElement('canvas');document.body.append(canvas);
 const ctx=new Proxy({canvas},{get:(t,k)=>k in t?t[k as keyof typeof t]:()=>{}}) as unknown as CanvasRenderingContext2D;
 const surface=createSceneSurface(ctx,()=>{},2,observe);hooks.publish({bitmap:{width:400,height:300,close(){}},workMs:90,geometryBytes:2048,cache:{bytes:1024}},view);
 expect(observe).toHaveBeenCalledWith(view,90,expect.any(Number),false);expect(observe.mock.calls[0][2]).toBeGreaterThanOrEqual(3072);surface.dispose();canvas.remove();
});
it('preserves pixels after worker failure without decoding or drawing geographic geometry on the UI thread',()=>{
 hooks.available=true;hooks.fallbackDraw.mockClear();const canvas=document.createElement('canvas');document.body.append(canvas);
 const drawImage=vi.fn(),ctx=new Proxy({canvas,drawImage},{get:(t,k)=>k in t?t[k as keyof typeof t]:()=>{}}) as unknown as CanvasRenderingContext2D;
 const close=vi.fn(),geographic={...view,geography:{tiles:[{z:14,x:1,y:1,features:[]}],revision:1,loading:false,error:false}},surface=createSceneSurface(ctx,()=>{});
 surface.draw(geographic,0);hooks.publish({bitmap:{width:400,height:300,close},staticReady:true},geographic);surface.draw(geographic,1);hooks.failed();
 surface.draw({...geographic,camera:{...view.camera,x:20}},2);expect(hooks.fallbackDraw).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();expect(drawImage).toHaveBeenCalled();expect(surface.ready(geographic)).toBe(false);
 surface.dispose();expect(close).toHaveBeenCalledOnce();canvas.remove();
});
it('display readiness does not retain or re-read the input scene',()=>{
 hooks.available=true;const canvas=document.createElement('canvas');document.body.append(canvas);const ctx=new Proxy({canvas},{get:(t,k)=>k in t?t[k as keyof typeof t]:()=>{}}) as unknown as CanvasRenderingContext2D;
 const geographic={...view,geography:{tiles:[{z:14,x:1,y:1,features:[]}],revision:1,loading:false,error:false}},surface=createSceneSurface(ctx,()=>{});
 hooks.publish({bitmap:{width:400,height:300,close(){}},staticReady:true},geographic);surface.draw(geographic,1);
 Object.defineProperty(geographic,'geography',{get(){throw new Error('Retained input scene');}});expect(surface.status().pictureReady).toBe(true);surface.dispose();canvas.remove();
});

it('bounds automatic worker recovery and allows an explicit retry',()=>{
 vi.useFakeTimers();const canvas=document.createElement('canvas');document.body.append(canvas);const ctx=new Proxy({canvas},{get:(t,k)=>k in t?t[k as keyof typeof t]:()=>{}}) as unknown as CanvasRenderingContext2D;
 const surface=createSceneSurface(ctx,()=>{}),initial=hooks.created;
 try{hooks.failed();vi.advanceTimersByTime(2999);expect(hooks.created).toBe(initial);vi.advanceTimersByTime(1);expect(hooks.created).toBe(initial+1);hooks.failed();vi.advanceTimersByTime(30000);expect(hooks.created).toBe(initial+2);hooks.failed();vi.advanceTimersByTime(120000);expect(hooks.created).toBe(initial+2);surface.retry();expect(hooks.created).toBe(initial+3);}finally{surface.dispose();vi.useRealTimers();canvas.remove();}
});
it('a pressure-empty worker result cannot replace the last usable picture',()=>{
 hooks.available=true;const canvas=document.createElement('canvas');document.body.append(canvas);const ctx=new Proxy({canvas},{get:(t,k)=>k in t?t[k as keyof typeof t]:()=>{}}) as unknown as CanvasRenderingContext2D;
 const geographic={...view,geography:{tiles:[{z:14,x:1,y:1,features:[]}],revision:1,loading:false,error:false}},surface=createSceneSurface(ctx,()=>{}),goodClose=vi.fn(),emptyClose=vi.fn();
 hooks.publish({bitmap:{width:400,height:300,close:goodClose},pictureReady:true},geographic);surface.draw(geographic,0);
 hooks.publish({bitmap:{width:400,height:300,close:emptyClose},pictureReady:false,geometryPressure:true},geographic);surface.draw(geographic,1);
 expect(goodClose).not.toHaveBeenCalled();expect(emptyClose).toHaveBeenCalledOnce();expect(surface.status().pictureReady).toBe(true);surface.dispose();canvas.remove();
});
