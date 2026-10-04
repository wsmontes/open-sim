import {it,expect} from 'vitest';
import {createMobilityController} from '../src/client/mobility-controller';
const options={seed:1,now:()=> '2026-10-03T20:00:00Z',onChange:()=>{}};
it('missing_counts_keeps_estimated_usable',()=>{const c=createMobilityController(options);c.setMode('calibrated');expect(c.status()).toMatchObject({mode:'estimated',available:false,scenarioInstant:options.now()});});
it('city_change_clears_old_agents',()=>{const c=createMobilityController(options);c.setCells([{coord:{x:0,y:0},cell:{terrain:'land',road:true}},{coord:{x:1,y:0},cell:{terrain:'land',road:true}}],'a');c.setDemand({vehicles:1,pedestrians:0,truckShare:0,hour:12});c.advance(1/30);expect(c.frame()).toHaveLength(1);c.setCity('CA-BC');expect(c.frame()).toEqual([]);});
it('scenario_is_explicit_and_invalid_instants_do_not_replace_it',()=>{const c=createMobilityController(options);c.setScenario('2026-10-04T10:00:00Z');c.setScenario('invalid');expect(c.status().scenarioInstant).toBe('2026-10-04T10:00:00.000Z');});

it('removing transit withdraws its buses without requiring another network revision',async()=>{
 const {default:data}=await import('../src/adapters/reality/data/vancouver-transit-mobility.json');
 const {default:proof}=await import('../docs/quality/2026-10-02/vancouver-data/transit-motion-network.json');
 const nodes=new Map(proof.nodes.map(node=>[node.id,node])),edges=new Map(proof.edges.map(edge=>[edge.id,edge])),outgoing=new Map<string,string[]>();
 for(const edge of edges.values()){const list=outgoing.get(edge.from)??[];list.push(edge.id);outgoing.set(edge.from,list);}
 const c=createMobilityController(options);c.setNetwork({revision:proof.revision,nodes,edges,outgoing} as import('../src/presentation/mobility-model').MobilityNetwork);c.setTransit(data as import('../src/core/transit-data').TransitContent);expect(c.frame().some(a=>a.kind==='bus')).toBe(true);c.setTransit(null);expect(c.frame().some(a=>a.kind==='bus')).toBe(false);
});
