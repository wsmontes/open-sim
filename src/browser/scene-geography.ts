import {tileKey,type GeographicTile,type GeographicScene} from '../presentation/geographic-map';
export type GeographicPatch=Omit<GeographicScene,'tiles'>&{tiles:readonly GeographicTile[];keys:readonly string[]};
export function createSceneGeography(decode:(tile:GeographicTile)=>GeographicTile,limit:()=>number=()=>Infinity){
 const retained=new Map<string,GeographicTile>(),sizes=new Map<string,number>(),partial=new Set<string>(),rejected=new Set<string>();
 let bytes=0,tiles:readonly GeographicTile[]=[],keys:readonly string[]=[],revision=0;
 const drop=(key:string)=>{partial.delete(key);bytes-=sizes.get(key)??0;sizes.delete(key);retained.delete(key);};
 return {
  apply(patch:GeographicPatch):GeographicScene{
   const wanted=new Set(patch.keys);let changed=patch.tiles.length>0||patch.keys.length!==keys.length||patch.keys.some((key,i)=>key!==keys[i]);
   for(const key of retained.keys())if(!wanted.has(key)){drop(key);changed=true;}
   for(const key of rejected)if(!wanted.has(key))rejected.delete(key);
   for(const key of [...patch.keys].reverse()){if(bytes<=limit())break;if(retained.has(key)){drop(key);rejected.add(key);changed=true;}}
   if(changed)tiles=[];
   for(const tile of patch.tiles){
    const key=tileKey(tile);if(!wanted.has(key))continue;drop(key);
    const decoded=decode(tile),size=(decoded.encoded?.byteLength??0)+decoded.features.reduce((n,f)=>n+224+f.geometry.reduce((sum,r)=>sum+r.length*32,0),0);
    if(size>limit()||bytes+size>limit()){rejected.add(key);continue;}
    rejected.delete(key);if(decoded.limited)partial.add(key);sizes.set(key,size);bytes+=size;retained.set(key,decoded);
   }
   const next=patch.keys.flatMap(key=>{const tile=retained.get(key);if(tile)return [tile];if(rejected.has(key))return [];throw new Error('Missing scene tile');});
   if(changed){tiles=next;keys=[...patch.keys];revision++;}
   return {tiles,revision,loading:patch.loading,error:patch.error,limited:patch.limited||rejected.size>0||partial.size>0};
  },
  clear(){sizes.clear();partial.clear();rejected.clear();bytes=0;retained.clear();tiles=[];keys=[];revision++;},
  stats:()=>({tiles:retained.size,bytes,limited:rejected.size>0||partial.size>0}),
 };
}
