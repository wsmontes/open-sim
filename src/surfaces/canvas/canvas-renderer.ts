import {lightContext} from './city-light';
import {drawCellMobility,drawVisibleMobility} from './mobility-draw';
import type {MobilityFrameAgent,TrafficSignalFrame} from '../../presentation/mobility-model';
import type {TerrainTile} from '../../presentation/terrain-model';
import type {TerrainReading} from '../../presentation/terrain-surface';
import {renderGeographicWorld} from './geographic-renderer';
import type {GeographicScene} from '../../presentation/geographic-map';
import {GLOBE_ZOOM} from '../../presentation/geographic-map';
import type {Building,Cell,CellCoord,GameState} from '../../core/model';
import {CHUNK,WORLD,cellIndex,chunkId,variant,wrapX} from '../../core/coordinates';
import {effectiveCells} from '../../core/world';
import {roadClassOf} from '../../core/model';
import {lifeAt} from '../../presentation/street-life';
import type {ChunkStatus} from '../../session/ports';
import type {SelectedTool} from '../../presentation/tools';
import type {Camera,Viewport} from '../../presentation/camera';
import {TILE_H,TILE_W,cellSpace,isCoarse} from '../../presentation/camera';
export type WorldView = {
 light?:'day'|'night';
 geography?:GeographicScene;
 terrain?:{tiles:readonly TerrainTile[];sample:(geo:{lat:number;lon:number})=>TerrainReading|null;revision:number};
 mobility?:readonly MobilityFrameAgent[];
 signals?:readonly TrafficSignalFrame[];
 pixelRatio?:number;
 camera:Camera;
 viewport:Viewport;
 state:GameState;
 chunks:ReadonlyMap<string,ChunkStatus>;
 tool:SelectedTool;
 hover:CellCoord|null;
 preview:readonly CellCoord[];
 previewAffordable:boolean;
 seed:number;
 // The animation clock, in seconds of wall time scaled by the game speed: it advances while the city runs and stops
 // when the city is paused, which is the whole of the traffic's motion. Nothing about it is stored or shared.
 motion:number;
};
const BLOCK=4,BLOCKS=CHUNK/BLOCK;
const CLASS_RGB:Record<string,[number,number,number]>={water:[62,128,196],road:[139,145,153],green:[105,170,74],land:[127,190,88],
 residential:[207,92,60],commercial:[74,119,190],industrial:[133,139,146],park:[79,158,70],power:[111,114,120]};
const hex=([r,g,b]:[number,number,number])=>`#${[r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('')}`;
export function aggregateCells(cells:readonly Cell[],blocks=BLOCKS):string[]{
 const size=CHUNK/blocks,out:string[]=[];
 for(let by=0;by<blocks;by++)for(let bx=0;bx<blocks;bx++){
  const counts:Record<string,number>={water:0,road:0,green:0,land:0,residential:0,commercial:0,industrial:0,park:0,power:0};
  for(let y=by*size;y<(by+1)*size;y++)for(let x=bx*size;x<(bx+1)*size;x++){
   const c=cells[y*CHUNK+x];
   const category=c.building??(c.road?'road':c.terrain==='water'?'water':c.terrain==='green'?'green':'land');
   counts[category]+=1;
  }
  const cells_in_block=size*size,ranked=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  const buildings=counts.residential+counts.commercial+counts.industrial+counts.power;
  const [first]=ranked[0]!;
  const share=(kind:string)=>counts[kind]/cells_in_block;
  const colour=buildings/cells_in_block>=.45&&CLASS_RGB[first]?CLASS_RGB[first]!
   :share('water')>=.45?CLASS_RGB.water
   :share('road')>=.3?CLASS_RGB.road
   :share('green')>=.45?CLASS_RGB.green
   :(ranked.reduce((sum,[kind,count])=>{const rgb=CLASS_RGB[kind]!;return [sum[0]+rgb[0]*count,sum[1]+rgb[1]*count,sum[2]+rgb[2]*count];},[0,0,0]) as [number,number,number]).map(v=>v/cells_in_block) as [number,number,number];
  out.push(hex(colour));
 }
 return out;
}
const mosaicCache=new WeakMap<object,string[]>();
function cachedMosaic(view:WorldView,id:string):string[]|null {
 const managed=view.state.chunks[id],status=view.chunks.get(id);
 // Commands and ticks replace changed chunk objects. Caching by that object means an edit invalidates only its own
 // region; the old global revision key made every visible managed region aggregate all 1,024 cells after any command.
 const owner=managed??(status?.status==='ready'?status.base:null);
 if(!owner)return null;
 const cached=mosaicCache.get(owner);
 if(cached)return cached;
 const cells=managed?effectiveCells(managed):status?.status==='ready'?status.base.cells:null;
 if(!cells)return null;
 const blocks=aggregateCells(cells);
 mosaicCache.set(owner,blocks);
 return blocks;
}
// Ground polygons use the same projection as picking. Height is always screen-vertical.
const GRASS=['#8cbe6a','#93c471','#84b662'],GREEN=['#74a95a','#7caf61','#6d9f54'];
const WATER=['#4a86bf','#508fc7','#457fb5'];
const ROOF:Record<Building,string>={residential:'#c9684b',commercial:'#5b82b8',industrial:'#8b9199',park:'#6fae5e',power:'#797d84'};
const TREE_TONES=['#438b45','#58a34c','#6cb256'] as const;
// Shared, never-mutated dash patterns: the dotted outline of a stage-0 site, and the solid default. The lane dash is
// zoom-dependent so it is still built per call, but only on near-zoom road cells, which are few.
const DASH_SITE:readonly number[]=[3,3],DASH_SOLID:readonly number[]=[];
// Module-level neighbour offsets for the road social/stage probe: a constant tuple instead of a fresh array per cell.
const NEIGHBOURS:readonly (readonly [number,number])[]=[[1,0],[-1,0],[0,1],[0,-1]];

// The ground-to-screen map for one frame. project(cell)=camera + groundVector(rotation,zoom), and groundVector is
// linear in (x,y). Precomputing cos/sin and the pixel scale once per frame turns every per-cell projection into the
// same handful of multiplies into scratch, with no object allocated. The arithmetic is grouped exactly as
// groundVector groups it (u=c*x-s*y, v=s*x+c*y; screen=((u-v)*w,(u+v)*h)) so the result is bit-for-bit identical:
// distributing it into a flat 2x2 (a*x+b*y) would reorder the floating-point adds and shift the last bits, which is
// enough to flip the painter sort on a tie and draw a different cell at a given slot. Equal, not merely close.
let RC=1,RS=0,RW=0,RH=0,CAMX=0,CAMY=0;
let SX=0,SY=0; // scratch outputs of the last projection
const setMatrix=(camera:Camera):void=>{
 RC=Math.cos(camera.rotation);RS=Math.sin(camera.rotation);RW=TILE_W*camera.zoom;RH=TILE_H*camera.zoom;CAMX=camera.x;CAMY=camera.y;
};
const proj=(x:number,y:number):void=>{const u=RC*x-RS*y,v=RS*x+RC*y;SX=CAMX+(u-v)*RW;SY=CAMY+(u+v)*RH;};
const projXOf=(x:number,y:number):number=>CAMX+(RC*x-RS*y-(RS*x+RC*y))*RW;
const projYOf=(x:number,y:number):number=>CAMY+(RC*x-RS*y+(RS*x+RC*y))*RH;

// A quad from eight scalar corners (x0,y0,...,x3,y3). Same call sequence as the old polygon([p0,p1,p2,p3]): beginPath,
// moveTo, three lineTo, closePath, fill, optional stroke.
const quad=(ctx:CanvasRenderingContext2D,x0:number,y0:number,x1:number,y1:number,x2:number,y2:number,x3:number,y3:number,stroke=false):void=>{
 ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.lineTo(x2,y2);ctx.lineTo(x3,y3);ctx.closePath();ctx.fill();if(stroke)ctx.stroke();
};
// The square footprint of a cell at (cx,cy) with the given radius, projected and drawn as a quad. Corner order
// matches the old footprint(): (-r,-r),(r,-r),(r,r),(-r,r).
const footprintQuad=(ctx:CanvasRenderingContext2D,cx:number,cy:number,radius:number,stroke=false):void=>{
 quad(ctx,
  projXOf(cx-radius,cy-radius),projYOf(cx-radius,cy-radius),
  projXOf(cx+radius,cy-radius),projYOf(cx+radius,cy-radius),
  projXOf(cx+radius,cy+radius),projYOf(cx+radius,cy+radius),
  projXOf(cx-radius,cy+radius),projYOf(cx-radius,cy+radius),
  stroke);
};
// Per-frame memo of the region a lookup last resolved. A cell and its four neighbours almost always share a region, so
// remembering the last id and its cells (managed edits+base, or a ready base) turns the per-cell chunkId string build
// and map get into a single string compare. Reset at the top of every frame because the view can change between them.
let MEMO_VIEW:WorldView|null=null,MEMO_ID='',MEMO_EDITS:Record<string,Cell>|null=null,MEMO_BASE:readonly Cell[]|null=null,MEMO_OK=false;
const resetLookup=(view:WorldView):void=>{MEMO_VIEW=view;MEMO_ID='';MEMO_EDITS=null;MEMO_BASE=null;MEMO_OK=false;};
function lookup(view:WorldView,cell:CellCoord):Cell|null{
 const id=chunkId(cell);
 if(id!==MEMO_ID||MEMO_VIEW!==view){
  MEMO_VIEW=view;MEMO_ID=id;
  const managed=view.state.chunks[id];
  if(managed){MEMO_EDITS=managed.edits;MEMO_BASE=managed.base.cells;MEMO_OK=true;}
  else{const status=view.chunks.get(id);if(status?.status==='ready'){MEMO_EDITS=null;MEMO_BASE=status.base.cells;MEMO_OK=true;}else{MEMO_EDITS=null;MEMO_BASE=null;MEMO_OK=false;}}
 }
 if(!MEMO_OK)return null;
 const i=cellIndex(cell);
 return (MEMO_EDITS?MEMO_EDITS[i]:undefined)??MEMO_BASE![i]!;
}
function tree(ctx:CanvasRenderingContext2D,px:number,py:number,scale:number,tone:number){
 ctx.fillStyle='#765838';ctx.fillRect(px-scale*.045,py-scale*.35,Math.max(1,scale*.09),scale*.35);
 ctx.fillStyle=TREE_TONES[tone%3]!;
 ctx.beginPath();ctx.arc(px,py-scale*.42,scale*.16,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='rgba(255,255,255,.2)';ctx.beginPath();ctx.arc(px-scale*.05,py-scale*.48,scale*.06,0,Math.PI*2);ctx.fill();
}
function building(ctx:CanvasRenderingContext2D,view:WorldView,coord:CellCoord,cell:Cell,v:number){
 const camera=view.camera,scale=TILE_W*camera.zoom,kind=cell.building!;
 const cx=coord.x,cy=coord.y;
 // Floor corners (radius .34) as eight scalars, same order as footprint(): (-r,-r),(r,-r),(r,r),(-r,r).
 const r=.34;
 const fx0=projXOf(cx-r,cy-r),fy0=projYOf(cx-r,cy-r);
 const fx1=projXOf(cx+r,cy-r),fy1=projYOf(cx+r,cy-r);
 const fx2=projXOf(cx+r,cy+r),fy2=projYOf(cx+r,cy+r);
 const fx3=projXOf(cx-r,cy+r),fy3=projYOf(cx-r,cy+r);
 if(kind==='park'){
  ctx.fillStyle=ROOF.park;quad(ctx,fx0,fy0,fx1,fy1,fx2,fy2,fx3,fy3);
  if(scale>=10)tree(ctx,projXOf(cx,cy),projYOf(cx,cy),scale,v);return;
 }
 if(cell.stage===0){
  ctx.fillStyle='#cbb083';quad(ctx,fx0,fy0,fx1,fy1,fx2,fy2,fx3,fy3);ctx.strokeStyle='#f6f1e4';ctx.setLineDash(DASH_SITE);ctx.stroke();ctx.setLineDash(DASH_SOLID);return;
 }
 const height=Math.max(1,cell.stage??1)*TILE_H*camera.zoom*.85;
 // Roof corners share x and sit `height` above the floor corners.
 const rx0=fx0,ry0=fy0-height,rx1=fx1,ry1=fy1-height,rx2=fx2,ry2=fy2-height,rx3=fx3,ry3=fy3-height;
 const near=scale>=24;
 // Front-facing walls only, in corner order i -> i+1. The old code read floor[i]/floor[j] from arrays; the four
 // corners are inlined here as a small lookup so the geometry is identical.
 const FX=[fx0,fx1,fx2,fx3],FY=[fy0,fy1,fy2,fy3],RX=[rx0,rx1,rx2,rx3],RY=[ry0,ry1,ry2,ry3];
 for(let i=0;i<4;i++){
  const j=(i+1)%4,ax=FX[i]!,ay=FY[i]!,bx=FX[j]!,by=FY[j]!;
  if(bx<=ax)continue;
  ctx.fillStyle=i%2?'#c8b99c':'#ece1c8';quad(ctx,ax,ay,bx,by,RX[j]!,RY[j]!,RX[i]!,RY[i]!);
  if(near){
   ctx.strokeStyle='#5b6674';ctx.lineWidth=Math.max(1,scale*.04);
   for(let f=0;f<Math.min(8,cell.stage??1);f++){
    const y=height*(f+.5)/Math.max(1,cell.stage??1);
    ctx.beginPath();ctx.moveTo(ax+(bx-ax)*.25,ay+(by-ay)*.25-y);
    ctx.lineTo(ax+(bx-ax)*.75,ay+(by-ay)*.75-y);ctx.stroke();
   }
  }
 }
 ctx.fillStyle=ROOF[kind];ctx.strokeStyle='rgba(58,50,40,.35)';ctx.lineWidth=Math.max(1,scale*.025);quad(ctx,rx0,ry0,rx1,ry1,rx2,ry2,rx3,ry3,near);
 if(near){
  const px=projXOf(cx,cy),py=projYOf(cx,cy);ctx.fillStyle='rgba(255,255,255,.25)';
  ctx.fillRect(px-scale*.07,py-height-scale*.06,scale*.14,scale*.1);
 }
}
function drawCell(ctx:CanvasRenderingContext2D,view:WorldView,coord:CellCoord){
 const cell=lookup(view,coord),v=variant(coord.x,coord.y,view.seed),camera=view.camera,scale=TILE_W*camera.zoom;
 const cx=coord.x,cy=coord.y;
 ctx.fillStyle=!cell?(view.chunks.get(chunkId(coord))?.status==='error'?'#875356':'#687481'):cell.terrain==='water'?WATER[v%3]:cell.terrain==='green'?GREEN[v%3]:GRASS[v%3];
 // A tiny ground overlap covers antialias seams; it never moves world geometry.
 footprintQuad(ctx,cx,cy,.505);
 if(!cell)return;
 if(cell.terrain==='water')return;
 if(cell.road){
  const kind=roadClassOf(cell),width=kind==='highway'?.24:kind==='avenue'?.18:.13;
  ctx.fillStyle=kind==='highway'?'#b2b8bf':'#969da5';
  // The two road strips, drawn as scalar quads. Along-x strip then cross-x strip, same order as `for cross of [false,true]`.
  quad(ctx,
   projXOf(cx-.5,cy-width),projYOf(cx-.5,cy-width),projXOf(cx+.5,cy-width),projYOf(cx+.5,cy-width),
   projXOf(cx+.5,cy+width),projYOf(cx+.5,cy+width),projXOf(cx-.5,cy+width),projYOf(cx-.5,cy+width));
  quad(ctx,
   projXOf(cx-width,cy-.5),projYOf(cx-width,cy-.5),projXOf(cx+width,cy-.5),projYOf(cx+width,cy-.5),
   projXOf(cx+width,cy+.5),projYOf(cx+width,cy+.5),projXOf(cx-width,cy+.5),projYOf(cx-width,cy+.5));
  if(scale>=24){
   // Zoom-dependent dash, so still a fresh 2-tuple — but only on near road cells and recorded as its own value.
   ctx.strokeStyle='#e5e5dc';ctx.lineWidth=Math.max(1,scale*.025);ctx.setLineDash([scale*.12,scale*.12]);
   const ax=projXOf(cx-.5,cy),ay=projYOf(cx-.5,cy),bx=projXOf(cx+.5,cy),by=projYOf(cx+.5,cy);
   ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.stroke();ctx.setLineDash(DASH_SOLID);
   let stage=0,social=false;
   for(let n=0;n<NEIGHBOURS.length;n++){
    const x=NEIGHBOURS[n]![0],y=NEIGHBOURS[n]![1],ny=cy+y;if(ny<0||ny>=WORLD)continue;
    const nb=lookup(view,{x:wrapX(cx+x),y:ny});stage=Math.max(stage,nb?.stage??0);social||=nb?.building==='commercial'||nb?.building==='park';
   }
   const life=lifeAt({x:cx,y:cy,stage,social,road:kind},view.motion);
   if(life&&!view.mobility){
    const t=life.along-.5,side=life.lane*.08,lx=cx+(life.cross?side:t),ly=cy+(life.cross?t:side);
    const px=projXOf(lx,ly),py=projYOf(lx,ly);
    ctx.fillStyle=life.colour;ctx.fillRect(px-scale*.06,py-scale*.06,scale*.12,scale*.08);
   }
  }
  if(view.mobility)drawCellMobility(ctx,view,coord);
 }
 if(cell.building)building(ctx,view,coord,cell,v);
 else if(cell.terrain==='green'&&scale>=14)tree(ctx,projXOf(cx,cy),projYOf(cx,cy),scale,v);
}
function marker(ctx:CanvasRenderingContext2D,view:WorldView,cell:CellCoord,valid:boolean){
 ctx.fillStyle=valid?'rgba(124,224,110,.25)':'rgba(240,90,80,.3)';ctx.strokeStyle=valid?'#c8ffb8':'#ffc0b8';ctx.lineWidth=1;
 footprintQuad(ctx,cell.x,cell.y,.5,true);
}
// Reused draw-order buffers for the fine pass. The painter sort is kept for correctness (it stays identical to the old
// cells.sort), but the per-frame array of {cell,p} objects is gone: cell coordinates and screen y/x live in parallel
// typed/number arrays, and only an index array is sorted. Buffers grow as needed and are reused across frames.
let ORDER:number[]=[];
let CELLX:Int32Array=new Int32Array(0),CELLY:Int32Array=new Int32Array(0);
let PY:Float64Array=new Float64Array(0),PX:Float64Array=new Float64Array(0);
const ensure=(n:number):void=>{
 if(CELLX.length>=n)return;
 const cap=Math.max(n,CELLX.length*2,1024);
 CELLX=new Int32Array(cap);CELLY=new Int32Array(cap);PY=new Float64Array(cap);PX=new Float64Array(cap);
};
// Street life is drawn from this tile size on; the host uses it to know when a moving clock changes the picture at all.
export const drawsStreetLife=(camera:Camera):boolean=>!isCoarse(camera)&&TILE_W*camera.zoom>=24;
export function render(ctx:CanvasRenderingContext2D,view:WorldView):void{
 if(view.geography||view.camera.zoom<GLOBE_ZOOM){renderGeographicWorld(ctx,view);return;}
 ctx=lightContext(ctx,view.light??'day');
 const {camera,viewport}=view;ctx.imageSmoothingEnabled=false;ctx.lineJoin='round';ctx.fillStyle='#7c8794';ctx.fillRect(0,0,viewport.width,viewport.height);
 setMatrix(camera);resetLookup(view);
 // Include ground behind a tall building whose roof enters the viewport.
 const height=8*TILE_H*camera.zoom;
 // Four screen corners mapped back into cell space; the min/max are taken with scalar comparisons, no Math.min(...spread).
 const c0=cellSpace({x:0,y:0},camera),c1=cellSpace({x:viewport.width,y:0},camera);
 const c2=cellSpace({x:0,y:viewport.height+height},camera),c3=cellSpace({x:viewport.width,y:viewport.height+height},camera);
 const cxMin=Math.min(c0.x,c1.x,c2.x,c3.x),cxMax=Math.max(c0.x,c1.x,c2.x,c3.x);
 const cyMin=Math.min(c0.y,c1.y,c2.y,c3.y),cyMax=Math.max(c0.y,c1.y,c2.y,c3.y);
 const minX=Math.floor(cxMin)-1,maxX=Math.ceil(cxMax)+1;
 const minY=Math.max(0,Math.floor(cyMin)-1),maxY=Math.min(WORLD-1,Math.ceil(cyMax)+1);
 if(isCoarse(camera)||(maxX-minX)*(maxY-minY)>5000){
  // Bound work to visible regions, with cached 4x4 summaries. Screen zoom reuses these summaries.
  for(let y=Math.floor(minY/CHUNK)*CHUNK;y<=maxY;y+=CHUNK)for(let x=Math.floor(minX/CHUNK)*CHUNK;x<=maxX;x+=CHUNK){
   const id=chunkId({x,y}),blocks=cachedMosaic(view,id);
   const size=blocks?BLOCK:CHUNK;
   for(let by=0;by<CHUNK;by+=size)for(let bx=0;bx<CHUNK;bx+=size){
    const ccx=x+bx+(size-1)/2,ccy=y+by+(size-1)/2;
    proj(ccx,ccy);const px=SX,py=SY,reach=size*TILE_W*camera.zoom*1.5;
    if(px+reach<0||px-reach>viewport.width||py+reach<0||py-reach>viewport.height)continue;
    ctx.fillStyle=blocks?blocks[(by/BLOCK)*BLOCKS+bx/BLOCK]!:'#687481';footprintQuad(ctx,ccx,ccy,size*.502);
   }
  }
 }else{
  const reach=TILE_W*camera.zoom*1.5;
  ensure((maxX-minX+1)*(maxY-minY+1));
  let count=0;
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
   proj(x,y);const px=SX,py=SY;
   if(px+reach<0||px-reach>viewport.width||py+reach<0||py-height-reach>viewport.height)continue;
   CELLX[count]=x;CELLY[count]=y;PX[count]=px;PY[count]=py;ORDER[count]=count;count++;
  }
  // Painter order: screen y then x, exactly the old cells.sort comparator. Only indices move, in a reused plain array
  // (Array.prototype.sort is the stable sort the reference used, so ties keep row-major insertion order).
  if(ORDER.length>count)ORDER.length=count;
  ORDER.sort((a,b)=>PY[a]!-PY[b]!||PX[a]!-PX[b]!);
  const coord={x:0,y:0};
  for(let k=0;k<count;k++){const i=ORDER[k]!;coord.x=CELLX[i]!;coord.y=CELLY[i]!;drawCell(ctx,view,coord);}
 }
 if(isCoarse(camera))drawVisibleMobility(ctx,view);
 if(view.tool!=='explore')for(const cell of view.preview)marker(ctx,view,cell,view.previewAffordable);
 if(view.hover)marker(ctx,view,view.hover,true);
}
