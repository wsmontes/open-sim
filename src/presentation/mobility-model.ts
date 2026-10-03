import type {Point} from './camera';
export type MobilityKind='car'|'bus'|'truck'|'pedestrian'|'police'|'school-bus';
export type MobilityNode={id:string;point:Point;level:number};
export type MobilityEdge={id:string;from:string;to:string;path:readonly Point[];lengthM:number;roadClass:string;allowed:readonly MobilityKind[];method:'reported'|'derived';level:number;bridge:boolean};
export type MobilityNetwork={revision:string;nodes:ReadonlyMap<string,MobilityNode>;edges:ReadonlyMap<string,MobilityEdge>;outgoing:ReadonlyMap<string,readonly string[]>};
