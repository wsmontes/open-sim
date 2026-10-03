import {expect,test} from 'vitest';
import {streetJunctions,streetAgents} from '../src/presentation/street-detail';
import type {GeographicFeature} from '../src/presentation/geographic-map';
const road=(points:number[][],kind='residential',bridge=false):GeographicFeature=>({layer:'streets',kind,bridge,type:2,geometry:[points.map(([x,y])=>({x,y}))]});
test('a crossing requires real branches; a bend and a bridge are not crosswalk candidates',()=>{
 expect(streetJunctions([road([[0,0],[2,0],[2,2]])])).toHaveLength(0);
 const cross=[road([[-2,0],[0,0],[2,0]]),road([[0,-2],[0,0],[0,2]])];
 expect(streetJunctions(cross)).toHaveLength(1);expect(streetJunctions(cross)[0].directions).toHaveLength(4);
 expect(streetJunctions([...cross,road([[0,0],[2,2]],'motorway',true)])).toHaveLength(0);
 expect(streetJunctions([...cross,...cross])).toHaveLength(1);
});
test('urban agents have bounded deterministic positions and move along source streets',()=>{
 const features=[road([[0,0],[12,0]])],a=streetAgents(features,10,12),again=streetAgents(features,10,12),later=streetAgents(features,11,12);
 expect(a).toEqual(again);expect(a.length).toBeGreaterThan(0);expect(a.length).toBeLessThanOrEqual(12);expect(later).not.toEqual(a);
 for(const agent of a){expect(agent.point.x).toBeGreaterThanOrEqual(0);expect(agent.point.x).toBeLessThanOrEqual(12);expect(Math.abs(agent.point.y)).toBeLessThan(1);expect(agent.direction).toEqual({x:1,y:0});}
});
