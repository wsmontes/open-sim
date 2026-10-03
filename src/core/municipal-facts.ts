// Stable identity for joining statistical sources; names alone never establish jurisdiction.
export type CityIdentity={
 qid:string;
 name:string;
 countryCode:string;
 provinceCode?:string;
 officialCode?:string;
 dguid?:string;
 geography:'municipality'|'metro'|'province';
 boundaryVersion?:string;
};
