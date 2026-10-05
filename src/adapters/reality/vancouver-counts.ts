import {isRecord} from '../../core/guards';
import type {TrafficCount} from '../../core/traffic-data';
export type {TrafficCount} from '../../core/traffic-data';
// Local normalized observations are supported. Catalog locations and unlocated VanMap
// approach records are not counts: they must be resolved and dated before import.
export function parseVancouverCounts(value:unknown):readonly TrafficCount[]{
 if(!Array.isArray(value))return [];
 const out:TrafficCount[]=[],seen=new Set<string>();
 for(const row of value){
  if(!isRecord(row)||typeof row.id!=='string'||!row.id||seen.has(row.id)||typeof row.lat!=='number'||typeof row.lon!=='number'||!Number.isFinite(row.lat)||!Number.isFinite(row.lon)||Math.abs(row.lat)>85.05112878||Math.abs(row.lon)>180||typeof row.count!=='number'||!Number.isFinite(row.count)||row.count<0)continue;
  if(typeof row.from!=='string'||typeof row.to!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(row.from)||!/(Z|[+-]\d{2}:\d{2})$/.test(row.to)||!Number.isFinite(Date.parse(row.from))||!(Date.parse(row.to)>Date.parse(row.from)))continue;
  if(!['car','truck','pedestrian','all-vehicles'].includes(String(row.vehicleClass)))continue;
  if(row.direction!==undefined&&(typeof row.direction!=='number'||!Number.isFinite(row.direction)||row.direction<0||row.direction>=360))continue;
  const s=row.source;if(!isRecord(s)||typeof s.dataset!=='string'||!s.dataset||typeof s.url!=='string'||!/^https?:\/\//.test(s.url)||typeof s.territoryId!=='string'||!s.territoryId||typeof s.retrievedAt!=='string'||!Number.isFinite(Date.parse(s.retrievedAt))||s.method!=='reported')continue;
  seen.add(row.id);out.push({...row,source:{...s}} as TrafficCount);
 }
 return out;
}
