// @vitest-environment jsdom
import {expect,test} from 'vitest';
import type {CellCoord} from '../src/core/model';
import type {Camera} from '../src/presentation/camera';
import {cellSpace,project} from '../src/presentation/camera';
import type {SelectedTool} from '../src/presentation/hud';
import {attachInput} from '../src/presentation/input';
import type {InputContext} from '../src/presentation/input';

// jsdom reports a zero-sized canvas rect, so a clientX is already a buffer pixel here.
function harness(tool:SelectedTool){
 const canvas=document.createElement('canvas');
 canvas.width=320;canvas.height=200;document.body.append(canvas);
 let camera:Camera={x:160,y:100,zoom:1,rotation:0};
 const commits:CellCoord[][]=[],previews:CellCoord[][]=[],hovers:(CellCoord|null)[]=[];
 const context:InputContext={camera:()=>camera,tool:()=>tool};
 const detach=attachInput(canvas,context,{
  onHover:cell=>hovers.push(cell),
  onPreview:cells=>previews.push([...cells]),
  onCommit:cells=>commits.push([...cells]),
  onCamera:next=>{camera=next;},
  onCancel:()=>{},
 });
 const fire=(type:string,init:MouseEventInit={},target:EventTarget=canvas)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,...init}));
 const key=(value:string,target:EventTarget=window)=>target.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true}));
 return {canvas,commits,previews,hovers,detach,fire,key,get camera(){return camera;}};
}
const field=()=>{const input=document.createElement('input');document.body.append(input);return input;};
// A camera that neither moved nor turned: -0 must not be mistaken for a pan.
const staysHome=(camera:Camera)=>{
 expect(camera.x).toBe(160);expect(camera.y).toBe(100);expect(camera.zoom).toBe(1);expect(camera.rotation).toBeCloseTo(0,12);
};

test('a left drag in explore pans the map and never previews or commits',()=>{
 const h=harness('explore');
 h.fire('pointerdown',{clientX:100,clientY:100,button:0});
 h.fire('pointermove',{clientX:130,clientY:90});
 h.fire('pointerup',{clientX:130,clientY:90,button:0},window);
 expect(h.camera.x).toBe(190);
 expect(h.camera.y).toBe(90);
 staysHome({...h.camera,x:160,y:100});
 expect(h.commits).toEqual([]);
 expect(h.previews).toEqual([]);
 h.detach();
});

test('a build tool turns the drag into the very stroke it previewed, released outside included',()=>{
 const h=harness('road'),at=(cell:CellCoord)=>{const p=project(cell,h.camera);return {clientX:p.x,clientY:p.y};};
 h.fire('pointerdown',{...at({x:0,y:0}),button:0});
 expect(h.previews.at(-1)).toEqual([{x:0,y:0}]);
 h.fire('pointermove',at({x:1,y:0}));
 h.fire('pointermove',at({x:3,y:0}));
 expect(h.hovers.at(-1)).toEqual({x:3,y:0});
 h.fire('pointerup',at({x:9,y:9}),window);
 expect(h.commits).toHaveLength(1);
 expect(h.commits[0]).toEqual([{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]);
 expect(h.commits[0]).toEqual(h.previews.at(-1));
 staysHome(h.camera);
 h.detach();
});

test('a click without a drag commits a single cell under any tool',()=>{
 const h=harness('demolish'),p=project({x:2,y:1},h.camera);
 h.fire('pointerdown',{clientX:p.x,clientY:p.y,button:0});
 h.fire('pointerup',{clientX:p.x,clientY:p.y},window);
 expect(h.commits).toEqual([[{x:2,y:1}]]);
 staysHome(h.camera);
 h.detach();
});

test('middle and right drags pan in any tool, keep the angle and build nothing',()=>{
 const h=harness('residential');
 for(const button of [1,2]){
  const before={...h.camera};
  h.fire('pointerdown',{clientX:100,clientY:100,button});
  h.fire('pointermove',{clientX:120,clientY:95});
  h.fire('pointerup',{clientX:120,clientY:95,button},window);
  expect(h.camera.x).toBe(before.x+20);
  expect(h.camera.y).toBe(before.y-5);
  expect(h.camera.rotation).toBeCloseTo(before.rotation,12);
 }
 const menu=new MouseEvent('contextmenu',{bubbles:true,cancelable:true});
 h.canvas.dispatchEvent(menu);
 expect(menu.defaultPrevented).toBe(true);
 expect(h.commits).toEqual([]);
 expect(h.previews).toEqual([]);
 h.detach();
});

test('Ctrl or Command plus a horizontal drag turns the view about the screen centre',()=>{
 const h=harness('explore'),centre={x:160,y:100},before=cellSpace(centre,h.camera);
 for(const modifier of [{ctrlKey:true},{metaKey:true}]){
  h.fire('pointerdown',{clientX:100,clientY:100,button:0,...modifier});
  h.fire('pointermove',{clientX:100,clientY:160}); // vertical travel is not a turn
  expect(h.camera.rotation).toBeCloseTo(0,12);
  h.fire('pointermove',{clientX:140,clientY:100});
  h.fire('pointerup',{clientX:140,clientY:100},window);
  expect(h.camera.rotation).toBeCloseTo(Math.PI/9,9); // 40px at half a degree each
  h.fire('pointerdown',{clientX:100,clientY:100,button:0,...modifier});
  h.fire('pointermove',{clientX:60,clientY:100});
  h.fire('pointerup',{clientX:60,clientY:100},window);
  expect(h.camera.rotation).toBeCloseTo(0,9);
 }
 const after=cellSpace(centre,h.camera);
 expect(Math.abs(after.x-before.x)).toBeLessThanOrEqual(.01);
 expect(Math.abs(after.y-before.y)).toBeLessThanOrEqual(.01);
 expect(h.commits).toEqual([]);
 h.detach();
});

test('Q and E turn fifteen degrees a press, stay normalised, and do nothing while typing',()=>{
 const h=harness('explore'),centre={x:160,y:100},before=cellSpace(centre,h.camera);
 h.key('e');
 expect(h.camera.rotation).toBeCloseTo(Math.PI/12,9);
 h.key('q');
 expect(h.camera.rotation).toBeCloseTo(0,9);
 for(let press=0;press<24;press++)h.key('e'); // a whole turn comes back to north instead of growing past PI
 expect(Math.abs(h.camera.rotation)).toBeLessThanOrEqual(Math.PI);
 expect(h.camera.rotation).toBeCloseTo(0,9);
 for(let press=0;press<6;press++)h.key('q');
 expect(h.camera.rotation).toBeCloseTo(-Math.PI/2,9);
 expect(Math.abs(h.camera.rotation)).toBeLessThanOrEqual(Math.PI);
 const after=cellSpace(centre,h.camera);
 expect(Math.abs(after.x-before.x)).toBeLessThanOrEqual(.01);
 expect(Math.abs(after.y-before.y)).toBeLessThanOrEqual(.01);
 const input=field();
 h.key('e',input);
 h.key('q',input);
 expect(h.camera.rotation).toBeCloseTo(-Math.PI/2,9);
 h.detach();
});

test('a space typed in a field never arms the drag the player is not making',()=>{
 const h=harness('road'),input=field(),p=project({x:2,y:2},h.camera);
 h.key(' ',input);
 h.fire('pointerdown',{clientX:p.x,clientY:p.y,button:0});
 h.fire('pointermove',{clientX:p.x+40,clientY:p.y+40});
 h.fire('pointerup',{clientX:p.x+40,clientY:p.y+40},window);
 staysHome(h.camera);
 expect(h.commits).toHaveLength(1);
 h.key(' '); // on the page body space still pans, even with a tool selected
 h.fire('pointerdown',{clientX:p.x,clientY:p.y,button:0});
 h.fire('pointermove',{clientX:p.x-20,clientY:p.y});
 window.dispatchEvent(new KeyboardEvent('keyup',{key:' '}));
 h.fire('pointerup',{clientX:p.x-20,clientY:p.y},window);
 expect(h.camera.x).toBe(140);
 expect(h.camera.y).toBe(100);
 expect(h.commits).toHaveLength(1);
 h.detach();
});
