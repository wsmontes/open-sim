import {prepareMobilityRuntime} from './mobility-runtime';
import {WORLD} from '../core/coordinates';
import {metresPerCellAt} from './terrain-surface';
import type {TrafficSignalSite} from '../core/traffic-data';
import type {MobilityNetwork,MobilityNode} from './mobility-model';
export function matchTrafficSignals(network:MobilityNetwork,sites:readonly TrafficSignalSite[]):ReadonlyMap<string,TrafficSignalSite>{
 const buckets=new Map<string,MobilityNode[]>();
 for(const node of (network.runtime??prepareMobilityRuntime(network)).signalNodes){const key=`${Math.floor(node.point.x/8)},${Math.floor(node.point.y/8)}`,list=buckets.get(key)??[];list.push(node);buckets.set(key,list);}
 const out=new Map<string,TrafficSignalSite>();for(const s of sites){if(!Number.isFinite(s.lat)||!Number.isFinite(s.lon))continue;const p={x:(s.lon+180)/360*WORLD,y:(1-Math.asinh(Math.tan(s.lat*Math.PI/180))/Math.PI)/2*WORLD},scale=metresPerCellAt(s.lat),radius=25/scale;let best:string|undefined,distance=25;for(let x=Math.floor((p.x-radius)/8);x<=Math.floor((p.x+radius)/8);x++)for(let y=Math.floor((p.y-radius)/8);y<=Math.floor((p.y+radius)/8);y++)for(const node of buckets.get(`${x},${y}`)??[]){const d=Math.hypot(node.point.x-p.x,node.point.y-p.y)*scale;if(d<distance){distance=d;best=node.id;}}if(best&&!out.has(best))out.set(best,s);}
 return out;
}
