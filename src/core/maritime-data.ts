import type {MeasureSource} from './municipal-facts';
export type VesselKind='cargo'|'cruise'|'sailboat'|'seabus'|'aquabus'|'bc-ferry';
export type MarinePoint={lat:number;lon:number};
export type MarineTerminal={id:string;name:string;operator:string;position:MarinePoint;berths:readonly string[];source:MeasureSource;allowedKinds?:readonly VesselKind[];berthPositions?:Readonly<Record<string,MarinePoint>>};
export type MarineRoute={id:string;operator:string;berthId?:string;terminalIds:readonly string[];terminalPathIndices?:readonly number[];path:readonly MarinePoint[];allowed:readonly VesselKind[];method:'reported'|'derived';source:MeasureSource;verified:boolean;navigation?:{leastDepthM:number;airClearanceM?:number;verifiedForLargeShips:boolean;source:MeasureSource}};
export type CruiseCall={id:string;vesselName:string;company:string;terminalId:string;berthId?:string;arrival:string;departure:string;source:MeasureSource;windowMethod?:'reported'|'derived'};
export type MaritimeCapture={terminals:readonly MarineTerminal[];routes:readonly MarineRoute[];cruiseCalls:readonly CruiseCall[]};
export type ScheduledSailing={id:string;routeId:string;serviceDate:string;timezone:string;calls:readonly {terminalId:string;arrivalInstant?:string;departureInstant?:string;localArrival?:string;localDeparture?:string}[];vesselName?:string;status:'scheduled'|'cancelled';source:MeasureSource};
export type FerryScheduleCapture={validFrom:string;validUntil:string;sailings:readonly ScheduledSailing[]};
