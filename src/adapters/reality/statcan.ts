import type {CityFacts,CityIdentity,DemographicObservation,MeasureSource} from '../../core/municipal-facts';
type Row=Record<string,unknown>;
export function captureRows(value:unknown):{rows:Row[];source:Row}|null{
 if(!value||typeof value!=='object')return null;
 const v=value as Row;
 if(!Array.isArray(v.rows)||!v.source||typeof v.source!=='object')return null;
 const source=v.source as Row;
 if(!['dataset','url','retrievedAt','license'].every(k=>typeof source[k]==='string'))return null;
 return {rows:v.rows.filter((r):r is Row=>!!r&&typeof r==='object'),source};
}
export function measureSource(source:Row,territoryId:string,year:number,derived=false):MeasureSource{
 return {dataset:String(source.dataset),url:String(source.url),license:String(source.license),retrievedAt:String(source.retrievedAt),territoryId,observedYear:year,method:derived?'derived':'reported'};
}
export function readStatCanCapture(value:unknown,city:CityIdentity):readonly DemographicObservation[]{
 const capture=captureRows(value);
 if(!capture||city.countryCode!=='CA'||city.geography!=='municipality'||!city.dguid||!city.officialCode)return [];
 const rows=new Map<string,Row>();
 for(const r of capture.rows){
  if(r.REF_AREA!==city.dguid||r.ALT_GEO_CODE!==city.officialCode||r.GENDER!=='1'||r.STATISTIC!=='1'||r.TIME_PERIOD!=='2021'||r.FLAG==='x'||r.FLAG==='F'||r.OBS_VALUE===''||r.OBS_VALUE===null)continue;
  if(!Number.isFinite(Number(r.OBS_VALUE))||Number(r.OBS_VALUE)<0)continue;
  if(!rows.has(String(r.CHARACTERISTIC)))rows.set(String(r.CHARACTERISTIC),r);
 }
 const observations:DemographicObservation[]=[];
 const add=(id:string,key:DemographicObservation['key'],unit:DemographicObservation['unit'],category?:string,period='2021',denominatorId?:string)=>{
  const row=rows.get(id);if(!row)return;
  const denominator=denominatorId?rows.get(denominatorId):undefined;
  if(denominatorId&&(!denominator||Number(denominator.OBS_VALUE)<=0))return;
  const value=denominator?Number(row.OBS_VALUE)/Number(denominator.OBS_VALUE)*100:Number(row.OBS_VALUE);
  if(unit==='percent'&&value>100)return;
  observations.push({key,unit,category,period,value,geographyId:city.dguid!,kind:'census',quality:[`data-quality:${row.DATA_QUALITY_FLAG}`,`non-response-long:${row.TNR_LF}`,`non-response-short:${row.TNR_SF}`],source:{...measureSource(capture.source,city.dguid!,Number(period),!!denominator),reference:`CHARACTERISTIC=${id}; NOTE=${row.NOTE??''}`},...(denominator?{denominator:{value:Number(denominator.OBS_VALUE),description:'Employed labour force aged 15+ with usual place of work or no fixed workplace; 25% sample',period:'2021',geographyId:city.dguid!}}:{})});
 };
 add('1','population','people');add('50','households','households');add('56','household-size','persons-per-household');add('229','median-income','CAD','household-total','2020');add('2229','employment-rate','percent');
 add('35','age-share','percent','0–14');add('36','age-share','percent','15–64');add('37','age-share','percent','65+');
 for(const [id,category] of [['2604','car-truck-van'],['2607','public-transit'],['2608','walk'],['2609','bicycle'],['2610','other']])add(id,'commute-share','percent',category,'2021','2603');
 return observations;
}
export function mergeDemographics(facts:CityFacts,observations:readonly DemographicObservation[]):CityFacts{
 const demographics=observations.filter(o=>o.geographyId===facts.identity?.dguid);
 const population=demographics.find(o=>o.key==='population'&&o.kind==='census');
 return {...facts,demographics,...(population?{population:population.value,populationYear:Number(population.period),measures:{...facts.measures,population:{value:population.value,unit:'people' as const,source:population.source}}}:{})};
}
