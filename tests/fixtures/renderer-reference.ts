import type {Building,Cell,CellCoord,GameState} from '../../src/core/model';
import {CHUNK,WORLD,cellIndex,chunkId,variant,wrapX} from '../../src/core/coordinates';
import {effectiveCells} from '../../src/core/world';
import {roadClassOf} from '../../src/core/model';
import {lifeAt} from '../../src/presentation/street-life';
import type {ChunkStatus} from '../../src/session/ports';
import type {SelectedTool} from '../../src/presentation/tools';
import type {Camera,Point,Viewport} from '../../src/presentation/camera';
import {TILE_H,TILE_W,cellSpace,isCoarse,project} from '../../src/presentation/camera';
export type WorldView = {
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
const polygon=(ctx:CanvasRenderingContext2D,points:readonly Point[],stroke=false)=>{
 ctx.beginPath();ctx.moveTo(points[0]!.x,points[0]!.y);
 for(let i=1;i<points.length;i++)ctx.lineTo(points[i]!.x,points[i]!.y);
 ctx.closePath();ctx.fill();if(stroke)ctx.stroke();
};
function footprint(cell:CellCoord,camera:Camera,radius=.5):Point[]{
 return [[-radius,-radius],[radius,-radius],[radius,radius],[-radius,radius]].map(([x,y])=>project({x:cell.x+x,y:cell.y+y},camera));
}
function lookup(view:WorldView,cell:CellCoord):Cell|null{
 const id=chunkId(cell),managed=view.state.chunks[id];
 if(managed){const i=cellIndex(cell);return managed.edits[i]??managed.base.cells[i];}
 const status=view.chunks.get(id);return status?.status==='ready'?status.base.cells[cellIndex(cell)]:null;
}
function tree(ctx:CanvasRenderingContext2D,p:Point,scale:number,tone:number){
 ctx.fillStyle='#765838';ctx.fillRect(p.x-scale*.045,p.y-scale*.35,Math.max(1,scale*.09),scale*.35);
 ctx.fillStyle=['#438b45','#58a34c','#6cb256'][tone%3]!;
 ctx.beginPath();ctx.arc(p.x,p.y-scale*.42,scale*.16,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='rgba(255,255,255,.2)';ctx.beginPath();ctx.arc(p.x-scale*.05,p.y-scale*.48,scale*.06,0,Math.PI*2);ctx.fill();
}
function building(ctx:CanvasRenderingContext2D,view:WorldView,coord:CellCoord,cell:Cell,v:number){
 const camera=view.camera,scale=TILE_W*camera.zoom,kind=cell.building!;
 const floor=footprint(coord,camera,.34);
 if(kind==='park'){
  ctx.fillStyle=ROOF.park;polygon(ctx,floor);
  if(scale>=10)tree(ctx,project(coord,camera),scale,v);return;
 }
 if(cell.stage===0){
  ctx.fillStyle='#cbb083';polygon(ctx,floor);ctx.strokeStyle='#f6f1e4';ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);return;
 }
 const height=Math.max(1,cell.stage??1)*TILE_H*camera.zoom*.85;
 const roof=floor.map(p=>({x:p.x,y:p.y-height}));
 const near=scale>=24;
 // Only the front-facing walls are visible. The roof is independent of the camera's ground bearing.
 for(let i=0;i<4;i++){
  const j=(i+1)%4,a=floor[i]!,b=floor[j]!;
  if(b.x<=a.x)continue;
  ctx.fillStyle=i%2?'#c8b99c':'#ece1c8';polygon(ctx,[a,b,roof[j]!,roof[i]!]);
  if(near){
   ctx.strokeStyle='#5b6674';ctx.lineWidth=Math.max(1,scale*.04);
   for(let f=0;f<Math.min(8,cell.stage??1);f++){
    const y=height*(f+.5)/Math.max(1,cell.stage??1);
    ctx.beginPath();ctx.moveTo(a.x+(b.x-a.x)*.25,a.y+(b.y-a.y)*.25-y);
    ctx.lineTo(a.x+(b.x-a.x)*.75,a.y+(b.y-a.y)*.75-y);ctx.stroke();
   }
  }
 }
 ctx.fillStyle=ROOF[kind];ctx.strokeStyle='rgba(58,50,40,.35)';ctx.lineWidth=Math.max(1,scale*.025);polygon(ctx,roof,near);
 if(near){
  const p=project(coord,camera);ctx.fillStyle='rgba(255,255,255,.25)';
  ctx.fillRect(p.x-scale*.07,p.y-height-scale*.06,scale*.14,scale*.1);
 }
}
function drawCell(ctx:CanvasRenderingContext2D,view:WorldView,coord:CellCoord){
 const cell=lookup(view,coord),v=variant(coord.x,coord.y,view.seed),camera=view.camera,scale=TILE_W*camera.zoom;
 ctx.fillStyle=!cell?(view.chunks.get(chunkId(coord))?.status==='error'?'#875356':'#687481'):cell.terrain==='water'?WATER[v%3]:cell.terrain==='green'?GREEN[v%3]:GRASS[v%3];
 // A tiny ground overlap covers antialias seams; it never moves world geometry.
 polygon(ctx,footprint(coord,camera,.505));
 if(!cell)return;
 if(cell.terrain==='water')return;
 if(cell.road){
  const kind=roadClassOf(cell),width=kind==='highway'?.24:kind==='avenue'?.18:.13;
  ctx.fillStyle=kind==='highway'?'#b2b8bf':'#969da5';
  for(const cross of [false,true]){
   const points=(cross?[[-width,-.5],[width,-.5],[width,.5],[-width,.5]]:[[-.5,-width],[.5,-width],[.5,width],[-.5,width]]).map(([x,y])=>project({x:coord.x+x,y:coord.y+y},camera));
   polygon(ctx,points);
  }
  if(scale>=24){
   ctx.strokeStyle='#e5e5dc';ctx.lineWidth=Math.max(1,scale*.025);ctx.setLineDash([scale*.12,scale*.12]);
   const a=project({x:coord.x-.5,y:coord.y},camera),b=project({x:coord.x+.5,y:coord.y},camera);
   ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);
   let stage=0,social=false;
   for(const [x,y] of [[1,0],[-1,0],[0,1],[0,-1]]){
    const cy=coord.y+y;if(cy<0||cy>=WORLD)continue;
    const n=lookup(view,{x:wrapX(coord.x+x),y:cy});stage=Math.max(stage,n?.stage??0);social||=n?.building==='commercial'||n?.building==='park';
   }
   const life=lifeAt({x:coord.x,y:coord.y,stage,social,road:kind},view.motion);
   if(life){
    const t=life.along-.5,side=life.lane*.08,p=project({x:coord.x+(life.cross?side:t),y:coord.y+(life.cross?t:side)},camera);
    ctx.fillStyle=life.colour;ctx.fillRect(p.x-scale*.06,p.y-scale*.06,scale*.12,scale*.08);
   }
  }
 }
 if(cell.building)building(ctx,view,coord,cell,v);
 else if(cell.terrain==='green'&&scale>=14)tree(ctx,project(coord,camera),scale,v);
}
function marker(ctx:CanvasRenderingContext2D,view:WorldView,cell:CellCoord,valid:boolean){
 ctx.fillStyle=valid?'rgba(124,224,110,.25)':'rgba(240,90,80,.3)';ctx.strokeStyle=valid?'#c8ffb8':'#ffc0b8';ctx.lineWidth=1;
 polygon(ctx,footprint(cell,view.camera),true);
}
export function render(ctx:CanvasRenderingContext2D,view:WorldView):void{
 const {camera,viewport}=view;ctx.imageSmoothingEnabled=false;ctx.lineJoin='round';ctx.fillStyle='#7c8794';ctx.fillRect(0,0,viewport.width,viewport.height);
 // Include ground behind a tall building whose roof enters the viewport.
 const height=8*TILE_H*camera.zoom;
 const corners=[[0,0],[viewport.width,0],[0,viewport.height+height],[viewport.width,viewport.height+height]].map(([x,y])=>cellSpace({x,y},camera));
 const minX=Math.floor(Math.min(...corners.map(p=>p.x)))-1,maxX=Math.ceil(Math.max(...corners.map(p=>p.x)))+1;
 const minY=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.y)))-1),maxY=Math.min(WORLD-1,Math.ceil(Math.max(...corners.map(p=>p.y)))+1);
 if(isCoarse(camera)||(maxX-minX)*(maxY-minY)>5000){
  // Bound work to visible regions, with cached 4x4 summaries. Screen zoom reuses these summaries.
  for(let y=Math.floor(minY/CHUNK)*CHUNK;y<=maxY;y+=CHUNK)for(let x=Math.floor(minX/CHUNK)*CHUNK;x<=maxX;x+=CHUNK){
   const id=chunkId({x,y}),blocks=cachedMosaic(view,id);
   const size=blocks?BLOCK:CHUNK;
   for(let by=0;by<CHUNK;by+=size)for(let bx=0;bx<CHUNK;bx+=size){
    const cell={x:x+bx+(size-1)/2,y:y+by+(size-1)/2},p=project(cell,camera),reach=size*TILE_W*camera.zoom*1.5;
    if(p.x+reach<0||p.x-reach>viewport.width||p.y+reach<0||p.y-reach>viewport.height)continue;
    ctx.fillStyle=blocks?blocks[(by/BLOCK)*BLOCKS+bx/BLOCK]!:'#687481';polygon(ctx,footprint(cell,camera,size*.502));
   }
  }
 }else{
  const cells:Array<{cell:CellCoord;p:Point}>=[],reach=TILE_W*camera.zoom*1.5;
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
   const cell={x,y},p=project(cell,camera);
   if(p.x+reach<0||p.x-reach>viewport.width||p.y+reach<0||p.y-height-reach>viewport.height)continue;
   cells.push({cell,p});
  }
  cells.sort((a,b)=>a.p.y-b.p.y||a.p.x-b.p.x);
  for(const {cell} of cells)drawCell(ctx,view,cell);
 }
 if(view.tool!=='explore')for(const cell of view.preview)marker(ctx,view,cell,view.previewAffordable);
 if(view.hover)marker(ctx,view,view.hover,true);
}
