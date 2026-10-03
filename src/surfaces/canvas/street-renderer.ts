import type {WorldView} from './canvas-renderer';
import {project,TILE_W,type Point} from '../../presentation/camera';
import {streetJunctions,streetAgents,type StreetJunction} from '../../presentation/street-detail';
import type {GeographicFeature,GeographicTile} from '../../presentation/geographic-map';
import {nearestWorldX} from '../../presentation/geographic-map';
import {assembledFootprints,pointInside} from '../../presentation/city-art';
const cache=new WeakMap<readonly GeographicTile[],StreetJunction[]>();
const worldPoint=(p:Point,shift=0)=>({x:p.x+shift-.5,y:p.y-.5});
export function drawStreetDetails(ctx:CanvasRenderingContext2D,view:WorldView,roads:readonly {feature:GeographicFeature;shift:number}[],centreX:number){
 const scale=TILE_W*view.camera.zoom;if(scale<7)return;
 const tiles=view.geography?.tiles??[];
 let junctions=cache.get(tiles);if(!junctions){junctions=streetJunctions(tiles.flatMap(t=>t.features),20000);cache.set(tiles,junctions);}
 const inView=(p:Point)=>p.x>0&&p.x<view.viewport.width&&p.y>65&&p.y<view.viewport.height-60;
 let count=0;
 for(const junction of junctions){
  const shift=nearestWorldX(junction.point.x,centreX)-junction.point.x;
  if(!inView(project(worldPoint(junction.point,shift),view.camera)))continue;
  if(count++>=140)break;
  if(view.light==='night'){const p=project(worldPoint(junction.point,shift),view.camera);ctx.fillStyle='rgba(255,220,145,.07)';ctx.beginPath();ctx.ellipse(p.x,p.y,scale*.8,scale*.4,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='rgba(255,221,146,.9)';ctx.fillRect(p.x+scale*.35,p.y-scale*.2,Math.max(1,scale*.035),Math.max(1,scale*.035));}
  const width=junction.major?.55:.37;
  ctx.fillStyle='#e9e3cf';
  for(const d of junction.directions)for(let i=0;i<5;i++){
   const centre={x:junction.point.x+d.x*(.95+i*.15),y:junction.point.y+d.y*(.95+i*.15)},perp={x:-d.y*width,y:d.x*width};
   const p=[{x:centre.x+perp.x,y:centre.y+perp.y},{x:centre.x-perp.x,y:centre.y-perp.y},{x:centre.x-perp.x+d.x*.075,y:centre.y-perp.y+d.y*.075},{x:centre.x+perp.x+d.x*.075,y:centre.y+perp.y+d.y*.075}].map(p=>project(worldPoint(p,shift),view.camera));
   ctx.beginPath();ctx.moveTo(p[0].x,p[0].y);for(const a of p.slice(1))ctx.lineTo(a.x,a.y);ctx.closePath();ctx.fill();
  }
 }
 // A sparse, fixed roadside planting rhythm. Building footprints veto occupied lots.
 const footprints=assembledFootprints(tiles);let trees=0;
 planting:for(const {feature,shift} of roads){
  if(feature.bridge||/^(motorway|trunk|path|footway|steps)/.test(feature.kind))continue;
  for(const ring of feature.geometry)for(let i=1;i<ring.length;i++){
   const a=ring[i-1],b=ring[i],length=Math.hypot(b.x-a.x,b.y-a.y);if(length<6)continue;
   const seed=(Math.floor(a.x)^Math.floor(a.y))>>>0;if(seed%4)continue;
   const p={x:(a.x+b.x)/2-(b.y-a.y)/length*.72,y:(a.y+b.y)/2+(b.x-a.x)/length*.72};
   const screen=project(worldPoint(p,shift),view.camera);if(!inView(screen)||footprints.some(f=>p.x>=f.minX&&p.x<=f.maxX&&p.y>=f.minY&&p.y<=f.maxY&&pointInside(p,f.rings)))continue;
   if(trees++>=70)break planting;
   ctx.fillStyle='rgba(32,54,40,.2)';ctx.beginPath();ctx.ellipse(screen.x+scale*.12,screen.y,scale*.18,scale*.08,0,0,Math.PI*2);ctx.fill();
   ctx.fillStyle='#665b43';ctx.fillRect(screen.x-.5,screen.y-scale*.25,1,scale*.3);
   ctx.fillStyle=seed%2?'#67825c':'#829761';ctx.beginPath();ctx.ellipse(screen.x,screen.y-scale*.3,scale*.19,scale*.25,0,0,Math.PI*2);ctx.fill();
  }
 }
 const features=roads.map(({feature,shift})=>shift?{...feature,geometry:feature.geometry.map(r=>r.map(p=>({x:p.x+shift,y:p.y})))}:feature);
 for(const agent of streetAgents(features,view.motion,240,p=>inView(project(worldPoint(p),view.camera)))){
  const p=project(worldPoint(agent.point),view.camera);if(!inView(p))continue;
  const q=project(worldPoint({x:agent.point.x+agent.direction.x,y:agent.point.y+agent.direction.y}),view.camera),angle=Math.atan2(q.y-p.y,q.x-p.x);
  ctx.save();ctx.translate(p.x,p.y);ctx.rotate(angle);
  if(agent.kind==='car'){
   ctx.fillStyle='rgba(32,45,40,.25)';ctx.fillRect(-scale*.12,scale*.02,scale*.27,Math.max(1,scale*.11));
   ctx.fillStyle=['#c77951','#c4ccba','#4e777b','#b79859','#8d6c79'][agent.seed%5];ctx.fillRect(-scale*.13,-scale*.07,Math.max(2,scale*.27),Math.max(1.5,scale*.14));
   if(view.light==='night'){ctx.fillStyle='rgba(255,223,148,.8)';ctx.fillRect(scale*.1,-scale*.06,Math.max(1,scale*.045),scale*.12);}
   ctx.fillStyle='#d0dfdc';ctx.fillRect(-scale*.025,-scale*.055,Math.max(1,scale*.07),Math.max(1,scale*.1));
  }else if(scale>=10){
   ctx.fillStyle=['#bf8a66','#718695','#cfb976'][agent.seed%3];ctx.fillRect(-.7,-scale*.13,1.4,scale*.13);ctx.fillStyle='#e2c5a1';ctx.beginPath();ctx.arc(0,-scale*.15,Math.max(.8,scale*.035),0,Math.PI*2);ctx.fill();
  }
  ctx.restore();
 }
}
