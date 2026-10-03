import type {Point} from './camera';
export type MobilityKind='car'|'bus'|'truck'|'pedestrian'|'police'|'school-bus';
export type MobilityNode={id:string;point:Point;level:number};
export type MobilityEdge={id:string;from:string;to:string;path:readonly Point[];lengthM:number;roadClass:string;allowed:readonly MobilityKind[];method:'reported'|'derived';level:number;bridge:boolean};
export type MobilityNetwork={revision:string;nodes:ReadonlyMap<string,MobilityNode>;edges:ReadonlyMap<string,MobilityEdge>;outgoing:ReadonlyMap<string,readonly string[]>};
export type MobilityAgent={id:string;kind:MobilityKind;route:readonly string[];edgeIndex:number;distanceM:number;speedMps:number;seed:number;tripId?:string;patternId?:string;stopsM?:readonly number[]};
export type MobilityFrameAgent={id:string;kind:MobilityKind;point:Point;heading:Point;elevationM:number|null;seed:number;method:'simulated'|'observed';tripId?:string};
export type MobilityDemand={vehicles:number;pedestrians:number;truckShare:number;hour:number;bounds?:{minX:number;maxX:number;minY:number;maxY:number}};
export type MobilitySignal={nodeId:string;point:Point;phase:'east-west-green'|'east-west-yellow'|'north-south-green'|'north-south-yellow'|'clearance';method:'simulated'};
