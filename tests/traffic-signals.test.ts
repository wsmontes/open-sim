import {it,expect} from 'vitest';
import {createMobilityEngine} from '../src/presentation/mobility-engine';
import {buildGeographicNetwork,findMobilityRoute} from '../src/presentation/mobility-network';
import {matchTrafficSignals} from '../src/presentation/traffic-signals';
import {toGeo} from '../src/core/coordinates';
import type {GeographicFeature} from '../src/presentation/geographic-map';
const x=662000,y=1435000;
const road=(points:{x:number;y:number}[]):GeographicFeature=>({layer:'streets',kind:'residential',type:2,bridge:false,geometry:[points]});
const n=buildGeographicNetwork([road([{x:x-10,y},{x,y},{x:x+10,y}]),road([{x,y:y-10},{x,y},{x,y:y+10}])],'fixture');
const node=(a:number,b:number)=>[...n.nodes.values()].find(v=>v.point.x===a&&v.point.y===b)!;
const route=(vertical=false)=>findMobilityRoute(n,node(vertical?x:x-10,vertical?y-10:y).id,node(vertical?x:x+10,vertical?y+10:y).id,'car')!;
const advance=(e:ReturnType<typeof createMobilityEngine>,t:number)=>{for(let i=0;i<Math.round(t*30);i++)e.advance(1/30);};
it('uses the same red/amber permissions for cars and police patrols',()=>{const e=createMobilityEngine(n,1);advance(e,20.1);const r=route();e.setAgents([{id:'police',kind:'police',route:r,edgeIndex:0,distanceM:n.edges.get(r[0])!.lengthM-10,speedMps:10,seed:1}]);advance(e,2);expect(e.agents()[0].edgeIndex).toBe(0);expect(e.agents()[0].distanceM).toBeCloseTo(n.edges.get(r[0])!.lengthM-3.25);expect(e.signals().some(s=>s.aspect==='amber'&&Math.abs(s.direction.x)>0)).toBe(true);});
it('grants pedestrians an exclusive phase with vehicles red',()=>{const e=createMobilityEngine(n,1);advance(e,50.1);const r=route();e.setAgents([{id:'walker',kind:'pedestrian',route:r,edgeIndex:0,distanceM:n.edges.get(r[0])!.lengthM-.5,speedMps:2,seed:1},{id:'car',kind:'car',route:route(true),edgeIndex:0,distanceM:n.edges.get(route(true)[0])!.lengthM-10,speedMps:10,seed:2}]);advance(e,1);expect(e.agents().find(a=>a.id==='walker')!.edgeIndex).toBe(1);expect(e.agents().find(a=>a.id==='car')!.edgeIndex).toBe(0);expect(e.signals().every(s=>s.aspect==='red')).toBe(true);});
it('does not infer a signal on a two-neighbour curve',()=>{const curve=buildGeographicNetwork([road([{x,y},{x:x+10,y},{x:x+10,y:y+10}])],'curve');expect(createMobilityEngine(curve,1).signals()).toEqual([]);});
it('matches reported municipal positions only within 25m at a compatible ground node',()=>{const source={dataset:'fixture',url:'https://example.test',territoryId:'5915022',retrievedAt:'2026-10-03T00:00:00Z',method:'reported' as const};expect(matchTrafficSignals(n,[{id:'real-position',...toGeo({x,y}),source}]).get(node(x,y).id)?.id).toBe('real-position');expect(matchTrafficSignals(n,[{id:'far',...toGeo({x,y:y+5}),source}]).size).toBe(0);});

it('does not infer a vehicle signal where only a footpath joins a road',()=>{const foot={...road([{x,y:y-10},{x,y}]),kind:'footway'};const network=buildGeographicNetwork([road([{x:x-10,y},{x,y},{x:x+10,y}]),foot],'foot-junction');expect(createMobilityEngine(network,1).signals()).toEqual([]);});
