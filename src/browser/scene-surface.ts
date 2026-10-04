import {createVisualTileDecoder} from './visual-tile-decoder';
import {staticSceneKey,createSceneWorkerClient} from './scene-worker-client';
import type {SceneWorkerResult} from './scene-worker-protocol';
import type {WorldView} from '../surfaces/canvas/canvas-renderer';
import {render} from '../surfaces/canvas/canvas-renderer';
import {sameSceneFrame} from '../surfaces/canvas/scene-frame';
import {createNavigationRenderer,cameraReprojection} from '../surfaces/canvas/navigation-renderer';
import {drawInteractionOverlay,resetGeographicComposition} from '../surfaces/canvas/geographic-renderer';
import {createGpuPresenter} from '../surfaces/canvas/gpu-presenter';
import {renderPolicy} from '../presentation/render-policy';
import {sceneRasterCache} from '../surfaces/canvas/scene-cache';
export function createSceneSurface(ctx:CanvasRenderingContext2D,changed:()=>void,memoryGb?:number){
 const decoder=createVisualTileDecoder();
 const canvas=ctx.canvas as HTMLCanvasElement,fallback=createNavigationRenderer(render,resetGeographicComposition);
 let displayed:{result:SceneWorkerResult;view:WorldView}|undefined,incoming:typeof displayed,lastSubmitted:WorldView|undefined,gpu:ReturnType<typeof createGpuPresenter>,gpuCanvas:HTMLCanvasElement|undefined,disposed=false,forcePresent=false,lastSubmitAt=-Infinity,lastPresented:WorldView|undefined;
 const release=()=>{incoming?.result.bitmap.close();incoming=undefined;displayed?.result.bitmap.close();displayed=undefined;};
 const removeGpu=()=>{gpu?.dispose();gpu=undefined;gpuCanvas?.remove();gpuCanvas=undefined;canvas.style.background='';forcePresent=true;lastPresented=undefined;};
 const client=createSceneWorkerClient(undefined,()=>{removeGpu();release();lastSubmitted=undefined;changed();},(result,view)=>{incoming?.result.bitmap.close();incoming={result,view};changed();});
 if(client.available()){
  gpuCanvas=canvas.ownerDocument.createElement('canvas');gpuCanvas.setAttribute('aria-hidden','true');gpuCanvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';canvas.before(gpuCanvas);
  gpu=createGpuPresenter(gpuCanvas,()=>{removeGpu();changed();},memoryGb!==undefined&&memoryGb<=4);
  if(gpu)canvas.style.background='transparent';else {gpuCanvas.remove();gpuCanvas=undefined;}
 }
 return {
  ready:(view:WorldView)=>client.ready(view),
  pending:()=>forcePresent||!!incoming||!client.available()&&fallback.pending(),
  available:client.available,
  draw(view:WorldView,now:number):boolean{
   if(disposed)return false;forcePresent=false;
   if(!client.available()){sceneRasterCache.setLimit(renderPolicy(memoryGb,view.viewport.width,view.viewport.height).workerRasterBytes);fallback.draw(ctx,view.geography?{...view,geography:{...view.geography,tiles:view.geography.tiles.map(t=>decoder.decode(t))}}:view,now);return true;}
   const policy=renderPolicy(memoryGb,view.viewport.width,view.viewport.height);
   const urgent=!lastSubmitted||staticSceneKey(lastSubmitted)!==staticSceneKey(view);
   if(!sameSceneFrame(lastSubmitted,view)&&(urgent||now-lastSubmitAt>=1000/policy.dynamicFps)){client.submit(view,policy);lastSubmitted=view;lastSubmitAt=now;}
   const received=!!incoming,paint=received||!lastPresented||lastPresented.camera.x!==view.camera.x||lastPresented.camera.y!==view.camera.y||lastPresented.camera.zoom!==view.camera.zoom||lastPresented.camera.rotation!==view.camera.rotation||lastPresented.preview!==view.preview||lastPresented.tool!==view.tool||lastPresented.previewAffordable!==view.previewAffordable||lastPresented.hover?.x!==view.hover?.x||lastPresented.hover?.y!==view.hover?.y||lastPresented.viewport.width!==view.viewport.width||lastPresented.viewport.height!==view.viewport.height;
   if(!paint)return false;lastPresented=view;
   if(incoming){displayed?.result.bitmap.close();displayed=incoming;incoming=undefined;if(gpu)try{gpu.upload(displayed.result.bitmap);}catch{removeGpu();}}
   if(gpu&&displayed){gpu.draw(displayed.view.camera,view.camera,view.viewport);ctx.clearRect(0,0,view.viewport.width,view.viewport.height);}
   else {
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#b6bd96';ctx.fillRect(0,0,view.viewport.width,view.viewport.height);
    if(displayed){const [a,b,c,d,e,f]=cameraReprojection(displayed.view.camera,view.camera);ctx.setTransform(a,b,c,d,e,f);ctx.drawImage(displayed.result.bitmap,0,0);}ctx.restore();
   }
   drawInteractionOverlay(ctx,view);
   return true;
  },
  status:()=>({...client.status(),backend:gpu?'webgl2':client.available()?'worker-canvas2d':'canvas2d',displayBytes:(displayed?displayed.result.bitmap.width*displayed.result.bitmap.height*4:0)+(gpu?.bytes()??0)}),
  dispose(){disposed=true;client.dispose();release();removeGpu();fallback.dispose();decoder.clear();sceneRasterCache.clear();},
 };
}
