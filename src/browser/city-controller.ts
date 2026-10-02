import {createWikidataDirectory,type CityFacts} from '../adapters/reality/wikidata';
import {createIbgeDirectory} from '../adapters/reality/ibge';
// Only the newest place lookup may update the city UI or publish a census observation.
export function createCityController(onFacts:(facts:CityFacts)=>void){
 const directory=createWikidataDirectory(),municipalDirectory=createIbgeDirectory();let sequence=0;
 return{
  async lookUp(lat:number,lon:number,name?:string){
   const ticket=++sequence;
   const live=name?await directory.named(name,'pt'):null;
   const found=live??await directory.near(lat,lon,25);
   if(!found||ticket!==sequence)return;
   const municipal=found.municipalCode?await municipalDirectory.byMunicipalCode(found.municipalCode):null;
   if(ticket!==sequence)return;
   const facts:CityFacts=!municipal?found:{...found,
    ...(municipal.population!==undefined?{population:municipal.population,populationYear:municipal.populationYear}:{}),
    ...(municipal.areaKm2!==undefined?{areaKm2:municipal.areaKm2}:{}),
    ...(municipal.densityPerKm2!==undefined?{densityPerKm2:municipal.densityPerKm2}:{}),
    ...(municipal.gdpThousandsBrl!==undefined?{gdpThousandsBrl:municipal.gdpThousandsBrl,gdpYear:municipal.gdpYear}:{}),
    source:{...municipal.source,license:`${municipal.source.license} · também ${found.source.dataset} (${found.source.license})`},
   };
   onFacts(facts);
  },
 };
}
