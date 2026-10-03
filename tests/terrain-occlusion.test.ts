import {it,expect} from 'vitest';
import {createTerrainDepthBuffer} from '../src/presentation/terrain-occlusion';
it('a nearer slope hides the road behind it',()=>{
 const buffer=createTerrainDepthBuffer(100,100,[{points:[{x:0,y:0},{x:100,y:0},{x:0,y:100}],depths:[10,10,10]}]);
 expect(buffer.visible({x:20,y:20},2)).toBe(false);expect(buffer.visible({x:20,y:20},11)).toBe(true);
 expect(buffer.visible({x:90,y:90},0)).toBe(true);
});
it('overlapping triangles keep the nearest depth regardless of order',()=>{
 const a={points:[{x:0,y:0},{x:100,y:0},{x:0,y:100}] as const,depths:[1,1,1] as const},b={...a,depths:[8,8,8] as const};
 for(const order of [[a,b],[b,a]])expect(createTerrainDepthBuffer(100,100,order).visible({x:30,y:30},5)).toBe(false);
});
it('interpolates depth across a sloped triangle',()=>{
 const buffer=createTerrainDepthBuffer(100,100,[{points:[{x:0,y:0},{x:100,y:0},{x:0,y:100}],depths:[0,100,0]}],1);
 expect(buffer.visible({x:50,y:20},49)).toBe(false);expect(buffer.visible({x:50,y:20},52)).toBe(true);
});
