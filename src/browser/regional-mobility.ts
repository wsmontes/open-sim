import type {createMobilityController} from '../client/mobility-controller';
import type {TransitContent} from '../core/transit-data';
import type {TrafficSignalSite,SchoolSite} from '../core/traffic-data';
import {parseVancouverSchools} from '../adapters/reality/vancouver-schools';
export function createRegionalResource<T extends {dispose():void}>(load:()=>Promise<()=>T>,changed:()=>void){
 let wanted=false,allowed=false,disposed=false,pending=false,error=false,factory:(()=>T)|undefined,current:T|undefined;
 const activate=()=>{if(disposed||!wanted||!allowed||current||error)return;if(factory){try{current=factory();}catch{error=true;}changed();return;}if(pending)return;pending=true;
  void load().then(value=>{if(disposed)return;factory=value;pending=false;activate();},()=>{if(disposed)return;pending=false;error=true;changed();});
 };
 return {
  update(next:boolean,ready=true){wanted=next;allowed=ready;if(!wanted){current?.dispose();current=undefined;}activate();},
  value:()=>current,
  status:()=>({loading:pending&&wanted,error:error&&wanted,ready:!!current}),
  retry(){error=false;activate();},
  dispose(){disposed=true;current?.dispose();current=undefined;factory=undefined;},
 };
}
type Captures={transit:TransitContent;signals:readonly TrafficSignalSite[];schools:readonly SchoolSite[]};
const loadCaptures=async():Promise<Captures>=>{
 const [transit,signals,schools]=await Promise.all([import('../adapters/reality/data/vancouver-transit-mobility.json'),import('../adapters/reality/data/vancouver-signals.json'),import('../adapters/reality/data/vancouver-schools.json')]);
 return {transit:transit.default as TransitContent,signals:signals.default as readonly TrafficSignalSite[],schools:parseVancouverSchools(schools.default)};
};
export function createRegionalMobility(options:{controller:Pick<ReturnType<typeof createMobilityController>,'setCity'|'setTransit'|'setSignalSites'|'setCivicSites'>;republish:()=>void;changed:()=>void;load?:()=>Promise<Captures>}){
 let city=false,applied:Captures|undefined;
 const resource=createRegionalResource(async()=>{const captures=await (options.load??loadCaptures)();return ()=>({captures,dispose(){}});},()=>{
  const captures=resource.value()?.captures;if(city&&captures&&captures!==applied){applied=captures;options.controller.setTransit(captures.transit);options.controller.setSignalSites(captures.signals);options.controller.setCivicSites(captures.schools);}options.changed();
 });
 return {
  update(inCoverage:boolean,ready=true){if(city!==inCoverage){city=inCoverage;applied=undefined;options.controller.setCity(city?'CA-BC':null);if(city)options.republish();options.changed();}resource.update(city,ready);},
  retry:resource.retry,status:resource.status,dispose:resource.dispose,
 };
}
