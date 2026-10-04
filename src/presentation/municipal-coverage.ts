export type LocalArea={rings:readonly (readonly (readonly number[])[])[]};
// Conservative display coverage, not a replacement for a census subdivision boundary.
export function containsLocalArea(areas:readonly LocalArea[],point:{lat:number;lon:number}):boolean{
 if(!Number.isFinite(point.lat)||!Number.isFinite(point.lon))return false;
 const inside=(ring:LocalArea['rings'][number])=>{let contained=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[j],b=ring[i],dx=b[0]-a[0],dy=b[1]-a[1],cross=(point.lon-a[0])*dy-(point.lat-a[1])*dx;
  if(Math.abs(cross)<1e-10&&point.lon>=Math.min(a[0],b[0])-1e-10&&point.lon<=Math.max(a[0],b[0])+1e-10&&point.lat>=Math.min(a[1],b[1])-1e-10&&point.lat<=Math.max(a[1],b[1])+1e-10)return true;
  if((a[1]>point.lat)!==(b[1]>point.lat)&&point.lon<(b[0]-a[0])*(point.lat-a[1])/(b[1]-a[1])+a[0])contained=!contained;
 }return contained;};
 return areas.some(area=>area.rings.length>0&&inside(area.rings[0])&&!area.rings.slice(1).some(inside));
}
