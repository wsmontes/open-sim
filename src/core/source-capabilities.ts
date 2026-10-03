export type SourceCapability={
 id:string;
 scope:'global'|'country'|'province'|'operator';
 countries?:readonly string[];
 provinces?:readonly string[];
 territoryIds?:readonly string[];
 datasets:readonly string[];
 access:'bundled'|'direct'|'unverified'|'requires-backend';
};
