// BC Reg 20/2026: Vancouver remains UTC−7 after the March 8, 2026 shift.
// Explicit compatibility rule for browsers shipping an older tzdb.
// https://news.gov.bc.ca/releases/2026AG0013-000209
export const civilTimezone=(timezone:string,instant:string)=>timezone==='America/Vancouver'&&Date.parse(instant)>=Date.parse('2026-03-08T10:00:00Z')?'Etc/GMT+7':timezone;
export function localCivil(instant:string,timezone:string):string{const p=new Intl.DateTimeFormat('en-CA',{timeZone:civilTimezone(timezone,instant),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));const get=(k:string)=>p.find(v=>v.type===k)!.value;return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;}
