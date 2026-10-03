import {it,expect} from 'vitest';
import {routeBuses} from '../src/presentation/transit-motion';
import {createMobilityEngine} from '../src/presentation/mobility-engine';
import {motionSeconds} from '../src/presentation/clock';
import type {MobilityNetwork,MobilityAgent,MobilityEdge} from '../src/presentation/mobility-model';
import type {TransitRoutePattern} from '../src/presentation/transit-routes';
const nodes=new Map([['a',{id:'a',point:{x:0,y:0},level:0}],['b',{id:'b',point:{x:20,y:0},level:0}],['c',{id:'c',point:{x:20,y:20},level:0}]]);
const edges=new Map<string,MobilityEdge>([['ab',{id:'ab',from:'a',to:'b',path:[nodes.get('a')!.point,nodes.get('b')!.point],lengthM:20,roadClass:'residential',allowed:['car','bus'],method:'derived',level:0,bridge:false}],['bc',{id:'bc',from:'b',to:'c',path:[nodes.get('b')!.point,nodes.get('c')!.point],lengthM:20,roadClass:'residential',allowed:['car','bus'],method:'derived',level:0,bridge:false}]]);
const network:MobilityNetwork={revision:'fixture',nodes,edges,outgoing:new Map([['a',['ab']],['b',['bc']]])};
const pattern:TransitRoutePattern={id:'official-pattern-fixture',routeId:'fixture-route',directionId:'0',shapeId:'fixture-shape',edges:['ab','bc'],edgeLengthsM:[20,20],stopDistancesM:[0,10,40],method:'derived',networkRevision:'fixture'};
const bus:MobilityAgent={id:'fixture-bus',kind:'bus',route:['ab','bc'],edgeIndex:0,distanceM:0,speedMps:5,seed:1,patternId:pattern.id,stopsM:[10]};
const advance=(engine:ReturnType<typeof createMobilityEngine>,seconds:number)=>{const steps=Math.round(seconds*30);for(let i=0;i<steps;i++)engine.advance(1/30);};
it('creates two stable spaced buses per unique route pattern with declared stops',()=>{
 const buses=routeBuses([pattern,pattern],7);expect(buses).toHaveLength(2);expect(buses.map(b=>b.route)).toEqual([pattern.edges,pattern.edges]);expect(buses[0].stopsM).toEqual(pattern.stopDistancesM);expect(buses[1].edgeIndex).toBe(1);expect(routeBuses([pattern],7)).toEqual(buses);
});
it('follows the connected route through a curve and shares car queues',()=>{
 const engine=createMobilityEngine(network,1);engine.setAgents([{...bus,stopsM:[],distanceM:18,speedMps:10}]);advance(engine,1);expect(engine.frame()[0].point.x).toBe(20);expect(engine.frame()[0].point.y).toBeCloseTo(8,7);expect(engine.frame()[0].heading).toEqual({x:0,y:1});
 const queued=createMobilityEngine(network,1);queued.setAgents([{...bus,stopsM:[]},{id:'car',kind:'car',route:['ab','bc'],edgeIndex:0,distanceM:16,speedMps:0,seed:2}]);advance(queued,2);const frames=queued.frame();expect(frames.find(a=>a.id===bus.id)!.point.x).toBeLessThan(16-(12+4.5)/2);
});
it('dwells for 15 simulated seconds at the declared stop without restarting on reconciliation',()=>{
 const engine=createMobilityEngine(network,1);engine.setAgents([bus]);advance(engine,2);expect(engine.frame()[0].point.x).toBeCloseTo(10,7);
 engine.setAgents([bus]);advance(engine,14.9);expect(engine.frame()[0].point.x).toBeCloseTo(10,7);advance(engine,.2);expect(engine.frame()[0].point.x).toBeGreaterThan(10);
});
it('freezes buses on pause and applies the game acceleration to movement and dwell',()=>{
 const slow=createMobilityEngine(network,1),fast=createMobilityEngine(network,1);for(const engine of [slow,fast])engine.setAgents([bus]);
 for(let i=0;i<15;i++){slow.advance(motionSeconds(1/30,1));fast.advance(motionSeconds(1/30,2));}
 expect(fast.frame()[0].point.x).toBeCloseTo(slow.frame()[0].point.x*2,7);const frozen=fast.frame();for(let i=0;i<30;i++)fast.advance(motionSeconds(1/30,0));expect(fast.frame()).toEqual(frozen);
});
it('leaves the network for a frame before another simulated trip starts, and invalidated routes do not respawn',()=>{
 const engine=createMobilityEngine(network,1);engine.setAgents([{...bus,route:['ab'],stopsM:[],distanceM:19,speedMps:30}]);engine.advance(.1);expect(engine.frame()).toEqual([]);
 engine.advance(.1);expect(engine.frame()[0].point.x).toBeLessThan(5);expect(engine.frame()[0].id).toBe(bus.id);
 engine.setNetwork({...network,revision:'missing-road',edges:new Map(),outgoing:new Map()});expect(engine.frame()).toEqual([]);engine.advance(.2);expect(engine.frame()).toEqual([]);
});
it('keeps the intersection reserved while a dwelling bus still occupies it',async()=>{
 const {buildGeographicNetwork}=await import('../src/presentation/mobility-network');
 const graph=buildGeographicNetwork([{layer:'streets',kind:'residential',bridge:false,oneway:0,type:2,geometry:[[{x:-100,y:1000000},{x:100,y:1000000}],[{x:0,y:999900},{x:0,y:1000100}]]}],'junction');
 const center=[...graph.nodes.values()].find(n=>n.point.x===0&&n.point.y===1000000)!,incoming=[...graph.edges.values()].filter(e=>e.to===center.id),west=incoming.find(e=>e.path[0].x<0)!,north=incoming.find(e=>e.path[0].y<1000000)!,east=[...graph.edges.values()].find(e=>e.from===center.id&&e.path.at(-1)!.x>0)!,south=[...graph.edges.values()].find(e=>e.from===center.id&&e.path.at(-1)!.y>1000000)!;
 const engine=createMobilityEngine(graph,1);engine.setAgents([{...bus,id:'dwelling',route:[west.id,east.id],distanceM:west.lengthM-15*5,stopsM:[west.lengthM]},{id:'crossing',kind:'car',route:[north.id,south.id],edgeIndex:0,distanceM:north.lengthM-35,speedMps:5,seed:3}]);
 advance(engine,26);const car=engine.agents().find(a=>a.id==='crossing')!;expect(car.edgeIndex).toBe(0);expect(car.distanceM).toBeLessThan(north.lengthM);
});
it('keeps a finished bus withdrawn until its entry lane has space',()=>{
 const template={...bus,route:['ab'],stopsM:[],distanceM:19,speedMps:30},car:MobilityAgent={id:'entry-car',kind:'car',route:['ab'],edgeIndex:0,distanceM:0,speedMps:0,seed:2};
 const engine=createMobilityEngine(network,1);engine.setAgents([template]);engine.advance(.1);engine.setAgents([template,car]);engine.advance(1/30);engine.setAgents([template,car]);expect(engine.frame().map(a=>a.id)).toEqual(['entry-car']);
});
