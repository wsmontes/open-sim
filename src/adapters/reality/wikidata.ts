// Real demography for the city the player is looking at, from Wikidata (CC0). Two questions are worth asking, and
// both are answered by one SPARQL query each:
//
//   named(name, language)   the city the player typed or picked from the list
//   near(lat, lon, radius)  the city the player is actually standing in
//
// The rules are the ones this project applies to every source (docs/world-protocol.md): a value nobody stated stays
// absent — a city without a census does *not* get a zero — and a source that fails, lies or answers garbage leaves the
// game without a number instead of with an invented one. What arrives carries where it came from and its year, so the
// screen can say "11.904.961 (Wikidata, 2025)" instead of pretending to be authoritative on its own.
export type {CityFacts,CityDirectory,CityFactsSource} from './city';
import type {CityDirectory,CityFacts} from './city';
export type WikidataOptions = {
 fetcher?: typeof fetch;
 endpoint?: string;
 timeoutMs?: number;
 // Wikidata asks callers to identify themselves; a build with no user agent is a build that gets throttled.
 userAgent?: string;
 retrievedAt?: () => string;
};
const ENDPOINT='https://query.wikidata.org/sparql';
const DATASET='Wikidata';
const LICENSE='CC0';
const USER_AGENT='open-sim/0.1 (+https://github.com/wsmontes/open-sim)';
// One request at a time with a gap between them: a session asks at most a handful of times, and being a polite caller
// is cheaper than being rate limited.
const MIN_GAP_MS=120;

// `wikibase:mwapi` is what turns "the player typed Lisboa" into an entity without a second round trip, and the label
// service gives the human names in the language the player is reading.
//
// The `wdt:P31/wdt:P279* wd:Q486972` line is what keeps the answer a place. A search returns everything the words
// match, and the most relevant result for "Rio de Janeiro" is the 2016 Olympic Games: without asking for a human
// settlement — and its subclasses, which is what a city, a town and a municipality are — the adapter would report the
// population of an event, or of nothing at all. It is also what makes a municipal code meaningful, since only a place
// has one.
const namedQuery=(name:string,language:string)=>`SELECT ?city ?cityLabel ?countryLabel ?countryCode ?pop ?date ?rank ?area ?municipalCode WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "EntitySearch" ; wikibase:endpoint "www.wikidata.org" ;
                    mwapi:search ${JSON.stringify(name)} ; mwapi:language ${JSON.stringify(language)} .
    ?city wikibase:apiOutputItem mwapi:item .
  }
  ?city wdt:P31/wdt:P279* wd:Q486972 .
  OPTIONAL { ?city p:P1082 ?statement . ?statement ps:P1082 ?pop ; wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) OPTIONAL { ?statement pq:P585 ?date } }
  OPTIONAL { ?city wdt:P2046 ?area }
  OPTIONAL { ?city wdt:P17 ?country . OPTIONAL { ?country wdt:P297 ?countryCode } }
  OPTIONAL { ?city wdt:P1585 ?municipalCode }
  SERVICE wikibase:label { bd:serviceParam wikibase:language ${JSON.stringify(`${language},en`)} . }
} LIMIT 300`;
// Around a point, nearest first: the city the player is standing in, not the biggest one in the country.
const nearQuery=(lat:number,lon:number,radiusKm:number)=>`SELECT ?city ?cityLabel ?countryLabel ?countryCode ?pop ?date ?rank ?area ?municipalCode ?distance WHERE {
  SERVICE wikibase:around {
    ?city wdt:P625 ?location .
    bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral ; wikibase:radius ${JSON.stringify(String(radiusKm))} .
  }
  ?city wdt:P31/wdt:P279* wd:Q486972 .
  ?city wdt:P1082 ?anyPop .
  OPTIONAL { ?city p:P1082 ?statement . ?statement ps:P1082 ?pop ; wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) OPTIONAL { ?statement pq:P585 ?date } }
  OPTIONAL { ?city wdt:P2046 ?area }
  OPTIONAL { ?city wdt:P17 ?country . OPTIONAL { ?country wdt:P297 ?countryCode } }
  OPTIONAL { ?city wdt:P1585 ?municipalCode }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "pt,en" . }
} ORDER BY ?distance LIMIT 60`;

const entityId=(uri:string)=>uri.slice(uri.lastIndexOf('/')+1);
const plainNumber=(value:string|undefined):number|null=>{
 if(value===undefined)return null;
 const parsed=Number(value);
 return Number.isFinite(parsed)?parsed:null;
};
const yearOf=(value:string|undefined):number|null=>{
 if(!value)return null;
 const year=Number(value.slice(0,4));
 return Number.isInteger(year)&&year>0?year:null;
};
type Binding=Record<string,{value:string}>;
// Several rows describe one city: every dated census and every area statement. The newest census wins, and a row set
// with no census at all still names the city — without a population.
function factsFrom(bindings:readonly Binding[],retrievedAt:string):CityFacts|null {
 const byCity=new Map<string,CityFacts & {bestYear:number;distanceKm:number}>();
 for(const row of bindings){
  const uri=row['city']?.value;
  if(!uri)continue;
  const id=entityId(uri);
  const label=row['cityLabel']?.value??id;
  const country=row['countryLabel']?.value;
  const parsedPopulation=plainNumber(row['pop']?.value);
  const population=row['rank']?.value?.endsWith('DeprecatedRank')||parsedPopulation===null||!Number.isSafeInteger(parsedPopulation)||parsedPopulation<0?null:parsedPopulation;
  const year=yearOf(row['date']?.value);
  const area=plainNumber(row['area']?.value);
  // A statistics code is only useful if it has the shape the statistics office uses: anything else is ignored rather
  // than passed on to a second source that would then answer about some other city.
  const code=row['municipalCode']?.value;
  const municipalCode=code&&/^\d{7}$/.test(code)?code:undefined;
  // A `near` query states how far each candidate is; a `named` query does not, and then relevance order is the answer.
  const distance=plainNumber(row['distance']?.value);
  const current=byCity.get(id)??{id,label,source:{dataset:DATASET,url:`https://www.wikidata.org/wiki/${id}`,license:LICENSE},bestYear:-1,distanceKm:distance??Number.POSITIVE_INFINITY};
  if(distance!==null&&distance<current.distanceKm)current.distanceKm=distance;
  // The birth year of the entry is the newest census seen; an undated census loses to a dated one of any year.
  const stamp=population!==null?(year??0):-1;
  if(population!==null&&stamp>=current.bestYear){
   current.population=population;
   current.bestYear=stamp;
   if(year!==null)current.populationYear=year;
   else delete current.populationYear;
  }
  if(area!==null)current.areaKm2=area;
  if(municipalCode&&!current.municipalCode)current.municipalCode=municipalCode;
  if(country&&!current.country)current.country=country;
  const countryCode=row['countryCode']?.value;
  if(countryCode&&/^[A-Z]{2}$/.test(countryCode))current.countryCode=countryCode;
  byCity.set(id,current);
 }
 // Nearest wins outright when the query carried a distance — the row order of a federation service is not a promise.
 // With no distance (a search by name) the first entry is the most relevant one, which is what the service ordered.
 const entries=[...byCity.values()];
 const chosen=entries.find(entry=>Number.isFinite(entry.distanceKm))?entries.reduce((best,entry)=>entry.distanceKm<best.distanceKm?entry:best):entries[0];
 if(!chosen)return null;
 const {bestYear:_bestYear,distanceKm:_distance,...facts}=chosen;
 if(facts.population!==undefined||facts.areaKm2!==undefined){
  const source={...facts.source,territoryId:facts.id,retrievedAt,method:'reported' as const};
  facts.measures={
   ...(facts.population===undefined?{}:{population:{value:facts.population,unit:'people' as const,source:{...source,observedYear:facts.populationYear}}}),
   ...(facts.areaKm2===undefined?{}:{areaKm2:{value:facts.areaKm2,unit:'km2' as const,source}}),
  };
 }
 return facts;
}

export function createWikidataDirectory(options:WikidataOptions={}):CityDirectory {
 const fetcher=options.fetcher??fetch;
 const endpoint=options.endpoint??ENDPOINT;
 const timeoutMs=options.timeoutMs??20000;
 const userAgent=options.userAgent??USER_AGENT;
 const answers=new Map<string,CityFacts|null>();
 let chain:Promise<unknown>=Promise.resolve();
 let lastCall=0;
 const ask=async(query:string):Promise<CityFacts|null>=>{
  const cached=answers.get(query);
  if(cached!==undefined)return cached;
  // Serialised with a gap, and never longer than the timeout: a slow source must not hold the game hostage.
  const run=async()=>{
   const wait=Math.max(0,MIN_GAP_MS-(Date.now()-lastCall));
   if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
   lastCall=Date.now();
   const abort=new AbortController();
   const timer=setTimeout(()=>abort.abort(),timeoutMs);
   try{
    const response=await fetcher(endpoint,{
     method:'POST',
     headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8',accept:'application/sparql-results+json','user-agent':userAgent},
     body:`query=${encodeURIComponent(query)}`,
     signal:abort.signal,
    });
    if(!response.ok)return null;
    const body:unknown=await response.json();
    const bindings=(body as {results?:{bindings?:Binding[]}}|null)?.results?.bindings;
    if(!Array.isArray(bindings))return null;
    return factsFrom(bindings,(options.retrievedAt??(()=>new Date().toISOString()))());
   }catch{return null;}finally{clearTimeout(timer);}
  };
  const queued=chain.then(run,run);
  chain=queued.catch(()=>null);
  const result=await queued;
  answers.set(query,result);
  return result;
 };
 return {
  named:(name,language)=>name.trim()?ask(namedQuery(name.trim(),language)):Promise.resolve(null),
  near:(lat,lon,radiusKm)=>{
   if(!Number.isFinite(lat)||!Number.isFinite(lon)||!(radiusKm>0))return Promise.resolve(null);
   return ask(nearQuery(lat,lon,Math.min(100,radiusKm)));
  },
 };
}
