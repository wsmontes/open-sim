import type {TerrainTile} from '../presentation/terrain-model';
import {createTerrainSurface} from '../presentation/terrain-surface';

// A region ticket travels with asynchronous loads; an earlier city's response cannot publish.
export function createTerrainController(){
 let region:string|null=null,ticket=0,disposed=false,loading=false,revision=0;
 let tiles:readonly TerrainTile[]=[],surface=createTerrainSurface(tiles);
 return {
  setRegion(next:string|null):number{
   if(disposed||next===region)return ticket;
   region=next;ticket++;tiles=[];surface=createTerrainSurface(tiles);loading=next!==null;revision++;
   return ticket;
  },
  setTiles(next:readonly TerrainTile[],owner=ticket):boolean{
   if(disposed||owner!==ticket||region===null)return false;
   const replacement=createTerrainSurface(next);
   tiles=[...next];surface=replacement;loading=false;revision++;return true;
  },
  sample(geo:{lat:number;lon:number}){return surface.sample(geo);},
  tiles(){return tiles;},
  revision(){return revision;},
  status(){return {available:tiles.length>0,loading,limitedSurface:tiles.some(t=>t.kind==='dsm')};},
  dispose(){disposed=true;ticket++;tiles=[];surface=createTerrainSurface(tiles);loading=false;revision++;},
 };
}
