import {tileKey,type GeographicTile,type GeographicScene} from '../presentation/geographic-map';
export type GeographicPatch=Omit<GeographicScene,'tiles'>&{tiles:readonly GeographicTile[];keys:readonly string[]};
export function createSceneGeography(decode:(tile:GeographicTile)=>GeographicTile){
 const sizes=new Map<string,number>();let bytes=0;
 const retained=new Map<string,GeographicTile>();let tiles:readonly GeographicTile[]=[],revision=0;
 return {
  apply(patch:GeographicPatch):GeographicScene{
   for(const tile of patch.tiles){const key=tileKey(tile),decoded=decode(tile);bytes-=sizes.get(key)??0;const size=(decoded.encoded?.byteLength??0)+decoded.features.reduce((n,f)=>n+224+f.geometry.reduce((sum,r)=>sum+r.length*32,0),0);sizes.set(key,size);bytes+=size;retained.set(key,decoded);}
   const wanted=new Set(patch.keys);for(const key of retained.keys())if(!wanted.has(key)){bytes-=sizes.get(key)??0;sizes.delete(key);retained.delete(key);}
   const next=patch.keys.map(key=>{const tile=retained.get(key);if(!tile)throw new Error('Missing scene tile');return tile;});
   if(next.length!==tiles.length||next.some((tile,i)=>tile!==tiles[i])){tiles=next;revision++;}
   return {tiles,revision,loading:patch.loading,error:patch.error};
  },
  clear(){sizes.clear();bytes=0;retained.clear();tiles=[];revision++;},
  stats:()=>({tiles:retained.size,bytes}),
 };
}
