import {it,expect} from 'vitest';
import {schoolBusAgents,policePatrolAgents} from '../src/presentation/school-transport';
import {buildGeographicNetwork} from '../src/presentation/mobility-network';
import {toGeo} from '../src/core/coordinates';
import schools from '../src/adapters/reality/data/vancouver-schools.json';
import {parseVancouverSchools} from '../src/adapters/reality/vancouver-schools';
const x=662000,y=1435000;
const n=buildGeographicNetwork([{layer:'streets',kind:'residential',type:2,bridge:false,geometry:[[{x:x-150,y},{x:x-75,y},{x,y},{x:x+75,y}]]}],'fixture');
const school={id:'public-school-fixture',name:'Verified public site fixture',...toGeo({x,y}),source:{dataset:'fixture',url:'https://example.test',territoryId:'BC-SD39',retrievedAt:'2026-10-03T00:00:00Z',method:'reported' as const}};
it('keeps actual published VSB positions separate from simulated school routes',()=>{const parsed=parseVancouverSchools(schools);expect(parsed.length).toBe(108);expect(parsed.some(s=>s.name==='King George Secondary')).toBe(true);const bus=schoolBusAgents([school],n,'2026-10-05T15:00:00Z',1)[0];expect(bus.kind).toBe('school-bus');expect(bus.schoolId).toBe(school.id);expect(bus.dwellSeconds).toBe(20);const last=n.edges.get(bus.route.at(-1)!)!;expect(n.nodes.get(last.to)!.point).toEqual({x,y});expect(bus.stopsM!.length).toBeGreaterThan(0);});
it('runs only within assumed weekday Vancouver peak windows',()=>{for(const t of ['2026-10-03T15:00:00Z','2026-10-05T19:00:00Z','2026-10-05T23:30:00Z'])expect(schoolBusAgents([school],n,t,1)).toEqual([]);expect(schoolBusAgents([school],n,'2026-10-05T22:30:00Z',1)).toHaveLength(1);});
it('caps school fleet at six, deduplicates sites and requires school proximity',()=>{expect(schoolBusAgents([school,school],n,'2026-10-05T15:00:00Z',1)).toHaveLength(1);expect(schoolBusAgents([{...school,lat:0}],n,'2026-10-05T15:00:00Z',1)).toEqual([]);});
it('produces at most two stable connected non-emergency patrols on vehicle roads',()=>{const patrols=policePatrolAgents(n,1);expect(patrols.length).toBeGreaterThan(0);expect(patrols.length).toBeLessThanOrEqual(2);expect(policePatrolAgents(n,1)).toEqual(patrols);for(const p of patrols){expect(p.kind).toBe('police');expect(p.route.every((id,i)=>n.edges.get(id)!.allowed.includes('police')&&(!i||n.edges.get(p.route[i-1])!.to===n.edges.get(id)!.from))).toBe(true);}});

it('uses permanent BC UTC minus seven for November school windows',()=>{expect(schoolBusAgents([school],n,'2026-11-02T14:45:00Z',1)).toHaveLength(1);expect(schoolBusAgents([school],n,'2026-11-02T23:45:00Z',1)).toEqual([]);});
