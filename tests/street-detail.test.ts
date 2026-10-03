import {expect,test} from 'vitest';
import {streetJunctions,streetAgents,plantingStep,roadsideTrees,PLANT_VERGE} from '../src/presentation/street-detail';
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

// The complaint these defend: the trees walked when the player zoomed, and stood in a row of equal gaps. A tile hands
// the same street over in different pieces at different zooms, so planting read from the segments belongs to the tile
// and not to the city.
const samePlace=(a:readonly {x:number;y:number;seed:number}[],b:readonly {x:number;y:number;seed:number}[])=>
 a.length===b.length&&a.every((tree,index)=>tree.seed===b[index]!.seed&&Math.abs(tree.x-b[index]!.x)<1e-9&&Math.abs(tree.y-b[index]!.y)<1e-9);
test('a street carries the same trees however the tile cut it up',()=>{
 const whole=[{a:{x:0,y:0},b:{x:60,y:0}}];
 const chopped=[{a:{x:0,y:0},b:{x:11,y:0}},{a:{x:11,y:0},b:{x:12,y:0}},{a:{x:12,y:0},b:{x:38,y:0}},{a:{x:38,y:0},b:{x:60,y:0}}];
 const box={minX:-6,minY:-6,maxX:66,maxY:6};
 const one=roadsideTrees(whole,box,plantingStep(24),7,90);
 expect(one.length).toBeGreaterThan(4);
 expect(samePlace(roadsideTrees(chopped,box,plantingStep(24),7,90),one)).toBe(true);
});
test('pulling the camera back thins the row instead of moving it',()=>{
 const street=[{a:{x:0,y:0},b:{x:120,y:0}}],box={minX:-6,minY:-6,maxX:126,maxY:6};
 const near=roadsideTrees(street,box,plantingStep(30),7,90),far=roadsideTrees(street,box,plantingStep(6),7,90);
 expect(far.length).toBeGreaterThan(0);
 expect(far.length).toBeLessThan(near.length);
 // Every tree of the far view is a tree of the near one, in the same place: widening the view is a thinning.
 for(const tree of far)expect(near.some(n=>n.seed===tree.seed&&Math.abs(n.x-tree.x)<1e-9&&Math.abs(n.y-tree.y)<1e-9)).toBe(true);
});
test('the row stands on the verge and its gaps are not all the same',()=>{
 const street=[{a:{x:0,y:0},b:{x:150,y:0}}],box={minX:-6,minY:-6,maxX:156,maxY:6};
 const row=roadsideTrees(street,box,plantingStep(30),7,90).sort((a,b)=>a.x-b.x);
 expect(row.length).toBeGreaterThan(8);
 // Nothing is planted on the asphalt: every tree stands the width of the verge off the centre line.
 for(const tree of row)expect(Math.abs(Math.abs(tree.y)-PLANT_VERGE)).toBeLessThan(1e-9);
 // A planted avenue is not a ruler: the gaps vary, which is what a city does and a planter does not.
 const gaps=new Set(row.slice(1).map((tree,index)=>Math.round((tree.x-row[index]!.x)*100)/100));
 expect(gaps.size).toBeGreaterThan(2);
});
