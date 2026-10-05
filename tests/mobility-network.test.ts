import {it,expect} from 'vitest';
import {buildGeographicNetwork,buildCellNetwork,findMobilityRoute} from '../src/presentation/mobility-network';
import type {GeographicFeature} from '../src/presentation/geographic-map';
import {WORLD} from '../src/core/coordinates';
const road=(geometry:{x:number;y:number}[][],options:Partial<GeographicFeature>={}):GeographicFeature=>({layer:'streets',kind:'residential',type:2,bridge:false,geometry,...options});
const node=(network:ReturnType<typeof buildGeographicNetwork>,x:number,y:number,level=0)=>[...network.nodes.values()].find(n=>n.point.x===x&&n.point.y===y&&n.level===level)!.id;
it('connected_L_route',()=>{const n=buildGeographicNetwork([road([[{x:0,y:0},{x:10,y:0},{x:10,y:10}]])],'test');const route=findMobilityRoute(n,node(n,0,0),node(n,10,10),'car');expect(route).toHaveLength(2);expect(n.edges.get(route![0])!.to).toBe(n.edges.get(route![1])!.from);});
it('oneway_reverse_refused',()=>{const n=buildGeographicNetwork([road([[{x:0,y:0},{x:10,y:0}]],{oneway:1})],'test');expect(findMobilityRoute(n,node(n,0,0),node(n,10,0),'car')).toHaveLength(1);expect(findMobilityRoute(n,node(n,10,0),node(n,0,0),'car')).toBeNull();});
it('bridge_not_surface_intersection',()=>{const n=buildGeographicNetwork([road([[{x:0,y:5},{x:10,y:5}]],{bridge:true,level:1}),road([[{x:5,y:0},{x:5,y:10}]],{level:0})],'test');expect(findMobilityRoute(n,node(n,0,5,1),node(n,5,10),'car')).toBeNull();});
it('duplicate_tile_edge_once',()=>{const feature=road([[{x:0,y:0},{x:10,y:0}]],{sourceId:'osm/1'});const n=buildGeographicNetwork([feature,{...feature,geometry:[[{x:10,y:0},{x:0,y:0}]]}],'test');expect(n.edges.size).toBe(2);});
it('cell_highway_excludes_walkers',()=>{const n=buildCellNetwork([{coord:{x:0,y:0},cell:{terrain:'land',road:true,roadClass:'highway'}},{coord:{x:1,y:0},cell:{terrain:'land',road:true,roadClass:'highway'}}],'test');expect(findMobilityRoute(n,node(n,0,0),node(n,1,0),'pedestrian')).toBeNull();expect(findMobilityRoute(n,node(n,0,0),node(n,1,0),'truck')).toHaveLength(1);});
it('disconnected_destination_returns_null',()=>{const n=buildGeographicNetwork([road([[{x:0,y:0},{x:10,y:0}]]),road([[{x:20,y:0},{x:30,y:0}]])],'test');expect(findMobilityRoute(n,node(n,0,0),node(n,30,0),'car')).toBeNull();});
it('same-level crossing connects through a split node',()=>{const n=buildGeographicNetwork([road([[{x:0,y:5},{x:10,y:5}]]),road([[{x:5,y:0},{x:5,y:10}]])],'test');expect(findMobilityRoute(n,node(n,0,5),node(n,5,10),'car')).toHaveLength(2);});
it('walking paths exclude motor traffic and route cost uses metres',()=>{const n=buildGeographicNetwork([road([[{x:0,y:0},{x:10,y:0}]],{kind:'footway'})],'test');expect(findMobilityRoute(n,node(n,0,0),node(n,10,0),'car')).toBeNull();expect(findMobilityRoute(n,node(n,0,0),node(n,10,0),'pedestrian')).toHaveLength(1);expect([...n.edges.values()][0].lengthM).toBeGreaterThan(0);});
it('joins a bridge to surface roads only at matching approach endpoints',()=>{const n=buildGeographicNetwork([road([[{x:0,y:0},{x:5,y:0}]]),road([[{x:5,y:0},{x:10,y:0}]],{bridge:true,level:1}),road([[{x:10,y:0},{x:15,y:0}]])],'test');expect(findMobilityRoute(n,node(n,0,0),node(n,15,0),'car')).toHaveLength(3);});
it('wraps a cell road across the dateline with a short physical edge',()=>{const n=buildCellNetwork([{coord:{x:WORLD-1,y:WORLD/2},cell:{terrain:'land',road:true}},{coord:{x:0,y:WORLD/2},cell:{terrain:'land',road:true}}],'test');expect(n.edges.size).toBe(2);expect([...n.edges.values()][0].lengthM).toBeLessThan(20);});
it('deduplicates overlapping clipped tile geometry after splitting',()=>{const n=buildGeographicNetwork([road([[{x:0,y:0},{x:10,y:0}]]),road([[{x:5,y:0},{x:15,y:0}]])],'test');expect(n.edges.size).toBe(6);expect(findMobilityRoute(n,node(n,0,0),node(n,15,0),'car')).toHaveLength(3);});
it('airport runways are not part of road traffic',()=>{const n=buildGeographicNetwork([road([[{x:0,y:0},{x:10,y:0}]],{kind:'runway'})],'test');expect(n.edges.size).toBe(0);});
it('stops topology expansion at the segment, edge and intersection work budgets',()=>{
 const roads=Array.from({length:20},(_,i)=>road([[{x:i,y:0},{x:i,y:20}]]));
 expect(()=>buildGeographicNetwork(roads,'bounded',{maxSegments:5,maxEdges:100,maxComparisons:100})).toThrow(/budget/i);
 expect(()=>buildGeographicNetwork(roads,'bounded',{maxSegments:100,maxEdges:5,maxComparisons:1000})).toThrow(/budget/i);
 const crossing=[...roads,...Array.from({length:20},(_,i)=>road([[{x:0,y:i},{x:20,y:i}]]))];
 expect(()=>buildGeographicNetwork(crossing,'bounded',{maxSegments:100,maxEdges:10000,maxComparisons:5})).toThrow(/budget/i);
 const expected=buildGeographicNetwork(roads,'same');
 expect(buildGeographicNetwork(roads,'same',{maxSegments:100,maxEdges:100,maxComparisons:1000})).toEqual(expected);
});
it('bounds bucket allocation even for disjoint long roads',()=>{
 const disjoint=Array.from({length:30},(_,i)=>road([[{x:i*4096,y:100000},{x:i*4096+2016,y:102016}]]));
 expect(()=>buildGeographicNetwork(disjoint,'bucket-budget',{maxSegments:60,maxEdges:60,maxComparisons:4096})).toThrow(/budget/i);
});
it('bounds endpoint preparation before segment expansion',()=>{
 const endpoints=road(Array.from({length:100},(_,i)=>[{x:i,y:i}]));
 expect(()=>buildGeographicNetwork([endpoints],'endpoint-budget',{maxSegments:5,maxEdges:20,maxComparisons:100})).toThrow(/budget/i);
});
