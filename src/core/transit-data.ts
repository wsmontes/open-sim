export type TransitAgency={id?:string;name:string;url?:string;timezone:string};
// `label` is present only when the readable name is not one: a stop without a declared name keeps its provider id as a
// label and says so, so nothing about the source's own identifier is presented as a place name.
export type TransitStop={providerId:string;name:string;label?:'provider-id';lat:number;lon:number;rest?:Record<string,string>};
export type TransitStopTime={stopId:string;arrival:string;departure:string};
export type TransitTrip={id:string;serviceId:string;shapeId?:string;directionId?:string;stops:readonly TransitStopTime[]};
export type TransitRoute={providerId:string;name:string;label?:'provider-id';shortName?:string;longName?:string;type:number;trips:readonly TransitTrip[];rest?:Record<string,string>};
export type TransitCalendar={serviceId:string;weekdays:readonly string[];startDate:string;endDate:string};
export type TransitException={serviceId:string;date:string;type:'added'|'removed'};
export type TransitEntity={uri:string;kind:'stop'|'route';providerId:string;components:Record<string,unknown>};
export type TransitCapabilities={routing:'not-computed';realtime:'not-included'};
export type TransitContent={
 shapes:readonly TransitShape[];
 timezone:string;
 agencies:readonly TransitAgency[];
 stops:readonly TransitStop[];
 routes:readonly TransitRoute[];
 calendars:readonly TransitCalendar[];
 exceptions:readonly TransitException[];
 entities:readonly TransitEntity[];
 capabilities:TransitCapabilities;
};
export type TransitShape={id:string;points:readonly {lat:number;lon:number;sequence:number;distance?:number}[]};
