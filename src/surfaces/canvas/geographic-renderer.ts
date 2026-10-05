import {waterGlints} from './water-glints';
import {sceneRasterCache} from './scene-cache';
import {createSceneCompositor,type SceneCommand} from './scene-compositor';
import {createScenePreparer} from './prepared-scene';
import {aircraftDrawCommands} from './aircraft-draw';
import {vesselDrawCommands} from './vessel-draw';
import {lightContext} from './city-light';
import {mobilityDrawCommands} from './mobility-draw';
import {drawTerrain,projectSurface,surfaceLine,foundationElevation,terrainRoadPath,} from './terrain-renderer';
import {drawStreetDetails,drawPaving,drawPlanting,drawParkPlanting,drawTree} from './street-renderer';
import {drawBuilding,drawGhost,buildingScreenBounds} from './architecture-renderer';
import {geoOrthographic,geoPath,geoGraticule10} from 'd3-geo';
import type {GeoPermissibleObjects} from 'd3-geo';
import worldLand from './world-land.json';
import type {WorldView} from './canvas-renderer';
import {chunkId,cellIndex} from '../../core/coordinates';
import type {Cell,CellCoord} from '../../core/model';
import {roadClassOf} from '../../core/model';
import {TILE_W,type Point} from '../../presentation/camera';
import {roadConnections,} from '../../presentation/city-art';
import {geographicFocus,GLOBE_ZOOM,globePoint,planetRadius,type GeographicFeature} from '../../presentation/geographic-map';

const land=worldLand as unknown as GeoPermissibleObjects;
const graticule=geoGraticule10();
const PARKS=new Set(['park','garden','grass','forest','wood','meadow','scrub','heath','farmland','orchard','vineyard','allotments','village_green','recreation_ground','nature_reserve','golf_course','cemetery']);
const URBAN=new Set(['residential','commercial','industrial','retail','construction']);
// The tools that place a volume on the lot: a road is a surface, a zone is a building, and only the second one can be
// previewed as a building.
const ZONE_TOOLS=new Set<string>(['residential','commercial','industrial','power','park']);
const PALETTE={ground:'#b6bd96',park:'#91ad79',forest:'#759267',water:'#648d9e',shore:'#aac3c3',pavement:'#656d6b',sidewalk:'#cec6b3'};
function path(ctx:CanvasRenderingContext2D,rings:readonly Point[][],offsetX=0,offsetY=0){
 ctx.beginPath();for(const ring of rings){if(!ring.length)continue;ctx.moveTo(ring[0].x+offsetX,ring[0].y+offsetY);for(let i=1;i<ring.length;i++)ctx.lineTo(ring[i].x+offsetX,ring[i].y+offsetY);ctx.closePath();}
}
const polygonProjections=new WeakMap<GeographicFeature,{cameraKey:string;tiles:object|undefined;rings:Map<number,Point[][]>}>();
const projectRing=(view:WorldView,ring:Point[],shift:number,feature?:GeographicFeature)=>{
 const ocean=feature?.layer==='ocean'&&view.terrain?.tiles.some(t=>t.verticalDatum==='CGVD2013');
 if(!feature)return surfaceLine(view,ring.map(p=>({x:p.x+shift-.5,y:p.y-.5})),ocean?0:undefined);
 const cameraKey=[view.camera.x,view.camera.y,view.camera.zoom,view.camera.rotation].join(':');
 let cached=polygonProjections.get(feature);
 if(!cached||cached.cameraKey!==cameraKey||cached.tiles!==view.terrain?.tiles){cached={cameraKey,tiles:view.terrain?.tiles,rings:new Map()};polygonProjections.set(feature,cached);}
 let rings=cached.rings.get(shift);
 if(!rings){rings=feature.geometry.map(r=>surfaceLine(view,r.map(p=>({x:p.x+shift-.5,y:p.y-.5})),ocean?0:undefined));cached.rings.set(shift,rings);}
 return rings[feature.geometry.indexOf(ring)];
};
function polygon(ctx:CanvasRenderingContext2D,view:WorldView,feature:GeographicFeature,shift:number,fill:string){
 // Ocean reference is a derived nominal CGVD2013 surface, not a live tide measurement.
 path(ctx,feature.geometry.map(r=>projectRing(view,r,shift,feature)));ctx.fillStyle=fill;ctx.fill('evenodd');
}
function rectCell(ctx:CanvasRenderingContext2D,view:WorldView,c:CellCoord,fill:string,r=.5){
 path(ctx,[[{x:c.x-r,y:c.y-r},{x:c.x+r,y:c.y-r},{x:c.x+r,y:c.y+r},{x:c.x-r,y:c.y+r}].map(p=>projectSurface(view,p))]);ctx.fillStyle=fill;ctx.fill();
}
function drawGlobe(ctx:CanvasRenderingContext2D,view:WorldView){
 const {width,height}=view.viewport,focus=geographicFocus(view.camera,view.viewport),x=width/2,y=height/2;
 const radius=globeRadius(view);
 ctx.fillStyle='#172a34';ctx.fillRect(0,0,width,height);
 // Sparse fixed stars do not shimmer during navigation.
 ctx.fillStyle='#78939d';for(let i=0;i<60;i++)ctx.fillRect((i*149+31)%width,(i*83+17)%height,i%5===0?2:1,1);
 const halo=ctx.createRadialGradient(x,y,radius*.9,x,y,radius*1.1);halo.addColorStop(0,'rgba(133,187,194,.25)');halo.addColorStop(1,'rgba(133,187,194,0)');
 ctx.fillStyle=halo;ctx.beginPath();ctx.arc(x,y,radius*1.1,0,Math.PI*2);ctx.fill();
 const projection=geoOrthographic().rotate([-focus.lon,-focus.lat,0]).scale(radius).translate([x,y]).precision(.4);
 const geo=geoPath(projection,ctx);
 ctx.beginPath();geo({type:'Sphere'});ctx.fillStyle='#537f96';ctx.fill();
 ctx.save();ctx.beginPath();geo({type:'Sphere'});ctx.clip();
 ctx.beginPath();geo(land);ctx.fillStyle='#aaba8b';ctx.fill();ctx.strokeStyle='#d0d2a9';ctx.lineWidth=.65;ctx.stroke();
 ctx.beginPath();geo(graticule);ctx.strokeStyle='rgba(219,232,219,.13)';ctx.lineWidth=.6;ctx.stroke();
 const shade=ctx.createRadialGradient(x-radius*.38,y-radius*.45,radius*.12,x+radius*.24,y+radius*.15,radius*1.15);
 shade.addColorStop(0,'rgba(255,244,204,.1)');shade.addColorStop(.7,'rgba(14,38,56,.02)');shade.addColorStop(1,'rgba(7,22,39,.62)');
 ctx.fillStyle=shade;ctx.fillRect(x-radius,y-radius,radius*2,radius*2);ctx.restore();
 ctx.strokeStyle='rgba(204,236,231,.65)';ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.stroke();
 const places=[{lat:49.2827,lon:-123.1207,name:'Vancouver'},{lat:-23.5505,lon:-46.6333,name:'São Paulo'},{lat:38.7223,lon:-9.1393,name:'Lisboa'}];
 ctx.font=`${12*(view.pixelRatio??1)}px system-ui`;ctx.textBaseline='middle';
 for(const place of places){const p=globePoint(place,focus,radius);if(!p.visible)continue;ctx.fillStyle='#f0d38e';ctx.beginPath();ctx.arc(x+p.x,y+p.y,3*(view.pixelRatio??1),0,Math.PI*2);ctx.fill();ctx.fillStyle='#f3eedb';ctx.fillText(place.name,x+p.x+8*(view.pixelRatio??1),y+p.y);}
 // A fixed centre mark shows where zooming back in will land.
 ctx.strokeStyle='rgba(255,239,190,.85)';ctx.lineWidth=1;ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.stroke();
}
export const globeRadius=(view:Pick<WorldView,'camera'|'viewport'>)=>planetRadius(view.camera.zoom,view.viewport);

function roadPath(ctx:CanvasRenderingContext2D,view:WorldView,feature:GeographicFeature,shift:number){
 let mapped=roadPoints.get(feature);if(!mapped){mapped=new Map();roadPoints.set(feature,mapped);}
 let rings=mapped.get(shift);if(!rings){rings=feature.geometry.map(ring=>ring.map(p=>({x:p.x+shift-.5,y:p.y-.5})));mapped.set(shift,rings);}
 ctx.beginPath();for(const points of rings){
  // Without an official deck height, derive one level from the bridge's terrain abutments.
  const deck=feature.bridge?foundationElevation(view,points):undefined;
  terrainRoadPath(ctx,view,points,deck);
 }
}
const roadPoints=new WeakMap<GeographicFeature,Map<number,readonly Point[][]>>();
// A street is drawn in passes, not whole one feature after another. Painted whole, the second street of every crossing
// lays its kerb across the pavement of the first and the corner becomes a pale bar over a dark road — the seam that
// shows at every junction. Kerbs for the whole city first, then the surfaces, then the markings: every street then has
// the same claim on a junction, the kerb survives only where no pavement covers it, and a crossing reads as a crossing.
export type RoadPass='kerb'|'surface'|'marking';
// What a street is, read once per feature and kept: the three passes below ask the same three questions of every street
// in the city, and a regular expression per street per pass is a cost the far zooms pay for nothing.
const roadKinds=new WeakMap<GeographicFeature,{highway:boolean;arterial:boolean;pathway:boolean}>();
function roadKindOf(feature:GeographicFeature){
 let kind=roadKinds.get(feature);
 if(!kind){kind={highway:/^(motorway|trunk)/.test(feature.kind),arterial:/^(primary|secondary)/.test(feature.kind),pathway:/^(footway|path|steps|cycleway|pedestrian)/.test(feature.kind)};roadKinds.set(feature,kind);}
 return kind;
}
function drawRoads(ctx:CanvasRenderingContext2D,view:WorldView,roads:Array<{feature:GeographicFeature;shift:number}>,pass:RoadPass){
 const scale=TILE_W*view.camera.zoom;
 ctx.lineCap='round';ctx.lineJoin='round';
 for(const {feature,shift} of roads){
  const {highway,arterial,pathway}=roadKindOf(feature);
  const width=Math.max(pathway?.55:1,(highway?1.65:arterial?1.2:pathway?.10:feature.kind==='service'?.4:.8)*scale);
  // A footpath is not a road with kerbs: it is one quiet band, drawn with the kerbs so that the pavement of the street
  // it meets runs over it instead of under it.
  if(pathway){if(pass==='kerb'){roadPath(ctx,view,feature,shift);ctx.strokeStyle='#cac7ad';ctx.lineWidth=Math.max(1.1,width);ctx.stroke();}continue;}
  if(pass==='kerb'){roadPath(ctx,view,feature,shift);ctx.strokeStyle=PALETTE.sidewalk;ctx.lineWidth=width+Math.max(.8,scale*.23);ctx.stroke();continue;}
  if(pass==='surface'){roadPath(ctx,view,feature,shift);ctx.strokeStyle=highway?'#8d8870':PALETTE.pavement;ctx.lineWidth=width;ctx.stroke();continue;}
  if(width>6){roadPath(ctx,view,feature,shift);ctx.strokeStyle=highway?'#ebd696':'#e0d8bf';ctx.lineWidth=Math.max(.6,scale*.016);ctx.setLineDash([Math.max(2,scale*.16),Math.max(2,scale*.14)]);ctx.stroke();ctx.setLineDash([]);}
 }
}
function drawPlayerRoad(ctx:CanvasRenderingContext2D,view:WorldView,c:CellCoord,cell:Cell,lookup:(p:CellCoord)=>Cell|null,pass:RoadPass){
 const scale=TILE_W*view.camera.zoom,kind=roadClassOf(cell);
 const width=Math.max(1,scale*(kind==='highway'?.56:kind==='avenue'?.4:.25)),p=projectSurface(view,c);
 if(pass==='kerb'||pass==='surface'){
  // The player's street joins the city's streets on the same terms: its kerb is laid in the kerb pass, so where it
  // meets a mapped street the two pavements meet and neither kerb is drawn over the other.
  const connections=roadConnections(c,lookup);
  ctx.strokeStyle=pass==='kerb'?PALETTE.sidewalk:PALETTE.pavement;ctx.lineWidth=pass==='kerb'?width+scale*.1:width;
  for(const [key,dx,dy] of [['east',.5,0],['west',-.5,0],['north',0,-.5],['south',0,.5]] as const){
   if(!connections[key])continue;const end=projectSurface(view,{x:c.x+dx,y:c.y+dy});
   ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(end.x,end.y);ctx.stroke();
  }
 }
 if(pass==='surface'){ctx.fillStyle=PALETTE.pavement;ctx.beginPath();ctx.arc(p.x,p.y,width*.5,0,Math.PI*2);ctx.fill();}
}
const scenePreparer=createScenePreparer();
const compositors=new WeakMap<object,ReturnType<typeof createSceneCompositor>>(),staticCommands=new WeakMap<object,WeakMap<object,readonly SceneCommand[]>>();
export function drawInteractionOverlay(ctx:CanvasRenderingContext2D,view:WorldView){
 const scale=TILE_W*view.camera.zoom;ctx=lightContext(ctx,view.light??'day');
 if(view.tool!=='explore')for(const cell of view.preview){
  rectCell(ctx,view,cell,view.previewAffordable?'rgba(100,178,107,.4)':'rgba(199,86,70,.4)');ctx.strokeStyle=view.previewAffordable?'#f5e4a2':'#f3b1a0';ctx.lineWidth=1.5;ctx.stroke();
  if(!ZONE_TOOLS.has(view.tool)||view.preview.length>96)continue;
  const r=view.tool==='industrial'?.42:.34;drawGhost(ctx,view,{rings:[[{x:cell.x-r+.5,y:cell.y-r+.5},{x:cell.x+r+.5,y:cell.y-r+.5},{x:cell.x+r+.5,y:cell.y+r+.5},{x:cell.x-r+.5,y:cell.y+r+.5},{x:cell.x-r+.5,y:cell.y-r+.5}]],minX:cell.x-r,maxX:cell.x+r,minY:cell.y-r,maxY:cell.y+r,area:r*r*4,kind:view.tool,seed:(cell.x^Math.imul(cell.y,19349663))>>>0},view.previewAffordable);
 }
 if(view.hover&&scale>=1.12){rectCell(ctx,view,view.hover,'rgba(255,244,191,.15)');ctx.strokeStyle='#f5e4a2';ctx.lineWidth=1;ctx.stroke();}
}
export function resetGeographicComposition(ctx:CanvasRenderingContext2D){compositors.get(lightContext(ctx,'day'))?.clear();compositors.get(lightContext(ctx,'night'))?.clear();}
export const preparedSceneStats=()=>scenePreparer.stats();
let groundBitmap:{key:string;tiles:object|undefined;terrain:object|undefined;canvas:OffscreenCanvas}|undefined;
export function renderGeographicWorld(ctx:CanvasRenderingContext2D,view:WorldView){
 if(view.camera.zoom<GLOBE_ZOOM){compositors.get(lightContext(ctx,view.light??'day'))?.clear();drawGlobe(ctx,view);return;}
 ctx=lightContext(ctx,view.light??'day');
 const {camera,viewport}=view,scale=TILE_W*camera.zoom;
 ctx.imageSmoothingEnabled=true;ctx.lineJoin='round';ctx.lineCap='round';
 const prepared=scenePreparer.prepare(view),{centre,box,edits,features,roads,buildings,labels}=prepared;
 const mainContext=ctx,groundKey=prepared.key;
 const cachedGround=typeof OffscreenCanvas!=='undefined'&&sceneRasterCache.get('geographic-ground')?.canvas===groundBitmap?.canvas&&groundBitmap?.key===groundKey&&groundBitmap.tiles===view.geography?.tiles&&groundBitmap.terrain===view.terrain?.tiles;
 let groundCanvas:OffscreenCanvas|undefined;
 if(!cachedGround&&typeof OffscreenCanvas!=='undefined'&&viewport.width*viewport.height*4<=128*1024*1024){
  groundCanvas=new OffscreenCanvas(viewport.width,viewport.height);
  groundCanvas.width=viewport.width;groundCanvas.height=viewport.height;
  const groundContext=groundCanvas.getContext('2d');if(groundContext){ctx=lightContext(groundContext as unknown as CanvasRenderingContext2D,view.light??'day');ctx.fillStyle=PALETTE.ground;ctx.fillRect(0,0,viewport.width,viewport.height);}else groundCanvas=undefined;
 }
 if(!cachedGround){
 if(!groundCanvas){ctx.fillStyle=PALETTE.ground;ctx.fillRect(0,0,viewport.width,viewport.height);}
 drawTerrain(ctx,view);
 for(const layer of ['land','sites','ocean','water_polygons','street_polygons'])for(const {feature,shift} of features){
  if(feature.layer!==layer||feature.type!==3)continue;
  const fill=layer==='ocean'||layer==='water_polygons'?feature.kind==='glacier'?'#d5ded8':PALETTE.water:layer==='street_polygons'?PALETTE.sidewalk:PARKS.has(feature.kind)?feature.kind==='forest'||feature.kind==='wood'?PALETTE.forest:PALETTE.park:URBAN.has(feature.kind)?'#c3bdaa':PALETTE.ground;
  ctx.globalAlpha=view.terrain?.tiles.length&&(layer==='land'||layer==='sites')?.35:1;
  polygon(ctx,view,feature,shift,fill);ctx.globalAlpha=1;
  if(layer==='street_polygons')drawPaving(ctx,view,feature,shift);
  if(layer==='water_polygons'||layer==='ocean'){path(ctx,feature.geometry.map(r=>projectRing(view,r,shift,feature)));ctx.strokeStyle=PALETTE.shore;ctx.lineWidth=Math.min(1.3,scale*.12);ctx.stroke();}
  if(PARKS.has(feature.kind)&&view.moving!==true)drawParkPlanting(ctx,view,feature,shift,box);
 }
 }
 for(const {feature,shift} of features){
  if(!cachedGround&&feature.layer==='water_lines'){roadPath(ctx,view,feature,shift);ctx.strokeStyle=PALETTE.water;ctx.lineWidth=Math.max(1,scale*.06);ctx.stroke();}
  if(!cachedGround&&feature.layer==='boundaries'&&camera.zoom<.003){roadPath(ctx,view,feature,shift);ctx.strokeStyle='rgba(91,94,73,.35)';ctx.lineWidth=.7;ctx.setLineDash([3,4]);ctx.stroke();ctx.setLineDash([]);}
 }
 const lookup=(p:CellCoord):Cell|null=>{const id=chunkId(p),managed=view.state.chunks[id],i=cellIndex(p),status=view.chunks.get(id);return managed?(managed.edits[i]??managed.base.cells[i]):status?.status==='ready'?status.base.cells[i]:null;};
 // Ground for what the player changed, then every street's kerb, then every surface, then the markings, then the
 // street furniture: one order for the whole city, so no street is ever drawn across another's pavement.
 if(!cachedGround){
 for(const {coord,cell} of edits)rectCell(ctx,view,coord,cell.terrain==='water'?PALETTE.water:cell.building==='park'?PALETTE.park:PALETTE.ground);
 drawRoads(ctx,view,roads,'kerb');
 for(const {coord,cell} of edits)if(cell.road)drawPlayerRoad(ctx,view,coord,cell,lookup,'kerb');
 drawRoads(ctx,view,roads,'surface');
 for(const {coord,cell} of edits)if(cell.road)drawPlayerRoad(ctx,view,coord,cell,lookup,'surface');
 drawRoads(ctx,view,roads,'marking');
 // While the camera is moving, the furniture is left out: it is the part of the frame that costs the most to rebuild.
 if(view.moving!==true){
  drawStreetDetails(ctx,view,roads,centre.x);
  drawPlanting(ctx,view,roads,box);
 }
 }
 for(const {coord,cell} of edits)if(!cachedGround&&cell.building==='park'&&scale>=4)drawTree(ctx,projectSurface(view,coord),scale,(coord.x^coord.y)>>>0);
 ctx=mainContext;
 const retainedGround=groundCanvas?sceneRasterCache.set('geographic-ground',{canvas:groundCanvas},viewport.width*viewport.height*4):false;
 if(groundCanvas)groundBitmap=retainedGround?{key:groundKey,tiles:view.geography?.tiles,terrain:view.terrain?.tiles,canvas:groundCanvas}:undefined;
 const waterPhase=Math.floor(view.motion*(view.quality?.waterHz??5)),waterMotion=waterPhase/(view.quality?.waterHz??5);
 const glints=waterGlints(viewport,scale,waterMotion),hasWater=features.some(({feature})=>feature.layer==='water_polygons'||feature.layer==='ocean');
 const drawGround=()=>{if(groundCanvas||cachedGround)ctx.drawImage(groundCanvas??groundBitmap!.canvas,0,0);
 for(const {feature,shift} of features)if((feature.layer==='water_polygons'||feature.layer==='ocean')&&glints.length){
  ctx.save();path(ctx,feature.geometry.map(r=>projectRing(view,r,shift,feature)));ctx.clip('evenodd');ctx.strokeStyle=view.light==='night'?scale>=7?'rgba(190,217,224,.14)':'rgba(150,186,199,.14)':scale>=7?'rgba(225,239,225,.22)':'rgba(224,240,232,.3)';
  for(const glint of glints){ctx.lineWidth=glint.lineWidth;ctx.beginPath();ctx.moveTo(glint.x,glint.y);ctx.lineTo(glint.endX,glint.y);ctx.stroke();}ctx.restore();
 }
 };
 const aviationCommands=aircraftDrawCommands(ctx,view);
 let targetStatics=staticCommands.get(prepared);if(!targetStatics){targetStatics=new WeakMap();staticCommands.set(prepared,targetStatics);}let statics=targetStatics.get(ctx);
 if(!statics){statics=buildings.map(b=>({bounds:buildingScreenBounds(view,b.footprint,b.shift,b.kind,b.stage,b.base),depth:b.depth,draw:()=>{drawBuilding(ctx,view,b.footprint,b.shift,b.kind,b.stage,0,b.powered??true,true,b.base);if(b.powered===false&&scale>=7){const p=projectSurface(view,{x:(b.footprint.minX+b.footprint.maxX)/2,y:(b.footprint.minY+b.footprint.maxY)/2});ctx.fillStyle='rgba(242,178,86,.95)';ctx.font=`bold ${Math.max(10,scale*.3)}px system-ui`;ctx.fillText('!',p.x,p.y-scale*.6);}}})).filter(c=>c.bounds.x+c.bounds.width>=0&&c.bounds.y+c.bounds.height>=0&&c.bounds.x<=viewport.width&&c.bounds.y<=viewport.height);targetStatics.set(ctx,statics);}
 let compositor=compositors.get(ctx);if(!compositor){compositor=createSceneCompositor();compositors.set(ctx,compositor);}
 const drawLabels=()=>{
 if(camera.zoom<.06){
  ctx.font=`${(camera.zoom<.003?12:11)*(view.pixelRatio??1)}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';
  const occupied:Array<{x:number;y:number;width:number}>=[];
  for(const label of labels){const p=label.point,w=ctx.measureText(label.name).width;if(p.x<50||p.x>viewport.width-50||p.y<65||p.y>viewport.height-100||occupied.some(o=>Math.abs(o.x-p.x)<(o.width+w)/2+16&&Math.abs(o.y-p.y)<24*(view.pixelRatio??1)))continue;
   occupied.push({x:p.x,y:p.y,width:w});ctx.lineWidth=3;ctx.strokeStyle='rgba(239,237,212,.85)';ctx.strokeText(label.name,p.x,p.y);ctx.fillStyle='#3c4c46';ctx.fillText(label.name,p.x,p.y);
  }
  ctx.textAlign='start';
 }
 };
 const drawOverlays=()=>{
 if(view.tool!=='explore'){
  // A box preview of a whole district is a tint, not a forest of volumes: the ghost is worth its cost on the strokes a
  // player actually places, and the tint already says what is selected.
  const ghosts=ZONE_TOOLS.has(view.tool)&&view.preview.length<=96;
  for(const cell of view.preview){
   rectCell(ctx,view,cell,view.previewAffordable?'rgba(100,178,107,.4)':'rgba(199,86,70,.4)');ctx.strokeStyle=view.previewAffordable?'#f5e4a2':'#f3b1a0';ctx.lineWidth=1.5;ctx.stroke();
   if(!ghosts)continue;
   const r=view.tool==='industrial'?.42:.34;
   drawGhost(ctx,view,{rings:[[{x:cell.x-r+.5,y:cell.y-r+.5},{x:cell.x+r+.5,y:cell.y-r+.5},{x:cell.x+r+.5,y:cell.y+r+.5},{x:cell.x-r+.5,y:cell.y+r+.5},{x:cell.x-r+.5,y:cell.y-r+.5}]],minX:cell.x-r,maxX:cell.x+r,minY:cell.y-r,maxY:cell.y+r,area:r*r*4,kind:view.tool,seed:(cell.x^Math.imul(cell.y,19349663))>>>0},view.previewAffordable);
  }
 }
 if(view.hover&&camera.zoom>=.035){rectCell(ctx,view,view.hover,'rgba(255,244,191,.15)');ctx.strokeStyle='#f5e4a2';ctx.lineWidth=1;ctx.stroke();}
 };
 const dynamic:SceneCommand[]=[...aviationCommands.aircraft.map(a=>a.grounded?a:{...a,layer:1}),...aviationCommands.shadows,...vesselDrawCommands(ctx,view),...mobilityDrawCommands(ctx,view)];
 if(hasWater)for(const [i,glint] of glints.entries())dynamic.push({id:`water:${i}`,version:waterPhase,depth:-Infinity,bounds:glint.bounds,draw(){}});
 const overlayCells=[...view.preview,...(view.hover?[view.hover]:[])],points=overlayCells.map(p=>projectSurface(view,p)),margin=Math.max(12,scale*2);
 // Labels are unchanged within a prepared view; they must not dirty the whole city every animation frame.
 if(labels.length&&camera.zoom<.06)dynamic.push({id:'map-labels',version:prepared.key,layer:2,depth:Infinity,bounds:{x:0,y:0,width:viewport.width,height:viewport.height},draw:drawLabels});
 if(points.length){const x=Math.min(...points.map(p=>p.x))-margin,y=Math.min(...points.map(p=>p.y))-margin*3;dynamic.push({layer:2,depth:Infinity,bounds:{x,y,width:Math.max(...points.map(p=>p.x))+margin-x,height:Math.max(...points.map(p=>p.y))+margin-y},draw:drawOverlays});}
 // Recorder and older browsers without raster surfaces use a complete deterministic replay.
 compositor.compose(ctx,typeof OffscreenCanvas==='undefined'?{}:prepared,viewport.width,viewport.height,drawGround,statics,dynamic);
 if(groundCanvas&&!retainedGround){groundCanvas.width=0;groundCanvas.height=0;}
}
