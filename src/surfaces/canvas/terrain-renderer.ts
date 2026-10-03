import type {WorldView} from './canvas-renderer';
import {toGeo} from '../../core/coordinates';
import {project,TILE_H,type Point,type Camera} from '../../presentation/camera';
import {geographicFocus} from '../../presentation/geographic-map';
import {createSurfaceSupport,metresPerCellAt} from '../../presentation/terrain-surface';
import {projectElevated,trianglesForTile,pickTerrain,terrainDepth,type TerrainTriangle} from '../../presentation/terrain-projection';
import {createTerrainDepthBuffer} from '../../presentation/terrain-occlusion';
import {lightContext} from './city-light';

export const terrainMetres=(view:WorldView)=>metresPerCellAt(geographicFocus(view.camera,view.viewport).lat);
export function projectSurface(view:WorldView,point:Point,elevationM?:number):Point{
 const height=elevationM??view.terrain?.sample(toGeo(point))?.elevationM;
 return height===undefined?project(point,view.camera):projectElevated(point,height,view.camera,terrainMetres(view));
}
export function surfaceDepth(view:WorldView,point:Point,elevationM?:number):number{
 return view.terrain?.tiles.length?terrainDepth(point,elevationM??view.terrain.sample(toGeo(point))?.elevationM??0,view.camera,terrainMetres(view)):project(point,view.camera).y;
}
const meshes=new WeakMap<object,Map<number,readonly TerrainTriangle[]>>();
const visibility=new WeakMap<Camera,{tiles:object;width:number;height:number;triangles:readonly TerrainTriangle[];depth?:ReturnType<typeof createTerrainDepthBuffer>}>();
let painted:{camera:Camera;tiles:object;width:number;height:number;light:string;canvas:OffscreenCanvas}|null=null;
const paths=new WeakMap<Camera,{tiles:object|undefined;width:number;height:number;lines:WeakMap<object,{height:number|undefined;commands:readonly {screen:Point;visible:boolean}[]}>}>();
export function visibleTerrain(view:WorldView):readonly TerrainTriangle[]{
 const tiles=view.terrain?.tiles;if(!tiles?.length)return [];
 const known=visibility.get(view.camera);if(known?.tiles===tiles&&known.width===view.viewport.width&&known.height===view.viewport.height)return known.triangles;
 // Shared stride across adjacent tiles preserves edge vertices. Cap work before allocating meshes.
 let stride=1;while(tiles.length*2*Math.ceil(64/stride)**2>40000)stride*=2;
 const scale=view.camera.zoom;while(stride<64&&scale*32*stride<1)stride*=2;
 let cache=meshes.get(tiles);if(!cache){cache=new Map();meshes.set(tiles,cache);}
 let triangles=cache.get(stride);
 if(!triangles){
  const seen=new Set<string>(),support=view.terrain!;
  triangles=tiles.flatMap(tile=>{
   const key=[tile.bounds.west,tile.bounds.east,tile.bounds.south,tile.bounds.north].join(':');
   if(seen.has(key))return [];seen.add(key);
   const heightsM=new Float32Array(tile.size*tile.size),valid=new Uint8Array(heightsM.length);
   for(let y=0;y<tile.size;y++)for(let x=0;x<tile.size;x++){
    const geo={lon:tile.bounds.west+(tile.bounds.east-tile.bounds.west)*x/(tile.size-1),lat:tile.bounds.north-(tile.bounds.north-tile.bounds.south)*y/(tile.size-1)},reading=support.sample(geo),index=y*tile.size+x;
    if(reading){heightsM[index]=reading.elevationM;valid[index]=1;}else heightsM[index]=NaN;
   }
   return trianglesForTile({...tile,heightsM,valid},stride);
  });cache.set(stride,triangles);
 }
 const m=terrainMetres(view),{width,height}=view.viewport;
 const visible=triangles.filter(t=>{const points=t.points.map((p,i)=>projectElevated(p,t.heightsM[i],view.camera,m));return Math.max(...points.map(p=>p.x))>=0&&Math.min(...points.map(p=>p.x))<=width&&Math.max(...points.map(p=>p.y))>=0&&Math.min(...points.map(p=>p.y))<=height;});
 visibility.set(view.camera,{tiles,width,height,triangles:visible});return visible;
}
export function visibleSurfacePoint(view:WorldView,point:Point,elevationM?:number):boolean{
 if(!view.terrain?.tiles.length)return true;
 const triangles=visibleTerrain(view),known=visibility.get(view.camera)!;const m=terrainMetres(view);
 if(!known.depth)known.depth=createTerrainDepthBuffer(view.viewport.width,view.viewport.height,triangles.map(t=>({points:t.points.map((p,i)=>projectElevated(p,t.heightsM[i],view.camera,m)) as [Point,Point,Point],depths:t.points.map((p,i)=>terrainDepth(p,t.heightsM[i],view.camera,m)) as [number,number,number]})));
 const height=elevationM??view.terrain.sample(toGeo(point))?.elevationM;if(height===undefined)return true;
 return known.depth.visible(projectSurface(view,point,height),terrainDepth(point,height,view.camera,m),4/(TILE_H*view.camera.zoom));
}
export function terrainRoadPath(ctx:CanvasRenderingContext2D,view:WorldView,points:readonly Point[],elevationM?:number):void{
 let cache=paths.get(view.camera);if(!cache||cache.tiles!==view.terrain?.tiles||cache.width!==view.viewport.width||cache.height!==view.viewport.height){cache={tiles:view.terrain?.tiles,width:view.viewport.width,height:view.viewport.height,lines:new WeakMap()};paths.set(view.camera,cache);}
 let line=cache.lines.get(points);
 if(!line||line.height!==elevationM){
  const readings=view.terrain?createSurfaceSupport(view.terrain.sample).line(points):points.map(point=>({point,elevationM:null}));
  line={height:elevationM,commands:readings.map(reading=>{const height=elevationM??reading.elevationM??undefined;return {screen:projectSurface(view,reading.point,height),visible:visibleSurfacePoint(view,reading.point,height)};})};cache.lines.set(points,line);
 }
 let connected=false;
 for(const command of line.commands){
  const p=command.screen;if(!command.visible){connected=false;continue;}
  if(connected)ctx.lineTo(p.x,p.y);else ctx.moveTo(p.x,p.y);connected=true;
 }
}
export function clipTerrainVolume(ctx:CanvasRenderingContext2D,view:WorldView,points:readonly Point[],base:number,heightM:number):void{
 if(!view.terrain?.tiles.length||!points.length)return;
 visibleSurfacePoint(view,points[0],base);const buffer=visibility.get(view.camera)!.depth!;
 const m=terrainMetres(view),ground=points.map(p=>projectSurface(view,p,base));
 const rise=projectElevated(points[0],0,view.camera,m).y-projectElevated(points[0],heightM,view.camera,m).y;
 const x0=Math.max(0,Math.floor((Math.min(...ground.map(p=>p.x))-rise*.4)/buffer.step)*buffer.step),x1=Math.min(view.viewport.width,Math.max(...ground.map(p=>p.x))+rise*.4);
 const y0=Math.max(0,Math.floor((Math.min(...ground.map(p=>p.y))-rise)/buffer.step)*buffer.step),y1=Math.min(view.viewport.height,Math.max(...ground.map(p=>p.y))+rise*.3);
 const front=Math.max(...ground.map(p=>p.y)),z=Math.max(...points.map(p=>terrainDepth(p,base,view.camera,m))),scale=rise/Math.max(1e-10,heightM),tolerance=4/(TILE_H*view.camera.zoom);
 const runs:{x:number;y:number;width:number}[]=[];let hidden=false;
 for(let y=y0;y<y1;y+=buffer.step){let start:number|null=null;
  for(let x=x0;x<x1;x+=buffer.step){
   const altitude=Math.max(0,Math.min(heightM,(front-y)/scale)),depth=z+altitude/m*Math.sqrt(2/3);
   const visible=buffer.visible({x:x+buffer.step/2,y:y+buffer.step/2},depth,tolerance);
   if(visible&&start===null)start=x;
   if(!visible){hidden=true;if(start!==null){runs.push({x:start,y,width:x-start});start=null;}}
  }
  if(start!==null)runs.push({x:start,y,width:x1-start});
 }
 if(!hidden)return;
 ctx.beginPath();for(const run of runs)ctx.rect(run.x,run.y,run.width,buffer.step);ctx.clip();
}
export function pickSurface(view:WorldView,screen:Point):Point|null{
 const hit=pickTerrain(screen,visibleTerrain(view),view.camera,terrainMetres(view));return hit?.point??null;
}
export function surfaceLine(view:WorldView,points:readonly Point[],elevationM?:number):Point[]{
 if(!view.terrain)return points.map(p=>project(p,view.camera));
 return createSurfaceSupport(view.terrain.sample).line(points).map(p=>projectSurface(view,p.point,elevationM??p.elevationM??undefined));
}
export function foundationElevation(view:WorldView,points:readonly Point[]):number|undefined{
 return view.terrain?createSurfaceSupport(view.terrain.sample).foundation(points)??undefined:undefined;
}
export function drawTerrain(ctx:CanvasRenderingContext2D,view:WorldView):void{
 if(!view.terrain?.tiles.length)return;
 if(typeof OffscreenCanvas!=='undefined'){
  const {width,height}=view.viewport,light=view.light??'day';
  if(painted?.camera===view.camera&&painted.tiles===view.terrain.tiles&&painted.width===width&&painted.height===height&&painted.light===light){ctx.drawImage(painted.canvas,0,0);return;}
  const canvas=painted?.canvas??new OffscreenCanvas(width,height);if(canvas.width!==width)canvas.width=width;if(canvas.height!==height)canvas.height=height;
  const context=canvas.getContext('2d');
  if(context){context.clearRect(0,0,width,height);paintTerrain(lightContext(context as unknown as CanvasRenderingContext2D,light),view);painted={camera:view.camera,tiles:view.terrain.tiles,width,height,light,canvas};ctx.drawImage(canvas,0,0);return;}
 }
 paintTerrain(ctx,view);
}
function paintTerrain(ctx:CanvasRenderingContext2D,view:WorldView):void{
 const m=terrainMetres(view),triangles=[...visibleTerrain(view)];
 triangles.sort((a,b)=>terrainDepth(a.points[0],a.heightsM[0],view.camera,m)-terrainDepth(b.points[0],b.heightsM[0],view.camera,m));
 for(const t of triangles){
  const [a,b,c]=t.points,h=t.heightsM;
  const ux=(b.x-a.x)*m,uy=(b.y-a.y)*m,uz=h[1]-h[0],vx=(c.x-a.x)*m,vy=(c.y-a.y)*m,vz=h[2]-h[0];
  let nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;if(nz<0){nx=-nx;ny=-ny;nz=-nz;}
  const length=Math.hypot(nx,ny,nz)||1,shade=.7+.3*Math.max(0,(-nx*.4-ny*.4+nz*.82)/length);
  const p=t.points.map((point,i)=>projectElevated(point,h[i],view.camera,m));
  ctx.beginPath();ctx.moveTo(p[0].x,p[0].y);ctx.lineTo(p[1].x,p[1].y);ctx.lineTo(p[2].x,p[2].y);ctx.closePath();
  ctx.fillStyle=`#${[182,189,150].map(c=>Math.round(c*shade).toString(16).padStart(2,'0')).join('')}`;ctx.fill();
 }
}
