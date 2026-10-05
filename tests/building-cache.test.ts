import {it,expect,vi,afterEach} from 'vitest';
import {renderGeographicWorld} from '../src/surfaces/canvas/geographic-renderer';
import {sceneRasterCache} from '../src/surfaces/canvas/scene-cache';
import {drawBuilding} from '../src/surfaces/canvas/architecture-renderer';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
afterEach(()=>{sceneRasterCache.clear();vi.unstubAllGlobals();});
it('reuses a bounded building bitmap while its drawing inputs stay unchanged',()=>{
 let painted=0,images=0;
 const context=new Proxy({},{get:(_t,key)=>key==='drawImage'?()=>images++:()=>painted++,set:()=>true}) as CanvasRenderingContext2D;
 vi.stubGlobal('OffscreenCanvas',class {width:number;height:number;constructor(w:number,h:number){this.width=w;this.height=h;}getContext(){return context;}});
 const view:WorldView={camera:{x:200,y:100,zoom:1,rotation:0},viewport:{width:400,height:300},state:createGame('fixture',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0};
 const footprint={rings:[[{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2},{x:0,y:0}]],minX:0,maxX:2,minY:0,maxY:2,area:4,kind:'residential',seed:1};
 drawBuilding(context,view,footprint,0,'residential',2);expect(images).toBe(1);const first=painted;
 drawBuilding(context,view,footprint,0,'residential',2);expect(images).toBe(2);expect(painted).toBe(first);
 drawBuilding(context,{...view,light:'night'},footprint,0,'residential',2);expect(painted).toBeGreaterThan(first);
 const count=images;drawBuilding(context,{...view,camera:{...view.camera,x:-100000}},footprint,0,'residential',2);expect(images).toBe(count);
});

it('reuses static ground while water reflections keep moving and invalidates on camera changes',()=>{
 let painted=0;
 const offscreen=new Proxy({},{get:()=>()=>painted++,set:()=>true}) as CanvasRenderingContext2D;
 const paths:number[][]=[];const context=new Proxy({},{get:(_t,key)=>key==='moveTo'||key==='lineTo'?(x:number,y:number)=>paths.push([x,y]):()=>{},set:()=>true}) as CanvasRenderingContext2D;
 vi.stubGlobal('OffscreenCanvas',class {width:number;height:number;constructor(w:number,h:number){this.width=w;this.height=h;}getContext(){return offscreen;}});
 const view:WorldView={camera:{x:200,y:100,zoom:.15,rotation:0},viewport:{width:400,height:300},state:createGame('fixture',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0,geography:{revision:1,loading:false,error:false,tiles:[{z:14,x:0,y:0,features:[{layer:'water_polygons',kind:'water',bridge:false,type:3,geometry:[[{x:0,y:0},{x:20,y:0},{x:20,y:20},{x:0,y:20},{x:0,y:0}]]}]}]}};
 renderGeographicWorld(context,view);const first=painted,water=[...paths];paths.length=0;
 renderGeographicWorld(context,{...view,motion:7});expect(painted).toBe(first);expect(paths).not.toEqual(water);
 renderGeographicWorld(context,{...view,camera:{...view.camera,x:210}});expect(painted).toBeGreaterThan(first);
});
it('reuses an interior building bitmap after pure camera translation',()=>{let painted=0;const draws:number[][]=[],context=new Proxy({},{get:(_t,k)=>k==='drawImage'?(_c:unknown,x:number,y:number)=>draws.push([x,y]):()=>painted++,set:()=>true}) as CanvasRenderingContext2D;vi.stubGlobal('OffscreenCanvas',class {width:number;height:number;constructor(w:number,h:number){this.width=w;this.height=h;}getContext(){return context;}});const view:WorldView={camera:{x:200,y:180,zoom:1,rotation:0},viewport:{width:800,height:600},state:createGame('fixture',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0},footprint={rings:[[{x:0,y:0},{x:2,y:0},{x:2,y:2},{x:0,y:2},{x:0,y:0}]],minX:0,maxX:2,minY:0,maxY:2,area:4,kind:'residential',seed:1};drawBuilding(context,view,footprint,0,'residential',2);const first=painted,old=draws.at(-1)!;drawBuilding(context,{...view,camera:{...view.camera,x:220,y:190}},footprint,0,'residential',2);expect(painted).toBe(first);expect(draws.at(-1)).toEqual([old[0]+20,old[1]+10]);});
it('retains a distant labeled city across motion and keeps preview feedback live',()=>{
 let images=0,texts=0;
 const context=new Proxy({},{get:(_t,key)=>key==='drawImage'?()=>images++:key==='measureText'?()=>({width:30}):key==='fillText'?()=>texts++:()=>{},set:()=>true}) as CanvasRenderingContext2D;
 vi.stubGlobal('OffscreenCanvas',class {width:number;height:number;constructor(w:number,h:number){this.width=w;this.height=h;}getContext(){return context;}});
 const view:WorldView={camera:{x:200,y:100,zoom:.04,rotation:0},viewport:{width:400,height:300},state:createGame('fixture',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0,geography:{revision:1,loading:false,error:false,tiles:[{z:14,x:0,y:0,features:[{layer:'place_labels',kind:'city',name:'Cidade',bridge:false,type:1,geometry:[[{x:0,y:0}]]}]}]}};
 renderGeographicWorld(context,view);const firstImages=images,firstTexts=texts;expect(firstTexts).toBeGreaterThan(0);
 renderGeographicWorld(context,{...view,motion:1});expect(images).toBe(firstImages);expect(texts).toBe(firstTexts);
 renderGeographicWorld(context,{...view,tool:'road',preview:[{x:0,y:0}]});expect(images).toBeGreaterThan(firstImages);
});
