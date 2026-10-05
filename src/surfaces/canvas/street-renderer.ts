import {verticalPixelsPerMetre} from '../../presentation/terrain-projection';
import {projectSurface,visibleSurfacePoint,terrainMetres} from './terrain-renderer';
import type {WorldView} from './canvas-renderer';
import {cellSpace,TILE_W,type Point} from '../../presentation/camera';
import {streetJunctions,streetAgents,plantingStep,plantingStations,roadsideTrees,type Segment,type PlantingBox,type StreetJunction} from '../../presentation/street-detail';
import type {GeographicFeature,GeographicTile} from '../../presentation/geographic-map';
import {nearestWorldX} from '../../presentation/geographic-map';
import {assembledFootprints} from '../../presentation/city-art';
import {footprintIndex,pointInsideAny,junctionIndex,periodicBoxCandidates,type BoxIndex} from '../../presentation/spatial-index';
import {WORLD} from '../../core/coordinates';
const cache=new WeakMap<readonly GeographicTile[],StreetJunction[]>();
// Candidate scratch for the planting veto: the index decides which footprints to test, and writes them
// here. Module-level because a render pass is synchronous, and module-level scratch is this file's style.
let TREE_CANDIDATES=new Int32Array(64);
const JUNCTION_PICKS:number[]=[];
let junctionScan=new Int32Array(4096);

/**
 * The junctions the viewport can show, as indices into `junctions`, in array order. The cell-space box
 * of the screen expands by the loaded elevation range, so raised streets remain candidates, and the world repeats in x, so the box is asked for three times, one world apart.
 */
const elevationRanges=new WeakMap<object,{min:number;max:number}>();
export function nearbyJunctions(view:WorldView,index:BoxIndex):number[]{
 const {camera,viewport}=view;
 let lower=0,upper=0;
 const tiles=view.terrain?.tiles;if(tiles?.length){let range=elevationRanges.get(tiles);if(!range){let min=0,max=0;for(const tile of tiles)for(let i=0;i<tile.heightsM.length;i++)if(tile.valid[i]&&Number.isFinite(tile.heightsM[i])){min=Math.min(min,tile.heightsM[i]);max=Math.max(max,tile.heightsM[i]);}range={min,max};elevationRanges.set(tiles,range);}const pixels=verticalPixelsPerMetre(camera,terrainMetres(view));lower=range.min*pixels;upper=range.max*pixels;}
 const c0=cellSpace({x:0,y:lower},camera),c1=cellSpace({x:viewport.width,y:lower},camera),c2=cellSpace({x:0,y:viewport.height+upper},camera),c3=cellSpace({x:viewport.width,y:viewport.height+upper},camera);
 const minX=Math.min(c0.x,c1.x,c2.x,c3.x)-2,maxX=Math.max(c0.x,c1.x,c2.x,c3.x)+2,minY=Math.min(c0.y,c1.y,c2.y,c3.y)-2,maxY=Math.max(c0.y,c1.y,c2.y,c3.y)+2;
 JUNCTION_PICKS.length=0;
 let n=periodicBoxCandidates(index,minX,minY,maxX,maxY,WORLD,junctionScan);
 while(n===junctionScan.length){
  junctionScan=new Int32Array(junctionScan.length*2);
  n=periodicBoxCandidates(index,minX,minY,maxX,maxY,WORLD,junctionScan);
 }
 const seen=new Set<number>();for(let i=0;i<n;i++){const at=junctionScan[i]!;if(!seen.has(at)){seen.add(at);JUNCTION_PICKS.push(at);}}
 JUNCTION_PICKS.sort((a,b)=>a-b);
 return JUNCTION_PICKS;
}
// Bounds of a mapped polygon, read once: the plaza and the square both need to know where the ground is before they
// decide what to draw on it.
const featureBounds=new WeakMap<GeographicFeature,{minX:number;minY:number;maxX:number;maxY:number}>();
function polygonBounds(feature:GeographicFeature){
 let b=featureBounds.get(feature);
 if(!b){
  b={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
  for(const ring of feature.geometry)for(const p of ring){if(p.x<b.minX)b.minX=p.x;if(p.x>b.maxX)b.maxX=p.x;if(p.y<b.minY)b.minY=p.y;if(p.y>b.maxY)b.maxY=p.y;}
  featureBounds.set(feature,b);
 }
 return b;
}
// A square is a place to walk, not a wide road with a different tint. The joints are drawn inside the polygon the map
// gave and capped in both directions, so a plaza the size of a district costs the same as a plaza the size of a lot.
export function drawPaving(ctx:CanvasRenderingContext2D,view:WorldView,feature:GeographicFeature,shift:number):number{
 const scale=TILE_W*view.camera.zoom;
 if(scale<8)return 0;
 const b=polygonBounds(feature);
 if(b.maxX-b.minX<2||b.maxY-b.minY<2)return 0;
 const step=.6,first=(v:number)=>Math.ceil(v/step)*step;
 ctx.save();
 ctx.beginPath();
 for(const ring of feature.geometry){if(!ring.length)continue;const a=projectSurface(view,{x:ring[0].x+shift-.5,y:ring[0].y-.5});ctx.moveTo(a.x,a.y);for(let i=1;i<ring.length;i++){const p=projectSurface(view,{x:ring[i].x+shift-.5,y:ring[i].y-.5});ctx.lineTo(p.x,p.y);}ctx.closePath();}
 ctx.clip('evenodd');
 ctx.strokeStyle='rgba(122,116,101,.42)';ctx.lineWidth=Math.max(.6,scale*.018);
 let drawn=0;
 for(let x=first(b.minX);x<=b.maxX&&drawn<24;x+=step){
  const a=projectSurface(view,{x:x+shift-.5,y:b.minY-.5}),c=projectSurface(view,{x:x+shift-.5,y:b.maxY-.5});
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(c.x,c.y);ctx.stroke();drawn++;
 }
 for(let y=first(b.minY);y<=b.maxY&&drawn<40;y+=step){
  const a=projectSurface(view,{x:b.minX+shift-.5,y:y-.5}),c=projectSurface(view,{x:b.maxX+shift-.5,y:y-.5});
  ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(c.x,c.y);ctx.stroke();drawn++;
 }
 ctx.restore();
 return drawn;
}
const worldPoint=(p:Point,shift=0)=>({x:p.x+shift-.5,y:p.y-.5});
// One tree, drawn the same wherever it stands: the trees of a square and the trees of a kerb are the same city.
export function drawTree(ctx:CanvasRenderingContext2D,p:Point,size:number,seed:number){
 ctx.fillStyle='rgba(40,61,42,.18)';ctx.beginPath();ctx.ellipse(p.x+size*.16,p.y+size*.05,size*.25,size*.1,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#756750';ctx.fillRect(p.x-size*.035,p.y-size*.38,Math.max(.7,size*.07),size*.4);
 ctx.fillStyle=['#54784f','#648555','#779363'][seed%3];ctx.beginPath();ctx.ellipse(p.x,p.y-size*.4,size*.18,size*.28,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='rgba(213,224,174,.3)';ctx.beginPath();ctx.ellipse(p.x-size*.06,p.y-size*.49,size*.09,size*.15,0,0,Math.PI*2);ctx.fill();
}
function drawLamp(ctx:CanvasRenderingContext2D,p:Point,scale:number){
 ctx.fillStyle='rgba(255,214,140,.1)';ctx.beginPath();ctx.ellipse(p.x,p.y,scale*.85,scale*.42,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='rgba(74,74,69,.9)';ctx.fillRect(p.x-.6,p.y-scale*.44,Math.max(1,scale*.035),scale*.44);
 ctx.fillStyle='rgba(255,216,140,.95)';ctx.beginPath();ctx.arc(p.x,p.y-scale*.47,Math.max(1,scale*.05),0,Math.PI*2);ctx.fill();
}
// A bridge is above the ground and a footpath is not a street: neither is planted along.
const plantable=(feature:GeographicFeature)=>!feature.bridge&&!/^(motorway|trunk|path|footway|steps)/.test(feature.kind);
const inFrame=(view:WorldView,p:Point)=>p.x>0&&p.x<view.viewport.width&&p.y>65&&p.y<view.viewport.height-60;
// The streets are planted from the ground up: the lattice is read in world coordinates and a tree keeps its address at
// every zoom, so pulling the camera back thins the trees instead of walking them around the block. At night every third
// tree of the row gives way to a lamp, which is where the light of a street comes from.
export function drawPlanting(ctx:CanvasRenderingContext2D,view:WorldView,roads:readonly {feature:GeographicFeature;shift:number}[],box:PlantingBox){
 const scale=TILE_W*view.camera.zoom;
 // Cull individual planting below a four-pixel lot, before allocating a regional lattice.
 if(scale<4)return;
 const segments:Segment[]=[];
 for(const {feature,shift} of roads){
  if(!plantable(feature))continue;
  for(const ring of feature.geometry)for(let i=1;i<ring.length;i++)segments.push({a:{x:ring[i-1].x+shift,y:ring[i-1].y},b:{x:ring[i].x+shift,y:ring[i].y}});
 }
 if(!segments.length)return;
 // Building footprints veto occupied lots: a tree stands on the verge, never inside a wall.
 const footprints=assembledFootprints(view.geography?.tiles??[]);
 const index=footprintIndex(footprints);
 if(TREE_CANDIDATES.length<footprints.length)TREE_CANDIDATES=new Int32Array(footprints.length);
 for(const tree of roadsideTrees(segments,box,plantingStep(scale),0x51ed,72)){
  const screen=projectSurface(view,worldPoint(tree));
  if(!inFrame(view,screen)||!visibleSurfacePoint(view,worldPoint(tree)))continue;
  if(pointInsideAny(footprints,index,tree,TREE_CANDIDATES))continue;
  if(view.light==='night'&&tree.seed%3===0)drawLamp(ctx,screen,scale);
  else drawTree(ctx,screen,scale*(.88+(tree.seed>>>24&7)/7*.35),tree.seed);
 }
}
// A park is planted the same way, inside the polygon the map gave: the clip does the containing, so a square the shape of
// a district costs one path and its own stations.
export function drawParkPlanting(ctx:CanvasRenderingContext2D,view:WorldView,feature:GeographicFeature,shift:number,box:PlantingBox){
 const scale=TILE_W*view.camera.zoom;
 // Cull individual planting below a four-pixel lot, before allocating a regional lattice.
 if(scale<4)return;
 const b=polygonBounds(feature);
 const minX=Math.max(box.minX,b.minX+shift),maxX=Math.min(box.maxX,b.maxX+shift),minY=Math.max(box.minY,b.minY),maxY=Math.min(box.maxY,b.maxY);
 if(minX>maxX||minY>maxY)return;
 ctx.save();
 ctx.beginPath();
 for(const ring of feature.geometry){if(!ring.length)continue;const a=projectSurface(view,worldPoint(ring[0],shift));ctx.moveTo(a.x,a.y);for(let i=1;i<ring.length;i++){const p=projectSurface(view,worldPoint(ring[i],shift));ctx.lineTo(p.x,p.y);}ctx.closePath();}
 ctx.clip('evenodd');
 for(const tree of plantingStations({minX,minY,maxX,maxY},plantingStep(scale),0x51ed,78))drawTree(ctx,projectSurface(view,worldPoint(tree,shift)),scale*(.88+(tree.seed>>>24&7)/7*.35),tree.seed);
 ctx.restore();
}

export function drawStreetDetails(ctx:CanvasRenderingContext2D,view:WorldView,roads:readonly {feature:GeographicFeature;shift:number}[],centreX:number){
 const scale=TILE_W*view.camera.zoom;if(scale<7)return;
 const tiles=view.geography?.tiles??[];
 let junctions=cache.get(tiles);if(!junctions){junctions=streetJunctions(tiles.flatMap(t=>t.features),20000);cache.set(tiles,junctions);}
 const inView=(p:Point)=>p.x>0&&p.x<view.viewport.width&&p.y>65&&p.y<view.viewport.height-60;
 let count=0;
 const picks=nearbyJunctions(view,junctionIndex(junctions));
 for(const at of picks){
  const junction=junctions[at]!;
  const shift=nearestWorldX(junction.point.x,centreX)-junction.point.x;
  if(!inView(projectSurface(view,worldPoint(junction.point,shift))))continue;
  if(count++>=140)break;
  if(view.light==='night'){const p=projectSurface(view,worldPoint(junction.point,shift));ctx.fillStyle='rgba(255,220,145,.07)';ctx.beginPath();ctx.ellipse(p.x,p.y,scale*.8,scale*.4,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='rgba(255,221,146,.9)';ctx.fillRect(p.x+scale*.35,p.y-scale*.2,Math.max(1,scale*.035),Math.max(1,scale*.035));}
  const width=junction.major?.55:.37;
  ctx.fillStyle='#e9e3cf';
  for(const d of junction.directions)for(let i=0;i<5;i++){
   const centre={x:junction.point.x+d.x*(.95+i*.15),y:junction.point.y+d.y*(.95+i*.15)},perp={x:-d.y*width,y:d.x*width};
   const p=[{x:centre.x+perp.x,y:centre.y+perp.y},{x:centre.x-perp.x,y:centre.y-perp.y},{x:centre.x-perp.x+d.x*.075,y:centre.y-perp.y+d.y*.075},{x:centre.x+perp.x+d.x*.075,y:centre.y+perp.y+d.y*.075}].map(p=>projectSurface(view,worldPoint(p,shift)));
   ctx.beginPath();ctx.moveTo(p[0].x,p[0].y);for(const a of p.slice(1))ctx.lineTo(a.x,a.y);ctx.closePath();ctx.fill();
  }
 }
 // The planting is its own pass: a tree stands where the ground says, not where the tile cut the street, so it is drawn
 // from the same lattice at every zoom (drawPlanting below), and the streets keep only what belongs to them.
 if(view.mobility)return;
 const features=roads.map(({feature,shift})=>shift?{...feature,geometry:feature.geometry.map(r=>r.map(p=>({x:p.x+shift,y:p.y})))}:feature);
 for(const agent of streetAgents(features,view.motion,240,p=>inView(projectSurface(view,worldPoint(p)))&&visibleSurfacePoint(view,worldPoint(p)))){
  const p=projectSurface(view,worldPoint(agent.point));if(!inView(p))continue;
  const q=projectSurface(view,worldPoint({x:agent.point.x+agent.direction.x,y:agent.point.y+agent.direction.y})),angle=Math.atan2(q.y-p.y,q.x-p.x);
  ctx.save();ctx.translate(p.x,p.y);ctx.rotate(angle);
  if(agent.kind==='car'){
   ctx.fillStyle='rgba(32,45,40,.25)';ctx.fillRect(-scale*.12,scale*.02,scale*.27,Math.max(1,scale*.11));
   ctx.fillStyle=['#c77951','#c4ccba','#4e777b','#b79859','#8d6c79'][agent.seed%5];ctx.fillRect(-scale*.13,-scale*.07,Math.max(2,scale*.27),Math.max(1.5,scale*.14));
   if(view.light==='night'){ctx.fillStyle='rgba(255,223,148,.8)';ctx.fillRect(scale*.1,-scale*.06,Math.max(1,scale*.045),scale*.12);}
   ctx.fillStyle='#d0dfdc';ctx.fillRect(-scale*.025,-scale*.055,Math.max(1,scale*.07),Math.max(1,scale*.1));
  }else if(scale>=10){
   ctx.fillStyle=['#bf8a66','#718695','#cfb976'][agent.seed%3];ctx.fillRect(-.7,-scale*.13,1.4,scale*.13);ctx.fillStyle='#e2c5a1';ctx.beginPath();ctx.arc(0,-scale*.15,Math.max(.8,scale*.035),0,Math.PI*2);ctx.fill();
  }
  ctx.restore();
 }
}
