import {createSceneGeography} from './scene-geography';
import {buildingRaster} from '../surfaces/canvas/building-raster';
import {createVisualTileDecoder} from './visual-tile-decoder';
import type {SceneWorkerRequest,SceneWorkerResult} from './scene-worker-protocol';
import type {WorldView} from '../surfaces/canvas/canvas-renderer';
import {render} from '../surfaces/canvas/canvas-renderer';
import {sceneRasterCache} from '../surfaces/canvas/scene-cache';
import {createTerrainSurface} from '../presentation/terrain-surface';
import {resetGeographicComposition} from '../surfaces/canvas/geographic-renderer';
type Scope={onmessage:((event:MessageEvent<SceneWorkerRequest>)=>void)|null;postMessage(result:SceneWorkerResult,transfer:Transferable[]):void};
const decoder=createVisualTileDecoder();
const geographicScene=createSceneGeography(tile=>decoder.decode(tile));
const scope=globalThis as unknown as Scope;
let surface:OffscreenCanvas|undefined,context:CanvasRenderingContext2D|undefined,view:WorldView|undefined,staticKey='';
scope.onmessage=event=>{
 const request=event.data,start=performance.now(),patch=request.scene;
 if(!surface||surface.width!==request.viewport.width||surface.height!==request.viewport.height){surface=new OffscreenCanvas(request.viewport.width,request.viewport.height);context=surface.getContext('2d',{alpha:false,desynchronized:true}) as unknown as CanvasRenderingContext2D;staticKey='';}
 if(!context)throw new Error('Worker Canvas2D unavailable');
 const terrain=patch?.terrain?{...patch.terrain,sample:createTerrainSurface(patch.terrain.tiles).sample}:view?.terrain;
 const preparing=staticKey!==request.key;
 view={...view,state:patch?.state??view!.state,geography:patch&&'geography' in patch?(patch.geography?geographicScene.apply(patch.geography):(geographicScene.clear(),undefined)):view?.geography,playerPower:patch?.playerPower??view?.playerPower,terrain,seed:patch?.seed??view!.seed,camera:request.camera,viewport:request.viewport,pixelRatio:request.pixelRatio,light:request.light,motion:preparing?0:request.motion,quality:request.policy,mobility:preparing?[]:request.mobility,signals:preparing?[]:request.signals,vessels:preparing?[]:request.vessels,aircraft:preparing?[]:request.aircraft,chunks:patch?.chunks??view?.chunks??new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true};
 sceneRasterCache.setLimit(request.policy.workerRasterBytes);
 if(preparing)resetGeographicComposition(context);
 render(context,view);staticKey=request.key;
 const bitmap=surface.transferToImageBitmap();
 // Keep the retained composition after transferring ownership of the published pixels.
 context.drawImage(bitmap,0,0);
 const stats=sceneRasterCache.stats();scope.postMessage({ticket:request.ticket,key:request.key,staticReady:true,staticOnly:preparing,bitmap,cache:{bytes:stats.bytes,entries:stats.entries,rasterContexts:buildingRaster.stats().contexts},workMs:performance.now()-start},[bitmap]);
};
