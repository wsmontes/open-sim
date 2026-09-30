import type {Building,Cell,CellCoord,GameState} from '../core/model';
import {CHUNK,WORLD,cellIndex,chunkId,variant} from '../core/coordinates';
import {effectiveCells} from '../core/world';
import type {ChunkStatus} from '../session/ports';
import type {SelectedTool} from './hud';
import type {Camera,Point,Viewport} from './camera';
import {TILE_H,TILE_W,cellSpace,isCoarse,project} from './camera';
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
};
const GRASS=['#7fbe58','#86c55e','#78b551'];
const MEADOW=['#69aa4a','#71b351','#61a043'];
const WATER=['#3e80c4','#4489cc','#3a78bb'];
const UNKNOWN=['#333a44','#3b424d'];
const ERROR=['#54282e','#5d2d33'];
const ROOF:Record<Building,string>={residential:'#cf5c3c',commercial:'#4a77be',industrial:'#858b92',park:'#4f9e46',power:'#6f7278'};
const WALL_LIGHT='#e8dfc9',WALL_DARK='#c9bda2',LOT='#cbb083',MARK='#f6f1e4',SHADE='rgba(18,30,44,.18)';
const PREVIEW_OK={fill:'rgba(124,224,110,.3)',line:'#c8ffb8'};
const PREVIEW_BLOCKED={fill:'rgba(240,90,80,.32)',line:'#ffc0b8'};
const HOVER={fill:'rgba(255,255,255,.07)',line:'rgba(255,255,255,.65)'};
const diamondPath=(ctx:CanvasRenderingContext2D,cx:number,cy:number,hw:number,hh:number)=>{ctx.beginPath();ctx.moveTo(cx,cy-hh);ctx.lineTo(cx+hw,cy);ctx.lineTo(cx,cy+hh);ctx.lineTo(cx-hw,cy);ctx.closePath();};
const diamond=(ctx:CanvasRenderingContext2D,cx:number,cy:number,hw:number,hh:number)=>{diamondPath(ctx,cx,cy,hw,hh);ctx.fill();};
const polygon=(ctx:CanvasRenderingContext2D,points:Point[])=>{ctx.beginPath();ctx.moveTo(points[0].x,points[0].y);for(const p of points)ctx.lineTo(p.x,p.y);ctx.closePath();ctx.fill();};
export function render(ctx:CanvasRenderingContext2D,view:WorldView):void {
 const {camera,viewport}=view,tw=TILE_W*camera.zoom,th=TILE_H*camera.zoom;
 ctx.imageSmoothingEnabled=false;
 ctx.lineJoin='round';
 ctx.fillStyle='#16222f';
 ctx.fillRect(0,0,viewport.width,viewport.height);
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
 for(const [px,py] of [[0,0],[viewport.width,0],[0,viewport.height],[viewport.width,viewport.height]]){
  const c=cellSpace({x:px,y:py},camera);
  minX=Math.min(minX,c.x);maxX=Math.max(maxX,c.x);minY=Math.min(minY,c.y);maxY=Math.max(maxY,c.y);
 }
 if(isCoarse(camera))renderMosaic(ctx,view,{minX,maxX,minY,maxY});
 else{
  const x0=Math.floor(minX)-2,x1=Math.ceil(maxX)+2,y0=Math.floor(minY)-2,y1=Math.ceil(maxY)+2,lift=th*7;
  // Painter order: rows of equal x+y are drawn back to front, cells with the larger x+y land in front.
  for(let sum=x0+y0;sum<=x1+y1;sum++){
   const from=Math.max(x0,sum-y1),to=Math.min(x1,sum-y0);
   for(let x=from;x<=to;x++){
    const y=sum-x;
    if(y<0||y>=WORLD)continue;
    const p=project({x,y},camera);
    if(p.x+tw<0||p.x-tw>viewport.width||p.y+th+lift<0||p.y-th>viewport.height)continue;
    drawTile(ctx,view,{x,y},p,tw,th);
   }
  }
 }
 if(view.tool!=='explore')for(const cell of view.preview)drawMarker(ctx,view,cell,tw,th,view.previewAffordable?PREVIEW_OK:PREVIEW_BLOCKED,true);
 if(view.hover)drawMarker(ctx,view,view.hover,tw,th,HOVER,false);
}
function lookupCell(view:WorldView,cell:CellCoord):{cell:Cell|null;error:boolean} {
 const id=chunkId(cell),managed=view.state.chunks[id];
 if(managed){const i=cellIndex(cell);return {cell:managed.edits[i]??managed.base.cells[i],error:false};}
 const status=view.chunks.get(id);
 if(status?.status==='ready')return {cell:status.base.cells[cellIndex(cell)],error:false};
 return {cell:null,error:status?.status==='error'};
}
function drawTile(ctx:CanvasRenderingContext2D,view:WorldView,coord:CellCoord,p:Point,tw:number,th:number) {
 const found=lookupCell(view,coord),v=variant(coord.x,coord.y,view.seed);
 if(!found.cell)return drawUnknown(ctx,p,tw,th,v,found.error);
 const cell=found.cell;
 if(cell.terrain==='water')return drawWater(ctx,p,tw,th,v);
 ctx.fillStyle=(cell.terrain==='green'?MEADOW:GRASS)[v%3];
 diamond(ctx,p.x,p.y,tw,th);
 if(cell.road)drawRoad(ctx,p,tw,th,v);
 if(cell.building)drawBuilding(ctx,cell,p,tw,th,v);
}
function drawWater(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,v:number) {
 ctx.fillStyle=WATER[v%3];
 diamond(ctx,p.x,p.y,tw,th);
 ctx.strokeStyle='rgba(232,244,255,.4)';
 ctx.lineWidth=Math.max(1,tw*.03);
 ctx.setLineDash([]);
 const ox=(v%3-1)*tw*.2;
 ctx.beginPath();ctx.moveTo(p.x+ox-tw*.3,p.y+th*.28);ctx.lineTo(p.x+ox+tw*.14,p.y+th*.28);ctx.stroke();
}
function drawRoad(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,v:number) {
 ctx.fillStyle='#8b9199';
 diamond(ctx,p.x,p.y,tw,th);
 const ua={x:tw/2,y:th/2},ub={x:tw/2,y:-th/2},wa={x:ub.x*.24,y:ub.y*.24},wb={x:ua.x*.24,y:ua.y*.24};
 ctx.fillStyle='#9ea4ab';
 polygon(ctx,[{x:p.x-ua.x+wa.x,y:p.y-ua.y+wa.y},{x:p.x+ua.x+wa.x,y:p.y+ua.y+wa.y},{x:p.x+ua.x-wa.x,y:p.y+ua.y-wa.y},{x:p.x-ua.x-wa.x,y:p.y-ua.y-wa.y}]);
 polygon(ctx,[{x:p.x-ub.x+wb.x,y:p.y-ub.y+wb.y},{x:p.x+ub.x+wb.x,y:p.y+ub.y+wb.y},{x:p.x+ub.x-wb.x,y:p.y+ub.y-wb.y},{x:p.x-ub.x-wb.x,y:p.y-ub.y-wb.y}]);
 ctx.strokeStyle='rgba(246,241,228,.7)';
 ctx.lineWidth=Math.max(1,tw*.05);
 ctx.setLineDash([tw*.14,th*.2]);
 ctx.beginPath();ctx.moveTo(p.x-ua.x,p.y-ua.y);ctx.lineTo(p.x+ua.x,p.y+ua.y);ctx.stroke();
 ctx.setLineDash([]);
 ctx.fillStyle=v%2?'rgba(255,255,255,.25)':'rgba(60,70,80,.18)';
 diamond(ctx,p.x,p.y,tw*.1,th*.1);
}
function drawBuilding(ctx:CanvasRenderingContext2D,cell:Cell,p:Point,tw:number,th:number,v:number) {
 const kind=cell.building!;
 if(kind==='park')return drawPark(ctx,p,tw,th,v);
 if(cell.stage===0)return drawLot(ctx,p,tw,th);
 const floors=kind==='power'?4:1+v%3,h=floors*th*.85;
 ctx.fillStyle=SHADE;
 diamond(ctx,p.x+tw*.1,p.y+th*.1,tw*.88,th*.88);
 ctx.fillStyle=WALL_DARK;
 polygon(ctx,[{x:p.x-tw,y:p.y},{x:p.x,y:p.y+th},{x:p.x,y:p.y+th-h},{x:p.x-tw,y:p.y-h}]);
 ctx.fillStyle=WALL_LIGHT;
 polygon(ctx,[{x:p.x,y:p.y+th},{x:p.x+tw,y:p.y},{x:p.x+tw,y:p.y-h},{x:p.x,y:p.y+th-h}]);
 if(kind==='residential'||kind==='commercial'){
  const step=h/floors;
  ctx.fillStyle='#3c4a5c';
  for(let f=0;f<floors;f++){
   const t=(v>>(f*3))%2?.34:.62;
   const corner={x:p.x+tw*t,y:p.y+th*(1-t)-(f+.28)*step},du={x:tw*.24,y:-th*.24},dv={x:0,y:-step*.42};
   polygon(ctx,[corner,{x:corner.x+du.x,y:corner.y+du.y},{x:corner.x+du.x,y:corner.y+du.y+dv.y},{x:corner.x,y:corner.y+dv.y}]);
  }
 }else{
  ctx.fillStyle='rgba(40,48,58,.25)';
  polygon(ctx,[{x:p.x,y:p.y+th},{x:p.x+tw*.6,y:p.y+th*.4},{x:p.x+tw*.6,y:p.y+th*.4-h*.25},{x:p.x,y:p.y+th-h*.25}]);
 }
 ctx.fillStyle=ROOF[kind];
 polygon(ctx,[{x:p.x-tw,y:p.y-h},{x:p.x,y:p.y+th-h},{x:p.x+tw,y:p.y-h},{x:p.x,y:p.y-th-h}]);
 if(kind==='power'){
  ctx.fillStyle='#f0ece0';
  ctx.fillRect(p.x-Math.max(1,tw*.05),p.y-th*.6-h,Math.max(2,tw*.1),th*.5);
 }
}
function drawPark(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,v:number) {
 const count=2+v%3;
 for(let i=0;i<count;i++){
  const a=variant(v+i*7,v-i*13,i),dx=((a%5)-2)*tw*.13,dy=(((a>>3)%5)-2)*th*.26;
  ctx.fillStyle=i%2?'#3f8b3d':'#57a94a';
  ctx.beginPath();ctx.arc(p.x+dx,p.y+dy-th*.22,tw*.16,0,Math.PI*2);ctx.fill();
  ctx.fillStyle='rgba(255,255,255,.3)';
  ctx.beginPath();ctx.arc(p.x+dx-tw*.04,p.y+dy-th*.28,tw*.06,0,Math.PI*2);ctx.fill();
 }
}
function drawLot(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number) {
 ctx.fillStyle=LOT;
 diamond(ctx,p.x,p.y,tw,th);
 ctx.strokeStyle=MARK;
 ctx.lineWidth=Math.max(1,tw*.06);
 ctx.setLineDash([tw*.16,th*.2]);
 diamondPath(ctx,p.x,p.y,tw*.66,th*.66);
 ctx.stroke();
 ctx.setLineDash([]);
 ctx.strokeStyle='#7a5b34';
 ctx.lineWidth=Math.max(1,tw*.08);
 ctx.beginPath();ctx.moveTo(p.x,p.y-th*.05);ctx.lineTo(p.x,p.y-th*.55);ctx.stroke();
 ctx.fillStyle='#e0563f';
 polygon(ctx,[{x:p.x,y:p.y-th*.55},{x:p.x+tw*.2,y:p.y-th*.42},{x:p.x,y:p.y-th*.3}]);
}
function drawUnknown(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,v:number,failed:boolean) {
 ctx.fillStyle=(failed?ERROR:UNKNOWN)[v%2];
 diamond(ctx,p.x,p.y,tw,th);
 ctx.save();
 diamondPath(ctx,p.x,p.y,tw,th);
 ctx.clip();
 ctx.strokeStyle=failed?'rgba(255,150,140,.34)':'rgba(196,210,228,.22)';
 ctx.lineWidth=Math.max(1,tw*.06);
 const gap=tw*.3,off=((v>>4)%3)*tw*.1;
 for(let k=-tw*1.4;k<tw*1.4;k+=gap){
  ctx.beginPath();ctx.moveTo(p.x+k+off+th,p.y-th);ctx.lineTo(p.x+k+off-th,p.y+th);ctx.stroke();
 }
 ctx.restore();
 ctx.strokeStyle='rgba(10,16,24,.5)';
 ctx.lineWidth=Math.max(1,tw*.04);
 diamondPath(ctx,p.x,p.y,tw,th);
 ctx.stroke();
 if(!failed)return;
 ctx.fillStyle='#ffb4a8';
 ctx.strokeStyle='#ffb4a8';
 ctx.lineWidth=Math.max(1,tw*.09);
 ctx.beginPath();ctx.moveTo(p.x,p.y-th*.3);ctx.lineTo(p.x,p.y+th*.02);ctx.stroke();
 ctx.beginPath();ctx.arc(p.x,p.y+th*.22,Math.max(1,tw*.07),0,Math.PI*2);ctx.fill();
}
function drawMarker(ctx:CanvasRenderingContext2D,view:WorldView,cell:CellCoord,tw:number,th:number,style:{fill:string;line:string},strong:boolean) {
 const p=project(cell,view.camera);
 // A cell is under two pixels wide at 0.05x: keep the preview and the hover outline big enough to be useful.
 const w=Math.max(tw,4),h=Math.max(th,2);
 if(p.x+w<0||p.x-w>view.viewport.width||p.y+h<0||p.y-h>view.viewport.height)return;
 ctx.fillStyle=style.fill;
 diamond(ctx,p.x,p.y,w,h);
 ctx.strokeStyle=style.line;
 ctx.lineWidth=Math.max(1,w*(strong?.08:.04));
 if(strong)ctx.setLineDash([w*.14,h*.18]);
 diamondPath(ctx,p.x,p.y,w*.96,h*.96);
 ctx.stroke();
 ctx.setLineDash([]);
}

// --- Wide view: one mosaic block per 4x4 cells instead of one diamond per cell -------------------------------
// At 0.05x a cell is under two pixels, so per-cell art is neither readable nor cheap. Each region is summarised
// into 8x8 blocks coloured by what dominates them, which keeps a whole city on screen at 60 fps and stays
// deterministic: the same cells always produce the same colours.
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
const mosaicCache=new Map<string,string[]>();
function cachedMosaic(view:WorldView,id:string):string[]|null {
 const managed=view.state.chunks[id],key=managed?`${id}#${view.state.revision}`:id,cached=mosaicCache.get(key);
 if(cached)return cached;
 const cells=managed?effectiveCells(managed):view.chunks.get(id)?.status==='ready'?(view.chunks.get(id) as {base:{cells:Cell[]}}).base.cells:null;
 if(!cells)return null;
 const blocks=aggregateCells(cells);
 mosaicCache.set(key,blocks);
 while(mosaicCache.size>512)mosaicCache.delete(mosaicCache.keys().next().value!);
 return blocks;
}
type Box={minX:number;maxX:number;minY:number;maxY:number};
function renderMosaic(ctx:CanvasRenderingContext2D,view:WorldView,box:Box):void{
 const {camera,viewport}=view,span=BLOCK*TILE_W*camera.zoom,spanH=BLOCK*TILE_H*camera.zoom;
 const firstX=Math.floor((box.minX-1)/CHUNK),lastX=Math.floor((box.maxX+1)/CHUNK);
 const firstY=Math.max(0,Math.floor((box.minY-1)/CHUNK)),lastY=Math.min(WORLD/CHUNK-1,Math.floor((box.maxY+1)/CHUNK));
 const regions:string[]=[];
 for(let cy=firstY;cy<=lastY;cy++)for(let cx=firstX;cx<=lastX;cx++){
  const x=cx*CHUNK,y=cy*CHUNK,centre=project({x:x+CHUNK/2,y:y+CHUNK/2},camera);
  const halfW=CHUNK*TILE_W*camera.zoom,halfH=CHUNK*TILE_H*camera.zoom;
  if(centre.x+halfW<0||centre.x-halfW>viewport.width||centre.y+halfH<0||centre.y-halfH>viewport.height)continue;
  regions.push(`${cy*100000+cx}:${x}:${y}`);
 }
 // Back to front, then left to right inside each region, so the mosaic never depends on insertion order.
 regions.sort((a,b)=>{const [ka,ax,ay]=a.split(':').map(Number),[kb,bx,by]=b.split(':').map(Number);return (Number(ax)+Number(ay))-(Number(bx)+Number(by))||ka-kb;});
 for(const entry of regions){
  const [,xs,ys]=entry.split(':');const x=Number(xs),y=Number(ys),id=chunkId({x,y});
  const blocks=cachedMosaic(view,id);
  if(!blocks){
   const failed=view.chunks.get(id)?.status==='error';
   drawUnknown(ctx,project({x:x+CHUNK/2,y:y+CHUNK/2},camera),CHUNK*TILE_W*camera.zoom,CHUNK*TILE_H*camera.zoom,variant(x,y,view.seed),failed);
   continue;
  }
  for(let by=0;by<BLOCKS;by++)for(let bx=0;bx<BLOCKS;bx++){
   const p=project({x:x+bx*BLOCK+BLOCK/2,y:y+by*BLOCK+BLOCK/2},camera);
   ctx.fillStyle=blocks[by*BLOCKS+bx]!;
   diamond(ctx,p.x,p.y,span,spanH);
  }
 }
}
