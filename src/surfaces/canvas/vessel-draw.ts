import type {WorldView} from './canvas-renderer';
import {WORLD} from '../../core/coordinates';
import {cellSpace,TILE_W} from '../../presentation/camera';
import {nearestWorldX} from '../../presentation/geographic-map';
import {projectSurface,surfaceDepth,terrainMetres,visibleSurfacePoint} from './terrain-renderer';
import type {MarinePoint} from '../../core/maritime-data';
import type {VesselFrame} from '../../presentation/maritime-engine';
import {VESSEL_SIZE} from '../../presentation/maritime-engine';
import type {Point} from '../../presentation/camera';
export function drawVessel(ctx:CanvasRenderingContext2D,vessel:VesselFrame,projectWater:(p:MarinePoint,h:number)=>Point,pixelsPerMetre:number):void{
 const p=projectWater(vessel.position,vessel.waterElevationM),angle=vessel.headingDegrees*Math.PI/180,q=projectWater({lat:vessel.position.lat+Math.cos(angle)*.0001,lon:vessel.position.lon+Math.sin(angle)*.0001/Math.cos(vessel.position.lat*Math.PI/180)},vessel.waterElevationM),heading=Math.atan2(q.y-p.y,q.x-p.x),scale=Math.max(.15,pixelsPerMetre),size=VESSEL_SIZE[vessel.kind],length=Math.max(vessel.kind==='cargo'||vessel.kind==='cruise'?28:10,size.length*scale),width=Math.max(4,size.width*scale);
 ctx.save();ctx.translate(p.x,p.y);ctx.rotate(heading);
 if((vessel.speedMps??(vessel.phase==='berthed'?0:1))>0){ctx.strokeStyle='rgba(231,245,240,.5)';ctx.lineWidth=Math.max(1,scale*.8);ctx.beginPath();ctx.moveTo(-length*.45,-width*.35);ctx.lineTo(-length*.9,-width*.75);ctx.moveTo(-length*.45,width*.35);ctx.lineTo(-length*.9,width*.75);ctx.stroke();}
 ctx.fillStyle='rgba(25,45,50,.2)';ctx.fillRect(-length*.45+2,-width*.45+2,length*.9,width*.9);
 ctx.fillStyle=vessel.kind==='aquabus'?'#b74f81':vessel.kind==='seabus'?'#315b85':vessel.kind==='cargo'?'#3c5559':vessel.kind==='cruise'?'#293e60':'#e6e9df';ctx.beginPath();ctx.moveTo(length*.5,0);ctx.lineTo(length*.34,-width*.5);ctx.lineTo(-length*.44,-width*.5);ctx.lineTo(-length*.5,-width*.3);ctx.lineTo(-length*.5,width*.3);ctx.lineTo(-length*.44,width*.5);ctx.lineTo(length*.34,width*.5);ctx.closePath();ctx.fill();ctx.strokeStyle='#40595d';ctx.lineWidth=.8;ctx.stroke();
 if(vessel.kind==='cargo'){for(let row=0;row<3;row++)for(let col=0;col<8;col++){ctx.fillStyle=['#a9603f','#56807a','#737d95'][(row+col)%3];ctx.fillRect(-length*.2+col*length*.075,-width*.39+row*width*.27,length*.069,width*.23);}ctx.fillStyle='#e2e5dd';ctx.fillRect(-length*.41,-width*.37,length*.15,width*.74);}
 else if(vessel.kind==='cruise'){for(let level=0;level<5;level++){ctx.fillStyle=level%2?'#d4dcd8':'#f0eee3';ctx.fillRect(-length*.38+level*length*.03,-width*.43-level*scale*.6,length*(.74-level*.06),width*.83);ctx.strokeStyle='#78959b';ctx.lineWidth=Math.max(.5,scale*.3);ctx.strokeRect(-length*.37+level*length*.03,-width*.42-level*scale*.6,length*(.71-level*.06),width*.8);}ctx.fillStyle='#415273';ctx.fillRect(-length*.17,-width*.23,length*.045,width*.35);}
 else if(vessel.kind==='sailboat'){ctx.fillStyle='#8e8568';ctx.fillRect(-length*.19,-width*.3,length*.35,width*.6);ctx.restore();ctx.save();ctx.translate(p.x,p.y);const mast=Math.max(14,12*scale);ctx.strokeStyle='#647678';ctx.lineWidth=Math.max(1,scale*.25);ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,-mast);ctx.stroke();ctx.fillStyle='#faf1d4';ctx.beginPath();ctx.moveTo(-1,-mast);ctx.lineTo(-mast*.6,-mast*.17);ctx.lineTo(-1,-mast*.24);ctx.closePath();ctx.fill();ctx.beginPath();ctx.moveTo(2,-mast*.82);ctx.lineTo(mast*.45,-mast*.16);ctx.lineTo(2,-mast*.22);ctx.closePath();ctx.fill();}
 else{ctx.fillStyle='#ecefe2';ctx.fillRect(-length*.36,-width*.38,length*.69,width*.76);ctx.fillStyle='#4d7683';for(let i=0;i<5;i++)ctx.fillRect(-length*.3+i*length*.13,-width*.37,length*.09,width*.24);if(vessel.kind==='aquabus'){for(let i=0;i<4;i++){ctx.fillStyle=['#a85581','#e5b354','#78a778','#6688af'][i];ctx.fillRect(-length*.33+i*length*.16,width*.25,length*.16,width*.18);}}if(vessel.kind==='bc-ferry'){ctx.fillStyle='#39668a';ctx.fillRect(-length*.1,-width*.27,length*.22,width*.54);}}
 ctx.restore();
}

export function vesselDrawCommands(ctx:CanvasRenderingContext2D,view:WorldView){
 if(!view.geography||view.camera.zoom<.001)return [];
 const centre=cellSpace({x:view.viewport.width/2,y:view.viewport.height/2},view.camera),result:{depth:number;draw:()=>void}[]=[];
 const convert=(p:MarinePoint)=>{const phi=p.lat*Math.PI/180;return {x:nearestWorldX((p.lon+180)/360*WORLD,centre.x)-.5,y:(1-Math.asinh(Math.tan(phi))/Math.PI)/2*WORLD-.5};};
 const projectWater=(p:MarinePoint,h:number)=>projectSurface(view,convert(p),h),pixels=TILE_W*view.camera.zoom/terrainMetres(view);
 for(const vessel of [...(view.vessels??[])].sort((a,b)=>Number(b.kind==='bc-ferry')-Number(a.kind==='bc-ferry'))){const point=convert(vessel.position),p=projectWater(vessel.position,vessel.waterElevationM),margin=Math.max(30,VESSEL_SIZE[vessel.kind].length*pixels);
  if(p.x< -margin||p.y< -margin||p.x>view.viewport.width+margin||p.y>view.viewport.height+margin||!visibleSurfacePoint(view,point,vessel.waterElevationM))continue;
  result.push({depth:surfaceDepth(view,point,vessel.waterElevationM),draw:()=>drawVessel(ctx,vessel,projectWater,pixels)});if(result.length>=(view.camera.zoom<.2?8:24))break;
 }return result;
}
