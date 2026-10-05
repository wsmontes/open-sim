export type FrameNeed={moving:boolean;ambient:boolean;drawn?:boolean};
export type FrameStats={frames:number;drawn:number;frameMs:number;p50:number;p95:number;fps:number;drawing:boolean};

// A timer id is whatever the host's clock hands back; the scheduler only ever passes it straight back to clear it, so
// it stays opaque. This keeps the module free of DOM and Node types (tsconfig.presentation.json) while a browser host
// still passes its real setTimeout/requestAnimationFrame below.
type TimerId=unknown;
type Raf=(callback:(now:number)=>void)=>number;
type CancelRaf=(id:number)=>void;
type Delay=(callback:()=>void,ms:number)=>TimerId;
type ClearDelay=(id:TimerId)=>void;

export function createFrameScheduler(options:{
 draw:(now:number,seconds:number)=>FrameNeed;
 request:Raf;
 cancel:CancelRaf;
 delay?:Delay;
 clearDelay?:ClearDelay;
 visible:()=>boolean;
 now:()=>number;
 ambientFps?:number;
}){
 const {request,cancel,visible,now}=options;
 const delay: Delay=options.delay??(()=>{throw new Error('Ambient animation requires a timer port');});
 const clearDelay: ClearDelay=options.clearDelay??(()=>{});
 const ambientMs=1000/(options.ambientFps??30),samples=new Array<number>(120).fill(0),recent:number[]=[];
 let raf:number|null=null,timer:TimerId|null=null,last=0,need:FrameNeed={moving:false,ambient:false};
 let sampleCount=0,sampleAt=0,frames=0,drawn=0,mean=0;

 const percentile=(sorted:readonly number[],part:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(part*sorted.length)-1))]!:0;
 const schedule=()=>{
  if(raf!==null||timer!==null)return;
  if(need.moving){raf=request(frame);return;}
  if(need.ambient)timer=delay(()=>{timer=null;if(raf===null)raf=request(frame);},ambientMs);
 };
 const frame=(at:number)=>{
  raf=null;frames+=1;
  if(!visible()){need={moving:false,ambient:false};return;}
  const seconds=last?Math.min(.25,(at-last)/1000):0,start=now();
  need=options.draw(at,seconds);
  const elapsed=Math.max(0,now()-start);
  mean=mean?mean*.9+elapsed*.1:elapsed;
  samples[sampleAt]=elapsed;sampleAt=(sampleAt+1)%samples.length;sampleCount=Math.min(samples.length,sampleCount+1);
  recent.push(at);while(recent.length&&at-recent[0]!>1000)recent.shift();
  if(need.drawn!==false)drawn+=1;last=at;schedule();
 };
 return{
  invalidate(){
   // Input should not wait behind the 30 fps ambient timer. Cancel it and draw on the next animation frame.
   if(timer!==null){clearDelay(timer);timer=null;}
   if(raf===null)raf=request(frame);
  },
  stop(){
   if(raf!==null)cancel(raf);
   if(timer!==null)clearDelay(timer);
   raf=null;timer=null;last=0;need={moving:false,ambient:false};
  },
  running:()=>raf!==null||timer!==null,
  stats():FrameStats{
   const at=now();
   while(recent.length&&at-recent[0]!>1000)recent.shift();
   const sorted=samples.slice(0,sampleCount).sort((a,b)=>a-b);
   return{frames,drawn,frameMs:mean,p50:percentile(sorted,.5),p95:percentile(sorted,.95),fps:recent.length,drawing:need.moving||need.ambient};
  },
 };
}
