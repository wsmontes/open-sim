import {expect,it,vi} from 'vitest';
import {createSceneGeography} from '../src/browser/scene-geography';
it('reuses unchanged decoded selection, applies only tile deltas and releases departed tiles',()=>{
 const decode=vi.fn(t=>({...t,features:[]})),geo=createSceneGeography(decode),a={z:14,x:1,y:1,features:[]},b={...a,x:2};
 const first=geo.apply({tiles:[a],keys:['14:1:1'],revision:1,loading:true,error:false});
 const loaded=geo.apply({tiles:[],keys:['14:1:1'],revision:2,loading:false,error:false});
 expect(loaded.tiles).toBe(first.tiles);expect(loaded.revision).toBe(first.revision);expect(decode).toHaveBeenCalledTimes(1);
 const added=geo.apply({tiles:[b],keys:['14:1:1','14:2:1'],revision:3,loading:false,error:false});expect(added.tiles).toHaveLength(2);expect(decode).toHaveBeenCalledTimes(2);
 geo.apply({tiles:[],keys:['14:2:1'],revision:4,loading:false,error:false});expect(geo.stats().tiles).toBe(1);geo.clear();expect(geo.stats().tiles).toBe(0);
});
it('accounts for owned decoded geometry and drops bytes when selection changes',()=>{
 const geo=createSceneGeography(t=>t),a={z:10,x:1,y:1,features:[{layer:'water',kind:'water',bridge:false,type:3,geometry:[[{x:0,y:0},{x:1,y:1}]]}]};
 geo.apply({tiles:[a],keys:['10:1:1'],revision:1,loading:false,error:false});expect(geo.stats().bytes).toBeGreaterThanOrEqual(64);
 geo.apply({tiles:[],keys:[],revision:2,loading:false,error:false});expect(geo.stats().bytes).toBe(0);
});
