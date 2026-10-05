import {sceneRasterCache} from './scene-cache';
import type {ScreenBounds} from './scene-compositor';
import type {Building} from '../../core/model';
import type {WorldView} from './canvas-renderer';
import {TILE_W,TILE_H,type Point} from '../../presentation/camera';
import {architectureOf,regionOf,type Footprint} from '../../presentation/city-art';
import {geographicFocus} from '../../presentation/geographic-map';
import {projectSurface,foundationElevation,terrainMetres,clipTerrainVolume} from './terrain-renderer';
import {verticalPixelsPerMetre} from '../../presentation/terrain-projection';
import {lightContext} from './city-light';
function path(ctx:CanvasRenderingContext2D,rings:readonly Point[][],offsetX=0,offsetY=0){
 ctx.beginPath();for(const ring of rings){if(!ring.length)continue;ctx.moveTo(ring[0].x+offsetX,ring[0].y+offsetY);for(let i=1;i<ring.length;i++)ctx.lineTo(ring[i].x+offsetX,ring[i].y+offsetY);ctx.closePath();}
}
const projectRing=(view:WorldView,ring:Point[],shift:number,base?:number)=>ring.map(p=>projectSurface(view,{x:p.x+shift-.5,y:p.y-.5},base));
const baseOf=(view:WorldView,footprint:Footprint,shift:number)=>foundationElevation(view,footprint.rings.flatMap(r=>r.map(p=>({x:p.x+shift-.5,y:p.y-.5}))));
const heightOf=(view:WorldView,floors:number,base?:number)=>base!==undefined?floors*3*verticalPixelsPerMetre(view.camera,terrainMetres(view)):TILE_H*view.camera.zoom*(.55+floors*.72);
// One sun for the whole frame: the shadow is the footprint pushed by the height of what stands on it, in one fixed
// direction, so a tall building leans on its neighbours and on the street and nothing casts a shadow twice.
const drawShadow=(ctx:CanvasRenderingContext2D,rings:readonly Point[][],height:number)=>{path(ctx,rings,height*.36,height*.18);ctx.fillStyle='rgba(42,51,44,.19)';ctx.fill('evenodd');};
// The preview is the building itself, not a coloured square: before spending anything the player sees the volume the
// tool is about to place, in the zone's own colour, on the lot it will occupy.
export function drawGhost(ctx:CanvasRenderingContext2D,view:WorldView,footprint:Footprint,affordable:boolean){
 const base=baseOf(view,footprint,0),rings=footprint.rings.map(r=>projectRing(view,r,0,base)),outer=rings[0];
 const height=Math.max(2,heightOf(view,1,base));
 const face=affordable?'rgba(214,236,201,.55)':'rgba(238,196,188,.55)',side=affordable?'rgba(178,210,172,.55)':'rgba(216,168,160,.55)';
 for(let i=1;i<outer.length;i++){
  const a=outer[i-1],b=outer[i];if(b.x>=a.x)continue;
  path(ctx,[[a,b,{x:b.x,y:b.y-height},{x:a.x,y:a.y-height}]]);ctx.fillStyle=b.y>a.y?face:side;ctx.fill();
 }
 path(ctx,rings,0,-height);ctx.fillStyle=affordable?'rgba(152,198,144,.75)':'rgba(210,140,130,.75)';ctx.fill('evenodd');
 ctx.strokeStyle=affordable?'#f5e4a2':'#f3b1a0';ctx.lineWidth=1.2;ctx.stroke();
}
type BuildingBitmap={cameraX:number;cameraY:number;cameraKey:string;tiles:object|undefined;width:number;height:number;key:string;canvas:OffscreenCanvas;x:number;y:number;bytes:number};
const bitmapIds=new WeakMap<Footprint,string>();let nextBitmapId=0,bitmapHits=0,bitmapMisses=0;
const bitmapId=(footprint:Footprint)=>{let id=bitmapIds.get(footprint);if(!id){id=`building:${++nextBitmapId}`;bitmapIds.set(footprint,id);}return id;};
export const buildingCacheStats=()=>({...sceneRasterCache.stats(),hits:bitmapHits,misses:bitmapMisses});
export function buildingScreenBounds(view:WorldView,footprint:Footprint,shift:number,kind?:Building,stage?:number,base?:number):ScreenBounds{
 const rings=footprint.rings.flatMap(r=>projectRing(view,r,shift,base)),floors=architectureOf(footprint,kind,stage,regionOf(geographicFocus(view.camera,view.viewport))).floors,height=heightOf(view,floors,base),margin=TILE_W*view.camera.zoom*.7+15;
 const x=Math.floor(Math.min(...rings.map(p=>p.x))-margin),y=Math.floor(Math.min(...rings.map(p=>p.y))-height-margin);return {x,y,width:Math.ceil(Math.max(...rings.map(p=>p.x))+height*.4+margin-x),height:Math.ceil(Math.max(...rings.map(p=>p.y))+height*.2+margin-y)};
}
export function drawBuilding(ctx:CanvasRenderingContext2D,view:WorldView,footprint:Footprint,shift:number,kind?:Building,stage?:number,lift=0,powered=true,shadow=true,baseOverride?:number){
 const base=baseOverride??baseOf(view,footprint,shift);
 if(typeof OffscreenCanvas!=='undefined'){
  const key=[view.light,kind,stage,lift,powered,shadow,base,shift].join(':'),cameraKey=[view.camera.zoom,view.camera.rotation].join(':'),known=sceneRasterCache.get(bitmapId(footprint)) as BuildingBitmap|undefined;
  const reusablePan=known&&(known.cameraX===view.camera.x&&known.cameraY===view.camera.y||known.x>=0&&known.y>=0&&known.x+known.canvas.width<=known.width&&known.y+known.canvas.height<=known.height);
  if(reusablePan&&known?.cameraKey===cameraKey&&known.tiles===view.terrain?.tiles&&known.width===view.viewport.width&&known.height===view.viewport.height&&known.key===key){bitmapHits++;ctx.drawImage(known.canvas,known.x+view.camera.x-known.cameraX,known.y+view.camera.y-known.cameraY);return;}bitmapMisses++;
  const rings=footprint.rings.flatMap(r=>projectRing(view,r,shift,base)),floors=architectureOf(footprint,kind,stage,regionOf(geographicFocus(view.camera,view.viewport))).floors,height=heightOf(view,floors,base)+lift,margin=TILE_W*view.camera.zoom*.7+3;
  const x=Math.floor(Math.min(...rings.map(p=>p.x))-margin),y=Math.floor(Math.min(...rings.map(p=>p.y))-height-margin),width=Math.ceil(Math.max(...rings.map(p=>p.x))+height*.4+margin-x),heightPixels=Math.ceil(Math.max(...rings.map(p=>p.y))+height*.2+margin-y);
  if(x+width<0||y+heightPixels<0||x>view.viewport.width||y>view.viewport.height)return;
  if(width>0&&heightPixels>0&&width*heightPixels<=262144){
   const canvas=new OffscreenCanvas(width,heightPixels),context=canvas.getContext('2d');
   if(context){
    context.translate(-x,-y);drawOccludedBuilding(lightContext(context as unknown as CanvasRenderingContext2D,view.light??'day'),view,footprint,shift,kind,stage,lift,powered,shadow,base);
    const bytes=width*heightPixels*4;const entry:BuildingBitmap={cameraX:view.camera.x,cameraY:view.camera.y,cameraKey,tiles:view.terrain?.tiles,width:view.viewport.width,height:view.viewport.height,key,canvas,x,y,bytes};
    if(!sceneRasterCache.set(bitmapId(footprint),entry,bytes)){canvas.width=0;canvas.height=0;}else {ctx.drawImage(canvas,x,y);return;}

   }
  }
 }
 drawOccludedBuilding(ctx,view,footprint,shift,kind,stage,lift,powered,shadow,base);
}
function drawOccludedBuilding(ctx:CanvasRenderingContext2D,view:WorldView,footprint:Footprint,shift:number,kind:Building|undefined,stage:number|undefined,lift:number,powered:boolean,shadow:boolean,base:number|undefined){
 if(base===undefined){drawSupportedBuilding(ctx,view,footprint,shift,kind,stage,lift,powered,shadow,base);return;}
 const floors=architectureOf(footprint,kind,stage,regionOf(geographicFocus(view.camera,view.viewport))).floors;
 ctx.save();clipTerrainVolume(ctx,view,footprint.rings[0].map(p=>({x:p.x+shift-.5,y:p.y-.5})),base,floors*3+lift/verticalPixelsPerMetre(view.camera,terrainMetres(view)));
 drawSupportedBuilding(ctx,view,footprint,shift,kind,stage,lift,powered,shadow,base);ctx.restore();
}
function drawSupportedBuilding(ctx:CanvasRenderingContext2D,view:WorldView,footprint:Footprint,shift:number,kind?:Building,stage?:number,lift=0,powered=true,shadow=true,baseOverride?:number){
 const scale=TILE_W*view.camera.zoom,area=footprint.area,seed=footprint.seed;
 const style=architectureOf(footprint,kind,stage,regionOf(geographicFocus(view.camera,view.viewport))),usage=style.usage,floors=style.floors;
 const base=baseOverride??baseOf(view,footprint,shift),height=Math.max(.7,heightOf(view,style.floors,base));
 if(kind===undefined&&stage===undefined&&style.glass&&floors>6&&area>20){
  // A tower on a podium is still one building: the shadow belongs to the tall part and is cast once, by the tallest
  // thing on the lot. Drawn per part it would double the darkening and shorten the shadow to the podium's height.
  const centre={x:(footprint.minX+footprint.maxX)/2,y:(footprint.minY+footprint.maxY)/2},factor=.50+(seed%3)*.08;
  const tower={...footprint,rings:footprint.rings.map(r=>r.map(p=>({x:centre.x+(p.x-centre.x)*factor,y:centre.y+(p.y-centre.y)*factor}))),area:area*factor*factor};
  if(shadow)drawShadow(ctx,tower.rings.map(r=>projectRing(view,r,shift,base)),height);
  drawSupportedBuilding(ctx,view,footprint,shift,usage,3,0,powered,false,base);
  drawSupportedBuilding(ctx,view,tower,shift,usage,floors-3,heightOf(view,3,base),powered,false,base);return;
 }
 const rings=footprint.rings.map(r=>projectRing(view,r,shift,base).map(p=>({x:p.x,y:p.y-lift}))),outer=rings[0];
 if(base!==undefined&&lift===0){
  const ground=footprint.rings[0].map(p=>projectSurface(view,{x:p.x+shift-.5,y:p.y-.5}));
  ctx.fillStyle='#958b79';for(let i=1;i<outer.length;i++)if(outer[i].x<outer[i-1].x){path(ctx,[[ground[i-1],ground[i],outer[i],outer[i-1]]]);ctx.fill();}
 }
 if(style.archetype==='construction'){
  path(ctx,rings);ctx.fillStyle='#b8a48a';ctx.fill('evenodd');ctx.strokeStyle='#e5ca79';ctx.lineWidth=Math.max(1,scale*.05);ctx.setLineDash([Math.max(2,scale*.12),Math.max(2,scale*.08)]);ctx.stroke();ctx.setLineDash([]);
  ctx.save();path(ctx,rings);ctx.clip('evenodd');
  ctx.strokeStyle='#776e61';ctx.lineWidth=Math.max(1,scale*.05);
  for(const a of outer){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(a.x,a.y-scale*.18);ctx.stroke();}
  // The lot is staked out, not empty: the foundation line is pegged inside the fence, and the works board faces the
  // street so the player reads ground -> works -> building without waiting for the house to appear.
  path(ctx,[outer.map(p=>({x:p.x+(p.x-outer[0].x)*.12,y:p.y+(p.y-outer[0].y)*.12}))]);
  ctx.strokeStyle='rgba(120,110,95,.75)';ctx.lineWidth=Math.max(.7,scale*.03);ctx.stroke();
  const front=outer.reduce((best,p)=>p.y>best.y?p:best,outer[0]);
  const board=Math.max(4,scale*.34),post=Math.max(3,scale*.24);
  ctx.fillStyle='#7a6a55';path(ctx,[[{x:front.x-board*.04,y:front.y-post},{x:front.x-board*.04+Math.max(1,scale*.03),y:front.y-post},{x:front.x-board*.04+Math.max(1,scale*.03),y:front.y},{x:front.x-board*.04,y:front.y}]]);ctx.fill();
  ctx.fillStyle='#c9614a';path(ctx,[[{x:front.x-board*.12,y:front.y-board*.42-post},{x:front.x+board*.38,y:front.y-board*.42-post},{x:front.x+board*.38,y:front.y-board*.02-post},{x:front.x-board*.12,y:front.y-board*.02-post}]]);ctx.fill();
  ctx.fillStyle='#e8e0c8';path(ctx,[[{x:front.x-board*.14,y:front.y-board*.5-post},{x:front.x-board*.04,y:front.y-board*.5-post},{x:front.x-board*.04,y:front.y-board*.34-post},{x:front.x-board*.14,y:front.y-board*.34-post}]]);ctx.fill();
  ctx.fillStyle='#9c8f78';path(ctx,[[{x:front.x+board*.2,y:front.y-board*.16},{x:front.x+board*.42,y:front.y-board*.16},{x:front.x+board*.42,y:front.y-board*.16+Math.max(2,board*.14)},{x:front.x+board*.2,y:front.y-board*.16+Math.max(2,board*.14)}]]);ctx.fill();
  ctx.restore();return;
 }
 if(shadow&&lift===0)drawShadow(ctx,rings,height);
 const roof=rings.map(r=>r.map(p=>({x:p.x,y:p.y-height})));
 const detail=scale>=5;
 for(let i=1;i<outer.length;i++){
  const a=outer[i-1],b=outer[i];if(b.x>=a.x)continue;
  path(ctx,[[a,b,{x:b.x,y:b.y-height},{x:a.x,y:a.y-height}]]);
  ctx.fillStyle=b.y>a.y?style.dark:style.light;ctx.fill();
  if(detail){
   const span=Math.hypot(b.x-a.x,b.y-a.y),columns=Math.min(28,Math.max(1,Math.floor(span/Math.max(3,scale*.19))));
   ctx.strokeStyle=usage==='commercial'?'#496a78':'#655f53';ctx.lineWidth=Math.max(.65,Math.min(2.5,scale*.085));
   const rows=Math.min(floors,12);
   if(style.glass){ctx.fillStyle=view.light==='night'?'rgba(94,142,163,.08)':'rgba(144,190,200,.23)';path(ctx,[[a,b,{x:b.x,y:b.y-height},{x:a.x,y:a.y-height}]]);ctx.fill();}
   for(let f=0;f<rows;f++){
    const level=(f+.5)*height/rows;
    for(let w=0;w<columns;w++){
     ctx.strokeStyle=view.light==='night'&&powered&&(seed+w+f*3)%5===0?'rgba(255,216,133,.85)':view.light==='night'?'#263b4b':usage==='commercial'?'#496a78':'#655f53';
     const t=(w+.5)/columns,half=.22/columns;
     ctx.beginPath();ctx.moveTo(a.x+(b.x-a.x)*(t-half),a.y+(b.y-a.y)*(t-half)-level);
     ctx.lineTo(a.x+(b.x-a.x)*(t+half),a.y+(b.y-a.y)*(t+half)-level);ctx.stroke();
    }
   }
   if(style.storefront&&span>scale*.35){
    // The ground floor is the shop: a glazed frontage with a sign band over it. Lit at night when the grid reaches it.
    const band=Math.min(height*.32,scale*.46),sign=Math.min(height*.13,scale*.15);
    path(ctx,[[a,b,{x:b.x,y:b.y-band},{x:a.x,y:a.y-band}]]);
    ctx.fillStyle=view.light==='night'?(powered?'rgba(255,203,128,.42)':'#22323d'):'#3f5560';ctx.fill();
    ctx.strokeStyle='#e8dec4';ctx.lineWidth=Math.max(.7,scale*.035);ctx.stroke();
    path(ctx,[[{x:a.x,y:a.y-band},{x:b.x,y:b.y-band},{x:b.x,y:b.y-band-sign},{x:a.x,y:a.y-band-sign}]]);
    ctx.fillStyle=['#c9614a','#d3ae62','#5f8f86','#a8697c'][seed%4];ctx.fill();
    ctx.strokeStyle='rgba(52,44,36,.5)';ctx.lineWidth=.6;
    const door=Math.max(1,scale*.12),mull=Math.max(2,Math.round(span/(scale*.5)));
    for(let m=1;m<mull;m++){const t=m/mull;ctx.beginPath();ctx.moveTo(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t-band);ctx.lineTo(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t);ctx.stroke();}
    const t=((seed>>>4)%3+1)/4;
    ctx.fillStyle='#2f3b3f';ctx.fillRect(a.x+(b.x-a.x)*t-door/2,a.y+(b.y-a.y)*t-door*.85,door,door*.85);
   }
   if(style.cornice){
    // A band under the eaves is what makes a masonry block read as older than the glass one behind it.
    const band=Math.min(height*.09,scale*.1);
    path(ctx,[[{x:a.x,y:a.y-height+band},{x:b.x,y:b.y-height+band},{x:b.x,y:b.y-height},{x:a.x,y:a.y-height}]]);
    ctx.fillStyle='#ded3ba';ctx.fill();ctx.strokeStyle='#9a8f7d';ctx.lineWidth=.6;ctx.stroke();
   }
   if(style.units>1&&span>scale*.7){
    // One front door and one party wall per unit: the row is a row, not a long bungalow.
    ctx.strokeStyle=style.dark;ctx.lineWidth=Math.max(1,scale*.055);
    for(let u=1;u<style.units;u++){
     const t=u/style.units;
     ctx.beginPath();ctx.moveTo(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t);
     ctx.lineTo(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t-height);ctx.stroke();
    }
    const door=Math.max(1,scale*.11);
    ctx.fillStyle='#5d4a3a';
    for(let u=0;u<style.units;u++){
     const t=(u+.5)/style.units;
     ctx.fillRect(a.x+(b.x-a.x)*t-door/2,a.y+(b.y-a.y)*t-door*.85,door,door*.85);
    }
   }

   if(style.balconies&&span>scale*.5){
    for(let f=1;f<rows;f++){const level=f*height/rows;
     ctx.beginPath();ctx.moveTo(a.x,a.y-level);ctx.lineTo(b.x,b.y-level);
     ctx.strokeStyle=style.dark;ctx.lineWidth=Math.max(1,scale*.045);ctx.stroke();
     ctx.beginPath();ctx.moveTo(a.x,a.y-level-scale*.025);ctx.lineTo(b.x,b.y-level-scale*.025);
     ctx.strokeStyle='#ded6bd';ctx.lineWidth=.6;ctx.stroke();
    }
   }
   if(style.canopy){
    const h=Math.min(height*.35,scale*.18),out=scale*.09;
    path(ctx,[[{x:a.x,y:a.y-h},{x:b.x,y:b.y-h},{x:b.x+out,y:b.y-h+out*.45},{x:a.x+out,y:a.y-h+out*.45}]]);
    ctx.fillStyle=['#986c58','#62887d','#aa8b55'][seed%3];ctx.fill();
    ctx.strokeStyle='#d8c9a9';ctx.lineWidth=Math.max(.7,scale*.035);ctx.stroke();
   }
   if(style.glass&&floors>2){ctx.strokeStyle=view.light==='night'?'rgba(121,157,171,.18)':'rgba(223,230,214,.45)';ctx.lineWidth=.6;for(let f=1;f<floors;f++){const h=f*height/floors;ctx.beginPath();ctx.moveTo(a.x,a.y-h);ctx.lineTo(b.x,b.y-h);ctx.stroke();}}
  }
 }
 path(ctx,roof);ctx.fillStyle=style.roof;ctx.fill('evenodd');ctx.strokeStyle='#706e61';ctx.lineWidth=Math.max(.5,Math.min(1.2,scale*.025));ctx.stroke();
 if(detail&&style.sawtooth){
  // A factory roof seen from above is a row of teeth: the long eave carries them, the short walls do not.
  const eave=roof[0];let at=0,longest=0;
  for(let i=1;i<eave.length;i++){const dx=Math.abs(eave[i].x-eave[i-1].x);if(dx>longest){longest=dx;at=i;}}
  const p=eave[at-1],q=eave[at];
  if(p&&q&&longest>scale*.7){
   const teeth=Math.max(2,Math.min(6,Math.round(longest/(scale*.9))));
   for(let i=0;i<teeth;i++){
    const t0=i/teeth,t1=(i+1)/teeth,tm=(t0+t1)/2;
    path(ctx,[[{x:p.x+(q.x-p.x)*t0,y:p.y+(q.y-p.y)*t0},{x:p.x+(q.x-p.x)*t1,y:p.y+(q.y-p.y)*t1},{x:p.x+(q.x-p.x)*tm,y:p.y+(q.y-p.y)*tm-scale*.11}]]);
    ctx.fillStyle=i%2?style.dark:style.light;ctx.fill();
    ctx.strokeStyle='rgba(60,58,50,.35)';ctx.lineWidth=.5;ctx.stroke();
   }
  }
 }
 if(detail&&style.roofType==='tile'){
  ctx.save();path(ctx,roof);ctx.clip('evenodd');
  const ridge={x:roof[0].reduce((s,p)=>s+p.x,0)/roof[0].length,y:roof[0].reduce((s,p)=>s+p.y,0)/roof[0].length-scale*.12};
  for(let i=1;i<roof[0].length;i++){path(ctx,[[roof[0][i-1],roof[0][i],ridge]]);ctx.fillStyle=i%2?style.roof:style.dark;ctx.fill();}
  ctx.restore();
 }
 if(detail&&style.rooftop){
  // The stair head and the tank on the roof are what a residential tower has instead of a spire.
  const centre={x:outer.reduce((s,p)=>s+p.x,0)/outer.length,y:outer.reduce((s,p)=>s+p.y,0)/outer.length-height};
  const w=Math.max(3,scale*.5),h=Math.max(2,scale*.28);
  ctx.fillStyle=style.light;ctx.fillRect(centre.x-w*.2,centre.y-h,w*.4,h);
  ctx.fillStyle=style.dark;ctx.fillRect(centre.x-w*.2,centre.y-h,w*.4,Math.max(1,h*.3));
  ctx.strokeStyle='rgba(60,58,50,.4)';ctx.lineWidth=.6;ctx.strokeRect(centre.x-w*.2,centre.y-h,w*.4,h);
  ctx.fillStyle='#c3cbc2';ctx.beginPath();ctx.arc(centre.x+w*.3,centre.y-h*.45,Math.max(1,scale*.1),0,Math.PI*2);ctx.fill();ctx.stroke();
 }
 if(detail&&area>4&&!style.rooftop){
  const centre={x:outer.reduce((s,p)=>s+p.x,0)/outer.length,y:outer.reduce((s,p)=>s+p.y,0)/outer.length-height};
  ctx.fillStyle=usage==='commercial'?'#aebfbb':'#d1c9b3';ctx.fillRect(centre.x-scale*.09,centre.y-scale*.08,Math.max(1,scale*.18),Math.max(1,scale*.1));
 }
 if(detail&&usage==='industrial'){
  const centre=outer[Math.floor(outer.length/2)];ctx.fillStyle='#b6ada0';ctx.fillRect(centre.x-scale*.08,centre.y-height-scale*.5,Math.max(2,scale*.14),scale*.5);
 }
}
