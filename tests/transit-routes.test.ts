import {it,expect} from 'vitest';
import {buildTransitPatterns} from '../src/presentation/transit-routes';
import {buildGeographicNetwork} from '../src/presentation/mobility-network';
import {toCell,toGeo} from '../src/core/coordinates';
import type {TransitContent,TransitTrip} from '../src/core/transit-data';
const origin=toCell(49.2827,-123.1207),points=[origin,{x:origin.x+20,y:origin.y},{x:origin.x+20,y:origin.y+20}];
const network=buildGeographicNetwork([{layer:'streets',kind:'residential',bridge:false,oneway:0,type:2,geometry:[points]}],'fixture');
const stops=points.map((p,i)=>({providerId:`s${i}`,name:`Stop ${i}`,...toGeo(p)}));
const trip=(id:string,ids=['s0','s1','s2'],directionId='0',shapeId:string|undefined='shape'):TransitTrip=>({id,serviceId:'weekday',directionId,shapeId,stops:ids.map(stopId=>({stopId,arrival:'08:00:00',departure:'08:00:00'}))});
const data=(trips=[trip('a')]):TransitContent=>({timezone:'America/Vancouver',agencies:[],stops,routes:[{providerId:'bus',name:'Fixture',type:3,trips}],calendars:[],exceptions:[],entities:[],capabilities:{routing:'not-computed',realtime:'not-included'},shapes:[{id:'shape',points:points.map((p,sequence)=>({...toGeo(p),sequence}))}]});
it('preserves opposite directions and never mixes variant stop sequences',()=>{
 const source=data([trip('a'),trip('reverse',['s2','s1','s0'],'1','reverse'),trip('short',['s0','s1'],'0','short')]);source.shapes=[...source.shapes,{id:'reverse',points:[...source.shapes[0].points].reverse().map((p,sequence)=>({...p,sequence}))},{id:'short',points:source.shapes[0].points.slice(0,2)}];
 const patterns=buildTransitPatterns(source,network);expect(patterns).toHaveLength(3);expect(patterns.map(p=>p.stopDistancesM.length)).toEqual([3,3,2]);expect(patterns.map(p=>p.directionId)).toEqual(['0','1','0']);expect(network.edges.get(patterns[1].edges[0])!.from).not.toBe(network.edges.get(patterns[0].edges[0])!.from);
});
it('does not multiply identical patterns for repeated trips or duplicate stops',()=>{
 const patterns=buildTransitPatterns(data([trip('a',['s0','s0','s1','s2']),trip('b',['s0','s0','s1','s2'])]),network);expect(patterns).toHaveLength(1);expect(patterns[0].stopDistancesM[0]).toBe(patterns[0].stopDistancesM[1]);expect(patterns[0].edges.length).toBeGreaterThan(0);
});
it('uses a connected fallback without a shape and reports disconnected patterns instead of inventing a bus',()=>{
 const source=data([trip('a',undefined,'0',undefined)]);source.routes[0].trips=[{...source.routes[0].trips[0],shapeId:undefined}];
 expect(buildTransitPatterns(source,network)[0].method).toBe('derived');
 const isolated=buildGeographicNetwork([],'isolated'),failures:string[]=[];expect(buildTransitPatterns(source,isolated,f=>failures.push(f.reason))).toEqual([]);expect(failures).toHaveLength(1);
});
it('rejects a shape whose corridor cannot connect declared stops',()=>{
 const source=data();source.shapes=[{id:'shape',points:[{...toGeo({x:origin.x+200,y:origin.y+200}),sequence:0},{...toGeo({x:origin.x+220,y:origin.y+200}),sequence:1}]}];
 expect(buildTransitPatterns(source,network)).toEqual([]);
});
it('chooses connected stop anchors when the nearest mapped node is an isolated one-way endpoint',()=>{
 const roads=[{layer:'streets',kind:'residential',bridge:false,oneway:0 as const,type:2,geometry:[points.map(p=>({x:p.x,y:p.y+.5}))]},{layer:'streets',kind:'service',bridge:false,oneway:1 as const,type:2,geometry:[[{x:origin.x-1,y:origin.y},origin]]}];
 const graph=buildGeographicNetwork(roads,'alternative');const patterns=buildTransitPatterns(data(),graph);expect(patterns).toHaveLength(1);expect(patterns[0].stopDistancesM).toHaveLength(3);
});
