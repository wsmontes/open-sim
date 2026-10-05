import {renderPolicy} from './render-policy';

export type DetailDemand={zoomBias:number;minimumZoom?:number;maxTiles:number;concurrency:number;cacheBytes:number};
// Owned bytes and observed completion costs are estimates, not total browser memory.
// The byte budget is the device's declared raster budget — the same figure that bounds the worker's raster cache —
// so pressure means the renderer keeps more than the device affords, not merely that its caches filled.
export function createAdaptiveDetail(memoryGb?:number){
 const budget=renderPolicy(memoryGb,0,0).totalRasterBytes;
 const bands=new Map<number,{bias:number;healthy:number;changedAt:number;workMs:number;ownedBytes:number}>();
 let concurrency=memoryGb!==undefined&&memoryGb<=2?2:4,fastLoads=0,loadMs=0;
 // The band is a power-of-two zoom bucket: overload in one view must not coarsen an unrelated one.
 const band=(zoom:number)=>Math.max(-20,Math.min(2,Math.floor(Math.log2(Math.max(.000001,zoom)))));
 const state=(zoom:number)=>{const key=band(zoom);let value=bands.get(key);if(!value){value={bias:zoom<.035?1:0,healthy:0,changedAt:-Infinity,workMs:0,ownedBytes:0};bands.set(key,value);}return value;};
 const demand=(zoom:number):DetailDemand=>{const {bias}=state(zoom);return {zoomBias:bias,minimumZoom:zoom>=.035?14:0,maxTiles:Math.max(4,40>>bias),concurrency,cacheBytes:budget};};
 const api={
  // Bumped whenever the demand changes, so a caller can refresh a stream without polling every frame.
  revision:0,
  demand,
  render(zoom:number,workMs:number,ownedBytes:number,now:number){
   const s=state(zoom);s.workMs=workMs;s.ownedBytes=ownedBytes;
   if(workMs>80||ownedBytes>budget){s.healthy=0;if(now-s.changedAt>=1000){s.bias=Math.min(4,s.bias+1);s.changedAt=now;api.revision++;}return;}
   if(workMs<20&&ownedBytes<budget*.6){s.healthy++;if(s.healthy>=8&&now-s.changedAt>=10000&&s.bias>0){s.bias--;s.healthy=0;s.changedAt=now;api.revision++;}}else s.healthy=0;
  },
  pressure(zoom:number,now:number){const s=state(zoom);s.healthy=0;if(s.bias<4){s.bias++;s.changedAt=now;api.revision++;}},
  load(ms:number,ok:boolean){loadMs=ms;
   if(!ok||ms>1500){fastLoads=0;if(concurrency!==1){concurrency=1;api.revision++;}return;}
   if(ms>=400){fastLoads=0;return;}
   if(++fastLoads<8)return;
   fastLoads=0;const next=Math.min(4,concurrency+1);if(next!==concurrency){concurrency=next;api.revision++;}
  },
  status(zoom:number){return {...demand(zoom),...state(zoom),loadMs,estimated:true};},
 };
 return api;
}
