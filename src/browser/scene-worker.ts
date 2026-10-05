import {GLOBE_ZOOM} from '../presentation/geographic-map';
import {TILE_W} from '../presentation/camera';
import {createSceneGeography} from './scene-geography';
import {buildingRaster} from '../surfaces/canvas/building-raster';
import {createVisualTileDecoder} from './visual-tile-decoder';
import type {SceneWorkerRequest,SceneWorkerResult} from './scene-worker-protocol';
import type {WorldView} from '../surfaces/canvas/canvas-renderer';
import {render} from '../surfaces/canvas/canvas-renderer';
import {sceneRasterCache} from '../surfaces/canvas/scene-cache';
import {createTerrainSurface} from '../presentation/terrain-surface';
import {resetGeographicComposition,releaseGeographicGeometry} from '../surfaces/canvas/geographic-renderer';
type Scope={onmessage:((event:MessageEvent<SceneWorkerRequest>)=>void)|null;postMessage(result:SceneWorkerResult,transfer:Transferable[]):void};
// The selected scene owns decoded geometry. Bound object creation, not just retention after decoding.
let geometryLimit=8*1024*1024,geometryTolerance=0,selection='';
const decoder=createVisualTileDecoder(0,undefined,()=>{const remaining=Math.max(0,geometryLimit-geographicScene.stats().bytes);return {maxPoints:Math.floor(remaining/64),maxFeatures:Math.floor(remaining/448),tolerance:geometryTolerance};});
const geographicScene=createSceneGeography(tile=>decoder.decode(tile),()=>geometryLimit);
const scope=globalThis as unknown as Scope;
let surface:OffscreenCanvas|undefined,context:CanvasRenderingContext2D|undefined,view:WorldView|undefined,staticKey='';
scope.onmessage=event=>{
 const request=event.data,start=performance.now(),patch=request.scene;
 if(!surface||surface.width!==request.viewport.width||surface.height!==request.viewport.height){surface=new OffscreenCanvas(request.viewport.width,request.viewport.height);context=surface.getContext('2d',{alpha:false,desynchronized:true}) as unknown as CanvasRenderingContext2D;staticKey='';}
 if(!context)throw new Error('Worker Canvas2D unavailable');
 geometryLimit=request.policy.totalRasterBytes/4;geometryTolerance=.5/(TILE_W*request.camera.zoom);
 if(patch&&'geography' in patch){const next=patch.geography?.keys.join('|')??'';if(next!==selection||patch.geography?.tiles.length){releaseGeographicGeometry(context);if(view)view={...view,geography:undefined};}selection=next;}
 const terrain=patch?.terrain?{...patch.terrain,sample:createTerrainSurface(patch.terrain.tiles).sample}:view?.terrain;
 const preparing=staticKey!==request.key;
 view={...view,state:patch?.state??view!.state,geography:patch&&'geography' in patch?(patch.geography?geographicScene.apply(patch.geography):(geographicScene.clear(),undefined)):view?.geography,playerPower:patch?.playerPower??view?.playerPower,terrain,seed:patch?.seed??view!.seed,camera:request.camera,viewport:request.viewport,pixelRatio:request.pixelRatio,light:request.light,motion:preparing?0:request.motion,quality:request.policy,mobility:preparing?[]:request.mobility,signals:preparing?[]:request.signals,vessels:preparing?[]:request.vessels,aircraft:preparing?[]:request.aircraft,chunks:patch?.chunks??view?.chunks??new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true};
 sceneRasterCache.setLimit(request.policy.workerRasterBytes);
 if(preparing)resetGeographicComposition(context);
 render(context,view);staticKey=request.key;
 const bitmap=surface.transferToImageBitmap();
 // Keep the retained composition after transferring ownership of the published pixels.
 context.drawImage(bitmap,0,0);
 const stats=sceneRasterCache.stats();scope.postMessage({ticket:request.ticket,key:request.key,staticReady:true,staticOnly:preparing,bitmap,cache:{bytes:stats.bytes,entries:stats.entries,rasterContexts:buildingRaster.stats().contexts},workMs:performance.now()-start,geometryBytes:geographicScene.stats().bytes,geometryPressure:geographicScene.stats().limited,pictureReady:!view.geography||view.camera.zoom<GLOBE_ZOOM||view.geography.tiles.length>0&&(!geographicScene.stats().limited||view.geography.tiles.some(t=>t.features.length>0))},[bitmap]);
};
