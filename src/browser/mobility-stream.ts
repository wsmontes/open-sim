import {createMobilityController} from '../client/mobility-controller';
import {WORLD} from '../core/coordinates';
import {cellSpace,type Camera,type Viewport} from '../presentation/camera';
import {tileKey,type GeographicTile} from '../presentation/geographic-map';
export function createMobilityStream(load:(z:number,x:number,y:number)=>Promise<GeographicTile>,seed:number,changed:()=>void){
 const controller=createMobilityController(seed),cache=new Map<string,GeographicTile>(),pending=new Set<string>(),failed=new Set<string>();
 let selection='',demand:{z:number;x:number;y:number}[]=[],disposed=false;
 const publish=()=>{if(disposed)return;controller.setGeography(demand.flatMap(t=>cache.get(tileKey(t))?[cache.get(tileKey(t))!]:[]));changed();};
 const pump=()=>{
  if(disposed)return;
  for(const t of demand){const key=tileKey(t);if(cache.has(key)||pending.has(key)||failed.has(key))continue;if(pending.size>=4)break;pending.add(key);
   void load(t.z,t.x,t.y).then(tile=>{if(disposed)return;cache.set(key,tile);const wanted=new Set(demand.map(tileKey));for(const id of cache.keys()){if(cache.size<=64)break;if(!wanted.has(id))cache.delete(id);}},()=>failed.add(key)).finally(()=>{pending.delete(key);pump();});
  }
  if(pending.size===0)publish();
 };
 return {
  controller,
  update(camera:Camera,viewport:Viewport){
   const center=cellSpace({x:viewport.width/2,y:viewport.height/2},camera),zoom=Math.max(.2,camera.zoom),ratio=camera.zoom/zoom;
   const corners=[[-viewport.width,-viewport.height],[viewport.width*2,-viewport.height],[-viewport.width,viewport.height*2],[viewport.width*2,viewport.height*2]].map(([x,y])=>cellSpace({x:viewport.width/2+(x-viewport.width/2)*ratio,y:viewport.height/2+(y-viewport.height/2)*ratio},camera));
   const minX=Math.min(...corners.map(p=>p.x)),maxX=Math.max(...corners.map(p=>p.x)),minY=Math.min(...corners.map(p=>p.y)),maxY=Math.max(...corners.map(p=>p.y)),next:{z:number;x:number;y:number}[]=[],n=2**14,side=WORLD/n;
   if(camera.zoom>=.02)for(let y=Math.max(0,Math.floor(minY/side));y<=Math.min(n-1,Math.floor(maxY/side));y++)for(let x=Math.floor(minX/side);x<=Math.floor(maxX/side);x++)next.push({z:14,x:((x%n)+n)%n,y});
   next.sort((a,b)=>Math.hypot((a.x+.5)*side-center.x,(a.y+.5)*side-center.y)-Math.hypot((b.x+.5)*side-center.x,(b.y+.5)*side-center.y));
   const limited=next.slice(0,40),key=limited.map(tileKey).join('|');if(key!==selection){selection=key;demand=limited;pump();}
   const visibleCorners=[[0,0],[viewport.width,0],[0,viewport.height],[viewport.width,viewport.height]].map(([x,y])=>cellSpace({x,y},camera));
   controller.setDemand({vehicles:140,pedestrians:80,truckShare:.08,hour:12,bounds:{minX:Math.min(...visibleCorners.map(p=>p.x)),maxX:Math.max(...visibleCorners.map(p=>p.x)),minY:Math.min(...visibleCorners.map(p=>p.y)),maxY:Math.max(...visibleCorners.map(p=>p.y))}});
  },
  retry(){failed.clear();pump();},
  dispose(){disposed=true;controller.dispose();cache.clear();},
 };
}
