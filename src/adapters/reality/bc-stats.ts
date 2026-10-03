import type {CityIdentity,DemographicObservation} from '../../core/municipal-facts';
import {captureRows,measureSource} from './statcan';
export function readBcStatsCapture(value:unknown,city:CityIdentity):readonly DemographicObservation[]{
 const c=captureRows(value);
 if(!c||city.provinceCode!=='CA-BC'||city.geography!=='municipality'||!city.officialCode||!city.dguid)return [];
 const observations:DemographicObservation[]=[];
 for(const r of c.rows){
  const year=Number(r.Year),total=Number(r.Total);
  if(`59${String(r.Region).padStart(5,'0')}`!==city.officialCode||r['Region.Type']!=='Municipality'||r.Gender!=='T'||!['Estimate','Projection'].includes(String(r.Type))||!Number.isInteger(year)||!Number.isInteger(total)||total<=0)continue;
  const ages=Array.from({length:91},(_,i)=>Number(r[i===90?'90+':String(i)]));
  if(ages.some(v=>!Number.isFinite(v)||v<0)||ages.reduce((a,b)=>a+b,0)!==total)continue;
  if(observations.some(o=>o.period===String(year)&&o.kind===(r.Type==='Estimate'?'estimate':'projection')))continue;
  observations.push({key:'population',value:total,unit:'people',period:String(year),geographyId:city.dguid,kind:r.Type==='Estimate'?'estimate':'projection',quality:['all-genders','age-sum-validated','BC Stats estimate is not a census count'],source:measureSource(c.source,city.dguid,year)});
 }
 return observations;
}
