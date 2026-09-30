import type {Building,Cell,CellCoord,GameState} from '../core/model';
import {WORLD,cellIndex,chunkId,variant} from '../core/coordinates';
import type {ChunkStatus} from '../session/ports';
import type {SelectedTool} from './hud';
import type {Camera,Point,Viewport} from './camera';
import {TILE_H,TILE_W,cellSpace,project} from './camera';
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
 if(p.x+tw<0||p.x-tw>view.viewport.width||p.y+th<0||p.y-th>view.viewport.height)return;
 ctx.fillStyle=style.fill;
 diamond(ctx,p.x,p.y,tw,th);
 ctx.strokeStyle=style.line;
 ctx.lineWidth=Math.max(1,tw*(strong?.08:.04));
 if(strong)ctx.setLineDash([tw*.14,th*.18]);
 diamondPath(ctx,p.x,p.y,tw*.96,th*.96);
 ctx.stroke();
 ctx.setLineDash([]);
}
