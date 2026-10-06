import {resourcePolicy} from './resource-policy';

export type DetailDemand={zoomBias:number;minimumZoom?:number;maximumZoom?:number;maxTiles:number;concurrency:number;cacheBytes:number};
// Owned bytes and observed completion costs are estimates, not total browser memory.
// Render and encoded demand have separate reservations in the shared managed envelope.
export function createAdaptiveDetail(memoryGb?:number){
 const resources=resourcePolicy(memoryGb),budget=resources.rasterBytes+resources.sceneGeometryBytes;
 const bands=new Map<number,{bias:number;sourceBias:number;healthy:number;changedAt:number;workMs:number;ownedBytes:number;observedAt:number;trialAt:number;trial:false|'source'|'detail'}>();
 let concurrency=memoryGb!==undefined&&memoryGb<=2?2:4,fastLoads=0,loadMs=0;
 // The band is a power-of-two zoom bucket: overload in one view must not coarsen an unrelated one.
 const band=(zoom:number)=>Math.max(-20,Math.min(2,Math.floor(Math.log2(Math.max(.000001,zoom)))));
 const state=(zoom:number)=>{const key=band(zoom);let value=bands.get(key);if(!value){value={bias:zoom<.035?1:0,sourceBias:0,healthy:0,changedAt:-Infinity,workMs:0,ownedBytes:0,observedAt:0,trialAt:-Infinity,trial:false};bands.set(key,value);}return value;};
 const demand=(zoom:number):DetailDemand=>{const {bias,sourceBias}=state(zoom);return {zoomBias:bias,minimumZoom:zoom>=.035?14-sourceBias:0,maximumZoom:14-sourceBias,maxTiles:Math.max(4,40>>bias),concurrency,cacheBytes:resources.geographicEncodedBytes};};
 const api={
  // Bumped whenever the demand changes, so a caller can refresh a stream without polling every frame.
  revision:0,
  demand,
  render(zoom:number,workMs:number,ownedBytes:number,now:number){
   const s=state(zoom);s.workMs=workMs;s.ownedBytes=ownedBytes;s.observedAt=now;const trial=s.trial;s.trial=false;
   if(workMs>80||ownedBytes>budget){s.healthy=0;if(trial||now-s.changedAt>=1000){if(trial==='source')s.sourceBias=Math.min(14,s.sourceBias+1);else s.bias=Math.min(4,s.bias+1);s.changedAt=now;api.revision++;}return;}
   if(workMs<20&&ownedBytes<budget*.6){s.healthy++;if(s.healthy>=8&&now-s.changedAt>=10000&&(s.bias>0||s.sourceBias>0)){if(s.sourceBias>0){s.sourceBias--;s.trial='source';}else{s.bias--;s.trial='detail';}s.trialAt=now;s.healthy=0;s.changedAt=now;api.revision++;}}else s.healthy=0;
  },
  // A quality trial is not evidence of spare capacity: only its next render can confirm it.
  probe(zoom:number,now:number){const s=state(zoom);if((s.bias>0||s.sourceBias>0)&&s.healthy>0&&!s.trial&&now-s.observedAt>=10000&&now-Math.max(s.changedAt,s.trialAt)>=30000){if(s.sourceBias>0){s.sourceBias--;s.trial='source';}else{s.bias--;s.trial='detail';}s.healthy=0;s.trialAt=now;api.revision++;}},
  pressure(zoom:number,now:number){const s=state(zoom);s.healthy=0;s.trial=false;if(s.bias<4||s.sourceBias<14){s.bias=Math.min(4,s.bias+1);s.sourceBias=Math.min(14,s.sourceBias+1);s.changedAt=now;api.revision++;}},
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
