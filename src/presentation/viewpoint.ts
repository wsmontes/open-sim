import type {Camera,Point,Viewport} from './camera';
import {cellSpace,centerOn} from './camera';
export type Viewpoint={center:Point;zoom:number;rotation:number};
export const viewpointOf=(camera:Camera,viewport:Viewport):Viewpoint=>({center:cellSpace({x:viewport.width/2,y:viewport.height/2},camera),zoom:camera.zoom,rotation:camera.rotation});
export const cameraFor=(view:Viewpoint,viewport:Viewport):Camera=>centerOn(view.center,{x:0,y:0,zoom:view.zoom,rotation:view.rotation},viewport);
