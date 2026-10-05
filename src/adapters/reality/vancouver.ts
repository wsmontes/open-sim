import type {CityFacts,MunicipalFinance,NumericMeasure} from '../../core/municipal-facts';
import {measureSource} from './statcan';
export function readVancouverFinance(value:unknown):MunicipalFinance{
 if(!value||typeof value!=='object')throw new Error('Missing budget capture');
 const v=value as Record<string,unknown>;
 if(v.territoryId!=='Q24639'||v.fiscalYear!==2026||v.currency!=='CAD'||v.status!=='approved-budget')throw new Error('Wrong budget identity, year, currency or status');
 const source=v.source as Record<string,unknown>|undefined;
 if(!source||!['dataset','url','retrievedAt','license'].every(k=>typeof source[k]==='string'&&source[k]))throw new Error('Missing budget provenance');
 const read=(raw:unknown):NumericMeasure=>{
  if(!raw||typeof raw!=='object')throw new Error('Missing amount');
  const r=raw as Record<string,unknown>;const scale=r.unit==='CAD'?1:r.unit==='thousand-CAD'?1000:r.unit==='million-CAD'?1000000:undefined;
  if(r.period!=='annual'||scale===undefined||typeof r.value!=='number'||!Number.isFinite(r.value)||r.value<0||typeof r.reference!=='string')throw new Error('Invalid annual amount');
  return {value:r.value*scale,unit:'CAD',source:{...measureSource(source,'Q24639',2026,scale!==1),reference:r.reference}};
 };
 return {territoryId:'Q24639',fiscalYear:2026,status:'approved-budget',operating:read(v.operating),...(v.capital?{capital:read(v.capital)}:{})};
}
export function enrichVancouverFacts(facts:CityFacts,finance:MunicipalFinance):CityFacts{
 return facts.id===finance.territoryId?{...facts,finance}:facts;
}
