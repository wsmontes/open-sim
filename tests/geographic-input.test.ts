// @vitest-environment jsdom
import {expect,test} from 'vitest';
import {attachInput} from '../src/surfaces/canvas/input';
import {centerOn} from '../src/presentation/camera';
import {geographicFocus} from '../src/presentation/geographic-map';
import {toCell} from '../src/core/coordinates';
test('a globe pinch keeps the focus stable and a globe key-pan preserves latitude',()=>{
 const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;document.body.append(canvas);
 const viewport={width:800,height:600};let camera=centerOn(toCell(49.2827,-123.1207),{x:0,y:0,zoom:.000003,rotation:Math.PI/4},viewport);
 const before=geographicFocus(camera,viewport);
 const detach=attachInput(canvas,{geographic:true,camera:()=>camera,tool:()=> 'explore'}, {onCamera:next=>{camera=next;},onHover:()=>{},onPreview:()=>{},onCommit:()=>{},onTool:()=>{},onTap:()=>{},onCancel:()=>{}});
 const finger=(type:string,id:number,x:number,y:number)=>canvas.dispatchEvent(Object.assign(new MouseEvent(type,{clientX:x,clientY:y,bubbles:true,button:0}),{pointerId:id}));
 finger('pointerdown',1,350,300);finger('pointerdown',2,450,300);
 finger('pointermove',1,300,300);finger('pointermove',2,500,300);
 expect(camera.zoom).toBeCloseTo(.000006,10);
 // Sequential finger events include a small drag; latitude must never couple to longitude.
 expect(geographicFocus(camera,viewport).lat).toBeCloseTo(before.lat,3);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 expect(geographicFocus(camera,viewport).lat).toBeCloseTo(before.lat,3);
 expect(geographicFocus(camera,viewport).lon).toBeLessThan(before.lon);
 detach();canvas.remove();
});
