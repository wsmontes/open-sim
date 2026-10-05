import {WORLD,wrapX,toGeo,toCell} from '../core/coordinates';
import type {Camera,Point,Viewport} from './camera';
import {cellSpace,TILE_W,centerOn} from './camera';

export type GeographicFeature={layer:string;kind:string;bridge:boolean;type:number;geometry:Point[][];name?:string;height?:number;sourceId?:string;oneway?:-1|0|1;level?:number;tunnel?:boolean};
export type GeographicTile={encoded?:Uint8Array;encodedRevision?:string;z:number;x:number;y:number;features:GeographicFeature[];fallback?:boolean};
export type GeographicTileId={z:number;x:number;y:number;worldX:number};
export type GeographicScene={tiles:readonly GeographicTile[];revision:number;loading:boolean;error:boolean};
export const GLOBE_ZOOM=.000014;
export const CITY_ZOOM=.035;
export const SIMULATION_ZOOM=.035;
export function geographicTiles(camera:Camera,viewport:Viewport,limits?:{zoomBias:number;maxTiles:number}):GeographicTileId[]{
 let z=Math.max(0,Math.min(14,Math.floor(Math.log2(WORLD*TILE_W*camera.zoom/384))));
 z=Math.max(0,z-Math.max(0,limits?.zoomBias??0));
 const bounds=[[0,0],[viewport.width,0],[0,viewport.height],[viewport.width,viewport.height]].map(([x,y])=>cellSpace({x,y},camera));
 let n:number,side:number,x0:number,x1:number,y0:number,y1:number;
 do{
  n=2**z;side=WORLD/n;
  x0=Math.floor(Math.min(...bounds.map(p=>p.x))/side);x1=Math.floor(Math.max(...bounds.map(p=>p.x))/side);
  y0=Math.max(0,Math.floor(Math.min(...bounds.map(p=>p.y))/side));y1=Math.min(n-1,Math.floor(Math.max(...bounds.map(p=>p.y))/side));
  if((x1-x0+1)*(y1-y0+1)<=Math.max(1,limits?.maxTiles??40)||z===0)break;
  z--;
 }while(true);
 const out:GeographicTileId[]=[];
 for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)out.push({z,x:((x%n)+n)%n,y,worldX:x});
 const c=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);
 return out.sort((a,b)=>Math.hypot((a.worldX+.5)*side-c.x,(a.y+.5)*side-c.y)-Math.hypot((b.worldX+.5)*side-c.x,(b.y+.5)*side-c.y));
}

export const tileKey=(t:{z:number;x:number;y:number})=>`${t.z}:${t.x}:${t.y}`;
export type GeoCoord={lat:number;lon:number};
const RAD=Math.PI/180;
export function globePoint(geo:GeoCoord,focus:GeoCoord,radius:number):Point&{visible:boolean;depth:number}{
 const lat=geo.lat*RAD,centre=focus.lat*RAD,delta=(geo.lon-focus.lon)*RAD;
 const depth=Math.sin(centre)*Math.sin(lat)+Math.cos(centre)*Math.cos(lat)*Math.cos(delta);
 return{x:radius*Math.cos(lat)*Math.sin(delta),y:-radius*(Math.cos(centre)*Math.sin(lat)-Math.sin(centre)*Math.cos(lat)*Math.cos(delta)),visible:depth>=0,depth};
}
export function globeCoord(point:Point,focus:GeoCoord,radius:number):GeoCoord|null{
 const x=point.x/radius,y=-point.y/radius,rho=Math.hypot(x,y);
 if(rho>1)return null;if(rho<1e-12)return{...focus};
 const c=Math.asin(rho),lat=focus.lat*RAD;
 return{lat:Math.asin(Math.cos(c)*Math.sin(lat)+y*Math.sin(c)*Math.cos(lat)/rho)/RAD,
 lon:((focus.lon+Math.atan2(x*Math.sin(c),rho*Math.cos(lat)*Math.cos(c)-y*Math.sin(lat)*Math.sin(c))/RAD+540)%360)-180};
}
export function geographicFocus(camera:Camera,viewport:Viewport):GeoCoord{const c=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);return toGeo({x:c.x,y:Math.max(0,Math.min(WORLD-1,c.y))});}
export const planetRadius=(zoom:number,viewport:Viewport)=>Math.min(viewport.width,viewport.height)*.34*(zoom/.000003)**.65;
export function dragGlobe(camera:Camera,viewport:Viewport,from:Point,to:Point):Camera{
 const focus=geographicFocus(camera,viewport),radius=planetRadius(camera.zoom,viewport);
 const lon=focus.lon-(to.x-from.x)/radius*180/Math.PI/Math.max(.25,Math.cos(focus.lat*Math.PI/180));
 const lat=Math.max(-85,Math.min(85,focus.lat+(to.y-from.y)/radius*180/Math.PI));
 return centerOn(toCell(lat,lon),camera,viewport);
}
export const nearestWorldX=(x:number,focus:number)=>wrapX(x)+Math.round((focus-wrapX(x))/WORLD)*WORLD;
export function mapScale(camera:Camera,viewport:Viewport):{label:string;metres:number;pixels:number;mode:string}{
 const focus=geographicFocus(camera,viewport),metresPerPixel=camera.zoom<GLOBE_ZOOM?6371008.8/planetRadius(camera.zoom,viewport):40075016.686*Math.cos(focus.lat*RAD)/(WORLD*TILE_W*camera.zoom);
 const wanted=100*metresPerPixel,power=10**Math.floor(Math.log10(wanted)),value=wanted/power;
 const metres=(value>=5?5:value>=2?2:1)*power;
 return{label:metres>=1000?`${metres/1000} km`:`${metres} m`,metres,pixels:metres/metresPerPixel,
 mode:camera.zoom<GLOBE_ZOOM?'Planeta':camera.zoom<.0003?'Continente':camera.zoom<.003?'Região':camera.zoom<.08?'Cidade':'Bairro'};
}

// A provisional parent contributes only the demanded child rectangle. Clip in world
// coordinates before rotation, so adjacent detail and fallback share exact edges.
export function clipGeographicTile(parent:GeographicTile,child:Pick<GeographicTileId,'z'|'x'|'y'>):GeographicTile {
 const side=WORLD/2**child.z,minX=child.x*side,minY=child.y*side,maxX=minX+side,maxY=minY+side;
 const inside=(p:Point)=>p.x>=minX&&p.x<=maxX&&p.y>=minY&&p.y<=maxY;
 const polygon=(ring:Point[])=>{
  let out=ring;
  for(const [axis,edge,sign] of [['x',minX,1],['x',maxX,-1],['y',minY,1],['y',maxY,-1]] as const){
   const input=out;out=[];
   for(let i=0;i<input.length;i++){
    const a=input[(i+input.length-1)%input.length]!,b=input[i]!,ai=(a[axis]-edge)*sign>=0,bi=(b[axis]-edge)*sign>=0;
    if(ai!==bi){const t=(edge-a[axis])/(b[axis]-a[axis]);out.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t});}
    if(bi)out.push(b);
   }
  }
  if(out.length>=3&&(out[0]!.x!==out.at(-1)!.x||out[0]!.y!==out.at(-1)!.y))out.push({...out[0]!});
  return out;
 };
 const line=(ring:Point[])=>{
  const out:Point[][]=[];
  for(let i=1;i<ring.length;i++){
   const a=ring[i-1]!,b=ring[i]!,dx=b.x-a.x,dy=b.y-a.y;let start=0,end=1,valid=true;
   for(const [p,q] of [[-dx,a.x-minX],[dx,maxX-a.x],[-dy,a.y-minY],[dy,maxY-a.y]]){
    if(p===0){if(q!<0)valid=false;continue;}
    const t=q!/p!;if(p!<0)start=Math.max(start,t);else end=Math.min(end,t);
   }
   if(!valid||start>end)continue;
   const from={x:a.x+dx*start,y:a.y+dy*start},to={x:a.x+dx*end,y:a.y+dy*end},last=out.at(-1);
   if(last&&last.at(-1)!.x===from.x&&last.at(-1)!.y===from.y)last.push(to);else out.push([from,to]);
  }
  return out;
 };
 const features=parent.features.flatMap(feature=>{
  const geometry=feature.type===3?feature.geometry.map(polygon).filter(r=>r.length>=4):feature.type===2?feature.geometry.flatMap(line):feature.geometry.map(r=>r.filter(inside)).filter(r=>r.length);
  return geometry.length?[{...feature,geometry}]:[];
 });
 return {...child,features,fallback:true};
}
