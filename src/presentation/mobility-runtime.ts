import type {MobilityNetwork,MobilityNode} from './mobility-model';
export type SignalTemplate={nodeId:string;point:{x:number;y:number};direction:{x:number;y:number};axis:'east-west'|'north-south'};
export type MobilityRuntime={intersections:readonly string[];signals:readonly SignalTemplate[];signalNodes:readonly MobilityNode[]};
export function prepareMobilityRuntime(network:MobilityNetwork):MobilityRuntime{
 const neighbours=new Map<string,Set<string>>(),ground=new Map<string,Set<string>>();
 for(const edge of network.edges.values()){if(!edge.allowed.includes('car'))continue;for(const [a,b] of [[edge.from,edge.to],[edge.to,edge.from]]){if(edge.level===0){const set=ground.get(a)??new Set();set.add(b);ground.set(a,set);}if(edge.roadClass!=='service'){const set=neighbours.get(a)??new Set();set.add(b);neighbours.set(a,set);}}}
 const intersections=new Set([...neighbours].filter(([,set])=>set.size>=3).map(([id])=>id)),signals:SignalTemplate[]=[],seen=new Set<string>();
 for(const edge of network.edges.values()){if(!intersections.has(edge.to)||!edge.allowed.includes('car'))continue;const a=edge.path.at(-2)!,b=edge.path.at(-1)!,length=Math.hypot(b.x-a.x,b.y-a.y);if(!length)continue;const direction={x:(b.x-a.x)/length,y:(b.y-a.y)/length},key=`${edge.to}:${Math.round(direction.x*10)},${Math.round(direction.y*10)}`;if(seen.has(key))continue;seen.add(key);signals.push({nodeId:edge.to,point:network.nodes.get(edge.to)!.point,direction,axis:Math.abs(b.x-a.x)>=Math.abs(b.y-a.y)?'east-west':'north-south'});}
 return {intersections:[...intersections],signals,signalNodes:[...network.nodes.values()].filter(n=>n.level===0&&(ground.get(n.id)?.size??0)>=3)};
}
