import {expect,test} from 'vitest';
import {project,cellSpace,centerOn,rotateTo,zoomTo} from '../src/presentation/camera';
import {cameraFor,viewpointOf} from '../src/presentation/viewpoint';
for(const rotation of [0,Math.PI/2,-Math.PI/2,Math.PI])for(const zoom of [.05,1,3]){
 test(`ground bearing preserves inclination and inverse ${rotation}/${zoom}`,()=>{
  const camera={x:80,y:90,zoom,rotation},p={x:12.25,y:8.75};
  const q=project(p,camera),back=cellSpace(q,camera);
  expect(back.x).toBeCloseTo(p.x,9);expect(back.y).toBeCloseTo(p.y,9);
  const dx=project({x:1,y:0},camera),dy=project({x:0,y:1},camera);
  const a={x:dx.x-camera.x,y:(dx.y-camera.y)*2},b={x:dy.x-camera.x,y:(dy.y-camera.y)*2};
  expect(a.x*b.x+a.y*b.y).toBeCloseTo(0,8);
 });
}
test('continuous centre survives changing viewport and zoom',()=>{
 const first={width:390,height:844},next={width:844,height:390};
 const camera=centerOn({x:100.25,y:220.75},{x:0,y:0,zoom:.6,rotation:1},first);
 const view=viewpointOf(camera,first),resized=cameraFor(view,next);
 expect(viewpointOf(resized,next).center.x).toBeCloseTo(100.25,8);
 expect(viewpointOf(rotateTo(zoomTo(resized,next,2),next,-1),next).center.y).toBeCloseTo(220.75,8);
});
