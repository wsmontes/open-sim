import type {ScreenBounds,SceneCommand} from './scene-compositor';
import type {MobilityFrameAgent,TrafficSignalFrame} from '../../presentation/mobility-model';
import {MOBILITY_LENGTH} from '../../presentation/mobility-engine';
import {TILE_W,cellSpace,type Point} from '../../presentation/camera';
import {nearestWorldX} from '../../presentation/geographic-map';
import {toGeo,wrapX} from '../../core/coordinates';
import type {CellCoord} from '../../core/model';
import type {WorldView} from './canvas-renderer';
import {projectSurface,terrainMetres,visibleSurfacePoint,surfaceDepth} from './terrain-renderer';
import {metresPerCellAt} from '../../presentation/terrain-surface';
export function drawMobilityAgent(ctx:CanvasRenderingContext2D,agent:MobilityFrameAgent,projectPoint:(point:Point)=>Point,pixelsPerMetre:number,motion:number):void{
 const p=projectPoint(agent.point),q=projectPoint({x:agent.point.x+agent.heading.x,y:agent.point.y+agent.heading.y}),angle=Math.atan2(q.y-p.y,q.x-p.x);
 const scale=Math.max(.2,pixelsPerMetre),length=Math.max(agent.kind==='bus'||agent.kind==='school-bus'?14:agent.kind==='truck'?10:6,MOBILITY_LENGTH[agent.kind]*scale),width=Math.max(agent.kind==='bus'||agent.kind==='school-bus'?4:3,2.1*scale);
 ctx.save();ctx.translate(p.x,p.y);
 if(agent.kind==='pedestrian'){
  const body=Math.max(4,1.3*scale),step=Math.sin(motion*9+agent.seed)*body*.28,dx=Math.cos(angle),dy=Math.sin(angle);
  ctx.strokeStyle='#3c4645';ctx.lineWidth=Math.max(.8,scale*.3);ctx.beginPath();ctx.moveTo(-.6,0);ctx.lineTo(-.6+dx*step,dy*step+1);ctx.moveTo(.6,0);ctx.lineTo(.6-dx*step,1-dy*step);ctx.stroke();
  ctx.fillStyle=['#bd8060','#577f91','#c0aa66'][agent.seed%3];ctx.fillRect(-Math.max(.7,scale*.3),-body,Math.max(1.4,scale*.6),body);
  ctx.fillStyle='#e2b995';ctx.beginPath();ctx.arc(0,-body-Math.max(.8,scale*.25),Math.max(.8,scale*.25),0,Math.PI*2);ctx.fill();ctx.restore();return;
 }
 ctx.rotate(angle);ctx.fillStyle='rgba(28,39,37,.24)';ctx.fillRect(-length/2+1,-width/2+1,length,width);
 if(agent.kind==='truck'){
  ctx.fillStyle='#e4ded0';ctx.fillRect(-length/2,-width/2,length*.66,width);ctx.fillStyle='#b8754f';ctx.fillRect(length*.2,-width/2,length*.3,width);ctx.fillStyle='#9baeb0';ctx.fillRect(length*.29,-width*.36,length*.09,width*.72);
 }else if(agent.kind==='bus'||agent.kind==='school-bus'){
  ctx.fillStyle=agent.kind==='school-bus'?'#e9b947':'#ecede6';ctx.fillRect(-length/2,-width/2,length,width);
  ctx.fillStyle=agent.kind==='school-bus'?'#414849':'#348e9d';ctx.fillRect(-length*.44,width*.2,length*.88,Math.max(.8,width*.18));
  ctx.fillStyle='#577782';for(let i=0;i<6;i++)ctx.fillRect(-length*.41+i*length*.13,-width*.36,length*.09,width*.3);
  ctx.fillStyle='#91adb6';ctx.fillRect(length*.35,-width*.35,length*.11,width*.7);
 }else{
  ctx.fillStyle=agent.kind==='police'?'#eef0e7':['#bb6e50','#ded6b4','#477784','#8c6e8b','#c6a858'][agent.seed%5];ctx.fillRect(-length/2,-width/2,length,width);
  ctx.fillStyle='#b8d0d1';ctx.fillRect(-length*.13,-width*.38,length*.31,width*.76);
  if(agent.kind==='police'){ctx.fillStyle='#35547a';ctx.fillRect(-length*.42,-width*.45,length*.22,width*.9);ctx.fillStyle='#cf4e42';ctx.fillRect(-length*.08,-width*.48,Math.max(1,length*.12),width*.48);ctx.fillStyle='#4d8cda';ctx.fillRect(-length*.08,0,Math.max(1,length*.12),width*.48);}
 }
 ctx.strokeStyle='#435456';ctx.lineWidth=.7;ctx.strokeRect(-length/2,-width/2,length,width);
 ctx.fillStyle='#f4e5ac';ctx.fillRect(length*.43,-width*.42,Math.max(.6,scale*.24),width*.25);ctx.fillRect(length*.43,width*.2,Math.max(.6,scale*.24),width*.25);ctx.restore();
}
const byCell=new WeakMap<object,Map<string,MobilityFrameAgent[]>>();
function commands(ctx:CanvasRenderingContext2D,view:WorldView,agents:readonly MobilityFrameAgent[]){
 const m=terrainMetres(view),pixels=TILE_W*view.camera.zoom/m,limit=Math.min(view.quality?.dynamicAgents??480,view.camera.zoom<.2?120:480);
 const centre=cellSpace({x:view.viewport.width/2,y:view.viewport.height/2},view.camera);
 let count=0;
 const result:{depth:number;bounds:ScreenBounds;draw:()=>void}[]=[];
 for(const agent of agents){
  const reference=toGeo({x:agent.point.x,y:agent.point.y}),offset=(agent.kind==='pedestrian'?3.5:1.8)/metresPerCellAt(reference.lat);
  const point={x:nearestWorldX(agent.point.x,centre.x)-agent.heading.y*offset,y:agent.point.y+agent.heading.x*offset};
  // Geographic geometry's half-cell origin follows the existing street rendering convention.
  if(view.geography){point.x-=.5;point.y-=.5;}
  const projectPoint=(p:Point)=>projectSurface(view,p,agent.elevationM??undefined);
  const p=projectPoint(point);if(p.x<-24||p.y<-24||p.x>view.viewport.width+24||p.y>view.viewport.height+24||!Number.isFinite(p.x)||!Number.isFinite(p.y)||!visibleSurfacePoint(view,point,agent.elevationM??undefined))continue;
  if(count++>=limit)break;
  const bodyScale=Math.max(.2,pixels),length=Math.max(agent.kind==='bus'||agent.kind==='school-bus'?14:agent.kind==='truck'?10:6,MOBILITY_LENGTH[agent.kind]*bodyScale),width=Math.max(agent.kind==='bus'||agent.kind==='school-bus'?4:3,2.1*bodyScale);
  const radius=agent.kind==='pedestrian'?Math.max(4,1.3*bodyScale)+Math.max(.8,bodyScale*.25)+2:Math.hypot(length,width)/2+3;
  result.push({bounds:{x:p.x-radius,y:p.y-radius,width:radius*2,height:radius*2},depth:surfaceDepth(view,point,agent.elevationM??undefined),draw:()=>drawMobilityAgent(ctx,{...agent,point},projectPoint,pixels,view.motion)});
 }
 return result;
}
export function drawTrafficSignal(ctx:CanvasRenderingContext2D,signal:TrafficSignalFrame,point:Point,zoom:number):void{
 const size=Math.max(2,Math.min(4,zoom*5));ctx.save();ctx.translate(point.x,point.y);ctx.strokeStyle='#647573';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,-size*7);ctx.stroke();ctx.fillStyle='#27393b';ctx.fillRect(-size*.8,-size*8,size*1.6,size*4.6);for(const [i,color] of ['red','amber','green'].entries()){ctx.fillStyle=signal.aspect===color?['#ef5c52','#f4bd51','#5cce84'][i]:'#455955';ctx.beginPath();ctx.arc(0,-size*7.2+i*size*1.4,size*.55,0,Math.PI*2);ctx.fill();}ctx.restore();
}
export function signalDrawCommands(ctx:CanvasRenderingContext2D,view:WorldView){
 if(view.camera.zoom<.15)return [];const centre=cellSpace({x:view.viewport.width/2,y:view.viewport.height/2},view.camera),result:SceneCommand[]=[];
 for(const signal of view.signals??[]){const scale=metresPerCellAt(toGeo(signal.point).lat),point={x:nearestWorldX(signal.point.x,centre.x)-(signal.direction.x*6+signal.direction.y*3)/scale,y:signal.point.y-(signal.direction.y*6-signal.direction.x*3)/scale};if(view.geography){point.x-=.5;point.y-=.5;}const p=projectSurface(view,point);if(p.x<0||p.y<0||p.x>view.viewport.width||p.y>view.viewport.height||!visibleSurfacePoint(view,point))continue;result.push({id:`signal:${signal.nodeId}:${signal.direction.x}:${signal.direction.y}`,version:signal.aspect,bounds:{x:p.x-12,y:p.y-44,width:24,height:56},depth:surfaceDepth(view,point),draw:()=>drawTrafficSignal(ctx,signal,p,view.camera.zoom)});if(result.length>=128)break;}
 return result;
}
// The frame asks for these lists twice — once to know whether anything visible is moving, once to draw it — and building
// them projects every agent. The view object is built fresh for each frame, so remembering the list on it makes the
// second question free while keeping what is drawn identical to what was asked about.
const frameCommands=new WeakMap<object,SceneCommand[]>();
export function mobilityDrawCommands(ctx:CanvasRenderingContext2D,view:WorldView){
 const cached=frameCommands.get(view);if(cached)return cached;
 const built=[...commands(ctx,view,view.mobility??[]),...signalDrawCommands(ctx,view)];
 frameCommands.set(view,built);return built;
}
export function drawVisibleMobility(ctx:CanvasRenderingContext2D,view:WorldView):void{for(const command of mobilityDrawCommands(ctx,view).sort((a,b)=>a.depth-b.depth))command.draw();}
export function drawCellMobility(ctx:CanvasRenderingContext2D,view:WorldView,coord:CellCoord):void{
 const frame=view.mobility;if(!frame)return;let index=byCell.get(frame);
 if(!index){index=new Map();for(const agent of frame){const key=`${wrapX(Math.round(agent.point.x))}:${Math.round(agent.point.y)}`,list=index.get(key)??[];list.push(agent);index.set(key,list);}byCell.set(frame,index);}
 for(const command of commands(ctx,view,index.get(`${wrapX(coord.x)}:${coord.y}`)??[]))command.draw();
}
