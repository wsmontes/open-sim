import {createResourceCache} from '../../core/resource-cache';
import {ResourcePressure} from '../../core/resource-pressure';
import {decodeVisualTile} from './decode';
import type {MapFeature} from './normalize';
const layers=new Set(['land','sites','ocean','water_polygons','water_lines','buildings','streets','street_polygons']);
export function createNormalizationCache(cacheBytes:number,maxEntries=32){
 const cache=createResourceCache<readonly MapFeature[]>(cacheBytes,()=>{},maxEntries);
 return {...cache,decode(key:string,bytes:Uint8Array,z:number,x:number,y:number,geometryBytes:number){
  const tile=decodeVisualTile(bytes,z,x,y,layers,{maxPoints:Math.floor(geometryBytes/64),maxFeatures:Math.floor(geometryBytes/448),tolerance:0});
  if(tile.limited)throw new ResourcePressure();
  const features=tile.features.filter(f=>!f.tunnel&&f.type!==1),cost=features.reduce((sum,f)=>sum+224+f.geometry.reduce((sum,r)=>sum+r.length*32,0),0);
  cache.set(key,features,cost);return features;
 }};
}
