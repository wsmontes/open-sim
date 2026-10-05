import {decodeVisualTile} from '../adapters/osm/decode';
import {tileKey,type GeographicTile} from '../presentation/geographic-map';
export function createVisualTileDecoder(limitBytes=32*1024*1024,layers?:ReadonlySet<string>){
 const cache=new Map<string,{tile:GeographicTile;revision:string|undefined;encoded:Uint8Array;bytes:number}>();let bytes=0;
 return {decode(tile:GeographicTile):GeographicTile{
  if(!tile.encoded)return tile;const key=tileKey(tile),known=cache.get(key);
  if(known&&(tile.encodedRevision!==undefined?known.revision===tile.encodedRevision:known.encoded===tile.encoded)){cache.delete(key);cache.set(key,known);return known.tile;}
  const decoded=decodeVisualTile(tile.encoded,tile.z,tile.x,tile.y,layers),size=decoded.features.reduce((n,f)=>n+224+f.geometry.reduce((n,r)=>n+r.length*32,0),0);
  if(known){cache.delete(key);bytes-=known.bytes;}while(bytes+size>limitBytes&&cache.size){const first=cache.keys().next().value!;bytes-=cache.get(first)!.bytes;cache.delete(first);}
  if(size<=limitBytes){cache.set(key,{tile:decoded,revision:tile.encodedRevision,encoded:tile.encoded,bytes:size});bytes+=size;}return decoded;
 },clear(){cache.clear();bytes=0;},stats:()=>({bytes,entries:cache.size})};
}

export const MOBILITY_LAYERS:ReadonlySet<string>=new Set(['streets']);
