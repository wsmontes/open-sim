import polygonClipping from 'polygon-clipping';
import type {Building,Cell,CellCoord} from '../core/model';
import {WORLD,wrapX} from '../core/coordinates';
import type {GeographicFeature,GeographicTile} from './geographic-map';
import type {Point} from './camera';
export type Footprint={rings:Point[][];minX:number;maxX:number;minY:number;maxY:number;area:number;kind:string;height?:number;seed:number};
const signedArea=(ring:Point[])=>ring.reduce((area,p,i)=>{const q=ring[(i+1)%ring.length];return area+p.x*q.y-q.x*p.y;},0)/2;
const cache=new WeakMap<GeographicFeature,Footprint[]>();
export function buildingFootprints(feature:GeographicFeature):Footprint[]{
 const cached=cache.get(feature);if(cached)return cached;
 const out:Footprint[]=[];let winding=0;
 for(const ring of feature.geometry){
  if(ring.length<4)continue;
  const area=signedArea(ring);if(Math.abs(area)<.001)continue;
  if(!winding)winding=Math.sign(area);
  if(Math.sign(area)!==winding&&out.length){out[out.length-1].rings.push(ring);continue;}
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(const p of ring){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
  out.push({rings:[ring],minX,maxX,minY,maxY,area:Math.abs(area),kind:feature.kind,height:feature.height,
   seed:(Math.imul(Math.round(minX*16),73856093)^Math.imul(Math.round(minY*16),19349663))>>>0});
 }
 cache.set(feature,out);return out;
}
export function pointInside(point:Point,rings:readonly Point[][]):boolean{
 let inside=false;
 for(const ring of rings)for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i],b=ring[j];
  if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
 }
 return inside;
}
export function footprintEdited(footprint:Footprint,edits:readonly CellCoord[]):boolean{
 return edits.some(c=>c.x+.5>=footprint.minX&&c.x+.5<=footprint.maxX&&c.y+.5>=footprint.minY&&c.y+.5<=footprint.maxY&&pointInside({x:c.x+.5,y:c.y+.5},footprint.rings));
}
const palettes:Record<Building,readonly string[]>={
 residential:['#aa6450','#a07c56','#6b7880','#b7956e','#73827a','#967164'],
 commercial:['#588a99','#647b91','#8b989d','#a8a79a','#637d86','#847f91'],
 industrial:['#8e9082','#797c73','#aa927a','#6c7a81'],park:['#67966c'],power:['#777d80'],
};
export function buildingAppearance(kind:Building,stage:number,seed:number){
 const palette=palettes[kind],index=seed%palette.length;
 return{roof:palette[index],light:kind==='commercial'?['#c4d2cf','#b7c7d2','#d2c8ac','#bfc6bd','#c4b9b2','#a7bdc4'][index]:['#e1d5bb','#d2bda4','#cbb6a0','#d8d1bb'][seed%4],
 dark:kind==='commercial'?['#7c9aa4','#75869f','#9d8e72','#7f8e7d','#96827d','#658997'][index]:['#a18d77','#a99b83','#aa8e79','#9ca58f'][seed%4],
 floors:Math.max(1,stage),form:seed%4};
}
export function roadConnections(cell:CellCoord,lookup:(p:CellCoord)=>Cell|null){
 const road=(x:number,y:number)=>y>=0&&y<WORLD&&!!lookup({x:wrapX(x),y})?.road;
 return{east:road(cell.x+1,cell.y),west:road(cell.x-1,cell.y),north:road(cell.x,cell.y-1),south:road(cell.x,cell.y+1)};
}

const assemblyCache=new WeakMap<readonly GeographicTile[],Footprint[]>();
const polygonOf=(f:Footprint)=>f.rings.map(r=>r.map(p=>[p.x,p.y] as [number,number]));
// The source clips buildings into buffered tiles without feature IDs. Only positive
// overlap across adjacent tile boundaries joins fragments; shared walls do not.
export function assembledFootprints(tiles:readonly GeographicTile[]):Footprint[]{
 const cached=assemblyCache.get(tiles);if(cached)return cached;
 const all:Array<{f:Footprint;tile:GeographicTile;edge:boolean}>=[];
 const anchor=tiles[0]?tiles[0].x*WORLD/2**tiles[0].z:0;
 for(const tile of tiles){
  const side=WORLD/2**tile.z,x0=tile.x*side,y0=tile.y*side;
  const shift=Math.round((anchor-x0)/WORLD)*WORLD;
  for(const feature of tile.features)if(feature.layer==='buildings')for(const original of buildingFootprints(feature)){
   const f=shift?{...original,minX:original.minX+shift,maxX:original.maxX+shift,rings:original.rings.map(r=>r.map(p=>({x:p.x+shift,y:p.y})))}:original;
   all.push({f,tile,edge:original.minX<x0+1||original.maxX>x0+side-1||original.minY<y0+1||original.maxY>y0+side-1});
  }
 }
 const parent=all.map((_,i)=>i),root=(i:number):number=>parent[i]===i?i:(parent[i]=root(parent[i]));
 const edges=all.map((v,i)=>({...v,i})).filter(v=>v.edge).sort((a,b)=>a.f.minX-b.f.minX);
 for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length&&edges[j].f.minX<edges[i].f.maxX;j++){
  const a=edges[i],b=edges[j];
  if(a.tile===b.tile||a.tile.z!==b.tile.z||a.f.maxY<=b.f.minY||b.f.maxY<=a.f.minY)continue;
  const overlap=polygonClipping.intersection(polygonOf(a.f),polygonOf(b.f));
  if(overlap.some(p=>Math.abs(signedArea(p[0].map(([x,y])=>({x,y}))))>.00001))parent[root(b.i)]=root(a.i);
 }
 const groups=new Map<number,Footprint[]>();all.forEach(({f},i)=>{const r=root(i),g=groups.get(r);if(g)g.push(f);else groups.set(r,[f]);});
 const result:Footprint[]=[];
 for(const group of groups.values()){
  if(group.length===1){result.push(group[0]);continue;}
  const joined=polygonClipping.union(polygonOf(group[0]),...group.slice(1).map(polygonOf));
  const feature:GeographicFeature={layer:'buildings',kind:group[0].kind,height:group[0].height,bridge:false,type:3,geometry:joined.flatMap(p=>p.map(r=>r.map(([x,y])=>({x,y}))))};
  result.push(...buildingFootprints(feature));
 }
 assemblyCache.set(tiles,result);return result;
}

export function remainingFootprints(footprint:Footprint,edits:readonly CellCoord[]):Footprint[]{
 const affected=edits.filter(c=>c.x+1>footprint.minX&&c.x<footprint.maxX&&c.y+1>footprint.minY&&c.y<footprint.maxY);
 if(!affected.length)return[footprint];
 const cuts=affected.map(c=>[[[c.x,c.y],[c.x+1,c.y],[c.x+1,c.y+1],[c.x,c.y+1],[c.x,c.y]]] as polygonClipping.Polygon);
 const result=polygonClipping.difference(polygonOf(footprint),...cuts);
 const feature:GeographicFeature={layer:'buildings',kind:footprint.kind,height:footprint.height,bridge:false,type:3,geometry:result.flatMap(p=>p.map(r=>r.map(([x,y])=>({x,y}))))};
 return buildingFootprints(feature).map(f=>({...f,area:footprint.area,seed:footprint.seed}));
}

export type CityRegion='neutral'|'vancouver'|'sao-paulo'|'lisbon';
export function regionOf(focus:{lat:number;lon:number}):CityRegion{
 for(const [region,lat,lon] of [['vancouver',49.2827,-123.1207],['sao-paulo',-23.5505,-46.6333],['lisbon',38.7223,-9.1393]] as const)
  if(Math.hypot(focus.lat-lat,(focus.lon-lon)*Math.cos(lat*Math.PI/180))<.5)return region;
 return 'neutral';
}
export function architectureOf(f:Footprint,kind:Building|undefined,stage:number|undefined,region:CityRegion){
 const ratio=(f.maxX-f.minX)/Math.max(.1,f.maxY-f.minY),seed=f.seed,width=Math.max(.1,f.maxX-f.minX);
 const usage=kind??(f.kind==='industrial'||(f.area>100&&(ratio>3||ratio<.33))?'industrial':f.kind==='commercial'||f.area>20?'commercial':'residential');
 const floors=stage??(f.height?Math.max(1,Math.round(f.height/3)):usage==='industrial'?2:region==='lisbon'?f.area<4?1:3+seed%4:f.area<4?1:f.area<12?2+seed%3:f.area<30?4+seed%5:7+seed%13);
 const archetype=stage===0?'construction':usage==='power'?'plant':usage==='industrial'?'warehouse':usage==='commercial'?(floors>=7?'glass':floors<4?'shop':'masonry'):floors<=2?(f.area<4?'house':'rowhouse'):'apartment';
 const style=buildingAppearance(usage,floors,seed);
 const tiled=region==='lisbon'&&floors<8&&usage!=='industrial'||archetype==='house'||archetype==='rowhouse';
 // What the block is made of, not only how tall it is: a row is several front doors sharing a wall, the older
 // building carries a cornice under its roof, the shop opens a glazed frontage onto the street, the factory roof is
 // saw-toothed and the apartment block has its tank and stair head on the roof. All of it comes from the footprint
 // the map gave, so two clients looking at the same street draw the same street.
 const units=archetype==='rowhouse'?Math.max(2,Math.min(6,Math.round(width/2.6))):1;
 return{...style,usage,archetype,roofType:tiled?'tile':'flat',units,
  cornice:archetype==='masonry'||(archetype==='apartment'&&(floors<=4||region==='lisbon')),
  storefront:usage==='commercial'&&archetype!=='glass',
  sawtooth:archetype==='warehouse',rooftop:archetype==='apartment'&&floors>=5,
  roof:tiled?['#a96b4f','#b77b57','#9e644c','#bc805b'][seed%4]:style.roof,
  light:archetype==='glass'?['#a6c1c2','#a0b9c7','#a6bfb7'][seed%3]:archetype==='masonry'&&region!=='lisbon'?['#d4bca5','#d5ccb8','#c8b6aa'][seed%3]:region==='lisbon'&&usage!=='industrial'?['#e4d2b3','#d7c394','#d6bca8','#d6dcc7'][seed%4]:style.light,
  dark:archetype==='glass'?['#668c96','#6b859c','#6e9386'][seed%3]:archetype==='masonry'&&region!=='lisbon'?['#9e846e','#9e9580','#9b8178'][seed%3]:region==='lisbon'&&usage!=='industrial'?['#b79e81','#aa966e','#af8e7a','#98a48e'][seed%4]:style.dark,
  balconies:archetype==='apartment'||region==='sao-paulo'&&archetype==='masonry',
  canopy:archetype==='shop',glass:archetype==='glass',floors};
}
