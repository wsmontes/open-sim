import type {MeasureSource} from './municipal-facts';
export type TrafficCount={id:string;lat:number;lon:number;from:string;to:string;direction?:number;vehicleClass:'car'|'truck'|'pedestrian'|'all-vehicles';count:number;source:MeasureSource};
