import {expect,test} from 'vitest';
import {normalizeChunk,type MapFeature} from '../src/adapters/osm/normalize';
const polygon=(layer:string,rings:number[][][]):MapFeature=>({layer,kind:'',bridge:false,geometry:rings.map(r=>r.map(([x,y])=>({x,y}))),type:3});
test('polygon holes and ocean coast preserve land inside the hole',()=>{const b=normalizeChunk('0:0',[polygon('ocean',[[[0,0],[32,0],[32,32],[0,32],[0,0]],[[2,2],[4,2],[4,4],[2,4],[2,2]]])]);expect(b.cells[0].terrain).toBe('water');expect(b.cells[2*32+2].terrain).toBe('land');});
test('a footprint crossing regions preserves occupation at both edges',()=>{const f=polygon('buildings',[[[30,2],[34,2],[34,4],[30,4],[30,2]]]);expect(normalizeChunk('0:0',[f]).cells[2*32+31].building).toBeTruthy();expect(normalizeChunk('1:0',[f]).cells[2*32].building).toBeTruthy();});
test('only an explicit bridge may carry a street over water',()=>{const ocean=polygon('ocean',[[[0,0],[32,0],[32,32],[0,32],[0,0]]]);const road:MapFeature={layer:'streets',kind:'residential',bridge:false,type:2,geometry:[[{x:0,y:.5},{x:32,y:.5}]]};expect(normalizeChunk('0:0',[ocean,road]).cells[0].road).toBeUndefined();expect(normalizeChunk('0:0',[ocean,{...road,bridge:true}]).cells[0].road).toBe(true);});
const line=(layer:string,kind:string,points:number[][]):MapFeature=>({layer,kind,bridge:false,type:2,geometry:[points.map(([x,y])=>({x,y}))]});
test('only driveable ways become roads',()=>{
 const road=(kind:string)=>normalizeChunk('0:0',[line('streets',kind,[[0,.5],[30,.5]])]).cells[0].road;
 for(const kind of ['footway','steps','path','cycleway','pedestrian','bridleway','rail','subway','track','ferry','','(unknown)'])expect(road(kind)).toBeUndefined();
 for(const kind of ['residential','service','unclassified','tertiary','secondary','primary','trunk','motorway','living_street','road','primary_link'])expect(road(kind)).toBe(true);
});
test('parking sites and non-green land uses stay land while parks turn green',()=>{
 const terrain=(layer:string,kind:string)=>normalizeChunk('0:0',[{...polygon(layer,[[[0,0],[32,0],[32,32],[0,32],[0,0]]]),kind}]).cells[0].terrain;
 for(const kind of ['park','forest','grass','garden','meadow','scrub','farmland','recreation_ground','cemetery'])expect(terrain('land',kind)).toBe('green');
 for(const kind of ['parking','bicycle_parking','construction','commercial','residential','industrial','retail','(unknown)'])expect(terrain('sites',kind)).toBe('land');
});
test('a tile with thousands of rings stays fast and keeps holes as holes',()=>{
 // One `buildings` feature carries every footprint of a tile (São Paulo: 10.137 rings). Scanning all rings for every
 // cell took ~800 ms per region; clipping each ring to its own bounding box is what makes a city appear at once.
 const rings:number[][][]=[];
 for(let k=0;k<3000;k+=1){
  const x=(k*7)%4096,y=(k*13)%4096;
  rings.push([[x,y],[x+3,y],[x+3,y+3],[x,y+3],[x,y]]);
  rings.push([[x+1,y+1],[x+2,y+1],[x+2,y+2],[x+1,y+2],[x+1,y+1]]);   // hole inside the footprint
 }
 const feature:MapFeature={layer:'buildings',kind:'',bridge:false,type:3,geometry:rings.map(ring=>ring.map(([x,y])=>({x,y})))};
 const started=Date.now(),chunk=normalizeChunk('0:0',[feature]),elapsed=Date.now()-started;
 expect(elapsed).toBeLessThan(500);
 const built=chunk.cells.filter(cell=>cell.building).length;
 expect(built).toBeGreaterThan(0);
 const [x,y]=[rings[0]![0]![0]!,rings[0]![0]![1]!];
 if(x>=0&&x<28&&y>=0&&y<28){
  expect(chunk.cells[(y+1)*32+x+1]!.building).toBeUndefined();   // the hole stays empty
  expect(chunk.cells[y*32+x]!.building).toBeTruthy();
 }
});
