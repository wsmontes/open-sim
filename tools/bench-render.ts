// Micro-benchmark for the canvas renderer (spec 2026-10-01). It runs the OLD renderer (a verbatim upstream copy kept
// in tests/fixtures) and the NEW allocation-light one through a no-op recording context for a dense mid-zoom view, and
// prints ms/frame and a heap-growth allocation proxy for each. No DOM, no canvas: the context only counts calls, so
// what the numbers measure is the renderer's own work and garbage, not the browser's.
//
//   npx tsx tools/bench-render.ts [frames]
import {render as optimized} from '../src/surfaces/canvas/canvas-renderer';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
import {render as reference} from '../tests/fixtures/renderer-reference';
import {createGame} from '../src/core/commands';
import {CHUNK} from '../src/core/coordinates';
import type {BaseChunk,Cell} from '../src/core/model';
import type {ChunkStatus} from '../src/session/ports';

// A no-op context that still counts the calls, so a frame is real work (every method is invoked) but nothing is drawn.
const METHODS=['beginPath','moveTo','lineTo','closePath','fill','stroke','arc','ellipse','fillRect','strokeRect','save','restore','translate','rotate','clip','setLineDash','clearRect','drawImage'];
function noopContext(){
 let calls=0;const bump=()=>{calls+=1;};
 const target:Record<string,unknown>={};
 for(const name of METHODS)target[name]=bump;
 target['measureText']=()=>({width:0});
 const ctx=new Proxy(target,{get:(o,k)=>(k in o?o[k as string]:undefined),set:()=>true}) as unknown as CanvasRenderingContext2D;
 return {ctx,calls:()=>calls};
}

// The same dense town the tests use: woods, water, three road classes, buildings of three heights, parks and a site.
const cells:Cell[]=Array.from({length:1024},(_u,index)=>{
 const y=Math.floor(index/CHUNK),x=index%CHUNK;
 if(y%7===0)return {terrain:'land',road:true};
 if(y%7===3)return {terrain:'land',road:true,roadClass:'avenue'};
 if(y%7===5)return {terrain:'land',road:true,roadClass:'highway'};
 if(x>26)return {terrain:'water'};
 if((x+y)%11===0)return {terrain:'green'};
 if(y%7===1)return {terrain:'land',building:'residential',stage:x%4===0?0:1+(x%3),origin:'player'};
 if(y%7===2)return {terrain:'land',building:'commercial',stage:1+(x%3),origin:'player'};
 if(y%7===4)return {terrain:'land',building:'industrial',stage:1+(x%3),origin:'player'};
 if(y%7===6)return {terrain:'land',building:x%4===0?'park':'residential',stage:1+(x%3),origin:'player'};
 return {terrain:'land'};
});
const base:BaseChunk={id:'0:0',source:'bench',normalizerVersion:1,cells};
const state=createGame('bench',7,base);
const viewport={width:1280,height:800};
// Mid zoom with a turned bearing: the fine (per-cell) pass, lots of near buildings and roads, and street life moving.
const view:WorldView={
 camera:{x:viewport.width/2,y:viewport.height/2,zoom:1.1,rotation:0.7},
 viewport,state,chunks:new Map<string,ChunkStatus>(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:7,motion:4.2,
};

type Render=(ctx:CanvasRenderingContext2D,view:WorldView)=>void;
const gc=(globalThis as {gc?:()=>void}).gc;
// ms/frame: timed over `frames` with a warm-up, reported as the best of several passes so a stray GC does not bias it.
function timed(run:Render,frames:number):{msPerFrame:number;callsPerFrame:number}{
 const warm=noopContext();for(let i=0;i<50;i++)run(warm.ctx,view);
 const callsPerFrame=warm.calls()/50;
 const rec=noopContext();
 const start=process.hrtime.bigint();
 for(let i=0;i<frames;i++)run(rec.ctx,view);
 const nanos=Number(process.hrtime.bigint()-start);
 return {msPerFrame:nanos/1e6/frames,callsPerFrame};
}
// Allocation proxy: heap bytes retained after a short window of frames, measured from a clean heap. Only meaningful
// with --expose-gc; the minimum across windows is the least GC-biased sample, so it tracks per-frame garbage.
function allocBytes(run:Render,window:number,samples:number):number{
 if(!gc)return Number.NaN;
 let best=Number.POSITIVE_INFINITY;
 for(let s=0;s<samples;s++){
  gc();gc();
  const before=process.memoryUsage().heapUsed;
  const rec=noopContext();
  for(let i=0;i<window;i++)run(rec.ctx,view);
  const after=process.memoryUsage().heapUsed;
  const delta=after-before;
  if(delta>=0&&delta<best)best=delta;
 }
 return best===Number.POSITIVE_INFINITY?Number.NaN:best/window;
}

const frames=Math.max(100,Number(process.argv[2])||2000);
const runs=3;
const bestMs=(run:Render)=>{let m=timed(run,frames);for(let i=1;i<runs;i++){const n=timed(run,frames);if(n.msPerFrame<m.msPerFrame)m=n;}return m;};
const refMs=bestMs(reference),optMs=bestMs(optimized);
const refBytes=allocBytes(reference,200,8),optBytes=allocBytes(optimized,200,8);
const pct=(a:number,b:number)=>!Number.isFinite(a)||!Number.isFinite(b)||a===0?'n/a':`${(((a-b)/a)*100).toFixed(1)}%`;
console.log(`frames per pass: ${frames}, passes: ${runs}, gc exposed: ${Boolean(gc)}`);
console.log(`calls/frame: reference ${refMs.callsPerFrame}, optimized ${optMs.callsPerFrame} (must be equal)`);
console.log(`reference (upstream)   ms/frame ${refMs.msPerFrame.toFixed(4)}  heap-bytes/frame ${Number.isFinite(refBytes)?refBytes.toFixed(0):'n/a (run with --expose-gc)'}`);
console.log(`optimized (new)        ms/frame ${optMs.msPerFrame.toFixed(4)}  heap-bytes/frame ${Number.isFinite(optBytes)?optBytes.toFixed(0):'n/a (run with --expose-gc)'}`);
console.log(`speedup ms/frame: ${pct(refMs.msPerFrame,optMs.msPerFrame)}; allocation proxy reduced: ${pct(refBytes,optBytes)}`);
