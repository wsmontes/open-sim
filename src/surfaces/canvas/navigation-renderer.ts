import {project,type Camera} from '../../presentation/camera';
import {GLOBE_ZOOM} from '../../presentation/geographic-map';
import type {WorldView} from './canvas-renderer';
import {sceneRasterCache} from './scene-cache';
const same=(a:Camera,b:Camera)=>a.x===b.x&&a.y===b.y&&a.zoom===b.zoom&&a.rotation===b.rotation;
export function cameraReprojection(old:Camera,next:Camera):readonly number[]{
 const o=project({x:0,y:0},old),x=project({x:1,y:0},old),y=project({x:0,y:1},old),n=project({x:0,y:0},next),nx=project({x:1,y:0},next),ny=project({x:0,y:1},next);
 const ax=x.x-o.x,ay=x.y-o.y,bx=y.x-o.x,by=y.y-o.y,det=ax*by-bx*ay;
 const a=((nx.x-n.x)*by-(ny.x-n.x)*ay)/det,b=((nx.y-n.y)*by-(ny.y-n.y)*ay)/det,c=(-(nx.x-n.x)*bx+(ny.x-n.x)*ax)/det,d=(-(nx.y-n.y)*bx+(ny.y-n.y)*ax)/det;
 return [a,b,c,d,n.x-a*o.x-c*o.y,n.y-b*o.x-d*o.y];
}
// Input paints the last complete city immediately. Accurate geometry resumes after120ms without camera changes.
// Reprojection is temporary: elevation and actor positions are rebuilt at the settled camera.
export function createNavigationRenderer(full:(ctx:CanvasRenderingContext2D,view:WorldView)=>void,reset:(ctx:CanvasRenderingContext2D)=>void){
 let complete:WorldView|undefined,lastCamera:Camera|undefined,snapshot:OffscreenCanvas|undefined,changedAt=-Infinity,reprojected=false;
 const release=()=>{sceneRasterCache.delete('navigation-raster');snapshot=undefined;};
 return {
  pending:()=>reprojected,
  draw(ctx:CanvasRenderingContext2D,view:WorldView,now:number){
   const changed=!!lastCamera&&!same(lastCamera,view.camera);lastCamera={...view.camera};if(changed)changedAt=now;
   const compatible=complete&&complete.viewport.width===view.viewport.width&&complete.viewport.height===view.viewport.height&&complete.light===view.light&&complete.camera.zoom>=GLOBE_ZOOM&&view.camera.zoom>=GLOBE_ZOOM;
   if(compatible&&now-changedAt<120&&typeof OffscreenCanvas!=='undefined'&&(!reprojected||snapshot&&sceneRasterCache.get('navigation-raster')?.canvas===snapshot)){
    if(snapshot&&sceneRasterCache.get('navigation-raster')?.canvas!==snapshot)snapshot=undefined;
    if(!snapshot&&view.viewport.width*view.viewport.height*4<=128*1024*1024){snapshot=new OffscreenCanvas(view.viewport.width,view.viewport.height);const source=snapshot.getContext('2d');if(source){source.drawImage(ctx.canvas,0,0);sceneRasterCache.set('navigation-raster',{canvas:snapshot},view.viewport.width*view.viewport.height*4);}else snapshot=undefined;}
    if(snapshot){const [a,b,c,d,e,f]=cameraReprojection(complete!.camera,view.camera);ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#b6bd96';ctx.fillRect(0,0,view.viewport.width,view.viewport.height);ctx.setTransform(a,b,c,d,e,f);ctx.drawImage(snapshot,0,0);ctx.restore();reprojected=true;return;}
   }
   if(reprojected)reset(ctx);release();reprojected=false;full(ctx,view);complete=view;
  },dispose(){release();complete=undefined;lastCamera=undefined;reprojected=false;},
 };
}
