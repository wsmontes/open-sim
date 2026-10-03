import type {AirportCapture,AirportPoint,AirportRunway} from '../core/airport-data';
export type AircraftPhase='approach'|'landing-roll'|'waiting'|'takeoff-roll'|'climb';
export type AircraftFrame={id:string;airportId:string;airlineCode:string;phase:AircraftPhase;position:AirportPoint;headingDegrees:number;altitudeM:number;verticalDatum:string;progress:number;colours:readonly string[];method:'simulated';runwayId?:string;opacity?:number};
const STEP=1/30,RAD=Math.PI/180;
type Flight={id:string;runway:AirportRunway;direction:1|-1;arrival:boolean;time:number;airline:AirportCapture['airlines'][number]};
export function createAviationEngine(capture:AirportCapture,seed:number){
 const runways=capture.runways.filter(r=>r.airportId===capture.id&&!r.closed&&Number.isFinite(r.elevationM)&&r.verticalDatum==='CGVD2013'),flights=new Map<string,Flight>(),counts=new Map<string,number>();let accumulator=0,disposed=false,cursor=0,sequence=0;
 const xy=(p:AirportPoint)=>({x:(p.lon-capture.position.lon)*111195*Math.cos(capture.position.lat*RAD),y:(p.lat-capture.position.lat)*111195});
 const cross=(a:{x:number;y:number},b:{x:number;y:number},c:{x:number;y:number})=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
 const conflicts=(a:AirportRunway,b:AirportRunway)=>{if(a.id===b.id)return true;const [p,q]=a.ends.map(xy),[r,s]=b.ends.map(xy);if(Math.max(p.x,q.x)+150<Math.min(r.x,s.x)||Math.max(r.x,s.x)+150<Math.min(p.x,q.x)||Math.max(p.y,q.y)+150<Math.min(r.y,s.y)||Math.max(r.y,s.y)+150<Math.min(p.y,q.y))return false;return cross(p,q,r)*cross(p,q,s)<=0&&cross(r,s,p)*cross(r,s,q)<=0;};
 const spawn=()=>{if(disposed||!capture.airlines.length)return;for(let n=0;n<runways.length&&flights.size<8;n++){const runway=runways[(cursor+n)%runways.length];if([...flights.values()].some(f=>conflicts(f.runway,runway)))continue;const count=counts.get(runway.id)??0;counts.set(runway.id,count+1);const id=`air:${seed}:${capture.id}:${runway.id}:${count}`;flights.set(id,{id,runway,direction:count%2===0?1:-1,arrival:count%2===0,time:0,airline:capture.airlines[sequence++%capture.airlines.length]});}if(runways.length)cursor=(cursor+1)%runways.length;};
 const frameFor=(f:Flight):AircraftFrame=>{const r=f.runway,[a,b]=f.direction>0?r.ends:[r.ends[1],r.ends[0]],dx=(b.lon-a.lon)*111195*Math.cos(a.lat*RAD),dy=(b.lat-a.lat)*111195,length=Math.hypot(dx,dy),heading=(Math.atan2(dx,dy)/RAD+360)%360,base=r.elevationM!;let distance=0,height=0,phase:AircraftPhase='waiting',progress=0,opacity=1;
  if(f.arrival){if(f.time<100){progress=f.time/100;distance=-8000*(1-progress);height=-distance*Math.tan(3*RAD);phase='approach';opacity=Math.min(1,f.time/3);}else if(f.time<160){progress=(f.time-100)/60;distance=length*.6*(2*progress-progress*progress);phase='landing-roll';}else{distance=length*.6;progress=Math.min(1,(f.time-160)/30);opacity=Math.min(1,(190-f.time)/10);}}
  else if(f.time<10){opacity=Math.min(1,f.time/3);progress=f.time/10;}
  else if(f.time<70){progress=(f.time-10)/60;distance=length*.6*progress*progress;phase='takeoff-roll';}
  else{progress=(f.time-70)/100;distance=length*.6+8000*progress;height=8000*progress*Math.tan(5*RAD);phase='climb';opacity=Math.min(1,(170-f.time)/3);}
  return {id:f.id,airportId:capture.id,airlineCode:f.airline.code,phase,position:{lat:a.lat+dy/length*distance/111195,lon:a.lon+dx/length*distance/111195/Math.cos(a.lat*RAD)},headingDegrees:heading,altitudeM:base+height,verticalDatum:r.verticalDatum!,progress,colours:f.airline.colours,method:'simulated',runwayId:r.id,opacity:Math.max(0,opacity)};
 };
 spawn();return {advance(seconds:number){if(disposed||!Number.isFinite(seconds)||seconds<=0)return;accumulator+=Math.min(.25,seconds);while(accumulator+1e-10>=STEP){for(const f of flights.values()){f.time+=STEP;if(f.time>=(f.arrival?190:170))flights.delete(f.id);}spawn();accumulator-=STEP;}},frame():readonly AircraftFrame[]{return [...flights.values()].map(frameFor);},dispose(){disposed=true;flights.clear();}};
}
