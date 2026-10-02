import type {Building,Cell,CellCoord,GameState} from '../../core/model';
import {CHUNK,WORLD,chunkId,variant,wrapX} from '../../core/coordinates';
import {effectiveCells,occupied} from '../../core/world';
import {roadClassOf} from '../../core/model';
import type {RoadClass} from '../../core/model';
import {lifeAt} from '../../presentation/street-life';
import type {StreetLife} from '../../presentation/street-life';
import {drawLife} from './street-life-draw';
import type {ChunkStatus} from '../../session/ports';
import type {SelectedTool} from './hud';
import type {Camera,Point,Viewport} from '../../presentation/camera';
import {TILE_H,TILE_W,cellSpace,isCoarse,project} from '../../presentation/camera';
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
// The palette. Every colour is a little muted and a little warm — afternoon grass rather than a signal green, weathered
// brick, denim blue — because a city reads as cosy when nothing in it shouts. Saturation is what separates charming
// from loud, so the tones stay close together and the contrast is spent on the shadows instead.
const GRASS=['#8cbe6a','#93c471','#84b662'];
const MEADOW=['#74a95a','#7caf61','#6d9f54'];
const WATER=['#4a86bf','#508fc7','#457fb5'];
const UNKNOWN=['#5c6570','#646d79'];
const ERROR=['#7d4a4e','#875356'];
const ROOF:Record<Building,string>={residential:'#c9684b',commercial:'#5b82b8',industrial:'#8b9199',park:'#6fae5e',power:'#797d84'};
// Three tones per kind and three wall tints, worked out once when the module loads. Neighbouring buildings then differ
// from each other without a single extra drawing call and without parsing a colour per cell per frame: this is what
// keeps a row of same-kind buildings from reading as one long slab.
const tint=(hexColour:string,factor:number):string=>{
 const value=parseInt(hexColour.slice(1),16);
 const part=(shift:number)=>Math.max(0,Math.min(255,Math.round(((value>>shift)&255)*factor)));
 return `#${[part(16),part(8),part(0)].map(channel=>channel.toString(16).padStart(2,'0')).join('')}`;
};
// Roofs vary in value, never in hue: the colour of a roof is how the player reads what a zone is, so a neighbour
// differs from the next building by a shade and not by becoming a different kind of building. The chimney and the
// vent are darker shades of the roof they stand on, so they are worked out here too.
type RoofTone={colour:string;chimney:string;vent:string};
const roofTone=(colour:string):RoofTone=>({colour,chimney:tint(colour,.66),vent:tint(colour,.78)});
const tones=(colour:string):readonly RoofTone[]=>[roofTone(tint(colour,1)),roofTone(tint(colour,.94)),roofTone(tint(colour,1.06))];
const ROOF_TONES:Record<Building,readonly RoofTone[]>={residential:tones(ROOF.residential),commercial:tones(ROOF.commercial),industrial:tones(ROOF.industrial),park:tones(ROOF.park),power:tones(ROOF.power)};
const WALL_TONES:readonly (readonly [string,string])[]=[
 ['#efe7d3','#cabda0'],['#e8dfc9','#c2b498'],['#e2d7bd','#bbac8c'],
];
const LOT='#cbb083',MARK='#f6f1e4';
// A building casts two shadows: a wide soft one that gives it weight, and a tight dark one that anchors it to the
// ground. Drawn by hand rather than with `shadowBlur`, which is a blur pass per shape and the most expensive thing a
// 2D context offers.
const SHADE='rgba(32,44,58,.16)',SHADE_CORE='rgba(22,32,44,.28)';
const PREVIEW_OK={fill:'rgba(124,224,110,.3)',line:'#c8ffb8'};
const PREVIEW_BLOCKED={fill:'rgba(240,90,80,.32)',line:'#ffc0b8'};
const HOVER={fill:'rgba(255,255,255,.07)',line:'rgba(255,255,255,.65)'};
// Diagonal neighbours share their edges exactly, but each ground fill covers only half of a shared pixel, so the
// background used to show through as a one pixel thread between them. A seam is one pixel wide whatever the zoom, so
// the repair is measured in pixels too: the ground diamond has half-axes (2h, h), so its edge sits 2h/sqrt(5) = .894h
// from the centre, and padding both half-axes by 1.12 pushes every edge one pixel outwards. Both neighbours then cover
// the whole shared pixel and the later fill paints it in its own colour. Ground fills only, turned views only.
const SEAM_PAD=1.12;
const diamondPath=(ctx:CanvasRenderingContext2D,cx:number,cy:number,hw:number,hh:number)=>{ctx.beginPath();ctx.moveTo(cx,cy-hh);ctx.lineTo(cx+hw,cy);ctx.lineTo(cx,cy+hh);ctx.lineTo(cx-hw,cy);ctx.closePath();};
const diamond=(ctx:CanvasRenderingContext2D,cx:number,cy:number,hw:number,hh:number)=>{diamondPath(ctx,cx,cy,hw,hh);ctx.fill();};
// Quadrilaterals and triangles take their corners as plain numbers: a building is a dozen of them per frame, and an
// array of point objects per shape was the renderer's largest source of garbage.
const quadPath=(ctx:CanvasRenderingContext2D,ax:number,ay:number,bx:number,by:number,cx:number,cy:number,dx:number,dy:number)=>{ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.lineTo(cx,cy);ctx.lineTo(dx,dy);ctx.closePath();};
const quad=(ctx:CanvasRenderingContext2D,ax:number,ay:number,bx:number,by:number,cx:number,cy:number,dx:number,dy:number)=>{quadPath(ctx,ax,ay,bx,by,cx,cy,dx,dy);ctx.fill();};
const quadStroke=(ctx:CanvasRenderingContext2D,ax:number,ay:number,bx:number,by:number,cx:number,cy:number,dx:number,dy:number)=>{quadPath(ctx,ax,ay,bx,by,cx,cy,dx,dy);ctx.stroke();};
const triangle=(ctx:CanvasRenderingContext2D,ax:number,ay:number,bx:number,by:number,cx:number,cy:number)=>{ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.lineTo(cx,cy);ctx.closePath();ctx.fill();};
// Every dash a cell sets is undone before the cell returns, so the context leaves each drawing function solid. The
// solid pattern is one shared array, and the lane dash is rebuilt only when the zoom changes.
const SOLID:number[]=[];
let laneDash:number[]=[],laneDashFor=-1;
const laneDashOf=(tw:number,th:number):number[]=>{if(laneDashFor!==tw){laneDash=[tw*.14,th*.2];laneDashFor=tw;}return laneDash;};
// Street life is drawn from this tile size on; main uses it to know when a moving clock changes the picture at all.
export const drawsStreetLife=(camera:Camera):boolean=>!isCoarse(camera)&&TILE_W*camera.zoom>=LIFE_MIN_TILE;
export function render(ctx:CanvasRenderingContext2D,view:WorldView):void {
 const {camera,viewport}=view,tw=TILE_W*camera.zoom,th=TILE_H*camera.zoom;
 // The bearing is a context transform: the art below keeps drawing with the unrotated projection, while culling and
 // the visible-region list use the real camera, so a turned view neither leaves a cell out nor paints one it cannot see.
 const turned=camera.rotation!==0,flat:Camera=turned?{...camera,rotation:0}:camera,pad=turned?SEAM_PAD:0;
 const cos=Math.cos(camera.rotation),sin=Math.sin(camera.rotation),absCos=Math.abs(cos),absSin=Math.abs(sin);
 // Conservative screen half-box of one cell: the turned diamond plus the tallest silhouette the art draws (buildings
 // rise at most four tiles above their cell, a lean that grows sideways as the view turns).
 const spanX=tw*absCos+th*absSin+th*4*absSin,spanY=th*absCos+tw*absSin+th*4*absCos;
 ctx.imageSmoothingEnabled=false;
 ctx.lineJoin='round';
 // What is outside the map is a haze, not a void: a dark navy reads as a missing texture and makes the city look like
 // it is floating, while a soft cool grey lets the eye treat it as distance.
 ctx.fillStyle='#7c8794';
 ctx.fillRect(0,0,viewport.width,viewport.height);
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
 for(const [px,py] of [[0,0],[viewport.width,0],[0,viewport.height],[viewport.width,viewport.height]]){
  const c=cellSpace({x:px,y:py},camera);
  minX=Math.min(minX,c.x);maxX=Math.max(maxX,c.x);minY=Math.min(minY,c.y);maxY=Math.max(maxY,c.y);
 }
 if(turned){ctx.save();ctx.translate(camera.x,camera.y);ctx.rotate(camera.rotation);ctx.translate(-camera.x,-camera.y);}
 // Two reasons to draw blocks instead of cells: the cell is too small to be a cell (a wide zoom), or there are so
 // many of them that drawing each one would spend the frame — the second is what keeps a mid zoom over a large
 // region from being the most expensive view in the game.
 const span=(maxX-minX+2)*(maxY-minY+2);
 if(isCoarse(camera)||span>MOSAIC_CELLS)renderMosaic(ctx,view,{minX,maxX,minY,maxY});
 else{
  const x0=Math.floor(minX)-2,x1=Math.ceil(maxX)+2,y0=Math.floor(minY)-2,y1=Math.ceil(maxY)+2,zoom=camera.zoom;
  // One scratch point and one scratch cell for the whole pass: the projection below is `project()` written out, so a
  // frame of thousands of cells allocates nothing per cell. Nothing downstream keeps either object.
  const p:Point={x:0,y:0},coord:CellCoord={x:0,y:0};
  // Painter order: rows of equal x+y are drawn back to front, cells with the larger x+y land in front.
  for(let sum=x0+y0;sum<=x1+y1;sum++){
   const from=Math.max(x0,sum-y1),to=Math.min(x1,sum-y0);
   for(let x=from;x<=to;x++){
    const y=sum-x;
    if(y<0||y>=WORLD)continue;
    const u=(x-y)*TILE_W*zoom,v=(x+y)*TILE_H*zoom;
    const qx=turned?camera.x+cos*u-sin*v:camera.x+u,qy=turned?camera.y+sin*u+cos*v:camera.y+v;
    if(qx+spanX<0||qx-spanX>viewport.width||qy+spanY<0||qy-spanY>viewport.height)continue;
    p.x=camera.x+u;p.y=camera.y+v;coord.x=x;coord.y=y;
    drawTile(ctx,view,coord,p,tw,th,pad);
   }
  }
 }
 if(view.tool!=='explore')for(const cell of view.preview)drawMarker(ctx,view,cell,tw,th,view.previewAffordable?PREVIEW_OK:PREVIEW_BLOCKED,true,flat);
 if(view.hover)drawMarker(ctx,view,view.hover,tw,th,HOVER,false,flat);
 if(turned)ctx.restore();
}
// The cell the view shows at (x,y), or null while its region is not loaded. Plain numbers in, no wrapper object out:
// this runs once per drawn cell and four more times per road and coast cell. Neighbouring calls almost always land in
// the same region, so the region is resolved once and remembered until the call asks for another one — which is what
// keeps the region id, a string, from being built for every cell of every frame.
let regionView:WorldView|null=null,regionX=NaN,regionY=NaN,regionEdits:Record<string,Cell>|null=null,regionCells:readonly Cell[]|null=null;
function cellAt(view:WorldView,x:number,y:number):Cell|null {
 const wx=wrapX(x),rx=Math.floor(wx/CHUNK),ry=Math.floor(y/CHUNK);
 if(view!==regionView||rx!==regionX||ry!==regionY){
  const id=`${rx}:${ry}`,managed=view.state.chunks[id],status=managed?undefined:view.chunks.get(id);
  regionView=view;regionX=rx;regionY=ry;
  regionEdits=managed?managed.edits:null;
  regionCells=managed?managed.base.cells:status?.status==='ready'?status.base.cells:null;
 }
 if(!regionCells)return null;
 const i=(y%CHUNK)*CHUNK+(wx%CHUNK);
 return regionEdits?.[i]??regionCells[i]!;
}
const failedAt=(view:WorldView,coord:CellCoord):boolean=>view.chunks.get(chunkId(coord))?.status==='error';
// What is worth drawing at which zoom. A cell below these sizes is a handful of pixels: a tree is two of them, a
// window less than one, so the detail costs frames and buys nothing. The gates are the reason a whole city can be on
// screen at sixty frames a second with the near view still full of trees and windows. Street life starts where a car
// is more than two pixels; it is derived from the four neighbours and the animation clock, never from the world.
const LIFE_MIN_TILE=16,TREE_MIN_TILE=16,WINDOW_MIN_TILE=15,SHORE_MIN_TILE=14;
// Below this the city is drawn in its simple form: ground, a road, a box with a roof. A cell is under eleven pixels
// across there, so the lanes, the windows and the paving lines would be sub-pixel marks that cost frames — and a dash
// pattern whose gaps are shorter than the line width is the single most expensive thing this renderer can ask for.
const SIMPLE_TILE=11;
// How many cells a frame may draw before the wide view takes over. The number is a budget, not a taste: past it the
// per-cell art costs more of the frame than the detail is worth at that size.
const MOSAIC_CELLS=6000;
const NEIGHBOURS=[[1,0],[-1,0],[0,1],[0,-1]] as const;
const SIGNS=[1,-1] as const;
function streetLife(view:WorldView,coord:CellCoord,tw:number,cell:Cell):StreetLife|null {
 if(tw<LIFE_MIN_TILE)return null;
 let stage=0,social=false;
 for(const [dx,dy] of NEIGHBOURS){
  const found=cellAt(view,coord.x+dx,coord.y+dy);
  if(!found||!occupied(found))continue;
  if(found.building==='park'||found.building==='commercial')social=true;
  else if(found.building)stage=Math.max(stage,found.stage??0);
 }
 return lifeAt({x:coord.x,y:coord.y,stage,social,road:roadClassOf(cell)},view.motion);
}
function drawTile(ctx:CanvasRenderingContext2D,view:WorldView,coord:CellCoord,p:Point,tw:number,th:number,pad:number) {
 const simple=tw<SIMPLE_TILE;
 const cell=cellAt(view,coord.x,coord.y),v=variant(coord.x,coord.y,view.seed);
 if(!cell)return drawUnknown(ctx,p,tw,th,v,failedAt(view,coord),pad);
 if(cell.terrain==='water'){drawWater(ctx,p,tw,th,v,pad);if(tw>=SHORE_MIN_TILE)drawShore(ctx,view,coord,p,tw,th);return;}
 ctx.fillStyle=(cell.terrain==='green'?MEADOW:GRASS)[v%3];
 diamond(ctx,p.x,p.y,tw+pad,th+pad);
 // Green land on a real map is a lawn, a meadow or a wood. The cell's own draw decides how many trees it gets, so a
 // forest reads as a forest and a lawn as a lawn, and nothing about it has to be stored to stay the same tomorrow.
 if(cell.terrain==='green'&&tw>=TREE_MIN_TILE){
  const trees=1+v%3;
  for(let i=0;i<trees;i++){
   const a=variant(v+i*11,v*3-i*5,i),dx=((a%5)-2)*tw*.17,dy=(((a>>4)%5)-2)*th*.3;
   drawTree(ctx,p.x+dx,p.y+dy,tw,th,a%3,i===0);
  }
 }
 if(cell.road)drawRoad(ctx,p,tw,th,v,pad,simple?null:streetLife(view,coord,tw,cell),roadClassOf(cell),simple);
 if(cell.building)drawBuilding(ctx,cell,p,tw,th,v,pad,simple);
}
// A coastline is the most attractive thing a map gives us for free, and a hard edge between blue and green wastes it.
// The foam is drawn from the water's side: whoever draws later paints over the neighbour anyway, so a cell only has to
// know what it is, not what surrounds it.
const SHORE_EDGES=[[0,-1,1,-1],[0,1,-1,1],[-1,0,-1,-1],[1,0,1,1]] as const;
function drawShore(ctx:CanvasRenderingContext2D,view:WorldView,coord:CellCoord,p:Point,tw:number,th:number) {
 ctx.fillStyle='rgba(238,247,255,.5)';
 const hx=tw*.5,hy=th*.5;
 for(const [dx,dy,sx,sy] of SHORE_EDGES){
  const ny=coord.y+dy;
  if(ny<0||ny>=WORLD)continue;
  const neighbour=cellAt(view,coord.x+dx,ny);
  if(!neighbour||neighbour.terrain==='water')continue;
  const ex=p.x+sx*hx,ey=p.y+sy*hy;
  triangle(ctx,ex,ey,ex+(dx?0:hx),ey+(dx?hy:0),ex+(dx?0:-hx),ey+(dx?-hy:0));
 }
}
function drawWater(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,v:number,pad:number) {
 ctx.fillStyle=WATER[v%3];
 diamond(ctx,p.x,p.y,tw+pad,th+pad);
 ctx.strokeStyle='rgba(232,244,255,.4)';
 ctx.lineWidth=Math.max(1,tw*.03);
 const ox=(v%3-1)*tw*.2;
 ctx.beginPath();ctx.moveTo(p.x+ox-tw*.3,p.y+th*.28);ctx.lineTo(p.x+ox+tw*.14,p.y+th*.28);ctx.stroke();
}
// The three classes are one drawing with three widths: a street is a lane each way, an avenue is wide enough to have
// a middle, and a highway is a carriageway with a rail on it. Drawing them from one table is what keeps them looking
// like the same city instead of three different games.
const ROAD_ART: Record<RoadClass,{surface:string;shade:string;lane:number;rail:boolean}> = {
 street:{surface:'#9ea4ab',shade:'#8b9199',lane:0.24,rail:false},
 avenue:{surface:'#a9afb6',shade:'#959ba3',lane:0.33,rail:false},
 highway:{surface:'#b4b9bf',shade:'#a0a6ad',lane:0.42,rail:true},
};
function drawRoad(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,v:number,pad:number,life:StreetLife|null,kind:RoadClass,simple:boolean) {
 const art=ROAD_ART[kind];
 if(simple){
  // A road far away is its colour and its direction: a filled diamond and one lighter band along it.
  ctx.fillStyle=art.shade;
  diamond(ctx,p.x,p.y,tw+pad,th+pad);
  ctx.fillStyle=art.surface;
  diamond(ctx,p.x,p.y,tw*.72,th*.72);
  return;
 }
 ctx.fillStyle=art.shade;
 diamond(ctx,p.x,p.y,tw+pad,th+pad);
 const uax=tw/2,uay=th/2,ubx=tw/2,uby=-th/2,wax=ubx*art.lane,way=uby*art.lane,wbx=uax*art.lane,wby=uay*art.lane;
 ctx.fillStyle=art.surface;
 quad(ctx,p.x-uax+wax,p.y-uay+way,p.x+uax+wax,p.y+uay+way,p.x+uax-wax,p.y+uay-way,p.x-uax-wax,p.y-uay-way);
 quad(ctx,p.x-ubx+wbx,p.y-uby+wby,p.x+ubx+wbx,p.y+uby+wby,p.x+ubx-wbx,p.y+uby-wby,p.x-ubx-wbx,p.y-uby-wby);
 ctx.strokeStyle='rgba(246,241,228,.7)';
 ctx.lineWidth=Math.max(1,tw*.05);
 ctx.setLineDash(laneDashOf(tw,th));
 ctx.beginPath();ctx.moveTo(p.x-uax,p.y-uay);ctx.lineTo(p.x+uax,p.y+uay);ctx.stroke();
 ctx.setLineDash(SOLID);
 // An avenue gets a planted middle and a highway gets a rail: the two things a player reads from far away.
 if(kind==='avenue'){
  // The middle of an avenue is planted: the same trees as everywhere else, in a line, which is what makes an avenue
  // read as an avenue from far away instead of as a wide street.
  ctx.fillStyle='#6f9a4e';
  diamond(ctx,p.x,p.y,tw*.16,th*.16);
  if(tw>=TREE_MIN_TILE&&(v%5)<3)drawTree(ctx,p.x,p.y+th*.04,tw*.9,th*.9,v%3,false);
 }else if(art.rail){
  ctx.strokeStyle='rgba(226,232,238,.55)';
  ctx.lineWidth=Math.max(1,tw*.035);
  for(const sign of SIGNS){
   ctx.beginPath();
   ctx.moveTo(p.x+(uax-wax*2.4)*sign,p.y+(uay-way*2.4)*sign);
   ctx.lineTo(p.x+(ubx+wbx*2.4)*sign,p.y+(uby+wby*2.4)*sign);
   ctx.stroke();
  }
 }
 ctx.fillStyle=v%2?'rgba(255,255,255,.25)':'rgba(60,70,80,.18)';
 diamond(ctx,p.x,p.y,tw*.1,th*.1);
 // Last, so a car sits on the lane markings instead of under them.
 if(life)drawLife(ctx,p.x,p.y,tw,th,life);
}
function drawBuilding(ctx:CanvasRenderingContext2D,cell:Cell,p:Point,tw:number,th:number,v:number,pad:number,simple:boolean) {
 const kind=cell.building!;
 if(kind==='park')return simple?drawParkSimple(ctx,p,tw,th):drawPark(ctx,p,tw,th,v);
 if(simple){
  // A building this far away is its footprint and its colour: one diamond where the walls, the roof and the shadow
  // would be a dozen drawing calls for the same four pixels. What the player reads at this zoom is where the city is
  // and what it is made of, and both are still here.
  ctx.fillStyle=SHADE_CORE;
  diamond(ctx,p.x+tw*.06,p.y+th*.06,tw*.74,th*.74);
  ctx.fillStyle=ROOF[kind];
  diamond(ctx,p.x,p.y-th*.18,tw*.72,th*.72);
  return;
 }
 if(cell.stage===0)return simple?drawLotSimple(ctx,p,tw,th,pad):drawLot(ctx,p,tw,th,pad);
 const floors=kind==='power'?Math.max(3,cell.stage??1)+1:Math.max(1,cell.stage??1);
 const h=floors*th*.85;
 // Each building stands inside its own lot instead of filling it: the gap is what makes a row of same-kind buildings
 // read as a street of neighbours rather than as one long wall. The size varies per cell, deterministically.
 const inset=.62+((v>>>7)%6)*.035,w=tw*inset,d=th*inset;
 const [wallLight,wallDark]=WALL_TONES[(v>>>3)%WALL_TONES.length]!;
 // The lot first: a building stands in a yard, not on the whole cell. That difference — walls set back from the
 // street, a strip of ground on every side — is most of what makes a row of boxes look like a lived-in street, and it
 // costs one diamond.
 ctx.fillStyle=LOT;
 diamond(ctx,p.x,p.y,tw*.99,th*.99);
 ctx.fillStyle='rgba(120,150,90,.35)';
 diamond(ctx,p.x,p.y+th*.03,tw*.86,th*.86);
 // The light comes from the upper left, so the shadow falls down and to the right: soft and wide, then tight and dark.
 ctx.fillStyle=SHADE;
 diamond(ctx,p.x+tw*.17,p.y+th*.19,tw*.98,th*.98);
 ctx.fillStyle=SHADE_CORE;
 diamond(ctx,p.x+tw*.07,p.y+th*.08,tw*.86,th*.86);
 ctx.fillStyle=wallDark;
 quad(ctx,p.x-w,p.y,p.x,p.y+d,p.x,p.y+d-h,p.x-w,p.y-h);
 ctx.fillStyle=wallLight;
 quad(ctx,p.x,p.y+d,p.x+w,p.y,p.x+w,p.y-h,p.x,p.y+d-h);
 if((kind==='residential'||kind==='commercial')&&tw>=WINDOW_MIN_TILE){
  const step=h/floors,ux=w*.5,uy=-d*.5,vy=-step*.42;
  ctx.fillStyle='#3c4a5c';
  for(let f=0;f<floors;f++){
   const t=(v>>(f*3))%2?.34:.62;
   const cx=p.x+w*t*2,cy=p.y+d*(1-t)-(f+.28)*step;
   quad(ctx,cx,cy,cx+ux,cy+uy,cx+ux,cy+uy+vy,cx,cy+vy);
  }
  // A shop on the ground floor gets an awning: one stripe that tells the player which buildings are the shops when the
  // roofs are all the same colour.
  if(kind==='commercial'){
   ctx.fillStyle='#f2c46b';
   quad(ctx,p.x+w*.15,p.y+d*.85,p.x+w*.85,p.y+d*.15,p.x+w*.85,p.y+d*.02,p.x+w*.15,p.y+d*.72);
  }
 }else{
  ctx.fillStyle='rgba(40,48,58,.25)';
  quad(ctx,p.x,p.y+d,p.x+w*.6,p.y+d*.4,p.x+w*.6,p.y+d*.4-h*.25,p.x,p.y+d-h*.25);
 }
 // The roof shades the walls a little, so a building has a top and not just a colour, and its rim gives the silhouette
 // an edge: it is the first thing that reads at any zoom.
 const roof=ROOF_TONES[kind][(v>>>11)%3]!;
 ctx.fillStyle=roof.colour;
 quad(ctx,p.x-w,p.y-h,p.x,p.y+d-h,p.x+w,p.y-h,p.x,p.y-d-h);
 // The whole silhouette gets one thin dark line — walls and roof together. Distant buildings are then read as shapes
 // instead of as colour patches, which is what the art direction calls the silhouette pass.
 ctx.strokeStyle='rgba(58,50,40,.35)';
 ctx.lineWidth=Math.max(1,tw*.03);
 quadStroke(ctx,p.x-w,p.y-h,p.x,p.y+d-h,p.x+w,p.y-h,p.x,p.y-d-h);
 quadStroke(ctx,p.x-w,p.y,p.x,p.y+d,p.x,p.y+d-h,p.x-w,p.y-h);
 quadStroke(ctx,p.x,p.y+d,p.x+w,p.y,p.x+w,p.y-h,p.x,p.y+d-h);
 // A lamp post in the yard, and flowers where the lot is deep enough for a garden: the props that carry the human
 // scale. One per building, deterministic, and only where a few pixels can show it.
 if(tw>=WINDOW_MIN_TILE){
  const side=(v>>>21)%2?1:-1;
  const lx=p.x+side*w*.95,ly=p.y+d*.35;
  ctx.strokeStyle='#5a5f66';
  ctx.lineWidth=Math.max(1,tw*.035);
  ctx.beginPath();ctx.moveTo(lx,ly);ctx.lineTo(lx,ly-th*.5);ctx.stroke();
  ctx.fillStyle='#f6e6b8';
  ctx.beginPath();ctx.arc(lx,ly-th*.55,Math.max(1,tw*.05),0,Math.PI*2);ctx.fill();
  if(kind==='residential'&&(v>>>23)%3===0){
   ctx.fillStyle='#d9738c';
   ctx.beginPath();ctx.arc(p.x-w*.7,p.y+d*.75,Math.max(1,tw*.05),0,Math.PI*2);ctx.fill();
   ctx.fillStyle='#8fb15f';
   ctx.beginPath();ctx.arc(p.x-w*.5,p.y+d*.85,Math.max(1,tw*.04),0,Math.PI*2);ctx.fill();
  }
 }
 // One piece of roof furniture per building: a chimney on a house, a vent on a shop, a tank on a factory. It is the
 // detail nobody names and everybody notices — a skyline of bare boxes looks unfinished.
 if(tw>=WINDOW_MIN_TILE){
  const spot=(v>>>17)%3;
  const rx=p.x-w*.35+spot*w*.35,ry=p.y-h+(spot-1)*d*.3;
  if(kind==='residential'){
   ctx.fillStyle=roof.chimney;
   ctx.fillRect(rx-Math.max(1,tw*.045),ry-th*.34,Math.max(2,tw*.09),th*.34);
  }else if(kind==='commercial'){
   ctx.fillStyle=roof.vent;
   ctx.fillRect(rx-tw*.1,ry-th*.12,tw*.2,th*.2);
  }else{
   ctx.fillStyle='#cfd3d8';
   ctx.beginPath();ctx.ellipse(rx,ry-th*.1,tw*.11,th*.16,0,0,Math.PI*2);ctx.fill();
  }
 }
 if(kind==='power'){
  ctx.fillStyle='#f0ece0';
  ctx.fillRect(p.x-Math.max(1,tw*.05),p.y-th*.6-h,Math.max(2,tw*.1),th*.5);
 }
}
// One tree, at a spot the caller chooses. Trees are the cheapest way a city looks alive and cared for, so they are
// everywhere the map says there is green: a wood, a lawn, a park, the middle of an avenue.
function drawTree(ctx:CanvasRenderingContext2D,x:number,y:number,tw:number,th:number,tone:number,lit:boolean) {
 const r=tw*(lit?.17:.13);
 // The shadow first, so trunks and crowns of anything drawn later sit on top of it.
 ctx.fillStyle='rgba(28,46,34,.26)';
 ctx.beginPath();ctx.ellipse(x+tw*.05,y+th*.07,r*1.15,r*.55,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#7a5a34';
 ctx.fillRect(x-r*.13,y-th*.16,Math.max(1,r*.26),th*.22);
 ctx.fillStyle=tone===0?'#3f8b3d':tone===1?'#57a94a':'#6cbb52';
 ctx.beginPath();ctx.arc(x,y-th*.36,r,0,Math.PI*2);ctx.fill();
 ctx.beginPath();ctx.arc(x-r*.5,y-th*.2,r*.62,0,Math.PI*2);ctx.fill();
 ctx.beginPath();ctx.arc(x+r*.5,y-th*.2,r*.62,0,Math.PI*2);ctx.fill();
 // One lit leaf cluster, always on the upper left: the light in this city comes from one place.
 ctx.fillStyle='rgba(255,255,255,.28)';
 ctx.beginPath();ctx.arc(x-r*.3,y-th*.5,r*.42,0,Math.PI*2);ctx.fill();
}
// The simple tier: what a cell looks like when it is a handful of pixels. Colour and silhouette only.
function drawParkSimple(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number) {
 ctx.fillStyle='#79b455';
 diamond(ctx,p.x,p.y,tw*.94,th*.94);
}
function drawLotSimple(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,pad:number) {
 ctx.fillStyle=LOT;
 diamond(ctx,p.x,p.y,tw+pad,th+pad);
}
function drawPark(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,v:number) {
 // A park keeps its lawn at every zoom — that is its colour on the map — but its trees only where a tree is a tree.
 ctx.fillStyle='#79b455';
 diamond(ctx,p.x,p.y,tw*.94,th*.94);
 ctx.fillStyle='rgba(240,236,214,.55)';
 ctx.beginPath();ctx.ellipse(p.x,p.y+th*.1,tw*.34,th*.3,0,0,Math.PI*2);ctx.fill();
 if(tw<TREE_MIN_TILE)return;
 const count=2+v%3;
 for(let i=0;i<count;i++){
  const a=variant(v+i*7,v-i*13,i),dx=((a%5)-2)*tw*.16,dy=(((a>>3)%5)-2)*th*.28;
  drawTree(ctx,p.x+dx,p.y+dy,tw,th,i%3,i===0);
 }
}
function drawLot(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,pad:number) {
 ctx.fillStyle=LOT;
 diamond(ctx,p.x,p.y,tw+pad,th+pad);
 ctx.strokeStyle=MARK;
 ctx.lineWidth=Math.max(1,tw*.06);
 ctx.setLineDash([tw*.16,th*.2]);
 diamondPath(ctx,p.x,p.y,tw*.66,th*.66);
 ctx.stroke();
 ctx.setLineDash(SOLID);
 ctx.strokeStyle='#7a5b34';
 ctx.lineWidth=Math.max(1,tw*.08);
 ctx.beginPath();ctx.moveTo(p.x,p.y-th*.05);ctx.lineTo(p.x,p.y-th*.55);ctx.stroke();
 ctx.fillStyle='#e0563f';
 triangle(ctx,p.x,p.y-th*.55,p.x+tw*.2,p.y-th*.42,p.x,p.y-th*.3);
}
function drawUnknown(ctx:CanvasRenderingContext2D,p:Point,tw:number,th:number,v:number,failed:boolean,pad:number) {
 ctx.fillStyle=(failed?ERROR:UNKNOWN)[v%2];
 diamond(ctx,p.x,p.y,tw+pad,th+pad);
 ctx.save();
 diamondPath(ctx,p.x,p.y,tw+pad,th+pad);
 ctx.clip();
 // Not loaded yet is a state the player sees a lot while panning, so it has to be quiet: two faint diagonal marks
 // suggest "map, later" without turning half the screen into a pattern.
 ctx.strokeStyle=failed?'rgba(255,170,160,.5)':'rgba(226,234,242,.16)';
 ctx.lineWidth=Math.max(1,tw*.05);
 const gap=tw*.42,off=((v>>4)%3)*tw*.08;
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
function drawMarker(ctx:CanvasRenderingContext2D,view:WorldView,cell:CellCoord,tw:number,th:number,style:{fill:string;line:string},strong:boolean,flat:Camera) {
 const p=project(cell,flat),q=view.camera.rotation===0?p:project(cell,view.camera);
 // A cell is under two pixels wide at 0.05x: keep the preview and the hover outline big enough to be useful.
 const w=Math.max(tw,4),h=Math.max(th,2);
 // The outline is culled in real screen space, where the turned diamond spans more than its own half-axes.
 const absCos=Math.abs(Math.cos(view.camera.rotation)),absSin=Math.abs(Math.sin(view.camera.rotation));
 const spanW=w*absCos+h*absSin,spanH=h*absCos+w*absSin;
 if(q.x+spanW<0||q.x-spanW>view.viewport.width||q.y+spanH<0||q.y-spanH>view.viewport.height)return;
 ctx.fillStyle=style.fill;
 diamond(ctx,p.x,p.y,w,h);
 ctx.strokeStyle=style.line;
 ctx.lineWidth=Math.max(1,w*(strong?.08:.04));
 if(strong)ctx.setLineDash([w*.14,h*.18]);
 diamondPath(ctx,p.x,p.y,w*.96,h*.96);
 ctx.stroke();
 if(strong)ctx.setLineDash(SOLID);
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
type Box={minX:number;maxX:number;minY:number;maxY:number};
function renderMosaic(ctx:CanvasRenderingContext2D,view:WorldView,box:Box):void{
 const {camera,viewport}=view,span=BLOCK*TILE_W*camera.zoom,spanH=BLOCK*TILE_H*camera.zoom;
 // Same split as the fine pass: positions are drawn unrotated under the context transform, culling uses the real camera.
 const turned=camera.rotation!==0,flat:Camera=turned?{...camera,rotation:0}:camera,pad=turned?SEAM_PAD:0;
 const cosT=Math.cos(camera.rotation),sinT=Math.sin(camera.rotation);
 const absCos=Math.abs(cosT),absSin=Math.abs(sinT);
 const firstX=Math.floor((box.minX-1)/CHUNK),lastX=Math.floor((box.maxX+1)/CHUNK);
 const firstY=Math.max(0,Math.floor((box.minY-1)/CHUNK)),lastY=Math.min(WORLD/CHUNK-1,Math.floor((box.maxY+1)/CHUNK));
 const regions:Array<{x:number;y:number;id:string;order:number;tie:number}>=[];
 for(let cy=firstY;cy<=lastY;cy++)for(let cx=firstX;cx<=lastX;cx++){
  const x=cx*CHUNK,y=cy*CHUNK,centre=project({x:x+CHUNK/2,y:y+CHUNK/2},camera);
  const halfW=CHUNK*TILE_W*camera.zoom,halfH=CHUNK*TILE_H*camera.zoom;
  const reach=halfW*absCos+halfH*absSin,drop=halfH*absCos+halfW*absSin;
  if(centre.x+reach<0||centre.x-reach>viewport.width||centre.y+drop<0||centre.y-drop>viewport.height)continue;
  regions.push({x,y,id:chunkId({x,y}),order:x+y,tie:cy*100000+cx});
 }
 // Back to front, then left to right inside each region, without serialising/parsing region coordinates every frame.
 regions.sort((a,b)=>a.order-b.order||a.tie-b.tie);
 for(const {x,y,id} of regions){
  const blocks=cachedMosaic(view,id);
  if(!blocks){
   const failed=view.chunks.get(id)?.status==='error';
   drawUnknown(ctx,project({x:x+CHUNK/2,y:y+CHUNK/2},flat),CHUNK*TILE_W*camera.zoom,CHUNK*TILE_H*camera.zoom,variant(x,y,view.seed),failed,pad);
   continue;
  }
  // Block positions are a constant step away from the region centre, and each one is culled before it is filled:
  // a wide view draws thousands of blocks and the ones outside the viewport cost nothing.
  const centre=project({x:x+CHUNK/2,y:y+CHUNK/2},flat);
  const stepX=TILE_W*camera.zoom,stepY=TILE_H*camera.zoom,reach=span+pad,reachH=spanH+pad;
  for(let by=0;by<BLOCKS;by++)for(let bx=0;bx<BLOCKS;bx++){
   const p={x:centre.x+(bx-by)*BLOCK*stepX,y:centre.y+((bx+by)*BLOCK-(CHUNK-BLOCK))*stepY};
   if(turned){
    const dx=p.x-camera.x,dy=p.y-camera.y,sx=camera.x+cosT*dx-sinT*dy,sy=camera.y+sinT*dx+cosT*dy;
    if(sx+reach<0||sx-reach>viewport.width||sy+reachH<0||sy-reachH>viewport.height)continue;
   }else if(p.x+reach<0||p.x-reach>viewport.width||p.y+reachH<0||p.y-reachH>viewport.height)continue;
   ctx.fillStyle=blocks[by*BLOCKS+bx]!;
   // A turned diamond is expensive to rasterize, and at a wide zoom a block is only a few pixels across: drawing
   // it as its bounding square is visually the same thing at a fraction of the cost.
   if(turned&&reach*2<5)ctx.fillRect(p.x-reach,p.y-reachH,reach*2,reachH*2);
   else diamond(ctx,p.x,p.y,reach,reachH);
  }
 }
}
