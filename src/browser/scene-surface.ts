import {staticSceneKey,createSceneWorkerClient} from './scene-worker-client';
import type {SceneWorkerResult} from './scene-worker-protocol';
import type {WorldView} from '../surfaces/canvas/canvas-renderer';
import {render} from '../surfaces/canvas/canvas-renderer';
import {sameSceneFrame} from '../surfaces/canvas/scene-frame';
import {createNavigationRenderer,cameraReprojection} from '../surfaces/canvas/navigation-renderer';
import {drawInteractionOverlay,resetGeographicComposition} from '../surfaces/canvas/geographic-renderer';
import {createGpuPresenter} from '../surfaces/canvas/gpu-presenter';
import {renderPolicy} from '../presentation/render-policy';
import {GLOBE_ZOOM} from '../presentation/geographic-map';
import {sceneRasterCache} from '../surfaces/canvas/scene-cache';
export function createSceneSurface(ctx:CanvasRenderingContext2D,changed:()=>void,memoryGb?:number,observed?:(view:WorldView,workMs:number,ownedBytes:number,geometryPressure?:boolean)=>void){
 const canvas=ctx.canvas as HTMLCanvasElement,fallback=createNavigationRenderer(render,resetGeographicComposition);
 let displayed:{result:SceneWorkerResult;camera:WorldView['camera'];pictureReady:boolean}|undefined,incoming:typeof displayed,lastSubmitted:WorldView|undefined,gpu:ReturnType<typeof createGpuPresenter>,gpuCanvas:HTMLCanvasElement|undefined,disposed=false,forcePresent=false,lastSubmitAt=-Infinity,lastPresented:Pick<WorldView,'camera'|'viewport'|'preview'|'hover'|'tool'|'previewAffordable'>|undefined,fallbackPicture=false;
 const release=()=>{incoming?.result.bitmap.close();incoming=undefined;displayed?.result.bitmap.close();displayed=undefined;};
 const removeGpu=()=>{gpu?.dispose();gpu=undefined;gpuCanvas?.remove();gpuCanvas=undefined;canvas.style.background='';forcePresent=true;lastPresented=undefined;};
 let recoveryAttempts=0,retryTimer:ReturnType<typeof setTimeout>|undefined;
 const armRecovery=()=>{if(disposed||retryTimer!==undefined||recoveryAttempts>=2)return;retryTimer=setTimeout(()=>{retryTimer=undefined;if(disposed)return;recoveryAttempts++;restart();},recoveryAttempts===0?3000:30000);};
 const makeClient=()=>createSceneWorkerClient(undefined,()=>{removeGpu();lastSubmitted=undefined;armRecovery();changed();},(result,view)=>{observed?.(view,result.workMs,(result.geometryBytes??0)+(result.cache?.bytes??0),!!result.geometryPressure&&!!result.staticOnly);incoming?.result.bitmap.close();incoming={result,camera:{...view.camera},pictureReady:result.pictureReady??(!view.geography||view.geography.tiles.length>0||view.camera.zoom<GLOBE_ZOOM)};changed();});
 let client=makeClient();
 const restart=()=>{client.dispose();client=makeClient();lastSubmitted=undefined;lastPresented=undefined;forcePresent=true;if(!client.available())armRecovery();changed();};
 if(!client.available())armRecovery();
 if(client.available()){
  gpuCanvas=canvas.ownerDocument.createElement('canvas');gpuCanvas.setAttribute('aria-hidden','true');gpuCanvas.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';canvas.before(gpuCanvas);
  gpu=createGpuPresenter(gpuCanvas,()=>{removeGpu();changed();},memoryGb!==undefined&&memoryGb<=4);
  if(gpu)canvas.style.background='transparent';else {gpuCanvas.remove();gpuCanvas=undefined;}
 }
 return {
  ready:(view:WorldView)=>view.geography&&!client.available()?false:client.ready(view),
  pending:()=>forcePresent||!!incoming||!client.available()&&fallback.pending(),
  available:()=>client.available(),
  retry(){if(disposed||client.available())return;if(retryTimer!==undefined){clearTimeout(retryTimer);retryTimer=undefined;}recoveryAttempts=0;restart();},
  draw(view:WorldView,now:number):boolean{
   if(disposed)return false;forcePresent=false;
   if(!client.available()&&!view.geography){sceneRasterCache.setLimit(renderPolicy(memoryGb,view.viewport.width,view.viewport.height).workerRasterBytes);fallbackPicture=true;fallback.draw(ctx,view,now);return true;}
   const policy=renderPolicy(memoryGb,view.viewport.width,view.viewport.height);
   const urgent=!lastSubmitted||staticSceneKey(lastSubmitted)!==staticSceneKey(view);
   if(client.available()&&!sameSceneFrame(lastSubmitted,view)&&(urgent||now-lastSubmitAt>=1000/policy.dynamicFps)){client.submit(view,policy);lastSubmitted=view;lastSubmitAt=now;}
   const received=!!incoming,paint=received||!lastPresented||lastPresented.camera.x!==view.camera.x||lastPresented.camera.y!==view.camera.y||lastPresented.camera.zoom!==view.camera.zoom||lastPresented.camera.rotation!==view.camera.rotation||lastPresented.preview!==view.preview||lastPresented.tool!==view.tool||lastPresented.previewAffordable!==view.previewAffordable||lastPresented.hover?.x!==view.hover?.x||lastPresented.hover?.y!==view.hover?.y||lastPresented.viewport.width!==view.viewport.width||lastPresented.viewport.height!==view.viewport.height;
   if(!paint)return false;lastPresented={camera:{...view.camera},viewport:{...view.viewport},preview:view.preview,hover:view.hover,tool:view.tool,previewAffordable:view.previewAffordable};
   if(incoming){if(!incoming.pictureReady&&displayed?.pictureReady){incoming.result.bitmap.close();incoming=undefined;}else{displayed?.result.bitmap.close();displayed=incoming;incoming=undefined;if(gpu)try{gpu.upload(displayed.result.bitmap);}catch{removeGpu();}}}
   if(gpu&&displayed){gpu.draw(displayed.camera,view.camera,view.viewport);ctx.clearRect(0,0,view.viewport.width,view.viewport.height);}
   else {
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#b6bd96';ctx.fillRect(0,0,view.viewport.width,view.viewport.height);
    if(displayed){const [a,b,c,d,e,f]=cameraReprojection(displayed.camera,view.camera);ctx.setTransform(a,b,c,d,e,f);ctx.drawImage(displayed.result.bitmap,0,0);}ctx.restore();
   }
   drawInteractionOverlay(ctx,view);
   return true;
  },
  status:()=>({...client.status(),pictureReady:displayed?.pictureReady??fallbackPicture,recoveryNeeded:!client.available(),recovering:retryTimer!==undefined,recoveryAttempts,backend:gpu?'webgl2':client.available()?'worker-canvas2d':'canvas2d',displayBytes:(displayed?displayed.result.bitmap.width*displayed.result.bitmap.height*4:0)+(gpu?.bytes()??0)}),
  dispose(){disposed=true;if(retryTimer!==undefined)clearTimeout(retryTimer);client.dispose();release();removeGpu();fallback.dispose();sceneRasterCache.clear();},
 };
}
