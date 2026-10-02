// @vitest-environment jsdom
import {expect,test,vi} from 'vitest';
import {COARSE_STEP,MAX_ZOOM,MIN_ZOOM,TILE_H,TILE_W,approach,arrived,cellSpace,normalizeAngle,settleZoom,snapZoom,zoomLadder,centerOn,clampZoom,closestChunks,isCoarse,pick,project,visibleChunks,zoomTo} from '../src/presentation/camera';
import {aggregateCells} from '../src/surfaces/canvas/canvas-renderer';
import {createTickClock} from '../src/presentation/clock';
import {attachInput,beginStroke,extendStroke,strokeCells} from '../src/surfaces/canvas/input';
import {quoteAction} from '../src/core/quote';
import {applyCommand,createGame} from '../src/core/commands';
import {chunkId,chunkOrigin,validCell,wrapX} from '../src/core/coordinates';
import type {Action,BaseChunk,CellCoord,Command,GameState} from '../src/core/model';
import {blank} from './fixtures/world';

test('project and pick are exact inverses at every zoom, antimeridian included',()=>{
 for(const zoom of [0.5,1,3])for(const base of [{x:0,y:0,zoom,rotation:0},{x:137.5,y:-42.25,zoom,rotation:0},{x:-768,y:96,zoom,rotation:0}])
  for(const cell of [{x:0,y:0},{x:4194303,y:5},{x:0,y:5},{x:123456,y:654321},{x:-1,y:7}])
   expect(pick(project(cell,base),base)).toEqual(cell);
});
test('the half diamond boundary picks the eastern neighbour',()=>{
 for(const zoom of [0.5,1,3]){
  const camera={x:100,y:50,zoom,rotation:0},cell={x:9,y:4},p=project(cell,camera),step={x:TILE_W*zoom,y:TILE_H*zoom};
  expect(pick({x:p.x+step.x*.49,y:p.y+step.y*.49},camera)).toEqual(cell);
  expect(pick({x:p.x+step.x*.5,y:p.y+step.y*.5},camera)).toEqual({x:cell.x+1,y:cell.y});
  expect(pick({x:p.x+step.x*.51,y:p.y+step.y*.51},camera)).toEqual({x:cell.x+1,y:cell.y});
  expect(pick({x:p.x-step.x*1.01,y:p.y},camera)).toEqual({x:cell.x-1,y:cell.y+1});
 }
});
test('clampZoom saturates at the documented limits',()=>{
 expect(clampZoom(0.001)).toBe(MIN_ZOOM);expect(clampZoom(9)).toBe(MAX_ZOOM);expect(clampZoom(1.5)).toBe(1.5);
});
test('centerOn keeps the cell on the viewport centre and preserves zoom',()=>{
 for(const zoom of [0.5,1,3])for(const viewport of [{width:321,height:197},{width:800,height:600}]){
  const camera=centerOn({x:4194303,y:5},{x:10,y:20,zoom,rotation:0},viewport),p=project({x:4194303,y:5},camera);
  expect(Math.abs(p.x-viewport.width/2)).toBeLessThanOrEqual(1);expect(Math.abs(p.y-viewport.height/2)).toBeLessThanOrEqual(1);expect(camera.zoom).toBe(zoom);
 }
});
test('visibleChunks covers the viewport with ordered, wrapped, deduplicated ids',()=>{
 const viewport={width:320,height:200},at=(cell:CellCoord,zoom:number)=>centerOn(cell,{x:0,y:0,zoom,rotation:0},viewport);
 for(const camera of [at({x:1000,y:1000},1),at({x:0,y:1000},.5),at({x:-20,y:1000},2),at({x:2**22-1,y:1000},3)]){
  const ids=visibleChunks(camera,viewport);
  expect(ids).toEqual([...ids].sort());expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeGreaterThan(0);
  for(const id of ids)expect(()=>chunkOrigin(id),id).not.toThrow();
  const covered=new Set(ids);
  for(let py=0;py<viewport.height;py+=5)for(let px=0;px<viewport.width;px+=5){
   const cell=pick({x:px,y:py},camera),wrapped={x:wrapX(cell.x),y:cell.y};
   if(!validCell(wrapped))continue;
   expect(covered.has(chunkId(cell)),`${px},${py} ${chunkId(cell)}`).toBe(true);
  }
 }
});
test('visibleChunks wraps cells across the antimeridian into real chunk ids',()=>{
 const viewport={width:320,height:200},west=centerOn({x:-20,y:1000},{x:0,y:0,zoom:2,rotation:0},viewport),east=centerOn({x:2**22+20,y:1000},{x:0,y:0,zoom:2,rotation:0},viewport);
 const ids=visibleChunks(west,viewport);
 expect(ids).toContain(chunkId({x:-20,y:1000}));expect(ids.some(id=>id.includes('-'))).toBe(false);
 for(const id of ids)expect(()=>chunkOrigin(id),id).not.toThrow();
 expect(visibleChunks(east,viewport)).toContain(chunkId({x:2**22+20,y:1000}));
});
test('strokeCells walks Bresenham order, deduplicates and caps the batch',()=>{
 expect(strokeCells({x:0,y:0},{x:3,y:0})).toEqual([{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}]);
 expect(strokeCells({x:2,y:2},{x:2,y:2})).toEqual([{x:2,y:2}]);
 expect(strokeCells({x:0,y:0},{x:3,y:3})).toEqual([{x:0,y:0},{x:1,y:1},{x:2,y:2},{x:3,y:3}]);
 const long=strokeCells({x:0,y:0},{x:4000,y:0});
 expect(long).toHaveLength(1024);expect(long[0]).toEqual({x:0,y:0});expect(long.at(-1)).toEqual({x:1023,y:0});
 const stroke=extendStroke(extendStroke(beginStroke({x:0,y:0}),{x:2,y:0}),{x:1,y:0});
 expect(stroke.cells).toEqual([{x:0,y:0},{x:1,y:0},{x:2,y:0}]);
 expect(extendStroke(stroke,{x:2,y:0}).cells).toEqual(stroke.cells);
});
test('a paused clock never ticks and hidden tabs do not burst on return',()=>{
 vi.useFakeTimers();
 const ticks=vi.fn(),clock=createTickClock(ticks);
 vi.advanceTimersByTime(5000);expect(ticks).not.toHaveBeenCalled();
 clock.setSpeed(1);vi.advanceTimersByTime(3000);expect(ticks).toHaveBeenCalledTimes(3);expect(clock.level()).toBe(1);
 clock.setSpeed(2);vi.advanceTimersByTime(1000);expect(ticks).toHaveBeenCalledTimes(5);
 clock.setSpeed(2);vi.advanceTimersByTime(2000);expect(ticks).toHaveBeenCalledTimes(9);
 clock.setHidden(true);vi.advanceTimersByTime(10000);expect(ticks).toHaveBeenCalledTimes(9);
 clock.setHidden(false);vi.advanceTimersByTime(1000);expect(ticks).toHaveBeenCalledTimes(11);
 clock.setSpeed(0);vi.advanceTimersByTime(5000);expect(ticks).toHaveBeenCalledTimes(11);
 clock.stop();clock.setSpeed(1);clock.setHidden(false);vi.advanceTimersByTime(5000);expect(ticks).toHaveBeenCalledTimes(11);
 vi.useRealTimers();
});
test('setSpeed with the current value does not restart the interval',()=>{
 vi.useFakeTimers();
 const ticks=vi.fn(),clock=createTickClock(ticks);
 clock.setSpeed(1);vi.advanceTimersByTime(400);clock.setSpeed(1);
 vi.advanceTimersByTime(600);expect(ticks).toHaveBeenCalledTimes(1);
 clock.stop();vi.useRealTimers();
});
test('dragging previews and commits the very same stroke, even released outside',()=>{
 const canvas=document.createElement('canvas');
 canvas.width=320;canvas.height=200;document.body.append(canvas);
 let camera={x:160,y:100,zoom:1,rotation:0};
 const previews:CellCoord[][]=[],commits:CellCoord[][]=[],hovers:(CellCoord|null)[]=[],cancels:number[]=[],detach=attachInput(canvas,{camera:()=>camera,tool:()=>'road' as const},{
  onHover:c=>hovers.push(c),onPreview:c=>previews.push([...c]),onCommit:c=>commits.push([...c]),onCamera:c=>{camera=c;},onTool:vi.fn(),onTap:()=>{},onCancel:()=>cancels.push(cancels.length+1),
 });
 const fire=(type:string,cell:CellCoord,target:EventTarget=canvas)=>{const p=project(cell,camera);target.dispatchEvent(new MouseEvent(type,{clientX:p.x,clientY:p.y,button:0,bubbles:true}));};
 fire('pointerdown',{x:0,y:0});
 fire('pointermove',{x:1,y:0});
 fire('pointermove',{x:3,y:0});
 fire('pointerup',{x:9,y:9},window);
 expect(commits).toHaveLength(1);
 expect(commits[0]).toEqual(strokeCells({x:0,y:0},{x:3,y:0}));
 expect(commits[0]).toEqual(previews.at(-1));
 expect(previews.at(-1)).toHaveLength(4);
 expect(hovers.at(-1)).toEqual({x:3,y:0});
 fire('pointermove',{x:1,y:1});
 expect(commits).toHaveLength(1);
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
 expect(cancels).toHaveLength(1);
 fire('pointerdown',{x:0,y:0});
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
 expect(previews.at(-1)).toEqual([]);
 expect(cancels).toHaveLength(2);
 fire('pointermove',{x:1,y:1});
 expect(previews.at(-1)).toEqual([]);
 expect(commits).toHaveLength(1);
 detach();
 fire('pointerdown',{x:1,y:1});fire('pointermove',{x:2,y:2});
 expect(previews).toHaveLength(5);
 expect(cancels).toHaveLength(2);
});
test('wheel zooms anchored on the pointer and space drag pans the camera',()=>{
 const canvas=document.createElement('canvas');
 canvas.width=320;canvas.height=200;document.body.append(canvas);
 let camera={x:160,y:100,zoom:1,rotation:0};
 const detach=attachInput(canvas,{camera:()=>camera,tool:()=>'road' as const},{onHover:()=>{},onPreview:()=>{},onCommit:()=>{},onCamera:c=>{camera=c;},onTool:vi.fn(),onTap:()=>{},onCancel:()=>{}});
 const pointer={x:160,y:100},before=pick(pointer,camera);
 canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:-240,clientX:pointer.x,clientY:pointer.y,bubbles:true,cancelable:true}));
 expect(camera.zoom).toBeGreaterThan(1);expect(pick(pointer,camera)).toEqual(before);
 canvas.dispatchEvent(new WheelEvent('wheel',{deltaY:99999,clientX:pointer.x,clientY:pointer.y,bubbles:true,cancelable:true}));
 expect(camera.zoom).toBe(MIN_ZOOM);
 const beforePan={...camera};
 window.dispatchEvent(new KeyboardEvent('keydown',{key:' '}));
 canvas.dispatchEvent(new MouseEvent('pointerdown',{clientX:100,clientY:100,button:0,bubbles:true}));
 canvas.dispatchEvent(new MouseEvent('pointermove',{clientX:130,clientY:90,bubbles:true}));
 window.dispatchEvent(new KeyboardEvent('keyup',{key:' '}));
 window.dispatchEvent(new MouseEvent('pointerup',{clientX:130,clientY:90,button:0,bubbles:true}));
 expect(camera.x).toBeCloseTo(beforePan.x+30,6);expect(camera.y).toBeCloseTo(beforePan.y-10,6);expect(camera.zoom).toBe(MIN_ZOOM);
 detach();
});
test('quoteAction matches applyCommand costs and rejections case by case',()=>{
 const base=blank();
 base.cells[0]={terrain:'water'};base.cells[33]={terrain:'land',road:true};base.cells[34]={terrain:'land',building:'residential',stage:1,origin:'imported'};
 const state=createGame('w',1,base),loaded={...base,id:'1:0'};
 const cases:[string,GameState,Action,BaseChunk[],'ok'|'blocked',number][]=[
  ['new road',state,{type:'build',tool:'road',cells:[{x:1,y:0}]},[],'ok',10],
  ['road over an existing road is free',state,{type:'build',tool:'road',cells:[{x:1,y:1}]},[],'ok',0],
  ['road over water is refused',state,{type:'build',tool:'road',cells:[{x:0,y:0}]},[],'blocked',0],
  ['water refuses incompatible tools',state,{type:'build',tool:'residential',cells:[{x:0,y:0}]},[],'blocked',0],
  ['occupied cell is refused',state,{type:'build',tool:'residential',cells:[{x:2,y:1}]},[],'blocked',0],
  ['road does not pass through a building',state,{type:'build',tool:'park',cells:[{x:2,y:1}]},[],'blocked',0],
  ['unloaded chunk blocks',state,{type:'build',tool:'road',cells:[{x:40,y:1}]},[],'blocked',0],
  ['available chunk is adopted',state,{type:'build',tool:'road',cells:[{x:40,y:1}]},[loaded],'ok',10],
  ['insufficient money blocks',{...state,money:5},{type:'build',tool:'residential',cells:[{x:3,y:3}]},[],'blocked',40],
  ['demolition costs one fee',state,{type:'demolish',cells:[{x:2,y:1}]},[],'ok',5],
  ['empty demolition is free',state,{type:'demolish',cells:[{x:3,y:3}]},[],'ok',0],
  ['mixed batch with duplicates charges once',state,{type:'build',tool:'road',cells:[{x:1,y:0},{x:1,y:0},{x:3,y:3}]},[],'ok',20],
  ['tick is free',state,{type:'tick'},[],'ok',0],
 ];
 for(const [name,before,action,available,status,cost] of cases){
  const quote=quoteAction(before,action,available),command:Command={version:1,worldId:before.worldId,actorId:'local-player',sequence:(before.actors['local-player']??0)+1,expectedRevision:before.revision,action};
  const result=applyCommand(before,command,available);
  expect(quote.status,name).toBe(status);expect(quote.cost,name).toBe(cost);
  if(quote.status==='ok'){expect(result.status,name).toBe('applied');expect(before.money-result.state.money,name).toBe(quote.cost);}
  else{expect(result.status,name).toBe('rejected');expect(quote.reason,name).toBeTruthy();}
 }
});
test('wide zoom fits a city and its surroundings and only the nearest regions are fetched',()=>{
 expect(MIN_ZOOM).toBeLessThanOrEqual(0.1);
 const viewport={width:1200,height:800},cell={x:100000,y:100000},camera=centerOn(cell,{x:0,y:0,zoom:MIN_ZOOM,rotation:0},viewport);
 const ids=visibleChunks(camera,viewport);
 expect(ids.length).toBeGreaterThan(60);
 for(const id of ids)expect(()=>chunkOrigin(id),id).not.toThrow();
 expect(ids).toContain(chunkId(cell));
 expect(ids).toEqual([...new Set(ids)]);
 const budget=closestChunks(ids,camera,viewport,12);
 expect(budget).toHaveLength(12);
 expect(new Set(budget).size).toBe(12);
 expect(budget).toEqual(closestChunks(ids,camera,viewport,12));
 expect(budget).toContain(chunkId(cell));
 const centre=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);
 const distance=(id:string)=>{const origin=chunkOrigin(id);return Math.max(Math.abs(origin.x+16-centre.x),Math.abs(origin.y+16-centre.y));};
 expect(Math.max(...budget.map(distance))).toBeLessThanOrEqual(Math.min(...ids.filter(id=>!budget.includes(id)).map(distance)));
 expect(closestChunks(ids,camera,viewport,0)).toEqual([]);
});
test('changing the zoom keeps the same world cell under the viewport centre',()=>{
 const viewport={width:900,height:600},camera=centerOn({x:42000,y:31000},{x:0,y:0,zoom:2,rotation:0},viewport);
 for(const zoom of [MIN_ZOOM,0.25,1,MAX_ZOOM,99]){
  const widened=zoomTo(camera,viewport,zoom),centre=cellSpace({x:viewport.width/2,y:viewport.height/2},widened);
  expect(widened.zoom).toBe(clampZoom(zoom));
  expect(Math.abs(centre.x-42000)).toBeLessThanOrEqual(0.01);
  expect(Math.abs(centre.y-31000)).toBeLessThanOrEqual(0.01);
 }
});
test('the renderer switches to region blocks only when a cell is too small to draw',()=>{
 expect(isCoarse({x:0,y:0,zoom:MIN_ZOOM,rotation:0})).toBe(true);
 expect(isCoarse({x:0,y:0,zoom:COARSE_STEP/TILE_W,rotation:0})).toBe(false);
 expect(isCoarse({x:0,y:0,zoom:0.5,rotation:0})).toBe(false);
 expect(isCoarse({x:0,y:0,zoom:MAX_ZOOM,rotation:0})).toBe(false);
});
test('region blocks summarise what dominates them and follow player edits',()=>{
 const water=blank();for(let y=0;y<4;y++)for(let x=0;x<4;x++)water.cells[y*32+x]={terrain:'water'};
 const roads=blank();for(let y=0;y<4;y++)for(let x=0;x<4;x++)roads.cells[y*32+x]={terrain:'land',road:true};
 const homes=blank();for(let y=0;y<4;y++)for(let x=0;x<4;x++)homes.cells[y*32+x]={terrain:'land',building:'residential',stage:1};
 const blocks=aggregateCells(blank().cells);
 expect(blocks).toHaveLength(64);
 for(const colour of blocks)expect(colour).toMatch(/^#[0-9a-f]{6}$/);
 expect(aggregateCells(water.cells)[0]).toBe('#3e80c4');
 expect(aggregateCells(roads.cells)[0]).toBe('#8b9199');
 expect(aggregateCells(homes.cells)[0]).toBe('#cf5c3c');
 expect(aggregateCells(water.cells)).toEqual(aggregateCells(water.cells));
 const edited=blank();edited.cells[0]={terrain:'water'};
 expect(aggregateCells(edited.cells)[0]).not.toBe(blocks[0]);
 expect(aggregateCells(edited.cells).slice(1)).toEqual(blocks.slice(1));
});

test('a camera move closes the distance, turns the short way, and never overshoots',()=>{
 // What the player sees when they press a button: the map slides into place instead of jumping. The properties that
 // make that pleasant are also the ones a naive lerp gets wrong — rotation across the seam, and passing the target.
 const from={x:0,y:0,zoom:1,rotation:3.0};
 // Just across the +-pi seam, so the short way is a few hundredths of a radian and not most of a circle.
 const to={x:120,y:-60,zoom:2.5,rotation:-3.0};
 let at=from,travelled=0,previous=Math.hypot(to.x-at.x,to.y-at.y);
 for(let step=0;step<200;step+=1){
  const next=approach(at,to,1-Math.exp(-9*(1/60)));
  travelled+=Math.abs(normalizeAngle(next.rotation-at.rotation));
  const distance=Math.hypot(to.x-next.x,to.y-next.y);
  // Every frame is closer than the last, and none of them is past the target.
  expect(distance).toBeLessThanOrEqual(previous+1e-9);
  expect(next.x).toBeGreaterThanOrEqual(Math.min(from.x,to.x)-1e-9);
  expect(next.x).toBeLessThanOrEqual(Math.max(from.x,to.x)+1e-9);
  previous=distance;at=next;
  if(arrived(at,to))break;
 }
 expect(arrived(at,to)).toBe(true);
 // The turn taken is the short one, whatever the signs of the angles.
 expect(travelled).toBeLessThan(Math.PI);
 expect(Math.abs(normalizeAngle(at.rotation-to.rotation))).toBeLessThan(0.01);
});

test('every zoom the game uses puts a tile on a whole, even number of device pixels',()=>{
 // The reason the wheel snaps instead of sliding: at other zooms a one pixel line is drawn as runs of one and two
 // pixels, and below half a pixel per cell a checkerboard becomes one flat tone. The ladder is what stops the art from
 // going soft, so its one property is what the test checks.
 for(const scale of [0.5,1,1.25,2]){
  const steps=zoomLadder(scale);
  expect(steps.length,`escada em ${scale}`).toBeGreaterThan(3);
  // The ends of the range are steps too, so the whole-city view stays reachable; between them, a tile is a whole even
  // number of device pixels.
  expect(steps[0]).toBe(MIN_ZOOM);
  expect(steps[steps.length-1]).toBe(MAX_ZOOM);
  for(const step of steps.slice(1,-1)){
   expect(step).toBeGreaterThan(MIN_ZOOM);
   expect(step).toBeLessThan(MAX_ZOOM);
   const devicePixels=TILE_W*step*scale;
   expect(Math.abs(devicePixels-Math.round(devicePixels)),`${step} em ${scale}`).toBeLessThan(1e-6);
   expect(Math.round(devicePixels)%2,`${step} em ${scale}`).toBe(0);
  }
  // Snapping is a step of the ladder, it is idempotent, and it never moves the zoom more than half a step.
  const spacing=Math.min(...steps.slice(1).map((step,index)=>step-steps[index]!));
  for(const wanted of steps.slice(1,-1)){
   const snapped=snapZoom(wanted,scale);
   expect(steps).toContain(snapped);
   expect(snapZoom(snapped,scale)).toBe(snapped);
   expect(Math.abs(snapped-wanted)).toBeLessThanOrEqual(spacing*0.500001);
  }
  // And outside the range the camera stays at its ends instead of running away.
  expect(snapZoom(0.0001,scale)).toBe(MIN_ZOOM);
  expect(snapZoom(99,scale)).toBe(MAX_ZOOM);
 }
});

test('a gesture keeps the zoom the fingers asked for, and stepped input lands on a crisp one',()=>{
 // The regression this pins: rounding every camera change made a pinch compute its position from a scale that was
 // never applied, so the city slid out from under the fingers on every frame — faster the further the gesture was
 // from a step. A wheel notch has no fingers to argue with, so it still lands on the ladder.
 const scale=1,asked=1.03;
 expect(settleZoom(asked,scale,false)).toBe(asked);
 const stepped=settleZoom(asked,scale,true);
 expect(stepped).not.toBe(asked);
 expect(Math.round(TILE_W*stepped*scale)%2).toBe(0);
 // Both stay inside the zoom the game allows.
 expect(settleZoom(99,scale,false)).toBe(MAX_ZOOM);
 expect(settleZoom(0.0001,scale,true)).toBe(MIN_ZOOM);
});
