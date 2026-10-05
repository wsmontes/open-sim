import {localCivil} from '../../presentation/civil-time';
import {isRecord} from '../../core/guards';
import type {FerryScheduleCapture,MarineRoute} from '../../core/maritime-data';
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;
export function readFerrySchedule(value:unknown,routes:readonly MarineRoute[]):FerryScheduleCapture{
 const fail=()=>{throw new Error('Invalid ferry schedule, route, source or civil time');};
 if(!isRecord(value)||!date(value.validFrom)||!date(value.validUntil)||String(value.validFrom)>String(value.validUntil)||!Array.isArray(value.sailings))return fail();
 const ids=new Set<string>();for(const s of value.sailings){if(!isRecord(s)||typeof s.id!=='string'||!s.id||ids.has(s.id)||!date(s.serviceDate)||String(s.serviceDate)<String(value.validFrom)||String(s.serviceDate)>String(value.validUntil)||typeof s.timezone!=='string'||!['scheduled','cancelled'].includes(String(s.status))||!Array.isArray(s.calls)||s.calls.length<2||!isRecord(s.source)||s.source.method!=='reported'||typeof s.source.dataset!=='string'||typeof s.source.url!=='string'||typeof s.source.retrievedAt!=='string'||!Number.isFinite(Date.parse(s.source.retrievedAt)))return fail();
  const route=routes.find(r=>r.id===s.routeId&&r.verified&&r.allowed.includes('bc-ferry'));if(!route||s.calls.length>2&&(!route.terminalPathIndices||route.terminalPathIndices.length!==s.calls.length)||route.terminalIds.length!==s.calls.length||s.calls.some((c,i)=>!isRecord(c)||c.terminalId!==route.terminalIds[i]))return fail();let previous=-Infinity;
  for(const [i,c] of s.calls.entries()){for(const [instantKey,localKey] of [['arrivalInstant','localArrival'],['departureInstant','localDeparture']]){const instant=c[instantKey],local=c[localKey];if(instant===undefined){if(local!==undefined)return fail();continue;}if(typeof instant!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(instant)||!Number.isFinite(Date.parse(instant))||typeof local!=='string')return fail();try{if(localCivil(instant,s.timezone)!==local)return fail();}catch{return fail();}const t=Date.parse(instant);if(t<previous)return fail();previous=t;if(i===0&&instantKey==='departureInstant'&&local.slice(0,10)!==s.serviceDate)return fail();}if(i===0&&!c.departureInstant||i===s.calls.length-1&&!c.arrivalInstant||i>0&&i<s.calls.length-1&&(!c.arrivalInstant||!c.departureInstant))return fail();}
  ids.add(s.id);
 }return structuredClone(value) as FerryScheduleCapture;
}
