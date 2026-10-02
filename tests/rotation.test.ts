import {expect,test} from 'vitest';
import type {Camera} from '../src/presentation/camera';
import {MAX_ZOOM,MIN_ZOOM,TILE_H,TILE_W,cellSpace,centerOn,clampZoom,normalizeAngle,pick,project,rotateTo,visibleChunks,zoomTo} from '../src/presentation/camera';
import {chunkId,chunkOrigin,validCell,wrapX} from '../src/core/coordinates';
import type {CellCoord} from '../src/core/model';

const ANGLES=[0,.3,Math.PI/4,Math.PI/2,Math.PI,-2.5,3];
const ZOOMS=[MIN_ZOOM,1,MAX_ZOOM];
const CELLS:CellCoord[]=[{x:0,y:0},{x:4194303,y:5},{x:0,y:5},{x:123456,y:654321},{x:-1,y:7},{x:7,y:-3}];
const ANCHORS=[{x:0,y:0},{x:137.5,y:-42.25},{x:-768,y:96}];

test('project and pick are exact inverses at every bearing, cell and zoom',()=>{
 for(const rotation of ANGLES)for(const zoom of ZOOMS)for(const anchor of ANCHORS){
  const camera={...anchor,zoom,rotation};
  for(const cell of CELLS)expect(pick(project(cell,camera),camera),`${cell.x},${cell.y} ${rotation} ${zoom}`).toEqual(cell);
 }
});
test('rotation zero projects and picks exactly like an unturned camera',()=>{
 for(const zoom of ZOOMS)for(const anchor of ANCHORS){
  const camera={...anchor,zoom,rotation:0};
  for(const cell of CELLS){
   const p=project(cell,camera);
   expect(p).toEqual({x:camera.x+(cell.x-cell.y)*TILE_W*zoom,y:camera.y+(cell.x+cell.y)*TILE_H*zoom});
   const space=cellSpace(p,camera);
   expect(space.x).toBeCloseTo(cell.x,6);expect(space.y).toBeCloseTo(cell.y,6);
   expect(pick({x:p.x,y:p.y},camera)).toEqual(cell);
  }
 }
});
test('a turned camera orbits the world around its anchor, keeping ground distance and fixed inclination',()=>{
 const cell={x:120,y:-40},anchor={x:640,y:360},radius=(camera:Camera)=>{const p=project(cell,camera);return Math.hypot(p.x-camera.x,2*(p.y-camera.y));};
 const straight=radius({...anchor,zoom:1,rotation:0});
 expect(straight).toBeGreaterThan(0);
 for(const rotation of ANGLES)expect(radius({...anchor,zoom:1,rotation})).toBeCloseTo(straight,6);
});
test('centerOn lands the cell on the viewport centre and keeps zoom and bearing',()=>{
 for(const viewport of [{width:321,height:197},{width:800,height:600}])for(const rotation of ANGLES)for(const zoom of ZOOMS){
  for(const cell of [{x:4194303,y:5},{x:-1,y:7},{x:1000,y:1000}]){
   const camera=centerOn(cell,{x:10,y:20,zoom,rotation},viewport),p=project(cell,camera);
   expect(p.x,`x ${cell.x},${cell.y}`).toBeCloseTo(viewport.width/2,3);
   expect(p.y,`y ${cell.x},${cell.y}`).toBeCloseTo(viewport.height/2,3);
   expect(camera.zoom).toBe(zoom);expect(camera.rotation).toBe(rotation);
  }
 }
});
test('zoomTo and rotateTo keep the same continuous cell under the centre',()=>{
 const viewport={width:900,height:600},centre={x:viewport.width/2,y:viewport.height/2};
 for(const rotation of ANGLES){
  const camera=centerOn({x:42000,y:31000},{x:0,y:0,zoom:2,rotation},viewport),before=cellSpace(centre,camera);
  for(const zoom of [MIN_ZOOM,0.25,1,MAX_ZOOM,99]){
   const widened=zoomTo(camera,viewport,zoom),after=cellSpace(centre,widened);
   expect(widened.zoom).toBe(clampZoom(zoom));expect(widened.rotation).toBe(rotation);
   expect(Math.abs(after.x-before.x),`x ${rotation} ${zoom}`).toBeLessThanOrEqual(0.01);
   expect(Math.abs(after.y-before.y),`y ${rotation} ${zoom}`).toBeLessThanOrEqual(0.01);
  }
  for(const target of ANGLES){
   const turned=rotateTo(camera,viewport,target),after=cellSpace(centre,turned);
   expect(turned.rotation).toBe(normalizeAngle(target));expect(turned.zoom).toBe(camera.zoom);
   expect(Math.abs(after.x-before.x),`x ${rotation}->${target}`).toBeLessThanOrEqual(0.01);
   expect(Math.abs(after.y-before.y),`y ${rotation}->${target}`).toBeLessThanOrEqual(0.01);
  }
 }
});
test('turning past half a turn comes back to the same view',()=>{
 const viewport={width:900,height:600},camera=centerOn({x:42000,y:31000},{x:100,y:200,zoom:1.5,rotation:.4},viewport);
 const once=rotateTo(camera,viewport,camera.rotation+2*Math.PI);
 expect(once.rotation).toBeCloseTo(camera.rotation,9);
 expect(once.x).toBeCloseTo(camera.x,6);expect(once.y).toBeCloseTo(camera.y,6);
});
test('a turned view still lists every region its visible cells fall in',()=>{
 const viewport={width:480,height:320};
 for(const rotation of ANGLES)for(const zoom of [MIN_ZOOM,0.5,1,MAX_ZOOM]){
  const camera=centerOn({x:1000,y:1000},{x:0,y:0,zoom,rotation},viewport),ids=new Set(visibleChunks(camera,viewport));
  expect(ids.size,`${rotation} ${zoom}`).toBeGreaterThan(0);
  for(const id of ids)expect(()=>chunkOrigin(id),id).not.toThrow();
  let sampled=0;
  for(let py=0;py<viewport.height;py+=4)for(let px=0;px<viewport.width;px+=4){
   const cell=pick({x:px,y:py},camera);
   if(!validCell({x:wrapX(cell.x),y:cell.y}))continue;
   sampled++;
   expect(ids.has(chunkId(cell)),`${px},${py} ${rotation} ${zoom}`).toBe(true);
  }
  expect(sampled,`${rotation} ${zoom}`).toBeGreaterThan(1000);
 }
},20_000);
test('a turned view wraps the antimeridian into real region ids',()=>{
 const viewport={width:320,height:200},rotation=Math.PI/3;
 const west=centerOn({x:-20,y:1000},{x:0,y:0,zoom:2,rotation},viewport);
 const ids=visibleChunks(west,viewport);
 expect(ids).toContain(chunkId({x:-20,y:1000}));
 expect(ids.some(id=>id.includes('-'))).toBe(false);
 for(const id of ids)expect(()=>chunkOrigin(id),id).not.toThrow();
});
test('normalizeAngle folds every angle into (-PI, PI] without moving the view',()=>{
 for(const angle of [0,.3,Math.PI/4,Math.PI,-Math.PI,2*Math.PI,-2*Math.PI,3,4*Math.PI+.75,-9.5,1e6]){
  const folded=normalizeAngle(angle);
  expect(folded,`${angle}`).toBeGreaterThan(-Math.PI);
  expect(folded,`${angle}`).toBeLessThanOrEqual(Math.PI);
  expect(Math.sin(folded),`${angle}`).toBeCloseTo(Math.sin(angle),9);
  expect(Math.cos(folded),`${angle}`).toBeCloseTo(Math.cos(angle),9);
 }
 expect(normalizeAngle(0)).toBe(0);expect(normalizeAngle(-0)).toBe(0);
 expect(normalizeAngle(Math.PI)).toBe(Math.PI);expect(normalizeAngle(-Math.PI)).toBe(Math.PI);
 expect(normalizeAngle(3*Math.PI)).toBe(Math.PI);expect(normalizeAngle(.3)).toBeCloseTo(.3,12);
});
