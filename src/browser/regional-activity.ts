import {createFrameMerge} from '../presentation/frame-merge';
import {createMaritimeEngine,type VesselFrame} from '../presentation/maritime-engine';
import {createAviationEngine} from '../presentation/aviation';
import {readMaritimeCapture} from '../adapters/reality/maritime';
import {readAirportCapture} from '../adapters/reality/airports';
import {readFerrySchedule} from '../adapters/reality/bc-ferries';
import {scheduledFerryFrames} from '../presentation/ferry-schedule';
import maritimeData from '../adapters/reality/data/vancouver-maritime.json';
import airportData from '../adapters/reality/data/cyvr.json';
import ferryData from '../adapters/reality/data/bc-ferries.json';
const marine=readMaritimeCapture(maritimeData),schedule=readFerrySchedule(ferryData,marine.routes);
export function createRegionalActivity(seed:number,vessels:number,aircraft:number){
 const maritime=createMaritimeEngine(marine,seed,vessels),aviation=createAviationEngine(readAirportCapture(airportData),seed,aircraft),merge=createFrameMerge<VesselFrame>();
 let ferries:readonly VesselFrame[]=[];
 return {
  advance(seconds:number,instant:string){maritime.setScenario(instant);ferries=scheduledFerryFrames(schedule,marine.routes,instant);maritime.setReservedCapacity(ferries.length);maritime.advance(seconds);aviation.advance(seconds);},
  vessels:()=>merge(ferries,maritime.frame()),aircraft:aviation.frame,
  dispose(){maritime.dispose();aviation.dispose();ferries=[];},
 };
}
