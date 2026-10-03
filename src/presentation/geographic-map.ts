import {WORLD,wrapX,toGeo,toCell} from '../core/coordinates';
import type {Camera,Point,Viewport} from './camera';
import {cellSpace,TILE_W,centerOn} from './camera';

export type GeographicFeature={layer:string;kind:string;bridge:boolean;type:number;geometry:Point[][];name?:string;height?:number;sourceId?:string;oneway?:-1|0|1;level?:number;tunnel?:boolean};
export type GeographicTile={z:number;x:number;y:number;features:GeographicFeature[]};
export type GeographicTileId={z:number;x:number;y:number;worldX:number};
export type GeographicScene={tiles:readonly GeographicTile[];revision:number;loading:boolean;error:boolean};
export const GLOBE_ZOOM=.000014;
export const CITY_ZOOM=.035;
export const SIMULATION_ZOOM=.035;
export function geographicTiles(camera:Camera,viewport:Viewport):GeographicTileId[]{
 let z=Math.max(0,Math.min(14,Math.floor(Math.log2(WORLD*TILE_W*camera.zoom/384))));
 const bounds=[[0,0],[viewport.width,0],[0,viewport.height],[viewport.width,viewport.height]].map(([x,y])=>cellSpace({x,y},camera));
 let n:number,side:number,x0:number,x1:number,y0:number,y1:number;
 do{
  n=2**z;side=WORLD/n;
  x0=Math.floor(Math.min(...bounds.map(p=>p.x))/side);x1=Math.floor(Math.max(...bounds.map(p=>p.x))/side);
  y0=Math.max(0,Math.floor(Math.min(...bounds.map(p=>p.y))/side));y1=Math.min(n-1,Math.floor(Math.max(...bounds.map(p=>p.y))/side));
  if((x1-x0+1)*(y1-y0+1)<=40||z===0)break;
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
