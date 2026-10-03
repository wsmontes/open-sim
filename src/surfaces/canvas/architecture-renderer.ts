import type {Building} from '../../core/model';
import type {WorldView} from './canvas-renderer';
import {project,TILE_W,TILE_H,type Point} from '../../presentation/camera';
import {architectureOf,regionOf,type Footprint} from '../../presentation/city-art';
import {geographicFocus} from '../../presentation/geographic-map';
function path(ctx:CanvasRenderingContext2D,rings:readonly Point[][],offsetX=0,offsetY=0){
 ctx.beginPath();for(const ring of rings){if(!ring.length)continue;ctx.moveTo(ring[0].x+offsetX,ring[0].y+offsetY);for(let i=1;i<ring.length;i++)ctx.lineTo(ring[i].x+offsetX,ring[i].y+offsetY);ctx.closePath();}
}
const projectRing=(view:WorldView,ring:Point[],shift:number)=>ring.map(p=>project({x:p.x+shift-.5,y:p.y-.5},view.camera));
export function drawBuilding(ctx:CanvasRenderingContext2D,view:WorldView,footprint:Footprint,shift:number,kind?:Building,stage?:number,lift=0,powered=true){
 const scale=TILE_W*view.camera.zoom,area=footprint.area,seed=footprint.seed;
 const style=architectureOf(footprint,kind,stage,regionOf(geographicFocus(view.camera,view.viewport))),usage=style.usage,floors=style.floors;
 const height=Math.max(.7,TILE_H*view.camera.zoom*(.55+style.floors*.72));
 if(kind===undefined&&stage===undefined&&style.glass&&floors>6&&area>20){
  drawBuilding(ctx,view,footprint,shift,usage,3);
  const centre={x:(footprint.minX+footprint.maxX)/2,y:(footprint.minY+footprint.maxY)/2},factor=.50+(seed%3)*.08;
  const tower={...footprint,rings:footprint.rings.map(r=>r.map(p=>({x:centre.x+(p.x-centre.x)*factor,y:centre.y+(p.y-centre.y)*factor}))),area:area*factor*factor};
  drawBuilding(ctx,view,tower,shift,usage,floors-3,TILE_H*view.camera.zoom*(.55+3*.72));return;
 }
 const rings=footprint.rings.map(r=>projectRing(view,r,shift).map(p=>({x:p.x,y:p.y-lift}))),outer=rings[0];
 if(style.archetype==='construction'){
  path(ctx,rings);ctx.fillStyle='#b8a48a';ctx.fill('evenodd');ctx.strokeStyle='#e5ca79';ctx.lineWidth=Math.max(1,scale*.05);ctx.setLineDash([Math.max(2,scale*.12),Math.max(2,scale*.08)]);ctx.stroke();ctx.setLineDash([]);
  ctx.save();path(ctx,rings);ctx.clip('evenodd');ctx.strokeStyle='#776e61';ctx.lineWidth=Math.max(1,scale*.05);for(const a of outer){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(a.x,a.y-scale*.18);ctx.stroke();}ctx.restore();return;
 }
 path(ctx,rings,height*.36,height*.18);ctx.fillStyle='rgba(42,51,44,.19)';ctx.fill('evenodd');
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
 if(detail&&style.roofType==='tile'){
  ctx.save();path(ctx,roof);ctx.clip('evenodd');
  const ridge={x:roof[0].reduce((s,p)=>s+p.x,0)/roof[0].length,y:roof[0].reduce((s,p)=>s+p.y,0)/roof[0].length-scale*.12};
  for(let i=1;i<roof[0].length;i++){path(ctx,[[roof[0][i-1],roof[0][i],ridge]]);ctx.fillStyle=i%2?style.roof:style.dark;ctx.fill();}
  ctx.restore();
 }
 if(detail&&area>4){
  const centre={x:outer.reduce((s,p)=>s+p.x,0)/outer.length,y:outer.reduce((s,p)=>s+p.y,0)/outer.length-height};
  ctx.fillStyle=usage==='commercial'?'#aebfbb':'#d1c9b3';ctx.fillRect(centre.x-scale*.09,centre.y-scale*.08,Math.max(1,scale*.18),Math.max(1,scale*.1));
 }
 if(detail&&usage==='industrial'){
  const centre=outer[Math.floor(outer.length/2)];ctx.fillStyle='#b6ada0';ctx.fillRect(centre.x-scale*.08,centre.y-height-scale*.5,Math.max(2,scale*.14),scale*.5);
 }
}
