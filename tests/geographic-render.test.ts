import {expect,test} from 'vitest';
import {render} from '../src/surfaces/canvas/canvas-renderer';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
import {centerOn} from '../src/presentation/camera';
import {toCell} from '../src/core/coordinates';
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

test('a marked player lot remains groundwork before growth rather than a finished house',async()=>{
 const {drawBuilding}=await import('../src/surfaces/canvas/architecture-renderer');
 const footprint={rings:[[{x:2,y:2},{x:3,y:2},{x:3,y:3},{x:2,y:3},{x:2,y:2}]],minX:2,maxX:3,minY:2,maxY:3,area:1,kind:'residential',seed:7};
 const site=recorder(),occupied=recorder();drawBuilding(site.context,view,footprint,0,'residential',0);drawBuilding(occupied.context,view,footprint,0,'residential',2);
 expect(site.fills).toEqual(['#b8a48a']);expect(occupied.fills.length).toBeGreaterThan(site.fills.length);
});

test('night actually changes the rendered city palette without moving source geometry',()=>{
 const day=recorder(),night=recorder();render(day.context,view);render(night.context,{...view,light:'night'});expect(night.paths).toEqual(day.paths);expect(night.fills).not.toEqual(day.fills);
});

test('water reflections never replace the shoreline path after clipping',()=>{
 const rec=recorder();render(rec.context,{...view,geography:{...view.geography!,tiles:[{z:14,x:0,y:0,features:[{layer:'water_polygons',kind:'water',bridge:false,type:3,geometry:[[{x:2,y:2},{x:8,y:2},{x:8,y:8},{x:2,y:8},{x:2,y:2}]]}]}]}});
 const shoreline=rec.strokes.find(s=>s.color==='#aac3c3');expect(shoreline?.path).toHaveLength(5);expect(shoreline?.path[0]).toEqual(shoreline?.path[4]);
});
