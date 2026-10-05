import type {WorldView} from './canvas-renderer';
import {WORLD,coordAt} from '../../core/coordinates';
import type {Building,Cell,CellCoord} from '../../core/model';
import {isPowered} from '../../core/simulation';
import {cellSpace,TILE_W,type Point} from '../../presentation/camera';
import {assembledFootprints,type Footprint} from '../../presentation/city-art';
import {nearestWorldX,type GeographicFeature} from '../../presentation/geographic-map';
import {createSpatialIndex,buildCellIndex,remainingIndexed,type Bounds} from '../../presentation/spatial-index';
import {foundationElevation,projectSurface,surfaceDepth} from './terrain-renderer';
export type PreparedBuilding={footprint:Footprint;shift:number;kind?:Building;stage?:number;powered?:boolean;depth:number;base?:number};
export type PreparedScene={key:string;centre:Point;box:Bounds;edits:readonly {coord:CellCoord;cell:Cell}[];features:readonly {feature:GeographicFeature;shift:number}[];roads:{feature:GeographicFeature;shift:number}[];buildings:readonly PreparedBuilding[];labels:readonly {point:Point;name:string;kind:string}[]};
const bounds=(f:GeographicFeature):Bounds=>{let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;for(const ring of f.geometry)for(const p of ring){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}return {minX,minY,maxX,maxY};};
const editVersions=new WeakMap<object,{key:string;edits:{coord:CellCoord;cell:Cell}[];index:ReturnType<typeof createSpatialIndex<number>>}>();
function editsOf(view:WorldView){const chunks=view.state.chunks,known=editVersions.get(chunks);if(known)return known;const edits:{coord:CellCoord;cell:Cell}[]=[];for(const [id,chunk] of Object.entries(chunks))for(const [i,cell] of Object.entries(chunk.edits))if(cell.origin!=='imported')edits.push({coord:coordAt(id,Number(i)),cell});const index=createSpatialIndex(edits.map((e,value)=>({bounds:{minX:e.coord.x,minY:e.coord.y,maxX:e.coord.x,maxY:e.coord.y},value})),256);const result={edits,key:JSON.stringify(edits),index};editVersions.set(chunks,result);return result;}
const powerVersions=new WeakMap<object,string>();
export function playerSceneKey(view:WorldView):string{
 const source=editsOf(view),chunks=view.state.chunks;let powerKey=powerVersions.get(chunks);
 if(powerKey===undefined){powerKey=source.edits.filter(e=>e.cell.building&&e.cell.building!=='park').map(e=>Number(view.playerPower?.get(`${e.coord.x}:${e.coord.y}`)??isPowered(view.state,e.coord))).join('');powerVersions.set(chunks,powerKey);}
 return source.key+':'+powerKey;
}
export function createScenePreparer(){
 let geometryTiles:object|undefined,featureIndex:ReturnType<typeof createSpatialIndex<GeographicFeature>>|undefined,buildingIndex:ReturnType<typeof createSpatialIndex<Footprint>>|undefined;
 let last:PreparedScene|undefined,lastTerrain:object|undefined,lastTiles:object|undefined;
 let geometryBuilds=0,projectionBuilds=0,foundationReads=0;
 let foundationTiles:object|undefined,foundations=new WeakMap<Footprint,number|undefined>();
 const baseOf=(view:WorldView,footprint:Footprint,shift:number)=>{if(foundations.has(footprint))return foundations.get(footprint);foundationReads++;const base=foundationElevation(view,footprint.rings.flatMap(r=>r.map(p=>({x:p.x+shift-.5,y:p.y-.5}))));foundations.set(footprint,base);return base;};
 return {prepare(view:WorldView):PreparedScene{
  const {camera,viewport}=view,tiles=view.geography?.tiles,terrain=view.terrain?.tiles,source=editsOf(view);
  const powerKey=playerSceneKey(view);
  const key=[camera.x,camera.y,camera.zoom,camera.rotation,viewport.width,viewport.height,view.pixelRatio,view.light,view.geography?.revision,view.terrain?.revision,source.key,powerKey].join(':');
  if(last?.key===key&&lastTiles===tiles&&lastTerrain===terrain)return last;
  if(geometryTiles!==tiles||!featureIndex){geometryTiles=tiles;geometryBuilds++;const features=(tiles??[]).flatMap(t=>t.features);featureIndex=createSpatialIndex(features.map(feature=>({bounds:bounds(feature),value:feature})),256);buildingIndex=createSpatialIndex(assembledFootprints(tiles??[]).map(footprint=>({bounds:footprint,value:footprint})),256);}
  if(foundationTiles!==terrain){foundationTiles=terrain;foundations=new WeakMap();}
  projectionBuilds++;
  const scale=TILE_W*camera.zoom,centre=cellSpace({x:viewport.width/2,y:viewport.height/2},camera),corners=[[0,0],[viewport.width,0],[0,viewport.height+scale*8],[viewport.width,viewport.height+scale*8]].map(([x,y])=>cellSpace({x,y},camera));
  const box={minX:Math.min(...corners.map(p=>p.x)),maxX:Math.max(...corners.map(p=>p.x)),minY:Math.min(...corners.map(p=>p.y)),maxY:Math.max(...corners.map(p=>p.y))};
  const candidates=new Set<number>(),turn=Math.floor(centre.x/WORLD);for(let wrap=turn-1;wrap<=turn+1;wrap++)for(const at of source.index.query({minX:box.minX-1-wrap*WORLD,maxX:box.maxX+1-wrap*WORLD,minY:box.minY-1,maxY:box.maxY+1}))candidates.add(at);
  const edits=[...candidates].sort((a,b)=>a-b).map(i=>source.edits[i]).map(e=>({...e,coord:{x:nearestWorldX(e.coord.x,centre.x),y:e.coord.y}})).filter(e=>e.coord.x>=box.minX-1&&e.coord.x<=box.maxX+1&&e.coord.y>=box.minY-1&&e.coord.y<=box.maxY+1);
  const features:{feature:GeographicFeature;shift:number}[]=[],buildings:PreparedBuilding[]=[],labels:{point:Point;name:string;kind:string}[]=[],roads:{feature:GeographicFeature;shift:number}[]=[];
  for(let wrap=turn-1;wrap<=turn+1;wrap++){const shift=wrap*WORLD,local={...box,minX:box.minX-shift,maxX:box.maxX-shift};for(const feature of featureIndex.query(local)){features.push({feature,shift});if(feature.layer==='streets'&&!feature.tunnel)roads.push({feature,shift});if(feature.layer==='place_labels'&&feature.name&&camera.zoom<.12){const p=feature.geometry[0]?.[0];if(p)labels.push({point:projectSurface(view,{x:p.x+shift,y:p.y}),name:feature.name,kind:feature.kind});}}
   const cuts=edits.map(e=>({x:e.coord.x-shift,y:e.coord.y})),cutIndex=buildCellIndex(cuts),cutScratch=new Int32Array(cutIndex.items.length),picked:CellCoord[]=[];
   for(const footprint of buildingIndex!.query(local)){const base=baseOf(view,footprint,shift),depth=Math.max(...footprint.rings[0].map(p=>surfaceDepth(view,{x:p.x+shift,y:p.y},base)));for(const remaining of remainingIndexed(footprint,cuts,cutIndex,picked,cutScratch))buildings.push({footprint:remaining,shift,base,depth});}
  }
  for(const {coord,cell} of edits)if(cell.building&&cell.building!=='park'){const r=cell.building==='industrial'?.42:.34,ring=[{x:coord.x-r+.5,y:coord.y-r+.5},{x:coord.x+r+.5,y:coord.y-r+.5},{x:coord.x+r+.5,y:coord.y+r+.5},{x:coord.x-r+.5,y:coord.y+r+.5},{x:coord.x-r+.5,y:coord.y-r+.5}],footprint={rings:[ring],minX:coord.x-r,maxX:coord.x+r,minY:coord.y-r,maxY:coord.y+r,area:r*r*4,kind:cell.building,seed:(coord.x^Math.imul(coord.y,19349663))>>>0};buildings.push({footprint,shift:0,kind:cell.building,stage:cell.stage,powered:view.playerPower?.get(`${((coord.x%WORLD)+WORLD)%WORLD}:${coord.y}`)??isPowered(view.state,{x:((coord.x%WORLD)+WORLD)%WORLD,y:coord.y}),base:baseOf(view,footprint,0),depth:surfaceDepth(view,coord)});}
  buildings.sort((a,b)=>a.depth-b.depth);lastTiles=tiles;lastTerrain=terrain;
  return last={key,centre,box,edits,features,roads,buildings,labels};
 },clear(){last=undefined;lastTiles=undefined;lastTerrain=undefined;foundationTiles=undefined;geometryTiles=undefined;featureIndex=undefined;buildingIndex=undefined;foundations=new WeakMap();},stats:()=>({geometryBuilds,projectionBuilds,foundationReads,retainedTileSets:Number(!!geometryTiles)})};
}
