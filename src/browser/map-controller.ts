import type {Camera,Viewport} from '../presentation/camera';
import {visibleChunks,closestChunks,isCoarse} from '../presentation/camera';
import {CHUNK,WORLD,chunkId,chunkOrigin} from '../core/coordinates';
import type {LocalSession} from '../session/local-session';
import {createMapStreaming} from '../session/map-streaming';
export function createMapController(config:{session:LocalSession;camera:()=>Camera;viewport:()=>Viewport;onVisible:(ids:readonly string[])=>void;onChange:()=>void;onError:(error:unknown)=>void}){
 const {session}=config;
 const stream=createMapStreaming({concurrency:4,available:(id,level)=>{
  const status=session.getChunk(id);return status?.status==='ready'&&(status.level==='detail'||level==='overview');
 },load:async(ids,level)=>{await session.loadVisible(ids,level);config.onChange();},onError:config.onError});
 let timer:ReturnType<typeof setTimeout>|undefined,idle:ReturnType<typeof setTimeout>|undefined;
 const update=()=>{
  const camera=config.camera(),viewport=config.viewport(),ids=visibleChunks(camera,viewport);
  session.retainVisible(ids);config.onVisible(ids);
  const detail=isCoarse(camera)?[]:closestChunks(ids,camera,viewport,120);
  stream.updateDemand({visible:closestChunks(ids,camera,viewport,512),detail,nearby:[]});
  clearTimeout(idle);
  // Preparation yields to gestures and visible loading; only a small nearby ring is materialized in memory.
  idle=setTimeout(()=>{
   const nearby=new Set<string>();
   for(const id of closestChunks(ids,camera,viewport,12)){
    const origin=chunkOrigin(id);
    for(const dx of [-CHUNK,0,CHUNK])for(const dy of [-CHUNK,0,CHUNK])if(origin.y+dy>=0&&origin.y+dy<WORLD)nearby.add(chunkId({x:origin.x+dx,y:origin.y+dy}));
   }
   stream.updateDemand({visible:closestChunks(ids,camera,viewport,512),detail,nearby:[...nearby]});
  },800);
 };
 return{update,schedule(){clearTimeout(timer);timer=setTimeout(update,100);},retry(){stream.retry();update();},idle:stream.idle,destroy(){clearTimeout(timer);clearTimeout(idle);stream.destroy();}};
}
