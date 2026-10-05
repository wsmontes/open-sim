import type {Point} from './camera';
export type ProjectedTerrainTriangle={points:readonly [Point,Point,Point];depths:readonly [number,number,number]};
// Screen-space depth is presentation-only. Bounded rasterization makes visibility independent of tile order.
export function createTerrainDepthBuffer(width:number,height:number,triangles:readonly ProjectedTerrainTriangle[],step=4){
 const stride=Math.max(1,Math.ceil(step)),w=Math.max(1,Math.ceil(width/stride)),h=Math.max(1,Math.ceil(height/stride));
 const depth=new Float32Array(w*h).fill(-Infinity);
 for(const triangle of triangles){
  const [a,b,c]=triangle.points,det=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);if(Math.abs(det)<1e-10)continue;
  const x0=Math.max(0,Math.floor(Math.min(a.x,b.x,c.x)/stride)),x1=Math.min(w-1,Math.ceil(Math.max(a.x,b.x,c.x)/stride));
  const y0=Math.max(0,Math.floor(Math.min(a.y,b.y,c.y)/stride)),y1=Math.min(h-1,Math.ceil(Math.max(a.y,b.y,c.y)/stride));
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   const px=(x+.5)*stride,py=(y+.5)*stride;
   const u=((b.y-c.y)*(px-c.x)+(c.x-b.x)*(py-c.y))/det,v=((c.y-a.y)*(px-c.x)+(a.x-c.x)*(py-c.y))/det,t=1-u-v;
   if(Math.min(u,v,t)<0)continue;
   const z=u*triangle.depths[0]+v*triangle.depths[1]+t*triangle.depths[2],index=y*w+x;if(z>depth[index])depth[index]=z;
  }
 }
 return {visible(point:Point,z:number,tolerance=0):boolean{
  const x=Math.floor(point.x/stride),y=Math.floor(point.y/stride);return x<0||y<0||x>=w||y>=h||z+tolerance>=depth[y*w+x];
 },step:stride,width:w,height:h};
}
