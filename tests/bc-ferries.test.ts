import actualSchedule from '../src/adapters/reality/data/bc-ferries.json';
import actualMarine from '../src/adapters/reality/data/vancouver-maritime.json';
import {readMaritimeCapture} from '../src/adapters/reality/maritime';
import {it,expect} from 'vitest';
import {readFerrySchedule} from '../src/adapters/reality/bc-ferries';
import {routes,schedule} from './fixtures/ferry';
it('preserves local date, timezone and published offset',()=>{expect(readFerrySchedule(schedule,routes)).toEqual(schedule);});
it('rejects missing route and reversed terminal calls',()=>{expect(()=>readFerrySchedule(schedule,[])).toThrow();expect(()=>readFerrySchedule({...schedule,sailings:[{...schedule.sailings[0],calls:[...schedule.sailings[0].calls].reverse()}]},routes)).toThrow();});
it('rejects an offset inconsistent with Vancouver local civil time',()=>{const s=structuredClone(schedule);s.sailings[0].calls[0].departureInstant='2026-10-03T23:50:00-08:00';expect(()=>readFerrySchedule(s,routes)).toThrow();});

it('handles permanent BC daylight time after November 2026 even with an older runtime tzdb',()=>{const s=structuredClone(schedule);s.validFrom=s.validUntil=s.sailings[0].serviceDate='2026-11-03';s.sailings[0].calls=s.sailings[0].calls.map(c=>({...c,...Object.fromEntries(Object.entries(c).filter(([k])=>k!=='terminalId').map(([k,v])=>[k,v.replace('2026-10-03','2026-11-03').replace('2026-10-04','2026-11-04')]))}));expect(readFerrySchedule(s,routes)).toEqual(s);});

it('preserves the October3 maintenance cancellations and both published directions',()=>{const s=readFerrySchedule(actualSchedule,readMaritimeCapture(actualMarine).routes);expect(s.sailings.filter(s=>s.status==='cancelled')).toHaveLength(4);expect(new Set(s.sailings.map(s=>s.routeId)).size).toBe(2);expect(s.sailings.find(s=>s.id==='2026-10-03:HSB-BOW:2055')!.status).toBe('scheduled');expect(s.sailings.find(s=>s.id==='2026-10-03:HSB-BOW:2215')).toBeUndefined();expect(s.sailings.find(s=>s.id==='2026-10-04:HSB-BOW:0545')).toBeUndefined();});
