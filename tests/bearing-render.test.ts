import {expect,test} from 'vitest';
import {render} from '../src/surfaces/canvas/canvas-renderer';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
test('changing bearing never rotates the drawing surface or building elevation',()=>{
 const base=blank('0:0');base.cells[0]={terrain:'land',building:'residential',stage:2};
 let rolls=0;const points:Array<[number,number]>=[];
 const ctx=new Proxy({}, {get:(_t,key)=>key==='rotate'?()=>{rolls++;}:key==='moveTo'||key==='lineTo'?(x:number,y:number)=>points.push([x,y]):()=>{},set:()=>true}) as CanvasRenderingContext2D;
 render(ctx,{camera:{x:150,y:120,zoom:1,rotation:Math.PI/3},viewport:{width:300,height:240},state:createGame('test',1,base),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0});
 expect(rolls).toBe(0);expect(points.length).toBeGreaterThan(0);
});
