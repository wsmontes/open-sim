import {expect,test} from 'vitest';
import {render} from '../src/surfaces/canvas/canvas-renderer';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
import {centerOn} from '../src/presentation/camera';
import {toCell} from '../src/core/coordinates';
import {drawBuilding} from '../src/surfaces/canvas/architecture-renderer';
function recorder(){const fills:string[]=[],paths:Array<Array<[number,number]>>=[];let path:Array<[number,number]>=[];let fill='',stroke='';const strokes:Array<{color:string;path:Array<[number,number]>}>=[];const context=new Proxy({},{get:(_t,key)=>key==='createRadialGradient'||key==='createLinearGradient'?()=>({addColorStop(){}}):key==='measureText'?()=>({width:20}):key==='beginPath'?()=>{path=[];paths.push(path);}:key==='moveTo'||key==='lineTo'?(x:number,y:number)=>path.push([x,y]):key==='fill'?()=>fills.push(fill):key==='stroke'?()=>strokes.push({color:stroke,path:[...path]}):()=>{},set:(_t,key,value)=>{if(key==='fillStyle')fill=String(value);if(key==='strokeStyle')stroke=String(value);return true;}}) as CanvasRenderingContext2D;return{context,fills,paths,strokes};}
const base=blank('0:0'),state=createGame('test',1,base);
const view:WorldView={camera:{x:250,y:150,zoom:.25,rotation:0},viewport:{width:500,height:300},state,chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0,
 geography:{revision:1,loading:false,error:false,tiles:[{z:14,x:0,y:0,features:[{layer:'buildings',kind:'residential',bridge:false,type:3,geometry:[[{x:2,y:2},{x:6,y:2},{x:6,y:5},{x:2,y:5},{x:2,y:2}]]}]}]}};
test('mid-zoom retains an imported building volume instead of painting a colour mosaic',()=>{
 const rec=recorder();render(rec.context,view);
 // Footprint, shadow, two or more walls and roof must all survive at .25 zoom.
 expect(rec.fills.some(c=>c.includes('rgba'))).toBe(true);
 expect(new Set(rec.fills).size).toBeGreaterThanOrEqual(4);
});
test('world rendering stays bounded and draws a real globe even with no network tiles',()=>{
 const rec=recorder(),viewport={width:500,height:400};
 render(rec.context,{...view,viewport,camera:centerOn(toCell(49.2827,-123.1207),{x:0,y:0,zoom:.000003,rotation:0},viewport),geography:{tiles:[],revision:1,loading:false,error:false}});
 expect(rec.paths.flat().length).toBeGreaterThan(1000);expect(rec.paths.length).toBeLessThan(2000);
 expect(rec.paths.flat().every(([x,y])=>Number.isFinite(x)&&Number.isFinite(y))).toBe(true);
});

test('simulation growth of imported cells preserves the real footprint',()=>{
 const changed={...state,chunks:{...state.chunks,'0:0':{...state.chunks['0:0'],edits:{99:{terrain:'land' as const,building:'residential' as const,stage:2,origin:'imported' as const}}}}};
 const before=recorder(),after=recorder();render(before.context,view);render(after.context,{...view,state:changed});
 expect(after.paths).toEqual(before.paths);
 expect(after.fills).toEqual(before.fills);
});

test('a marked player lot remains groundwork before growth rather than a finished house',()=>{
 const footprint={rings:[[{x:2,y:2},{x:3,y:2},{x:3,y:3},{x:2,y:3},{x:2,y:2}]],minX:2,maxX:3,minY:2,maxY:3,area:1,kind:'residential',seed:7};
 const site=recorder(),occupied=recorder();drawBuilding(site.context,view,footprint,0,'residential',0);drawBuilding(occupied.context,view,footprint,0,'residential',2);
 // The lot is groundwork: bare earth, a works board, no roof, no walls, none of the colour a finished house has.
 expect(site.fills[0]).toBe('#b8a48a');expect(site.fills).toContain('#c9614a');
 expect(occupied.fills).not.toContain('#b8a48a');expect(occupied.fills.length).toBeGreaterThan(site.fills.length);
});

test('a zone preview shows the volume the tool will place, in the colour of whether the player can pay',()=>{
 const paid=recorder();render(paid.context,{...view,tool:'residential',preview:[{x:3,y:3}],previewAffordable:true});
 expect(paid.fills).toContain('rgba(214,236,201,.55)');
 const refused=recorder();render(refused.context,{...view,tool:'residential',preview:[{x:3,y:3}],previewAffordable:false});
 expect(refused.fills).toContain('rgba(238,196,188,.55)');
 expect(refused.fills).not.toContain('rgba(214,236,201,.55)');
 // A road is a surface, not a volume: its preview stays on the ground.
 const road=recorder();render(road.context,{...view,tool:'road',preview:[{x:3,y:3}]});
 expect(road.fills).not.toContain('rgba(214,236,201,.55)');
});

test('night actually changes the rendered city palette without moving source geometry',()=>{
 const day=recorder(),night=recorder();render(day.context,view);render(night.context,{...view,light:'night'});expect(night.paths).toEqual(day.paths);expect(night.fills).not.toEqual(day.fills);
});

test('water reflections never replace the shoreline path after clipping',()=>{
 const rec=recorder();render(rec.context,{...view,geography:{...view.geography!,tiles:[{z:14,x:0,y:0,features:[{layer:'water_polygons',kind:'water',bridge:false,type:3,geometry:[[{x:2,y:2},{x:8,y:2},{x:8,y:8},{x:2,y:8},{x:2,y:2}]]}]}]}});
 const shoreline=rec.strokes.find(s=>s.color==='#aac3c3');expect(shoreline?.path).toHaveLength(5);expect(shoreline?.path[0]).toEqual(shoreline?.path[4]);
});

test('a glass tower casts one shadow, thrown by its whole height, and water moves with the clock',()=>{
 const tower={rings:[[{x:2,y:2},{x:12,y:2},{x:12,y:12},{x:2,y:12},{x:2,y:2}]],minX:2,maxX:12,minY:2,maxY:12,area:100,kind:'commercial',seed:6};
 const shadow='rgba(42,51,44,.19)';
 const high=recorder();drawBuilding(high.context,view,tower,0);
 const low=recorder();drawBuilding(low.context,view,{...tower,area:6,seed:3},0,'residential',3);
 expect(high.fills.filter(c=>c===shadow)).toHaveLength(1);
 expect(low.fills.filter(c=>c===shadow)).toHaveLength(1);
 // Too close for the reflection streaks, still far enough that the bay should not stand still.
 const water={layer:'water_polygons',kind:'water',bridge:false,type:3,geometry:[[{x:2,y:2},{x:40,y:2},{x:40,y:40},{x:2,y:40},{x:2,y:2}]]};
 const tiles=[{z:14,x:0,y:0,features:[water]}],mid={...view,camera:{...view.camera,zoom:.15},geography:{...view.geography!,tiles}};
 const still=recorder();render(still.context,{...mid,motion:0});
 const later=recorder();render(later.context,{...mid,motion:7});
 expect(still.paths.length).toBeGreaterThan(0);
 expect(still.paths).not.toEqual(later.paths);
});

test('at night the avenues carry lamps, and by day they do not',()=>{
 const streets=[3,4,5,6,7,8].map(y=>({layer:'streets',kind:'secondary',bridge:false,type:2,geometry:[[{x:0,y},{x:20,y}]]}));
 const tiles=[{z:14,x:0,y:0,features:streets}];
 const day=recorder();render(day.context,{...view,geography:{...view.geography!,tiles}});
 const night=recorder();render(night.context,{...view,light:'night',geography:{...view.geography!,tiles}});
 const lamps=night.fills.filter(c=>c==='rgba(255,216,140,.95)');
 expect(lamps.length).toBeGreaterThan(0);
 expect(lamps.length).toBeLessThanOrEqual(56);
 expect(day.fills).not.toContain('rgba(255,216,140,.95)');
});

test('a pedestrian square is paved with a bounded number of joints, and not from far away',()=>{
 const square={layer:'street_polygons',kind:'pedestrian',bridge:false,type:3,geometry:[[{x:2,y:2},{x:20,y:2},{x:20,y:20},{x:2,y:20},{x:2,y:2}]]};
 const tiles=[{z:14,x:0,y:0,features:[square]}];
 const near=recorder();render(near.context,{...view,geography:{...view.geography!,tiles}});
 const joints=near.strokes.filter(s=>s.color==='rgba(122,116,101,.42)');
 expect(joints.length).toBeGreaterThan(0);
 expect(joints.length).toBeLessThanOrEqual(40);
 const far=recorder();render(far.context,{...view,camera:{...view.camera,zoom:.05},geography:{...view.geography!,tiles}});
 expect(far.strokes.some(s=>s.color==='rgba(122,116,101,.42)')).toBe(false);
});

test('a row of houses draws party walls between its units and a shop draws a glazed frontage',()=>{
 const box=(minX:number,maxX:number,minY:number,maxY:number)=>({rings:[[{x:minX,y:minY},{x:maxX,y:minY},{x:maxX,y:maxY},{x:minX,y:maxY},{x:minX,y:minY}]],minX,maxX,minY,maxY,area:(maxX-minX)*(maxY-minY),kind:'residential',seed:3});
 // A party wall is the vertical stroke that runs the whole height of a face; nothing else in a house is vertical.
 const walls=(r:ReturnType<typeof recorder>)=>r.strokes.filter(s=>s.path.length===2&&s.path[0]![0]===s.path[1]![0]).length;
 const couple=recorder();drawBuilding(couple.context,view,box(2,8,2,4),0,'residential',2);
 const terrace=recorder();drawBuilding(terrace.context,view,box(2,16,2,4),0,'residential',2);
 const detached=recorder();drawBuilding(detached.context,view,box(3,5,2,3.6),0,'residential',2);
 expect(walls(couple)).toBeGreaterThan(0);
 expect(walls(terrace)).toBeGreaterThan(walls(couple));
 expect(walls(detached)).toBe(0);
 const shops=recorder();drawBuilding(shops.context,view,box(2,8,2,4),0,'commercial',2);
 expect(shops.fills).toContain('#3f5560');
 expect(couple.fills).not.toContain('#3f5560');
});
