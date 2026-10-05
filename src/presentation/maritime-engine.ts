import type {MaritimeCapture,MarinePoint,MarineRoute,VesselKind,CruiseCall} from '../core/maritime-data';
import {buildMaritimeNetwork} from './maritime-network';
export type VesselFrame={id:string;kind:VesselKind;operator:string;routeId:string;berthId?:string;position:MarinePoint;headingDegrees:number;phase:'sailing'|'approach'|'berthed'|'departing';waterElevationM:number;method:'simulated'|'schedule-estimate'|'observed';speedMps?:number;vesselName?:string;callId?:string};
export const VESSEL_SIZE={cargo:{length:220,width:32},cruise:{length:280,width:34},sailboat:{length:12,width:3.5},seabus:{length:34,width:12},aquabus:{length:10,width:5},'bc-ferry':{length:150,width:27}} as const;
const RAD=Math.PI/180,R=6371008.8,STEP=1/30;
const distance=(a:MarinePoint,b:MarinePoint)=>{const lat=(b.lat-a.lat)*RAD,lon=(((b.lon-a.lon+540)%360)-180)*RAD;return 2*R*Math.asin(Math.min(1,Math.sqrt(Math.sin(lat/2)**2+Math.cos(a.lat*RAD)*Math.cos(b.lat*RAD)*Math.sin(lon/2)**2)));};
type Geometry={route:MarineRoute;length:number;lengths:number[]};
type Boat={id:string;kind:VesselKind;geometry:Geometry;direction:1|-1;distance:number;phase:VesselFrame['phase'];remaining:number;held?:string;speed:number;moving:number;call?:CruiseCall;nextDirection?:1|-1};
const speeds:Record<VesselKind,number>={cargo:6,cruise:7,sailboat:2.5,seabus:4.4,aquabus:3,'bc-ferry':0};
export function createMaritimeEngine(capture:MaritimeCapture,seed:number,capacity=24){
 const cap=Number.isFinite(capacity)?Math.max(0,Math.min(24,Math.floor(capacity))):24;
 const network=buildMaritimeNetwork(capture,[]),terminals=new Map(capture.terminals.map(t=>[t.id,t])),geometries=[...network.routes.values()].map(route=>{const lengths=[0];for(let i=1;i<route.path.length;i++)lengths.push(lengths.at(-1)!+distance(route.path[i-1],route.path[i]));return {route,length:lengths.at(-1)!,lengths};}).filter(g=>g.length>0);
 let snapshot:readonly VesselFrame[]|undefined;
 const boats=new Map<string,Boat>(),berths=new Map<string,string>();let accumulator=0,disposed=false,reservedSlots=0,scenario=Date.parse(capture.cruiseCalls[0]?.arrival??'2000-01-01T00:00:00Z');
 const position=(boat:Boat)=>{const g=boat.geometry;let index=0;while(index<g.lengths.length-2&&boat.distance>g.lengths[index+1])index++;const a=g.route.path[index],b=g.route.path[index+1],t=Math.max(0,Math.min(1,(boat.distance-g.lengths[index])/(g.lengths[index+1]-g.lengths[index]||1))),dlon=((b.lon-a.lon+540)%360)-180;
  const p={lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+dlon*t},heading=(Math.atan2(dlon*Math.cos(p.lat*RAD),b.lat-a.lat)/RAD+(boat.direction<0?180:0)+360)%360;
  // Simulated opposing small ferries use a narrow right-hand lane, fading to the
  // published dock centre over the last/first30m. This is not a reported track.
  const offset=(boat.kind==='seabus'?10:boat.kind==='aquabus'?3:0)*Math.min(1,boat.distance/30,(g.length-boat.distance)/30);
  if(boat.phase!=='berthed'&&offset){p.lat-=Math.sin(heading*RAD)*offset/R/RAD;p.lon+=Math.cos(heading*RAD)*offset/R/RAD/Math.cos(p.lat*RAD);}
  return {point:p,heading};
 };
 const endTerminal=(boat:Boat)=>terminals.get(boat.geometry.route.terminalIds[boat.direction>0?boat.geometry.route.terminalIds.length-1:0]);
 const release=(boat:Boat)=>{if(boat.held&&berths.get(boat.held)===boat.id)berths.delete(boat.held);boat.held=undefined;};
 const reserve=(boat:Boat,atOrigin=false)=>{const terminal=atOrigin?terminals.get(boat.geometry.route.terminalIds[0]):endTerminal(boat);if(!terminal?.berths.length)return true;const requested=!atOrigin&&boat.direction>0?boat.call?.berthId:undefined;const candidates=requested?[requested]:terminal.berths;const id=candidates.find(id=>terminal.berths.includes(id)&&(!berths.has(id)||berths.get(id)===boat.id));if(!id)return false;if(boat.held!==id)release(boat);boat.held=id;berths.set(id,boat.id);return true;};
 const desired=()=>{const values:{g:Geometry;kind:VesselKind;call?:CruiseCall}[]=[];for(const g of geometries)for(const kind of g.route.allowed){if(kind==='bc-ferry')continue;if(kind==='cruise'){for(const call of capture.cruiseCalls){if(call.terminalId!==g.route.terminalIds.at(-1)||call.berthId!==g.route.berthId||!(Date.parse(call.arrival)<=scenario&&scenario<Date.parse(call.departure)))continue;values.push({g,kind,call});}}else values.push({g,kind});}return values.sort((a,b)=>['cruise','seabus','aquabus','cargo','sailboat'].indexOf(a.kind)-['cruise','seabus','aquabus','cargo','sailboat'].indexOf(b.kind));};
 const spawn=()=>{const wanted=desired(),ids=new Set(wanted.map(v=>`marine:${seed}:${v.g.route.id}:${v.kind}:${v.call?.id??'simulated'}`));for(const boat of boats.values())if(!ids.has(boat.id)){release(boat);boats.delete(boat.id);snapshot=undefined;}
  for(const item of wanted){const id=`marine:${seed}:${item.g.route.id}:${item.kind}:${item.call?.id??'simulated'}`;if(boats.has(id)||boats.size>=cap-reservedSlots)continue;const origin=item.g.route.path[0];if([...boats.values()].some(b=>distance(position(b).point,origin)<(VESSEL_SIZE[b.kind].length+VESSEL_SIZE[item.kind].length)/2+15))continue;
   const boat:Boat={id,kind:item.kind,geometry:item.g,direction:1,distance:0,phase:'berthed',remaining:30,speed:speeds[item.kind],moving:0,call:item.call};if(!reserve(boat,true))continue;if(!boat.held){boat.phase='departing';boat.remaining=0;}boats.set(id,boat);snapshot=undefined;
  }
 };
 const step=()=>{snapshot=undefined;for(const boat of boats.values()){
  boat.moving=0;if(boat.phase==='berthed'){boat.remaining-=STEP;if(boat.remaining>0)continue;if(boat.nextDirection){boat.direction=boat.nextDirection;boat.nextDirection=undefined;}boat.phase='departing';}
  const g=boat.geometry,remaining=boat.direction>0?g.length-boat.distance:boat.distance,ownerLength=Math.max(0,...(endTerminal(boat)?.berths??[]).map(id=>{const owner=boats.get(berths.get(id)??'');return owner?VESSEL_SIZE[owner.kind].length:0;})),queueDistance=(VESSEL_SIZE[boat.kind].length+ownerLength)/2+15,radius=Math.max(40,VESSEL_SIZE[boat.kind].length+30,queueDistance+20);
  const fromEnd=boat.direction>0?boat.distance:g.length-boat.distance;if(boat.phase==='departing'&&fromEnd>VESSEL_SIZE[boat.kind].length/2+3){release(boat);boat.phase='sailing';}
  let travel=boat.speed*STEP;if(remaining<=radius){boat.phase='approach';if(!reserve(boat))travel=Math.min(travel,Math.max(0,remaining-queueDistance));}
  for(const other of boats.values()){if(other===boat||other.geometry.route.id!==g.route.id||other.direction!==boat.direction)continue;const ahead=(other.distance-boat.distance)*boat.direction;if(ahead>0)travel=Math.min(travel,Math.max(0,ahead-(VESSEL_SIZE[boat.kind].length+VESSEL_SIZE[other.kind].length)/2-15));}
  travel=Math.min(travel,remaining);boat.distance+=boat.direction*travel;boat.moving=travel/STEP;
  if(remaining-travel<=1e-7&&reserve(boat)){boat.phase='berthed';boat.remaining=boat.kind==='cargo'||boat.kind==='cruise'?120:30;boat.moving=0;boat.nextDirection=boat.direction>0?-1:1;}
 }};
 spawn();
 return {
  setScenario(instant:string){const time=Date.parse(instant);if(!Number.isFinite(time)||disposed)return;scenario=time;spawn();},
  setReservedCapacity(count:number){reservedSlots=Number.isFinite(count)?Math.max(0,Math.min(cap,Math.floor(count))):0;while(boats.size>cap-reservedSlots){const b=[...boats.values()].at(-1)!;release(b);boats.delete(b.id);snapshot=undefined;}},
  advance(seconds:number){if(disposed||!Number.isFinite(seconds)||seconds<=0)return;accumulator+=Math.min(.25,seconds);spawn();while(accumulator+1e-10>=STEP){step();accumulator-=STEP;}},
  frame():readonly VesselFrame[]{return snapshot??=Object.freeze([...boats.values()].map(b=>{const p=position(b);return {id:b.id,kind:b.kind,operator:b.call?.company??b.geometry.route.operator,routeId:b.geometry.route.id,berthId:b.held,position:p.point,headingDegrees:p.heading,phase:b.phase,waterElevationM:0,method:'simulated' as const,speedMps:b.moving,vesselName:b.call?.vesselName,callId:b.call?.id};}));},
  dispose(){disposed=true;boats.clear();berths.clear();snapshot=undefined;},
 };
}
