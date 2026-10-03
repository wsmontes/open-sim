import {isRecord} from '../../core/guards';
import type {SchoolSite} from '../../core/traffic-data';
export type {SchoolSite} from '../../core/traffic-data';
export function parseVancouverSchools(value:unknown):readonly SchoolSite[]{
 if(!Array.isArray(value))return [];
 const seen=new Set<string>();return value.filter((s):s is SchoolSite=>{
  if(!isRecord(s)||typeof s.id!=='string'||!s.id||seen.has(s.id)||typeof s.name!=='string'||!s.name||typeof s.lat!=='number'||typeof s.lon!=='number'||!Number.isFinite(s.lat)||!Number.isFinite(s.lon)||s.lat<49.18||s.lat>49.32||s.lon< -123.3||s.lon> -123.0||!isRecord(s.source)||s.source.territoryId!=='BC-SD39'||s.source.method!=='reported'||typeof s.source.url!=='string'||typeof s.source.retrievedAt!=='string'||!Number.isFinite(Date.parse(s.source.retrievedAt)))return false;
  seen.add(s.id);return true;
 });
}
