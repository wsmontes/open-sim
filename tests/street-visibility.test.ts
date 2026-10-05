import {expect,it} from 'vitest';
import {nearbyJunctions,drawPlanting,drawParkPlanting} from '../src/surfaces/canvas/street-renderer';
import {buildBoxIndex} from '../src/presentation/spatial-index';
import {centerOn,cellSpace} from '../src/presentation/camera';
import {toCell} from '../src/core/coordinates';
import {terrainMetres} from '../src/surfaces/canvas/terrain-renderer';
import {verticalPixelsPerMetre} from '../src/presentation/terrain-projection';
import {createGame} from '../src/core/commands';
import {blank} from './fixtures/world';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
it('includes elevated junctions whose flat projections lie below the viewport',()=>{const viewport={width:500,height:300},camera=centerOn(toCell(49.27,-123.12),{x:0,y:0,zoom:1,rotation:0},viewport),base:WorldView={camera,viewport,state:createGame('test',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0},height=850/verticalPixelsPerMetre(camera,terrainMetres(base)),point=cellSpace({x:250,y:1000},camera),points=[cellSpace({x:250,y:150},camera),point],index=buildBoxIndex(points.map(p=>({minX:p.x,maxX:p.x,minY:p.y,maxY:p.y})),1),view={...base,terrain:{revision:1,tiles:[{id:'test',bounds:{west:-124,east:-123,south:49,north:50},size:2,spacingM:100,heightsM:new Float32Array(4).fill(height),valid:new Uint8Array(4).fill(1),kind:'dtm' as const,verticalDatum:'CGVD2013',sourceId:'test'}],sample:()=>({elevationM:height,kind:'dtm' as const,sourceId:'test',verticalDatum:'CGVD2013'})}};expect(nearbyJunctions(base,index)).toEqual([0]);expect(nearbyJunctions(view,index)).toEqual([0,1]);});

it('does not enumerate invisible trees across regional roads or forests',()=>{
 const viewport={width:800,height:600},camera=centerOn(toCell(49.27,-123.12),{x:0,y:0,zoom:.001,rotation:0},viewport);
 const view:WorldView={camera,viewport,state:createGame('test',1,blank('0:0')),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0};
 const feature={layer:'streets',kind:'residential',bridge:false,type:2,get geometry():{x:number;y:number}[][]{throw new Error('Regional tree geometry must not be enumerated');}};
 const ctx=new Proxy({},{get(){throw new Error('Subpixel trees must not paint');}}) as CanvasRenderingContext2D;
 const box={minX:0,minY:0,maxX:100000,maxY:100000};
 expect(()=>drawPlanting(ctx,view,[{feature,shift:0}],box)).not.toThrow();
 expect(()=>drawParkPlanting(ctx,view,Object.assign(Object.create(feature),{layer:'sites',kind:'forest'}),0,box)).not.toThrow();
});
