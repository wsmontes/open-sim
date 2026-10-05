import type {CityIdentity} from '../core/municipal-facts';
import type {SourceCapability} from '../core/source-capabilities';

// Eligibility is separate from availability: bundled providers still need a validated capture.
export function selectSources(city:CityIdentity,catalog:readonly SourceCapability[]):readonly SourceCapability[]{
 return catalog.filter(source=>{
  if(source.access==='unverified'||source.access==='requires-backend')return false;
  if(source.countries&&!source.countries.includes(city.countryCode))return false;
  if(source.provinces&&(!city.provinceCode||!source.provinces.includes(city.provinceCode)))return false;
  if(source.territoryIds&&!source.territoryIds.includes(city.qid))return false;
  if(source.scope==='country'&&!source.countries?.length)return false;
  if(source.scope==='province'&&!source.provinces?.length)return false;
  if(source.scope==='operator'&&(!source.territoryIds?.includes(city.qid)||city.geography!=='municipality'))return false;
  return true;
 });
}

export const CITY_IDENTITIES:Readonly<Record<string,CityIdentity>>={
 Q24639:{qid:'Q24639',name:'Vancouver',countryCode:'CA',provinceCode:'CA-BC',officialCode:'5915022',dguid:'2021A00055915022',geography:'municipality',boundaryVersion:'2021'},
 Q2132:{qid:'Q2132',name:'Victoria',countryCode:'CA',provinceCode:'CA-BC',geography:'municipality'},
 Q172:{qid:'Q172',name:'Toronto',countryCode:'CA',provinceCode:'CA-ON',geography:'municipality'},
 Q597:{qid:'Q597',name:'Lisboa',countryCode:'PT',geography:'municipality'},
 Q174:{qid:'Q174',name:'São Paulo',countryCode:'BR',officialCode:'3550308',geography:'municipality'},
};
export const SOURCE_CATALOG:readonly SourceCapability[]=[
 {id:'osm',scope:'global',datasets:['geography'],access:'bundled'},
 {id:'wikidata',scope:'global',datasets:['identity','demography'],access:'direct'},
 {id:'open-meteo',scope:'global',datasets:['weather'],access:'direct'},
 {id:'ourairports',scope:'global',datasets:['airports'],access:'bundled'},
 {id:'copernicus',scope:'global',datasets:['terrain-surface'],access:'bundled'},
 {id:'statcan',scope:'country',countries:['CA'],datasets:['demography','boundaries'],access:'bundled'},
 {id:'ibge',scope:'country',countries:['BR'],datasets:['demography'],access:'direct'},
 {id:'bc-stats',scope:'province',provinces:['CA-BC'],countries:['CA'],datasets:['population-estimates'],access:'bundled'},
 {id:'bc-finance',scope:'province',provinces:['CA-BC'],countries:['CA'],datasets:['finance-actuals'],access:'bundled'},
 {id:'lidarbc',scope:'province',provinces:['CA-BC'],countries:['CA'],datasets:['terrain'],access:'bundled'},
 {id:'drivebc',scope:'province',provinces:['CA-BC'],countries:['CA'],datasets:['highway-events'],access:'direct'},
 {id:'translink',scope:'operator',countries:['CA'],territoryIds:['Q24639'],datasets:['transit'],access:'bundled'},
 {id:'bc-transit-victoria',scope:'operator',countries:['CA'],territoryIds:['Q2132'],datasets:['transit'],access:'bundled'},
 {id:'aquabus',scope:'operator',countries:['CA'],territoryIds:['Q24639'],datasets:['passenger-ferries'],access:'bundled'},
 {id:'mobi',scope:'operator',countries:['CA'],territoryIds:['Q24639'],datasets:['shared-bikes'],access:'direct'},
 {id:'port-vancouver',scope:'operator',countries:['CA'],territoryIds:['Q24639'],datasets:['port'],access:'bundled'},
 {id:'vancouver-open-data',scope:'operator',countries:['CA'],territoryIds:['Q24639'],datasets:['signals','works','finance'],access:'direct'},
];
