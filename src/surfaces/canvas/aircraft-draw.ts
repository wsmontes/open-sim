import type {ScreenBounds} from './scene-compositor';
import type {WorldView} from './canvas-renderer';
import {cellSpace,TILE_W} from '../../presentation/camera';
import {nearestWorldX} from '../../presentation/geographic-map';
import {terrainPoint} from '../../presentation/terrain-surface';
import {projectSurface,surfaceDepth,terrainMetres,visibleSurfacePoint} from './terrain-renderer';
import type {AircraftFrame} from '../../presentation/aviation';import type {AirportPoint} from '../../core/airport-data';import type {Point} from '../../presentation/camera';
export function drawAircraft(ctx:CanvasRenderingContext2D,a:AircraftFrame,projectGround:(point:AirportPoint)=>Point,pixelsPerMetre:number):void{const p=projectGround(a.position),r=a.headingDegrees*Math.PI/180,q=projectGround({lat:a.position.lat+Math.cos(r)*.0001,lon:a.position.lon+Math.sin(r)*.0001/Math.cos(a.position.lat*Math.PI/180)}),angle=Math.atan2(q.y-p.y,q.x-p.x),scale=Math.max(.18,pixelsPerMetre),length=Math.max(12,40*scale),span=Math.max(10,35*scale);ctx.save();ctx.globalAlpha*=a.opacity??1;ctx.translate(p.x,p.y);ctx.rotate(angle);ctx.fillStyle=a.colours[0]??'#eeeee8';ctx.beginPath();for(const [i,v] of [[.5,0],[.35,-.045],[.08,-.075],[-.12,-.5],[-.26,-.5],[-.12,-.075],[-.38,-.055],[-.46,-.2],[-.5,-.2],[-.45,0],[-.5,.2],[-.46,.2],[-.38,.055],[-.12,.075],[-.26,.5],[-.12,.5],[.08,.075],[.35,.045]].entries()){const x=v[0]*length,y=v[1]*span;i?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.closePath();ctx.fill();ctx.strokeStyle='#526c73';ctx.lineWidth=.7;ctx.stroke();ctx.fillStyle=a.colours[1]??'#398e93';ctx.beginPath();ctx.moveTo(-length*.42,-span*.03);ctx.lineTo(-length*.32,-span*.03);ctx.lineTo(-length*.46,-span*.18);ctx.closePath();ctx.fill();ctx.fillStyle=a.colours[2]??'#344e5c';ctx.fillRect(length*.28,-span*.035,length*.09,span*.07);ctx.fillStyle=a.colours[1]??'#398e93';ctx.fillRect(-length*.12,-span*.33,length*.09,span*.08);ctx.fillRect(-length*.12,span*.25,length*.09,span*.08);ctx.restore();}
const frameAircraft=new WeakMap<object,{shadows:{depth:number;bounds:ScreenBounds;draw:()=>void}[];aircraft:{depth:number;bounds:ScreenBounds;draw:()=>void;grounded:boolean}[]}>();
export function aircraftDrawCommands(ctx:CanvasRenderingContext2D,view:WorldView){
 const cached=frameAircraft.get(view);if(cached)return cached;
 if(!view.geography||view.camera.zoom<.001)return {shadows:[],aircraft:[]};
 const centre=cellSpace({x:view.viewport.width/2,y:view.viewport.height/2},view.camera),shadows:{depth:number;bounds:ScreenBounds;draw:()=>void}[]=[],aircraft:{depth:number;bounds:ScreenBounds;draw:()=>void;grounded:boolean}[]=[],pixels=TILE_W*view.camera.zoom/terrainMetres(view);
 const convert=(p:AirportPoint)=>terrainPoint(p.lon,p.lat),pointFor=(p:AirportPoint)=>{const q=convert(p);return {x:nearestWorldX(q.x,centre.x)-.5,y:q.y-.5};};
 for(const a of view.aircraft??[]){if(a.verticalDatum!=='CGVD2013')continue;const point=pointFor(a.position),airProject=(p:AirportPoint)=>projectSurface(view,pointFor(p),a.altitudeM),p=airProject(a.position),margin=Math.max(30,40*pixels),groundProject=(p:AirportPoint)=>projectSurface(view,pointFor(p));
  const ground=groundProject(a.position);if(ground.x>=-margin&&ground.y>=-margin&&ground.x<=view.viewport.width+margin&&ground.y<=view.viewport.height+margin&&visibleSurfacePoint(view,point))shadows.push({bounds:{x:ground.x-margin,y:ground.y-margin,width:margin*2,height:margin*2},depth:surfaceDepth(view,point),draw:()=>{ctx.save();ctx.globalAlpha*=.18;drawAircraft(ctx,{...a,colours:['#263f43','#263f43','#263f43']},groundProject,pixels);ctx.restore();}});
  if(p.x>=-margin&&p.y>=-margin&&p.x<=view.viewport.width+margin&&p.y<=view.viewport.height+margin&&visibleSurfacePoint(view,point,a.altitudeM))aircraft.push({bounds:{x:p.x-margin,y:p.y-margin,width:margin*2,height:margin*2},grounded:a.phase!=='approach'&&a.phase!=='climb',depth:surfaceDepth(view,point,a.altitudeM),draw:()=>drawAircraft(ctx,a,airProject,pixels)});if(aircraft.length>=8)break;
 }
 const built={shadows,aircraft};
 frameAircraft.set(view,built);return built;
}
