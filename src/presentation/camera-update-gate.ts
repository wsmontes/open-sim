import type {Camera,Viewport} from './camera';
export function createCameraUpdateGate(){
 let previous:readonly number[]|undefined;
 return {changed(camera:Camera,viewport:Viewport){const values=[camera.x,camera.y,camera.zoom,camera.rotation,viewport.width,viewport.height];if(previous&&values.every((v,i)=>v===previous![i]))return false;previous=values;return true;},reset(){previous=undefined;}};
}
