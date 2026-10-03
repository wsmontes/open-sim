import {it,expect} from 'vitest';
import {drawVessel} from '../src/surfaces/canvas/vessel-draw';
import type {VesselFrame} from '../src/presentation/maritime-engine';
const vessel=(kind:VesselFrame['kind']):VesselFrame=>({id:'fixture',kind,operator:'Fixture',routeId:'fixture',position:{lat:0,lon:0},headingDegrees:90,phase:'sailing',waterElevationM:0,method:'simulated',speedMps:5});
function recorder(){const colors:string[]=[],lines:number[][]=[];const ctx=new Proxy({},{get:(_,key)=>key==='lineTo'||key==='moveTo'?(x:number,y:number)=>lines.push([x,y]):()=>{},set:(_,key,value)=>{if(key==='fillStyle'||key==='strokeStyle')colors.push(String(value));return true;}}) as CanvasRenderingContext2D;return {ctx,colors,lines};}
const project=(p:{lat:number;lon:number})=>({x:p.lon*100000,y:-p.lat*100000});
it('cargo has containers and cruise has stacked decks',()=>{const cargo=recorder(),cruise=recorder();drawVessel(cargo.ctx,vessel('cargo'),project,1);drawVessel(cruise.ctx,vessel('cruise'),project,1);expect(cargo.colors).toContain('#a9603f');expect(cruise.colors).toContain('#f0eee3');expect(cruise.colors).not.toContain('#a9603f');});
it('sailboat has a mast and a triangular sail',()=>{const r=recorder();drawVessel(r.ctx,vessel('sailboat'),project,2);expect(r.colors).toContain('#faf1d4');expect(r.lines.length).toBeGreaterThan(6);});
it('preserves distinct SeaBus and Aquabus paints',()=>{const sea=recorder(),aqua=recorder();drawVessel(sea.ctx,vessel('seabus'),project,1);drawVessel(aqua.ctx,vessel('aquabus'),project,1);expect(sea.colors).toContain('#315b85');expect(aqua.colors).toContain('#b74f81');});
it('draws wake only while moving, including a stopped approach queue',()=>{const moving=recorder(),still=recorder();drawVessel(moving.ctx,vessel('aquabus'),project,1);drawVessel(still.ctx,{...vessel('aquabus'),phase:'approach',speedMps:0},project,1);expect(moving.colors).toContain('rgba(231,245,240,.5)');expect(still.colors).not.toContain('rgba(231,245,240,.5)');});
