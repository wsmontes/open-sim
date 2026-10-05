import type {MeasureSource} from './municipal-facts';
export type TrafficCount={id:string;lat:number;lon:number;from:string;to:string;direction?:number;vehicleClass:'car'|'truck'|'pedestrian'|'all-vehicles';count:number;source:MeasureSource};
export type SchoolSite={id:string;name:string;lat:number;lon:number;source:MeasureSource};
export type TrafficSignalSite={id:string;lat:number;lon:number;source:MeasureSource};
