import {geoOrthographic,geoPath,geoGraticule10} from 'd3-geo';
import type {GeoPermissibleObjects} from 'd3-geo';
import worldLand from './world-land.json';
import type {WorldView} from './canvas-renderer';
import {WORLD,coordAt,chunkId,cellIndex} from '../../core/coordinates';
import type {Building,Cell,CellCoord} from '../../core/model';
import {roadClassOf} from '../../core/model';
import {project,cellSpace,TILE_W,TILE_H,type Point} from '../../presentation/camera';
import {assembledFootprints,buildingAppearance,remainingFootprints,roadConnections,type Footprint} from '../../presentation/city-art';
import {geographicFocus,nearestWorldX,GLOBE_ZOOM,globePoint,planetRadius,type GeographicFeature} from '../../presentation/geographic-map';

const land=worldLand as unknown as GeoPermissibleObjects;
const graticule=geoGraticule10();
const PARKS=new Set(['park','garden','grass','forest','wood','meadow','scrub','heath','farmland','orchard','vineyard','allotments','village_green','recreation_ground','nature_reserve','golf_course','cemetery']);
const URBAN=new Set(['residential','commercial','industrial','retail','construction']);
const PALETTE={ground:'#b6bd96',park:'#91ad79',forest:'#759267',water:'#648d9e',shore:'#aac3c3',pavement:'#656d6b',sidewalk:'#cec6b3'};
function path(ctx:CanvasRenderingContext2D,rings:readonly Point[][],offsetX=0,offsetY=0){
 ctx.beginPath();for(const ring of rings){if(!ring.length)continue;ctx.moveTo(ring[0].x+offsetX,ring[0].y+offsetY);for(let i=1;i<ring.length;i++)ctx.lineTo(ring[i].x+offsetX,ring[i].y+offsetY);ctx.closePath();}
}
const projectRing=(view:WorldView,ring:Point[],shift:number)=>ring.map(p=>project({x:p.x+shift-.5,y:p.y-.5},view.camera));
function polygon(ctx:CanvasRenderingContext2D,view:WorldView,feature:GeographicFeature,shift:number,fill:string){
 path(ctx,feature.geometry.map(r=>projectRing(view,r,shift)));ctx.fillStyle=fill;ctx.fill('evenodd');
}
function rectCell(ctx:CanvasRenderingContext2D,view:WorldView,c:CellCoord,fill:string,r=.5){
 path(ctx,[[{x:c.x-r,y:c.y-r},{x:c.x+r,y:c.y-r},{x:c.x+r,y:c.y+r},{x:c.x-r,y:c.y+r}].map(p=>project(p,view.camera))]);ctx.fillStyle=fill;ctx.fill();
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

function drawTree(ctx:CanvasRenderingContext2D,p:Point,size:number,seed:number){
 ctx.fillStyle='rgba(40,61,42,.18)';ctx.beginPath();ctx.ellipse(p.x+size*.16,p.y+size*.05,size*.25,size*.1,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#756750';ctx.fillRect(p.x-size*.035,p.y-size*.38,Math.max(.7,size*.07),size*.4);
 ctx.fillStyle=['#54784f','#648555','#779363'][seed%3];ctx.beginPath();ctx.ellipse(p.x,p.y-size*.4,size*.18,size*.28,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='rgba(213,224,174,.3)';ctx.beginPath();ctx.ellipse(p.x-size*.06,p.y-size*.49,size*.09,size*.15,0,0,Math.PI*2);ctx.fill();
}
function drawBuilding(ctx:CanvasRenderingContext2D,view:WorldView,footprint:Footprint,shift:number,kind?:Building,stage?:number,lift=0){
 const scale=TILE_W*view.camera.zoom,area=footprint.area,seed=footprint.seed;
 const elongated=(footprint.maxX-footprint.minX)/Math.max(.1,footprint.maxY-footprint.minY);
 const usage=kind??(footprint.kind==='industrial'||(area>80&&(elongated>3||elongated<.33))?'industrial':footprint.kind==='commercial'||area>20?'commercial':'residential');
 // Height is illustrative when Shortbread supplies no height. Geometry and location always remain the source's.
 const floors=stage??(footprint.height?Math.max(1,Math.round(footprint.height/3)):usage==='industrial'?2:area<4?1:area<12?2+(seed%3):area<30?4+(seed%5):7+(seed%13));
 const style=buildingAppearance(usage,floors,seed);
 const height=Math.max(.7,TILE_H*view.camera.zoom*(.55+style.floors*.72));
 if(kind===undefined&&stage===undefined&&floors>6&&area>20){
  drawBuilding(ctx,view,footprint,shift,usage,3);
  const centre={x:(footprint.minX+footprint.maxX)/2,y:(footprint.minY+footprint.maxY)/2},factor=.50+(seed%3)*.08;
  const tower={...footprint,rings:footprint.rings.map(r=>r.map(p=>({x:centre.x+(p.x-centre.x)*factor,y:centre.y+(p.y-centre.y)*factor}))),area:area*factor*factor};
  drawBuilding(ctx,view,tower,shift,usage,floors-3,TILE_H*view.camera.zoom*(.55+3*.72));return;
 }
 const rings=footprint.rings.map(r=>projectRing(view,r,shift).map(p=>({x:p.x,y:p.y-lift}))),outer=rings[0];
 path(ctx,rings,height*.36,height*.18);ctx.fillStyle='rgba(42,51,44,.19)';ctx.fill('evenodd');
 const roof=rings.map(r=>r.map(p=>({x:p.x,y:p.y-height})));
 const detail=scale>=5;
 for(let i=1;i<outer.length;i++){
  const a=outer[i-1],b=outer[i];if(b.x>=a.x)continue;
  path(ctx,[[a,b,{x:b.x,y:b.y-height},{x:a.x,y:a.y-height}]]);
  ctx.fillStyle=b.y>a.y?style.dark:style.light;ctx.fill();
  if(detail){
   const span=Math.hypot(b.x-a.x,b.y-a.y),columns=Math.min(28,Math.max(1,Math.floor(span/Math.max(3,scale*.19))));
   ctx.strokeStyle=usage==='commercial'?'#496a78':'#655f53';ctx.lineWidth=Math.max(.65,Math.min(2.5,scale*.085));
   const rows=Math.min(floors,12);
   for(let f=0;f<rows;f++){
    const level=(f+.5)*height/rows;
    for(let w=0;w<columns;w++){
     const t=(w+.5)/columns,half=.22/columns;
     ctx.beginPath();ctx.moveTo(a.x+(b.x-a.x)*(t-half),a.y+(b.y-a.y)*(t-half)-level);
     ctx.lineTo(a.x+(b.x-a.x)*(t+half),a.y+(b.y-a.y)*(t+half)-level);ctx.stroke();
    }
   }
   if(usage==='commercial'&&floors>2){ctx.strokeStyle='rgba(223,230,214,.45)';ctx.lineWidth=.6;for(let f=1;f<floors;f++){const h=f*height/floors;ctx.beginPath();ctx.moveTo(a.x,a.y-h);ctx.lineTo(b.x,b.y-h);ctx.stroke();}}
  }
 }
 path(ctx,roof);ctx.fillStyle=style.roof;ctx.fill('evenodd');ctx.strokeStyle='#706e61';ctx.lineWidth=Math.max(.5,Math.min(1.2,scale*.025));ctx.stroke();
 if(detail&&usage==='residential'&&area<8&&floors<3){
  const ridge={x:roof[0].reduce((s,p)=>s+p.x,0)/roof[0].length,y:roof[0].reduce((s,p)=>s+p.y,0)/roof[0].length-scale*.12};
  for(let i=1;i<roof[0].length;i++){path(ctx,[[roof[0][i-1],roof[0][i],ridge]]);ctx.fillStyle=i%2?style.roof:style.dark;ctx.fill();}
 }
 if(detail&&area>4){
  const centre={x:outer.reduce((s,p)=>s+p.x,0)/outer.length,y:outer.reduce((s,p)=>s+p.y,0)/outer.length-height};
  ctx.fillStyle=usage==='commercial'?'#aebfbb':'#d1c9b3';ctx.fillRect(centre.x-scale*.09,centre.y-scale*.08,Math.max(1,scale*.18),Math.max(1,scale*.1));
 }
 if(detail&&usage==='industrial'){
  const centre=outer[Math.floor(outer.length/2)];ctx.fillStyle='#b6ada0';ctx.fillRect(centre.x-scale*.08,centre.y-height-scale*.5,Math.max(2,scale*.14),scale*.5);
 }
}
const featureBounds=new WeakMap<GeographicFeature,{minX:number;minY:number;maxX:number;maxY:number}>();
function bounds(feature:GeographicFeature){
 let b=featureBounds.get(feature);if(b)return b;
 b={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
 for(const ring of feature.geometry)for(const p of ring){b.minX=Math.min(b.minX,p.x);b.minY=Math.min(b.minY,p.y);b.maxX=Math.max(b.maxX,p.x);b.maxY=Math.max(b.maxY,p.y);}
 featureBounds.set(feature,b);return b;
}
function roadPath(ctx:CanvasRenderingContext2D,view:WorldView,feature:GeographicFeature,shift:number){
 ctx.beginPath();for(const ring of feature.geometry){if(!ring.length)continue;const a=project({x:ring[0].x+shift-.5,y:ring[0].y-.5},view.camera);ctx.moveTo(a.x,a.y);for(let i=1;i<ring.length;i++){const p=project({x:ring[i].x+shift-.5,y:ring[i].y-.5},view.camera);ctx.lineTo(p.x,p.y);}}
}
function drawRoads(ctx:CanvasRenderingContext2D,view:WorldView,roads:Array<{feature:GeographicFeature;shift:number}>){
 const scale=TILE_W*view.camera.zoom;
 ctx.lineCap='round';ctx.lineJoin='round';
 for(const {feature,shift} of roads){
  const highway=/^(motorway|trunk)/.test(feature.kind),arterial=/^(primary|secondary)/.test(feature.kind),pathway=/^(footway|path|steps|cycleway|pedestrian)/.test(feature.kind);
  const width=Math.max(pathway?.55:1,(highway?1.65:arterial?1.2:pathway?.10:feature.kind==='service'?.4:.8)*scale);
  roadPath(ctx,view,feature,shift);ctx.strokeStyle=pathway?'#cac7ad':PALETTE.sidewalk;ctx.lineWidth=width+Math.max(.65,scale*.12);ctx.stroke();
  if(!pathway){ctx.strokeStyle=highway?'#8d8870':PALETTE.pavement;ctx.lineWidth=width;ctx.stroke();}
  if(width>6&&!pathway){ctx.strokeStyle=highway?'#ebd696':'#e0d8bf';ctx.lineWidth=Math.max(.6,scale*.016);ctx.setLineDash([Math.max(2,scale*.16),Math.max(2,scale*.14)]);ctx.stroke();ctx.setLineDash([]);}
  if(scale>=7&&!pathway&&feature.kind!=='service')for(const ring of feature.geometry){
   if(ring.length<2)continue;
   const seed=(Math.floor(ring[0].x)^Math.floor(ring[0].y))>>>0;if(seed%3)continue;
   const segment=seed%(ring.length-1),a=ring[segment],b=ring[segment+1],fraction=((seed%100)/100+view.motion*.08)%1;
   const p=project({x:a.x+(b.x-a.x)*fraction+shift-.5,y:a.y+(b.y-a.y)*fraction-.5},view.camera);
   ctx.fillStyle=['#d7d9c7','#c38e61','#bac8ae','#4c6d70'][seed%4];ctx.fillRect(p.x-scale*.06,p.y-scale*.045,Math.max(1.5,scale*.15),Math.max(1,scale*.09));
  }
 }
}
function drawPlayerRoad(ctx:CanvasRenderingContext2D,view:WorldView,c:CellCoord,cell:Cell,lookup:(p:CellCoord)=>Cell|null){
 const connections=roadConnections(c,lookup),p=project(c,view.camera),scale=TILE_W*view.camera.zoom,kind=roadClassOf(cell);
 const width=Math.max(1,scale*(kind==='highway'?.56:kind==='avenue'?.4:.25));
 for(const [key,dx,dy] of [['east',.5,0],['west',-.5,0],['north',0,-.5],['south',0,.5]] as const){
  if(!connections[key])continue;const end=project({x:c.x+dx,y:c.y+dy},view.camera);
  ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(end.x,end.y);ctx.strokeStyle=PALETTE.sidewalk;ctx.lineWidth=width+scale*.1;ctx.stroke();ctx.strokeStyle=PALETTE.pavement;ctx.lineWidth=width;ctx.stroke();
 }
 ctx.fillStyle=PALETTE.pavement;ctx.beginPath();ctx.arc(p.x,p.y,width*.5,0,Math.PI*2);ctx.fill();
}
export function renderGeographicWorld(ctx:CanvasRenderingContext2D,view:WorldView){
 if(view.camera.zoom<GLOBE_ZOOM){drawGlobe(ctx,view);return;}
 const {camera,viewport}=view,scale=TILE_W*camera.zoom;
 ctx.imageSmoothingEnabled=true;ctx.lineJoin='round';ctx.lineCap='round';ctx.fillStyle=PALETTE.ground;ctx.fillRect(0,0,viewport.width,viewport.height);
 const centre=cellSpace({x:viewport.width/2,y:viewport.height/2},camera);
 const corners=[[0,0],[viewport.width,0],[0,viewport.height+scale*8],[viewport.width,viewport.height+scale*8]].map(([x,y])=>cellSpace({x,y},camera));
 const minX=Math.min(...corners.map(p=>p.x)),maxX=Math.max(...corners.map(p=>p.x)),minY=Math.min(...corners.map(p=>p.y)),maxY=Math.max(...corners.map(p=>p.y));
 const visible=(b:{minX:number;maxX:number;minY:number;maxY:number},shift=0)=>b.maxX+shift>=minX&&b.minX+shift<=maxX&&b.maxY>=minY&&b.minY<=maxY;
 const edits:Array<{coord:CellCoord;cell:Cell}>=[];
 for(const [id,chunk] of Object.entries(view.state.chunks))for(const [i,cell] of Object.entries(chunk.edits)){
  if(cell.origin==='imported')continue;
  const original=coordAt(id,Number(i)),coord={x:nearestWorldX(original.x,centre.x),y:original.y};
  if(coord.x>=minX-1&&coord.x<=maxX+1&&coord.y>=minY-1&&coord.y<=maxY+1)edits.push({coord,cell});
 }
 const roads:Array<{feature:GeographicFeature;shift:number}>=[],buildings:Array<{footprint:Footprint;shift:number;kind?:Building;stage?:number;depth:number}>=[],labels:Array<{point:Point;name:string;kind:string}>=[];
 // Ground first, then road geometry, then depth-sorted building geometry. Tile iteration order never buries roofs.
 const features:Array<{feature:GeographicFeature;shift:number}>=[];
 for(const tile of view.geography?.tiles??[]){
  const origin=tile.x*WORLD/2**tile.z,shift=nearestWorldX(origin,centre.x)-origin;
  for(const feature of tile.features)if(visible(bounds(feature),shift))features.push({feature,shift});
 }
 for(const layer of ['land','sites','ocean','water_polygons','street_polygons'])for(const {feature,shift} of features){
  if(feature.layer!==layer||feature.type!==3)continue;
  const fill=layer==='ocean'||layer==='water_polygons'?feature.kind==='glacier'?'#d5ded8':PALETTE.water:layer==='street_polygons'?PALETTE.sidewalk:PARKS.has(feature.kind)?feature.kind==='forest'||feature.kind==='wood'?PALETTE.forest:PALETTE.park:URBAN.has(feature.kind)?'#c3bdaa':PALETTE.ground;
  polygon(ctx,view,feature,shift,fill);
  if(layer==='water_polygons'||layer==='ocean'){ctx.strokeStyle=PALETTE.shore;ctx.lineWidth=Math.min(1.3,scale*.12);ctx.stroke();}
  if(PARKS.has(feature.kind)&&scale>=5){
   const b=bounds(feature),sx=Math.max(b.minX,Math.floor(minX-shift)),ex=Math.min(b.maxX,Math.ceil(maxX-shift));
   const sy=Math.max(b.minY,Math.floor(minY)),ey=Math.min(b.maxY,Math.ceil(maxY));
   ctx.save();path(ctx,feature.geometry.map(r=>projectRing(view,r,shift)));ctx.clip('evenodd');
   let count=0;trees:for(let y=sy;y<ey;y+=3)for(let x=sx;x<ex;x+=3){if(count++>=700)break trees;drawTree(ctx,project({x:x+shift,y},camera),scale,(Math.floor(x)^Math.floor(y))>>>0);}ctx.restore();
  }
 }
 for(const {feature,shift} of features){
  if(feature.layer==='streets')roads.push({feature,shift});
  if(feature.layer==='water_lines'){roadPath(ctx,view,feature,shift);ctx.strokeStyle=PALETTE.water;ctx.lineWidth=Math.max(1,scale*.06);ctx.stroke();}
  if(feature.layer==='boundaries'&&camera.zoom<.003){roadPath(ctx,view,feature,shift);ctx.strokeStyle='rgba(91,94,73,.35)';ctx.lineWidth=.7;ctx.setLineDash([3,4]);ctx.stroke();ctx.setLineDash([]);}
  if(feature.layer==='place_labels'&&feature.name&&camera.zoom<.12){const p=feature.geometry[0]?.[0];if(p)labels.push({point:project({x:p.x+shift,y:p.y},camera),name:feature.name,kind:feature.kind});}
 }
 for(const footprint of assembledFootprints(view.geography?.tiles??[])){
  const shift=nearestWorldX(footprint.minX,centre.x)-footprint.minX;
  if(!visible(footprint,shift))continue;
  const depth=Math.max(...footprint.rings[0].map(p=>project({x:p.x+shift,y:p.y},camera).y));
  for(const remaining of remainingFootprints(footprint,edits.map(e=>({x:e.coord.x-shift,y:e.coord.y}))))buildings.push({footprint:remaining,shift,depth});
 }
 drawRoads(ctx,view,roads);
 const lookup=(p:CellCoord):Cell|null=>{const id=chunkId(p),managed=view.state.chunks[id],i=cellIndex(p),status=view.chunks.get(id);return managed?(managed.edits[i]??managed.base.cells[i]):status?.status==='ready'?status.base.cells[i]:null;};
 for(const {coord,cell} of edits){
  rectCell(ctx,view,coord,cell.terrain==='water'?PALETTE.water:cell.building==='park'?PALETTE.park:PALETTE.ground);
  if(cell.road)drawPlayerRoad(ctx,view,coord,cell,lookup);
  if(cell.building&&cell.building!=='park'){
   const r=cell.building==='industrial'?.42:.34;
   const ring=[{x:coord.x-r+.5,y:coord.y-r+.5},{x:coord.x+r+.5,y:coord.y-r+.5},{x:coord.x+r+.5,y:coord.y+r+.5},{x:coord.x-r+.5,y:coord.y+r+.5},{x:coord.x-r+.5,y:coord.y-r+.5}];
   buildings.push({footprint:{rings:[ring],minX:coord.x-r,maxX:coord.x+r,minY:coord.y-r,maxY:coord.y+r,area:r*r*4,kind:cell.building,seed:(coord.x^Math.imul(coord.y,19349663))>>>0},shift:0,kind:cell.building,stage:cell.stage,depth:project(coord,camera).y});
  }
  if(cell.building==='park'&&scale>=4)drawTree(ctx,project(coord,camera),scale,(coord.x^coord.y)>>>0);
 }
 buildings.sort((a,b)=>a.depth-b.depth);
 for(const b of buildings)drawBuilding(ctx,view,b.footprint,b.shift,b.kind,b.stage);
 if(camera.zoom<.06){
  ctx.font=`${(camera.zoom<.003?12:11)*(view.pixelRatio??1)}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';
  const occupied:Array<{x:number;y:number;width:number}>=[];
  for(const label of labels){const p=label.point,w=ctx.measureText(label.name).width;if(p.x<50||p.x>viewport.width-50||p.y<65||p.y>viewport.height-100||occupied.some(o=>Math.abs(o.x-p.x)<(o.width+w)/2+16&&Math.abs(o.y-p.y)<24*(view.pixelRatio??1)))continue;
   occupied.push({x:p.x,y:p.y,width:w});ctx.lineWidth=3;ctx.strokeStyle='rgba(239,237,212,.85)';ctx.strokeText(label.name,p.x,p.y);ctx.fillStyle='#3c4c46';ctx.fillText(label.name,p.x,p.y);
  }
  ctx.textAlign='start';
 }
 if(view.tool!=='explore')for(const cell of view.preview){rectCell(ctx,view,cell,view.previewAffordable?'rgba(100,178,107,.4)':'rgba(199,86,70,.4)');ctx.strokeStyle=view.previewAffordable?'#f5e4a2':'#f3b1a0';ctx.lineWidth=1.5;ctx.stroke();}
 if(view.hover&&camera.zoom>=.035){rectCell(ctx,view,view.hover,'rgba(255,244,191,.15)');ctx.strokeStyle='#f5e4a2';ctx.lineWidth=1;ctx.stroke();}
}
