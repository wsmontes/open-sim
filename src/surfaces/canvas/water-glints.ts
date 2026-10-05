import type {Viewport} from '../../presentation/camera';
import type {ScreenBounds} from './scene-compositor';
export type WaterGlint={x:number;y:number;endX:number;lineWidth:number;bounds:ScreenBounds};
export function waterGlints(viewport:Viewport,scale:number,motion:number):readonly WaterGlint[]{
 if(scale<4)return [];
 return Array.from({length:scale>=7?28:3},(_,i)=>{
  const x=scale>=7?(i*137+Math.sin(motion*.2+i)*10)%viewport.width:0,y=scale>=7?(i*83+29)%viewport.height:(.22+i*.27)*viewport.height+Math.sin(motion*.25)*scale*3*(1+i*.2),endX=scale>=7?x+10+i%4*4:viewport.width*.45,lineWidth=scale>=7?1:Math.max(1,scale*.3),margin=lineWidth/2+2;
  return {x,y,endX,lineWidth,bounds:{x:x-margin,y:y-margin,width:endX-x+margin*2,height:margin*2}};
 });
}
