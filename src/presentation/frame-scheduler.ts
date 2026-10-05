export type FrameNeed={moving:boolean;ambient:boolean;presented?:boolean};
export type FrameStats={frames:number;drawn:number;frameMs:number;p50:number;p95:number;fps:number;drawing:boolean};

// A timer id is whatever the host's clock hands back; the scheduler only ever passes it straight back to clear it, so
// it stays opaque. This keeps the module free of DOM and Node types (tsconfig.presentation.json) while a browser host
// still passes its real setTimeout/requestAnimationFrame below.
type TimerId=unknown;
type Raf=(callback:(now:number)=>void)=>number;
type CancelRaf=(id:number)=>void;
type Delay=(callback:()=>void,ms:number)=>TimerId;
type ClearDelay=(id:TimerId)=>void;

// The browser globals, read off globalThis rather than named directly: a host without them must inject its own ports,
// and the type-check needs no DOM/Node lib to see these.
type Platform={
 requestAnimationFrame?:Raf;
 cancelAnimationFrame?:CancelRaf;
 setTimeout?:(callback:()=>void,ms:number)=>TimerId;
 clearTimeout?:(id:TimerId)=>void;
 performance?:{now():number};
 document?:{hidden:boolean};
};
const platform=globalThis as Platform;

export function createFrameScheduler(options:{
 draw:(now:number,seconds:number)=>FrameNeed;
 request?:Raf;
 cancel?:CancelRaf;
 delay?:Delay;
 clearDelay?:ClearDelay;
 visible?:()=>boolean;
 now?:()=>number;
 ambientFps?:number;
 onSample?:(sample:{at:number;intervalMs:number;workMs:number;presented:boolean})=>void;
}){
 const request: Raf=options.request??(callback=>platform.requestAnimationFrame!(callback));
 const cancel: CancelRaf=options.cancel??(id=>platform.cancelAnimationFrame!(id));
 const delay: Delay=options.delay??((callback,ms)=>platform.setTimeout!(callback,ms));
 const clearDelay: ClearDelay=options.clearDelay??(id=>platform.clearTimeout!(id));
 const visible=options.visible??(()=>!platform.document||!platform.document.hidden);
 const now=options.now??(()=>platform.performance?platform.performance.now():Date.now());
 const ambientMs=1000/(options.ambientFps??30),samples=new Array<number>(120).fill(0),recent:number[]=[];
 let raf:number|null=null,timer:TimerId|null=null,last=0,need:FrameNeed={moving:false,ambient:false};
 let lastPresented:number|null=null,ambientDue:number|undefined;
 let sampleCount=0,sampleAt=0,frames=0,drawn=0,mean=0;

 const percentile=(sorted:readonly number[],part:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(part*sorted.length)-1))]!:0;
 const schedule=()=>{
  if(raf!==null||timer!==null)return;
  if(need.moving){raf=request(frame);return;}
  if(need.ambient)timer=delay(()=>{timer=null;if(raf===null)raf=request(frame);},Math.max(0,(ambientDue??now()+ambientMs)-now()));
 };
 const frame=(at:number)=>{
  raf=null;frames+=1;
  if(!visible()){need={moving:false,ambient:false};last=0;lastPresented=null;ambientDue=undefined;recent.length=0;return;}
  const seconds=last?Math.min(.25,(at-last)/1000):0,start=now();
  // Worker presentation/input can preempt the timer without pushing its next ambient tick back.
  if(!need.ambient||ambientDue===undefined||start>=ambientDue)ambientDue=start+ambientMs;
  need=options.draw(at,seconds);if(!need.ambient)ambientDue=undefined;
  const elapsed=Math.max(0,now()-start);
  mean=mean?mean*.9+elapsed*.1:elapsed;
  samples[sampleAt]=elapsed;sampleAt=(sampleAt+1)%samples.length;sampleCount=Math.min(samples.length,sampleCount+1);
  const presented=need.presented!==false,intervalMs=presented&&lastPresented!==null?at-lastPresented:0;
  if(presented){recent.push(at);lastPresented=at;drawn+=1;}
  options.onSample?.({at,intervalMs,workMs:elapsed,presented});
  while(recent.length&&at-recent[0]!>1000)recent.shift();
  last=at;schedule();
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
   raf=null;timer=null;last=0;lastPresented=null;ambientDue=undefined;recent.length=0;need={moving:false,ambient:false};
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
