import type {CityIdentity,MeasureSource} from '../../core/municipal-facts';
import {measureSource} from './statcan';
export type MunicipalActual={year:number;revenueCad?:number;expenseCad?:number;status:'actual';source:MeasureSource};
export function readBcMunicipalActuals(value:unknown,city:CityIdentity):readonly MunicipalActual[]{
 if(!Array.isArray(value)||city.geography!=='municipality'||city.provinceCode!=='CA-BC')return [];
 const years=new Map<number,MunicipalActual>();
 for(const row of value){
  if(!row||typeof row!=='object')continue;
  const r=row as Record<string,unknown>;const source=r.source as Record<string,unknown>|undefined;
  if(r.territoryId!==city.qid||r.csd!==city.officialCode||r.status!=='actual'||r.currency!=='CAD'||typeof r.year!=='number'||!Number.isInteger(r.year)||typeof r.value!=='number'||!Number.isFinite(r.value)||r.value<0||!['401','402'].includes(String(r.schedule))||!source||!['dataset','url','license','retrievedAt'].every(k=>typeof source[k]==='string'))continue;
  const prior=years.get(r.year)??{year:r.year,status:'actual' as const,source:measureSource(source,city.qid,r.year)};
  years.set(r.year,{...prior,...(r.schedule==='401'?{revenueCad:r.value}:{expenseCad:r.value})});
 }
 return [...years.values()].sort((a,b)=>a.year-b.year);
}
