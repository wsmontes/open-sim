import {tileKey,type GeographicTile} from '../presentation/geographic-map';
import {compactSceneState,sceneChunkKey,sceneIdentity} from './scene-state';
import type {WorldView} from '../surfaces/canvas/canvas-renderer';
import {playerSceneKey} from '../surfaces/canvas/prepared-scene';
import {renderPolicy,type RenderPolicy} from '../presentation/render-policy';
import type {ScenePatch,SceneWorkerRequest,SceneWorkerResult} from './scene-worker-protocol';
const stateSceneKey=(view:WorldView)=>{const edits=playerSceneKey(view);return view.geography?edits+(edits==='[]:'?'':':'+sceneChunkKey(view)):`${sceneIdentity(view.state.chunks)}:${sceneChunkKey(view)}`;};
const geographicKeys=new WeakMap<object,string>();
const geographicKey=(tiles:readonly GeographicTile[]|undefined)=>{if(!tiles)return '';let key=geographicKeys.get(tiles);if(key===undefined){key=tiles.map(t=>`${tileKey(t)}:${t.encodedRevision??sceneIdentity(t)}`).join('|');geographicKeys.set(tiles,key);}return key;};
export const staticSceneKey=(view:WorldView)=>[view.camera.x,view.camera.y,view.camera.zoom,view.camera.rotation,view.viewport.width,view.viewport.height,view.pixelRatio,view.light,geographicKey(view.geography?.tiles),view.terrain?.revision,view.seed,stateSceneKey(view)].join(':');
export function createSceneWorkerClient(factory:()=>Worker=()=>new Worker(new URL('./scene-worker.ts',import.meta.url),{type:'module'}),failed:()=>void=()=>{},publish:(result:SceneWorkerResult,view:WorldView)=>void=()=>{}){
 let worker:Worker|undefined,disposed=false,active=false,pending:{view:WorldView;policy:RenderPolicy}|undefined,lastSent:WorldView|undefined,lastStateKey='',lastPolicy:RenderPolicy|undefined,latestKey='',readyKey='',ticket=0;
 let deadline:ReturnType<typeof setTimeout>|undefined;
 const clearDeadline=()=>{if(deadline!==undefined){clearTimeout(deadline);deadline=undefined;}};
 const stats={bytes:0,entries:0,workMs:0,geometryBytes:0,geometryPressure:false};
 const visibility=typeof document==='undefined'?undefined:document;
 let failure:string|undefined;
 const fail=(reason='worker-error')=>{failure=reason;clearDeadline();worker?.terminate();worker=undefined;active=false;pending=undefined;lastSent=undefined;lastPolicy=undefined;lastStateKey='';readyKey='';if(!disposed)failed();};
 // Background tabs may be suspended by the browser; wall time there is not render work.
 const armDeadline=()=>{clearDeadline();if(!visibility?.hidden)deadline=setTimeout(()=>{if(!visibility?.hidden)fail('timeout');},15000);};
 const onVisibility=()=>{if(active)armDeadline();};
 visibility?.addEventListener('visibilitychange',onVisibility);
 const dispatch=(view:WorldView,policy:RenderPolicy)=>{
  const key=staticSceneKey(view),stateKey=stateSceneKey(view);let scene:ScenePatch|undefined;
  if(!lastSent||lastStateKey!==stateKey||lastSent.geography!==view.geography||lastSent.terrain?.revision!==view.terrain?.revision){scene={seed:view.seed};if(!lastSent||lastStateKey!==stateKey)if(view.geography){const compact=compactSceneState(view);scene.state=compact.state;scene.playerPower=compact.playerPower;}else {scene.state=view.state;scene.chunks=view.chunks;}if(!lastSent||lastSent.geography!==view.geography){if(view.geography){const known=new Map(lastSent?.geography?.tiles.map(t=>[tileKey(t),t])??[]);scene.geography={...view.geography,keys:view.geography.tiles.map(tileKey),tiles:view.geography.tiles.filter(t=>{const old=known.get(tileKey(t));return !old||old!==t&&(t.encodedRevision===undefined||old.encodedRevision!==t.encodedRevision);})};}else scene.geography=null;}if(!lastSent||lastSent.terrain?.revision!==view.terrain?.revision)scene.terrain=view.terrain?{tiles:view.terrain.tiles,revision:view.terrain.revision}:{tiles:[],revision:0};}
  const request:SceneWorkerRequest={ticket:++ticket,key,scene,camera:view.camera,viewport:view.viewport,pixelRatio:view.pixelRatio,light:view.light,motion:view.motion,mobility:view.mobility,signals:view.signals,vessels:view.vessels,aircraft:view.aircraft,policy};
  lastPolicy=policy;active=true;armDeadline();lastSent=view;lastStateKey=stateKey;
  try{worker!.postMessage(request);}catch(error){fail(error instanceof Error?error.message:'post-message-error');}
 };
 try{worker=factory();worker.onmessage=event=>{const result=event.data as SceneWorkerResult;
  if(disposed||!worker){result.bitmap.close();return;}
  clearDeadline();active=false;if(result.key===latestKey){readyKey=result.staticReady?result.key:'';Object.assign(stats,result.cache,{workMs:result.workMs,geometryBytes:result.geometryBytes??0,geometryPressure:result.geometryPressure??false});publish(result,lastSent!);}else result.bitmap.close();
  if(pending){const next=pending;pending=undefined;dispatch(next.view,next.policy);}else if(result.staticOnly&&result.key===latestKey&&lastSent)dispatch(lastSent,lastPolicy!);
 };worker.onerror=event=>fail(event?.message??'worker-error');}catch(error){worker=undefined;failure=error instanceof Error?error.message:'worker-unavailable';}
 return {
  available:()=>!!worker&&!disposed,
  ready:(view:WorldView)=>!worker||readyKey===staticSceneKey(view),
  submit(view:WorldView,policy=renderPolicy(undefined,view.viewport.width,view.viewport.height)){if(disposed||!worker)return;latestKey=staticSceneKey(view);if(active)pending={view,policy};else dispatch(view,policy);},
  status:()=>({...stats,failure,active:Number(active),pending:Number(!!pending),available:!!worker,staticReady:readyKey===latestKey&&!!readyKey}),
  dispose(){disposed=true;visibility?.removeEventListener('visibilitychange',onVisibility);clearDeadline();worker?.terminate();worker=undefined;active=false;pending=undefined;lastSent=undefined;},
 };
}
