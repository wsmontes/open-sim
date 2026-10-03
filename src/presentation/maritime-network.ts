import {WORLD} from '../core/coordinates';
import type {MaritimeCapture,MarineRoute,MarinePoint} from '../core/maritime-data';
import type {GeographicFeature} from './geographic-map';
import type {Point} from './camera';
import {metresPerCellAt} from './terrain-surface';
const world=(p:MarinePoint):Point=>({x:(p.lon+180)/360*WORLD,y:(1-Math.asinh(Math.tan(p.lat*Math.PI/180))/Math.PI)/2*WORLD});
const cross=(a:Point,b:Point,c:Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
const inside=(p:Point,rings:Point[][])=>{let hit=false;for(const ring of rings)for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;}return hit;};
const intersects=(a:Point,b:Point,c:Point,d:Point)=>{
 if(Math.max(a.x,b.x)<Math.min(c.x,d.x)||Math.max(c.x,d.x)<Math.min(a.x,b.x)||Math.max(a.y,b.y)<Math.min(c.y,d.y)||Math.max(c.y,d.y)<Math.min(a.y,b.y))return false;
 return cross(a,b,c)*cross(a,b,d)<=0&&cross(c,d,a)*cross(c,d,b)<=0;
};
export function buildMaritimeNetwork(capture:MaritimeCapture,land:readonly GeographicFeature[]):{routes:ReadonlyMap<string,MarineRoute>;rejected:readonly string[]}{
 const routes=new Map<string,MarineRoute>(),rejected:string[]=[],terminals=new Map(capture.terminals.map(t=>[t.id,t]));
 const polygons=land.filter(f=>f.layer==='land'&&f.type===3).map(f=>({rings:f.geometry,minX:Math.min(...f.geometry.flat().map(p=>p.x)),maxX:Math.max(...f.geometry.flat().map(p=>p.x)),minY:Math.min(...f.geometry.flat().map(p=>p.y)),maxY:Math.max(...f.geometry.flat().map(p=>p.y))}));
 for(const route of capture.routes){
  let reason=route.verified?'':'unverified';if(route.terminalIds.some(id=>!terminals.has(id)))reason='missing-terminal';
  if(route.allowed.some(kind=>(kind==='cargo'||kind==='cruise')&&route.terminalIds.some(id=>!terminals.get(id)?.allowedKinds?.includes(kind))))reason='incompatible-terminal';
  if(route.allowed.some(kind=>kind==='cargo'||kind==='cruise'||kind==='bc-ferry')&&(!route.navigation?.verifiedForLargeShips||!(route.navigation.leastDepthM>0)))reason='unverified-depth';
  if(!reason){const points=route.path.map(world);for(let i=1;i<points.length&&!reason;i++){let a=points[i-1],b=points[i];const scale=metresPerCellAt(route.path[i-1].lat),length=Math.hypot(b.x-a.x,b.y-a.y)*scale;if(!length)continue;
    // Floating-terminal endpoints can lie on mapped piers. Only the first/last
    // 30m is exempt, never an entire long shore-crossing segment.
    const start=i===1?Math.min(1,30/length):0,end=i===points.length-1?Math.max(start,1-30/length):1;const original=a;a={x:original.x+(b.x-original.x)*start,y:original.y+(b.y-original.y)*start};b={x:original.x+(b.x-original.x)*end,y:original.y+(b.y-original.y)*end};
    for(const polygon of polygons){if(Math.max(a.x,b.x)<polygon.minX||Math.min(a.x,b.x)>polygon.maxX||Math.max(a.y,b.y)<polygon.minY||Math.min(a.y,b.y)>polygon.maxY)continue;if(inside(a,polygon.rings)||inside(b,polygon.rings)||polygon.rings.some(r=>r.some((p,j)=>intersects(a,b,p,r[(j+1)%r.length])))){reason=`land-crossing-segment-${i}`;break;}}
   }}
  if(reason)rejected.push(`${route.id}:${reason}`);else routes.set(route.id,route);
 }
 return {routes,rejected};
}
