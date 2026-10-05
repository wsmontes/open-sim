// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
import {createSceneSurface} from '../src/browser/scene-surface';
const hooks=vi.hoisted(()=>({lost:()=>{},failed:()=>{},publish:(_result:unknown,_view:unknown)=>{},available:true,fallbackDraw:vi.fn()}));
vi.mock('../src/browser/scene-worker-client',()=>({staticSceneKey:()=>'',createSceneWorkerClient:(_factory:unknown,failed:()=>void,publish:typeof hooks.publish)=>{hooks.failed=()=>{hooks.available=false;failed();};hooks.publish=publish;return {available:()=>hooks.available,ready:()=>true,submit(){},status:()=>({}),dispose(){}};}}));
vi.mock('../src/surfaces/canvas/gpu-presenter',()=>({createGpuPresenter:(_canvas:unknown,lost:()=>void)=>{hooks.lost=lost;return {upload(){},draw(){},dispose(){},bytes:()=>0};}}));
vi.mock('../src/surfaces/canvas/navigation-renderer',()=>({cameraReprojection:()=>[1,0,0,1,0,0],createNavigationRenderer:()=>({draw:hooks.fallbackDraw,pending:()=>false,dispose(){}})}));
vi.mock('../src/surfaces/canvas/geographic-renderer',()=>({drawInteractionOverlay(){},resetGeographicComposition(){}}));
const view:WorldView={camera:{x:0,y:0,zoom:1,rotation:0},viewport:{width:400,height:300},state:createGame('fixture',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0};
it('forces a paused unchanged scene to repaint after GPU loss and worker failure',()=>{hooks.available=true;hooks.fallbackDraw.mockClear();const canvas=document.createElement('canvas');document.body.append(canvas);const drawImage=vi.fn(),ctx=new Proxy({canvas,drawImage},{get:(target,key)=>key in target?target[key as keyof typeof target]:()=>{}}) as unknown as CanvasRenderingContext2D,surface=createSceneSurface(ctx,()=>{});surface.draw(view,0);hooks.publish({bitmap:{width:400,height:300,close(){}},staticReady:true},view);surface.draw(view,1);expect(surface.draw(view,2)).toBe(false);hooks.lost();expect(surface.pending()).toBe(true);expect(surface.draw(view,3)).toBe(true);expect(drawImage).toHaveBeenCalledOnce();hooks.failed();expect(surface.pending()).toBe(true);surface.draw(view,4);expect(hooks.fallbackDraw).toHaveBeenCalledOnce();surface.dispose();canvas.remove();});
