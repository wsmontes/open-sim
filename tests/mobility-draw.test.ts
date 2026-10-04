import {it,expect} from 'vitest';
import {drawMobilityAgent,drawVisibleMobility} from '../src/surfaces/canvas/mobility-draw';
import type {MobilityFrameAgent} from '../src/presentation/mobility-model';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
const agent=(kind:MobilityFrameAgent['kind']='car'):MobilityFrameAgent=>({id:'test',kind,point:{x:0,y:0},heading:{x:1,y:0},elevationM:null,seed:1,method:'simulated'});
function recorder(){const rects:{color:string;width:number;height:number}[]=[],lines:number[][]=[],rotations:number[]=[],translations:number[][]=[];let color='';const ctx=new Proxy({},{get:(_target,key)=>key==='fillRect'?(x:number,y:number,width:number,height:number)=>rects.push({color,width,height}):key==='moveTo'||key==='lineTo'?(x:number,y:number)=>lines.push([x,y]):key==='rotate'?(angle:number)=>rotations.push(angle):key==='translate'?(x:number,y:number)=>translations.push([x,y]):()=>{},set:(_target,key,value)=>{if(key==='fillStyle')color=String(value);return true;}}) as CanvasRenderingContext2D;return {ctx,rects,lines,rotations,translations};}
const identity=(p:{x:number;y:number})=>p;
it('bus_longer_than_car',()=>{const car=recorder(),bus=recorder();drawMobilityAgent(car.ctx,agent(),identity,2,0);drawMobilityAgent(bus.ctx,agent('bus'),identity,2,0);expect(Math.max(...bus.rects.map(r=>r.width))).toBeGreaterThan(Math.max(...car.rects.map(r=>r.width))*2);});
it('truck_distinct_cab_and_cargo',()=>{const r=recorder();drawMobilityAgent(r.ctx,agent('truck'),identity,2,0);expect(r.rects.some(p=>p.color==='#e4ded0'&&p.width>=10)).toBe(true);expect(r.rects.some(p=>p.color==='#b8754f'&&p.width>=4)).toBe(true);});
it('walker_legs_follow_motion',()=>{const a=recorder(),b=recorder();drawMobilityAgent(a.ctx,agent('pedestrian'),identity,3,0);drawMobilityAgent(b.ctx,agent('pedestrian'),identity,3,.2);expect(a.lines).not.toEqual(b.lines);expect(a.lines.length).toBeGreaterThanOrEqual(4);});
it('rotated_camera_preserves_heading',()=>{const r=recorder();drawMobilityAgent(r.ctx,agent(),p=>({x:-p.y,y:p.x}),2,0);expect(r.rotations[0]).toBeCloseTo(Math.PI/2);});
it('outside_view_culled',()=>{const r=recorder(),view:WorldView={camera:{x:100,y:100,zoom:1,rotation:0},viewport:{width:200,height:200},state:createGame('test',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0,mobility:[{...agent(),point:{x:5000,y:5000}}]};drawVisibleMobility(r.ctx,view);expect(r.translations).toEqual([]);});
it('bus remains readable with visible windows at distant scale',()=>{
 const r=recorder();drawMobilityAgent(r.ctx,agent('bus'),identity,.2,0);
 expect(r.rects.find(p=>p.color==='#ecede6')!.height).toBeGreaterThanOrEqual(4);
 expect(r.rects.filter(p=>p.color==='#577782').every(p=>p.height>=1&&p.width>=1)).toBe(true);
});
it('distinguishes school yellow and non-emergency police bar from urban buses',()=>{const p=recorder(),s=recorder(),b=recorder();drawMobilityAgent(p.ctx,agent('police'),identity,2,0);drawMobilityAgent(s.ctx,agent('school-bus'),identity,2,0);drawMobilityAgent(b.ctx,agent('bus'),identity,2,0);expect(p.rects.some(r=>r.color==='#4d8cda')).toBe(true);expect(p.rects.some(r=>r.color==='#cf4e42')).toBe(true);expect(s.rects.some(r=>r.color==='#e9b947')).toBe(true);expect(b.rects.some(r=>r.color==='#e9b947')).toBe(false);});
it('bounds compact actors by actual body size and retains static signal identity',async()=>{const {mobilityDrawCommands,signalDrawCommands}=await import('../src/surfaces/canvas/mobility-draw');const r=recorder(),view:WorldView={camera:{x:100,y:100,zoom:.15,rotation:0},viewport:{width:200,height:200},state:createGame('test',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0,mobility:[agent()],signals:[{nodeId:'node',point:{x:0,y:0},direction:{x:1,y:0},aspect:'green',method:'derived'}]};expect(mobilityDrawCommands(r.ctx,view)[0].bounds.width).toBeLessThan(36);const signal=signalDrawCommands(r.ctx,view)[0];expect(signal.id).toBeDefined();expect(signal.version).toBe('green');});
