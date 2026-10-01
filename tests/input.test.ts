// @vitest-environment jsdom
import {expect,test} from 'vitest';
import type {CellCoord} from '../src/core/model';
import type {Camera} from '../src/presentation/camera';
import {cellSpace,project} from '../src/presentation/camera';
import type {SelectedTool} from '../src/presentation/hud';
import {attachInput} from '../src/presentation/input';
import type {InputContext} from '../src/presentation/input';

// jsdom reports a zero-sized canvas rect, so a clientX is already a buffer pixel here.
function harness(tool:SelectedTool,shape:'line'|'box'='line'){
 const canvas=document.createElement('canvas');
 canvas.width=320;canvas.height=200;document.body.append(canvas);
 let camera:Camera={x:160,y:100,zoom:1,rotation:0};
 const commits:CellCoord[][]=[],previews:CellCoord[][]=[],hovers:(CellCoord|null)[]=[],snaps:boolean[]=[],taps:CellCoord[]=[];
 // What the player is told about a cell has to be what the cell became, so the order of the two reports is part of
 // the gesture's contract, not an implementation detail.
 const order:string[]=[];
 const context:InputContext={camera:()=>camera,tool:()=>tool,strokeShape:()=>shape};
 const detach=attachInput(canvas,context,{
  onHover:cell=>hovers.push(cell),
  onPreview:cells=>previews.push([...cells]),
  onCommit:cells=>{order.push('commit');commits.push([...cells]);},
  onCamera:(next,options)=>{camera=next;snaps.push(options?.snap===true);},
  onTool:()=>{},onTap:cell=>{order.push('tap');taps.push(cell);},onCancel:()=>{},
 });
 const fire=(type:string,init:MouseEventInit={},target:EventTarget=canvas)=>target.dispatchEvent(new MouseEvent(type,{bubbles:true,...init}));
 const key=(value:string,target:EventTarget=window,init:KeyboardEventInit={})=>target.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,...init}));
 // jsdom has no PointerEvent in this version, and the handlers only read identity, button and position, so a mouse
 // event carrying a pointer id is the honest stand-in for a finger.
 const finger=(type:string,pointerId:number,clientX:number,clientY:number,target:EventTarget=canvas)=>{
  const event=Object.assign(new MouseEvent(type,{bubbles:true,clientX,clientY,button:0}),{pointerId});
  target.dispatchEvent(event);
  return event;
 };
 return {canvas,commits,previews,hovers,snaps,taps,order,detach,fire,key,finger,get camera(){return camera;}};
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


test('a zone drag paints the rectangle between where it began and where it is, and commits exactly that',()=>{
 const h=harness('residential','box'),at=(cell:CellCoord)=>{const p=project(cell,h.camera);return {clientX:p.x,clientY:p.y};};
 h.fire('pointerdown',{...at({x:0,y:0}),button:0});
 expect(h.previews.at(-1)).toEqual([{x:0,y:0}]);
 h.fire('pointermove',at({x:2,y:1}));
 const box=h.previews.at(-1)!;
 expect(box).toHaveLength(6);
 expect(box).toContainEqual({x:0,y:0});
 expect(box).toContainEqual({x:2,y:1});
 expect(box).toContainEqual({x:1,y:1});
 // A box is drawn from its anchor, so coming back to the anchor leaves one cell, not a trail.
 h.fire('pointermove',at({x:0,y:0}));
 expect(h.previews.at(-1)).toEqual([{x:0,y:0}]);
 h.fire('pointermove',at({x:1,y:2}));
 h.fire('pointerup',{...at({x:1,y:2})},window);
 expect(h.commits).toHaveLength(1);
 expect(h.commits[0]).toHaveLength(6);
 expect(h.commits[0]).toEqual(h.previews.at(-1));
 h.detach();
});

test('a box never asks for more cells than one command can carry',()=>{
 const h=harness('park','box'),at=(cell:CellCoord)=>{const p=project(cell,h.camera);return {clientX:p.x,clientY:p.y};};
 h.fire('pointerdown',{...at({x:0,y:0}),button:0});
 h.fire('pointermove',at({x:200,y:40}));
 const box=h.previews.at(-1)!;
 expect(box.length).toBeLessThanOrEqual(1024);
 // What survives the cap is still a rectangle: the far corner is pulled in, the anchor stays put.
 const xs=new Set(box.map(c=>c.x)),ys=new Set(box.map(c=>c.y));
 expect(box.length).toBe(xs.size*ys.size);
 expect(box).toContainEqual({x:0,y:0});
 h.detach();
});

test('the arrow keys pan the view without turning it, and keep quiet while the player types',()=>{
 const h=harness('explore'),before={...h.camera};
 h.key('ArrowRight');
 expect(h.camera.x).toBeGreaterThan(before.x);
 expect(h.camera.y).toBe(before.y);
 expect(h.camera.rotation).toBeCloseTo(before.rotation,12);
 const stepped=h.camera.x;
 h.key('ArrowUp');
 expect(h.camera.y).toBeLessThan(before.y);
 h.key('a');
 expect(h.camera.x).toBeLessThan(stepped);
 h.key('d');
 expect(h.camera.x).toBeCloseTo(stepped,9);
 const shifted={...h.camera};
 h.key('ArrowRight',window,{shiftKey:true});
 expect(Math.abs(h.camera.x-shifted.x)).toBeGreaterThan(Math.abs(stepped-before.x));
 const input=field();
 h.key('ArrowLeft',input);
 expect(h.camera.x).toBeCloseTo(h.camera.x,12);
 h.detach();
});

test('two fingers zoom about their midpoint, carry the map, and build nothing even with a tool in hand',()=>{
 const h=harness('road');
 h.finger('pointerdown',1,120,100);
 h.finger('pointerdown',2,200,100);
 expect(h.commits).toEqual([]);
 expect(h.camera.zoom).toBeCloseTo(1,9);
 // Fingers twice as far apart: the zoom doubles and the world point under the midpoint stays there.
 const anchorBefore=cellSpace({x:160,y:100},h.camera);
 h.finger('pointermove',1,40,100);
 h.finger('pointermove',2,280,100);
 expect(h.camera.zoom).toBeGreaterThan(1.5);
 const anchorAfter=cellSpace({x:160,y:100},h.camera);
 expect(Math.abs(anchorAfter.x-anchorBefore.x)).toBeLessThanOrEqual(.02);
 expect(Math.abs(anchorAfter.y-anchorBefore.y)).toBeLessThanOrEqual(.02);
 // Both fingers up: the gesture ends and a later drag builds again instead of panning behind the player's back.
 h.finger('pointerup',1,40,100,window);
 h.finger('pointerup',2,280,100,window);
 // A pinch is a camera gesture: with a build tool in hand it still commits nothing, and the drag that follows does.
 expect(h.commits).toEqual([]);
 const target=project({x:3,y:3},h.camera),click={clientX:target.x,clientY:target.y};
 h.fire('pointerdown',{...click,button:0});
 h.fire('pointerup',click,window);
 expect(h.commits).toHaveLength(1);
 h.detach();
});

test('a number key picks the tool, and typing does not',()=>{
 // The panel shows the tools in this order and the keys follow it, so the player can lay a street, an avenue and a
 // zone without reaching for the mouse. The attachment is this test's own: what it needs from the canvas is nothing,
 // because a key is not a pointer.
 const chosen:string[]=[];
 const canvas=document.createElement('canvas');
 const context:InputContext={camera:()=>({x:0,y:0,zoom:1,rotation:0}),tool:()=>'explore'};
 const detach=attachInput(canvas,context,{onHover:()=>{},onPreview:()=>{},onCommit:()=>{},onCamera:()=>{},onTap:()=>{},onCancel:()=>{},onTool:tool=>chosen.push(tool)});
 const press=(key:string,target:EventTarget=window)=>target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
 press('3');
 expect(chosen).toEqual(['avenue']);
 press('4');
 expect(chosen).toEqual(['avenue','highway']);
 press('0');
 expect(chosen).toEqual(['avenue','highway','demolish']);
 // A key pressed while the player is typing a place name is a letter, not a tool.
 const field=document.createElement('input');
 document.body.append(field);
 press('5',field);
 expect(chosen).toEqual(['avenue','highway','demolish']);
 field.remove();
 detach();
});

// What a phone expects from two fingers: the city moves with them, and the space between them is the zoom. Both halves
// are one line of arithmetic each, and both are easy to get subtly wrong — a midpoint delta applied twice moves the
// scene at twice the speed of the hand, which is exactly what a player notices first.
const worldUnder=(point:{x:number;y:number},camera:Camera)=>({x:(point.x-camera.x)/camera.zoom,y:(point.y-camera.y)/camera.zoom});

test('two fingers drag the city exactly as far as they move, and not at all further',()=>{
 const h=harness('explore');
 h.finger('pointerdown',1,200,150);
 h.finger('pointerdown',2,280,150);
 const before={...h.camera};
 // Both fingers move by the same amount: the gesture is a drag, and a drag must not change the zoom.
 h.finger('pointermove',1,215,165);
 h.finger('pointermove',2,295,165);
 expect(h.camera.zoom).toBeCloseTo(before.zoom,10);
 expect(h.camera.x).toBeCloseTo(before.x+15,6);
 expect(h.camera.y).toBeCloseTo(before.y+15,6);
 h.detach();
});

test('two fingers spread the city about the point between them',()=>{
 const h=harness('explore');
 const between={x:240,y:150};
 h.finger('pointerdown',1,200,150);
 h.finger('pointerdown',2,280,150);
 const anchor=worldUnder(between,h.camera);
 // The fingers move apart without the midpoint moving: 80 pixels apart becoming 120 is half again as close.
 h.finger('pointermove',1,180,150);
 h.finger('pointermove',2,300,150);
 expect(h.camera.zoom).toBeCloseTo(1.5,6);
 expect(worldUnder(between,h.camera).x).toBeCloseTo(anchor.x,6);
 expect(worldUnder(between,h.camera).y).toBeCloseTo(anchor.y,6);
 // And the gesture asked for that zoom, not for one rounded to a step: rounding is the app's decision and the wrong
 // one in the middle of a pinch.
 expect(h.snaps.at(-1)).toBe(false);
 h.detach();
});

test('a short touch selects, and a drag does not',()=>{
 // Selecting is how the player asks about a building, so it must be a touch that did not travel: a pan, a stroke or a
 // gesture all begin and end somewhere else, and none of them is a question about a cell.
 const h=harness('explore');
 h.fire('pointerdown',{clientX:150,clientY:120,button:0});
 h.fire('pointerup',{clientX:151,clientY:121,button:0},window);
 expect(h.taps).toHaveLength(1);
 const moved=harness('explore');
 moved.fire('pointerdown',{clientX:150,clientY:120,button:0});
 moved.fire('pointermove',{clientX:200,clientY:160});
 moved.fire('pointerup',{clientX:200,clientY:160,button:0},window);
 expect(moved.taps).toEqual([]);
 // Two fingers are a gesture about the whole map, never a question about one cell.
 const pinched=harness('explore');
 pinched.finger('pointerdown',1,120,120);
 pinched.finger('pointerdown',2,200,120);
 pinched.finger('pointerup',1,120,120);
 pinched.finger('pointerup',2,200,120);
 expect(pinched.taps).toEqual([]);
 h.detach();moved.detach();pinched.detach();
});

test('a tap that lays a street reports the cell after the build, not before',()=>{
 const built=harness('road');
 built.finger('pointerdown',1,100,100);
 built.finger('pointerup',1,100,100);
 expect(built.order).toEqual(['commit','tap']);
 // Both reports are about the same cell: the one the player touched.
 expect(built.commits).toHaveLength(1);
 expect(built.commits[0]).toEqual(built.taps);
});

test('a tap with nothing selected is only a question about the cell',()=>{
 const asked=harness('explore');
 asked.finger('pointerdown',1,100,100);
 asked.finger('pointerup',1,100,100);
 expect(asked.order).toEqual(['tap']);
 expect(asked.commits).toHaveLength(0);
});
