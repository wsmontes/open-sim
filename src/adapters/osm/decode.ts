import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {CHUNK,WORLD} from '../../core/coordinates';
import type {MapFeature} from './normalize';
import type {GeographicTile} from '../../presentation/geographic-map';
export function readMobilityAttributes(properties:Record<string,unknown>,zoom:number,id?:number){
 const direction=properties.oneway,reverse=properties.oneway_reverse===true;
 const oneway:-1|0|1|undefined=reverse?-1:direction===true||direction===1||direction==='yes'?1:direction===-1||direction==='-1'?-1:direction===false||direction===0||direction==='no'?0:zoom>=14?0:undefined;
 const rawLevel=properties.layer??properties.level,level=rawLevel!==undefined&&Number.isFinite(Number(rawLevel))?Number(rawLevel):undefined;
 const identity=properties.osm_id??id;
 return {oneway,level,sourceId:identity!==undefined?`osm/${String(identity)}`:undefined,tunnel:typeof properties.tunnel==='boolean'?properties.tunnel:undefined};
}

const LAYERS=new Set(['land','sites','ocean','water_polygons','water_lines','buildings','streets','street_polygons','place_labels','street_labels','boundaries']);
const cellsPerTile=(zoom:number)=>WORLD/2**zoom;

export type DecodedTile={byChunk:Map<string,MapFeature[]>};

function bucket(tileX:number,tileY:number,cellsPerSide:number,features:readonly MapFeature[]):Map<string,MapFeature[]>{
 const byChunk=new Map<string,MapFeature[]>();
 const chunksPerSide=cellsPerSide/CHUNK,firstX=tileX*chunksPerSide,firstY=tileY*chunksPerSide;
 for(const feature of features){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const ring of feature.geometry)for(const point of ring){
   if(point.x<minX)minX=point.x;if(point.x>maxX)maxX=point.x;
   if(point.y<minY)minY=point.y;if(point.y>maxY)maxY=point.y;
  }
  if(minX===Infinity)continue;
  const width=feature.layer==='streets'?(/motorway|trunk|primary/.test(feature.kind)?1.1:.67):.65;
  const x0=Math.max(firstX,Math.floor((minX-width)/CHUNK)),x1=Math.min(firstX+chunksPerSide-1,Math.floor((maxX+width)/CHUNK));
  const y0=Math.max(firstY,Math.floor((minY-width)/CHUNK)),y1=Math.min(firstY+chunksPerSide-1,Math.floor((maxY+width)/CHUNK));
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   const key=`${x}:${y}`,list=byChunk.get(key);
   if(list)list.push(feature);else byChunk.set(key,[feature]);
  }
 }
 return byChunk;
}

export function decodeVisualTile(bytes:Uint8Array,zoom:number,tileX:number,tileY:number,layers:ReadonlySet<string>=LAYERS):GeographicTile{
 const decoded=new VectorTile(new PbfReader(bytes)),features:MapFeature[]=[];
 const side=cellsPerTile(zoom),originX=tileX*side,originY=tileY*side;
 for(const [name,layer] of Object.entries(decoded.layers)){
  if(!layers.has(name))continue;
  for(let index=0;index<layer.length;index++){
   const raw=layer.feature(index);
   if(raw.type!==1&&raw.type!==2&&raw.type!==3)continue;
   if(name==='streets'&&raw.properties.rail===true)continue;
   features.push({
    layer:name,kind:String(raw.properties.kind??''),bridge:raw.properties.bridge===true,type:raw.type,
    name:String(raw.properties.name??''),height:Number(raw.properties.height??0)||undefined,
    ...(name==='streets'?readMobilityAttributes(raw.properties,zoom,raw.id):{}),
    geometry:raw.loadGeometry().map(ring=>ring.map(point=>({x:originX+point.x/raw.extent*side,y:originY+point.y/raw.extent*side}))),
   });
  }
 }
 return{z:zoom,x:tileX,y:tileY,features};
}
export function decodeTile(bytes:Uint8Array,zoom:number,tileX:number,tileY:number):DecodedTile{
 const visual=decodeVisualTile(bytes,zoom,tileX,tileY);
 return{byChunk:bucket(tileX,tileY,cellsPerTile(zoom),visual.features.filter(f=>!f.tunnel&&f.type!==1&&!f.layer.endsWith('labels')&&f.layer!=='boundaries'))};
}
