import {tileKey,type GeographicTile,type GeographicScene} from '../presentation/geographic-map';
export type GeographicPatch=Omit<GeographicScene,'tiles'>&{tiles:readonly GeographicTile[];keys:readonly string[]};
export function createSceneGeography(decode:(tile:GeographicTile)=>GeographicTile){
 const retained=new Map<string,GeographicTile>();let tiles:readonly GeographicTile[]=[],revision=0;
 return {
  apply(patch:GeographicPatch):GeographicScene{
   for(const tile of patch.tiles)retained.set(tileKey(tile),decode(tile));
   const wanted=new Set(patch.keys);for(const key of retained.keys())if(!wanted.has(key))retained.delete(key);
   const next=patch.keys.map(key=>{const tile=retained.get(key);if(!tile)throw new Error('Missing scene tile');return tile;});
   if(next.length!==tiles.length||next.some((tile,i)=>tile!==tiles[i])){tiles=next;revision++;}
   return {tiles,revision,loading:patch.loading,error:patch.error};
  },
  clear(){retained.clear();tiles=[];revision++;},
  stats:()=>({tiles:retained.size}),
 };
}
