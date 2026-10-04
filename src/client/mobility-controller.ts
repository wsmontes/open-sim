import type {TransitContent} from '../core/transit-data';
import {buildTransitPatterns} from '../presentation/transit-routes';
import {routeBuses} from '../presentation/transit-motion';
import type {SchoolSite} from '../core/traffic-data';
import {schoolBusAgents,policePatrolAgents} from '../presentation/school-transport';
import type {Cell,CellCoord} from '../core/model';
import type {GeographicTile} from '../presentation/geographic-map';
import {tileKey} from '../presentation/geographic-map';
import {buildGeographicNetwork,buildCellNetwork} from '../presentation/mobility-network';
import {createMobilityEngine} from '../presentation/mobility-engine';
import type {MobilityAgent,MobilityDemand,MobilityEdge,MobilityNetwork} from '../presentation/mobility-model';
import type {Point} from '../presentation/camera';
export type MobilityMode='estimated'|'calibrated';
export type MobilityStatus={mode:MobilityMode;available:boolean;scenarioInstant:string};
export function createMobilityController(options:number|{seed:number;now:()=>string;onChange:()=>void}){
 const seed=typeof options==='number'?options:options.seed;
 const now=typeof options==='number'?()=>new Date().toISOString():options.now;
 const changed=typeof options==='number'?()=>{}:options.onChange;
 let city:string|null=null,scenario:string|null=null,schools:readonly SchoolSite[]=[],civic=false,fleetStamp='',transit:TransitContent|null=null,transitStamp='',buses:readonly MobilityAgent[]=[];
 const refreshFleet=()=>{if(!civic&&!transit)return;if(transitStamp!==network.revision){transitStamp=network.revision;buses=transit?routeBuses(buildTransitPatterns(transit,network),seed):[];}const instant=scenario??now(),stamp=network.revision+instant.slice(0,16);if(stamp===fleetStamp)return;fleetStamp=stamp;engine.setAgents([...buses,...(civic?policePatrolAgents(network,seed):[]),...schoolBusAgents(schools,network,instant,seed)]);};
 let network=buildGeographicNetwork([],'empty'),revision=0,disposed=false;
 const engine=createMobilityEngine(network,seed),tiles=new Map<string,GeographicTile>();
 return {
  setNetwork(next:MobilityNetwork){if(disposed)return;network=next;engine.setNetwork(next);refreshFleet();},
  setTransit(dataset:TransitContent|null){if(disposed)return;transit=dataset;transitStamp='';fleetStamp='';if(!dataset&&!civic){buses=[];engine.setAgents([]);}else refreshFleet();},
  setCivicSites(sites:readonly SchoolSite[]){if(disposed)return;schools=sites;civic=true;fleetStamp='';refreshFleet();},
  setCity(territoryId:string|null){
   if(disposed||city===territoryId)return;city=territoryId;tiles.clear();transit=null;schools=[];civic=false;buses=[];fleetStamp='';transitStamp='';
   network=buildGeographicNetwork([],`city:${++revision}`);engine.setNetwork(network);engine.setAgents([]);
   engine.setDemand({vehicles:0,pedestrians:0,truckShare:0,hour:12});changed();
  },
  setScenario(instant:string){if(disposed||!Number.isFinite(Date.parse(instant)))return;scenario=new Date(instant).toISOString();changed();},
  // Calibration is unavailable until an observed count is matched and an explicit
  // sampling policy is installed. A requested unavailable mode stays estimated.
  setMode(_mode:MobilityMode){if(!disposed)changed();},
  status:():MobilityStatus=>({mode:'estimated',available:false,scenarioInstant:scenario??now()}),
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
  advance(seconds:number){if(!disposed){refreshFleet();engine.advance(seconds);}},
  frame:engine.frame,
  signals:engine.signals,
  setSignalSites:engine.setSignalSites,
  network:()=>network,
  dispose(){disposed=true;tiles.clear();network=buildGeographicNetwork([],'disposed');engine.setNetwork(network);},
 };
}
