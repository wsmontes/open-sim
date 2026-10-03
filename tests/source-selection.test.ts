import {expect,test} from 'vitest';
import {selectSources,CITY_IDENTITIES,SOURCE_CATALOG} from '../src/client/source-selection';
import type {CityIdentity} from '../src/core/municipal-facts';
import type {SourceCapability} from '../src/core/source-capabilities';
const ids=(city:CityIdentity)=>selectSources(city,SOURCE_CATALOG).map(s=>s.id);
test('Vancouver includes world Canada BC and covered operators',()=>{
 expect(ids(CITY_IDENTITIES['Q24639']!)).toEqual(expect.arrayContaining(['wikidata','osm','statcan','bc-stats','bc-finance','drivebc','translink','aquabus','mobi','port-vancouver']));
});
test('Victoria excludes Vancouver operators',()=>{
 const selected=ids(CITY_IDENTITIES['Q2132']!);
 expect(selected).toEqual(expect.arrayContaining(['statcan','bc-stats','bc-transit-victoria']));
 expect(selected).not.toContain('translink');
 expect(selected).not.toContain('aquabus');
 expect(selected).not.toContain('mobi');
});
test('Toronto excludes BC sources',()=>{
 const selected=ids(CITY_IDENTITIES['Q172']!);
 expect(selected).toContain('statcan');
 expect(selected).not.toContain('bc-stats');
 expect(selected).not.toContain('drivebc');
});
test('Lisbon retains world sources and excludes Canadian sources',()=>{
 const selected=ids(CITY_IDENTITIES['Q597']!);
 expect(selected).toContain('wikidata');
 expect(selected).not.toContain('statcan');
});
test('a Vancouver name in another country cannot enable municipal operators',()=>{
 const wrong={...CITY_IDENTITIES['Q24639']!,qid:'Qnew',countryCode:'US',provinceCode:'US-WA'};
 expect(ids(wrong)).not.toContain('aquabus');
});
test('an unverified direct provider remains disabled',()=>{
 const catalog:SourceCapability[]=[{id:'secret',scope:'global',datasets:['traffic'],access:'unverified'}];
 expect(selectSources(CITY_IDENTITIES['Q24639']!,catalog)).toEqual([]);
});
test('operator needs explicit territory membership and every geographic restriction',()=>{
 const city=CITY_IDENTITIES['Q24639']!;
 const catalog:SourceCapability[]=[
 {id:'no-area',scope:'operator',datasets:['bus'],access:'bundled'},
 {id:'wrong-country',scope:'operator',countries:['US'],territoryIds:['Q24639'],datasets:['bus'],access:'bundled'},
 {id:'right',scope:'operator',countries:['CA'],territoryIds:['Q24639'],datasets:['bus'],access:'bundled'},
 ];
 expect(selectSources(city,catalog).map(s=>s.id)).toEqual(['right']);
});
test('a metro identity does not inherit municipal facts',()=>{
 expect(ids({...CITY_IDENTITIES['Q24639']!,geography:'metro'})).not.toContain('aquabus');
});
