import type {Cell,CellCoord} from '../core/model';
import type {GeographicTile} from '../presentation/geographic-map';
import {tileKey} from '../presentation/geographic-map';
import {buildGeographicNetwork,buildCellNetwork} from '../presentation/mobility-network';
import {createMobilityEngine} from '../presentation/mobility-engine';
import type {MobilityAgent,MobilityDemand,MobilityEdge} from '../presentation/mobility-model';
import type {Point} from '../presentation/camera';
export function createMobilityController(seed:number){
 let network=buildGeographicNetwork([],'empty'),revision=0,disposed=false;
 const engine=createMobilityEngine(network,seed),tiles=new Map<string,GeographicTile>();
 return {
  setGeography(next:readonly GeographicTile[]){
   if(disposed)return;let changed=false;
   for(const tile of next){if(tile.z!==14)continue;const key=tileKey(tile);if(tiles.get(key)!==tile){tiles.set(key,tile);changed=true;}}
   if(!changed)return;while(tiles.size>64)tiles.delete(tiles.keys().next().value!);
   network=buildGeographicNetwork([...tiles.values()].flatMap(t=>t.features),`streets:${++revision}`);engine.setNetwork(network);
  },
  setCells(cells:readonly {coord:CellCoord;cell:Cell}[],stamp:string){
   if(disposed||network.revision===`cells:${stamp}`)return;
   network=buildCellNetwork(cells,`cells:${stamp}`);engine.setNetwork(network);
  },
  setDemand(demand:MobilityDemand){if(!disposed)engine.setDemand(demand);},
  setAgents(agents:readonly MobilityAgent[]){if(!disposed)engine.setAgents(agents);},
  setSurface(resolve:(point:Point,edge:MobilityEdge)=>number|null){engine.setSurface(resolve);},
  advance(seconds:number){if(!disposed)engine.advance(seconds);},
  frame:engine.frame,
  signals:engine.signals,
  setSignalSites:engine.setSignalSites,
  network:()=>network,
  dispose(){disposed=true;tiles.clear();network=buildGeographicNetwork([],'disposed');engine.setNetwork(network);},
 };
}
