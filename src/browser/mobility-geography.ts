import {createVisualTileDecoder,MOBILITY_LAYERS} from './visual-tile-decoder';
import type {GeographicTile} from '../presentation/geographic-map';
// Per-job ownership: no inactive decoder cache, shared quota across all selected tiles.
export function createMobilityGeography(maxBytes:number,maxPoints=Infinity){
 let bytes=0,limited=false;
 const decoder=createVisualTileDecoder(0,MOBILITY_LAYERS,()=>({maxPoints:Math.min(maxPoints,Math.floor(Math.max(0,maxBytes-bytes)/64)),maxFeatures:Math.floor(Math.max(0,maxBytes-bytes)/448),tolerance:0}));
 return {decode(tile:GeographicTile):GeographicTile|undefined{
  const result=decoder.decode(tile),cost=result.features.reduce((sum,f)=>sum+224+f.geometry.reduce((sum,ring)=>sum+ring.length*32,0),0),points=result.features.reduce((sum,f)=>sum+f.geometry.reduce((sum,r)=>sum+r.length,0),0);
  if(bytes+cost>maxBytes||points>maxPoints){limited=true;return;}bytes+=cost;maxPoints-=points;limited ||= !!result.limited;return result;
 },stats:()=>({bytes,limited})};
}
