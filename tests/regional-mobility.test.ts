import {expect,it,vi} from 'vitest';
import {createRegionalMobility,createRegionalResource} from '../src/browser/regional-mobility';
it('defers captures until the first picture and ignores a departed region',async()=>{
 let resolve!:(value:any)=>void;const load=vi.fn(()=>new Promise<any>(r=>resolve=r)),controller={setCity:vi.fn(),setTransit:vi.fn(),setSignalSites:vi.fn(),setCivicSites:vi.fn()},region=createRegionalMobility({controller,load,republish:vi.fn(),changed:vi.fn()});
 region.update(true,false);expect(load).not.toHaveBeenCalled();region.update(true,true);expect(load).toHaveBeenCalledOnce();region.update(false,true);
 resolve({transit:{},signals:[],schools:[]});await new Promise(r=>setTimeout(r,0));expect(controller.setTransit).not.toHaveBeenCalled();
 region.update(true,true);expect(load).toHaveBeenCalledOnce();expect(controller.setTransit).toHaveBeenCalledOnce();region.dispose();
});
it('does not create regional simulation after departure and releases engines on exit',async()=>{
 let resolve!:(value:()=>any)=>void;const dispose=vi.fn(),create=vi.fn(()=>({dispose})),load=vi.fn(()=>new Promise<()=>any>(r=>resolve=r)),resource=createRegionalResource(load,()=>{});
 resource.update(true,false);expect(load).not.toHaveBeenCalled();resource.update(true,true);resource.update(false,true);resolve(create);await new Promise(r=>setTimeout(r,0));expect(create).not.toHaveBeenCalled();
 resource.update(true,true);expect(create).toHaveBeenCalledOnce();expect(resource.value()).toBeDefined();resource.update(false,true);expect(dispose).toHaveBeenCalledOnce();expect(resource.value()).toBeUndefined();resource.dispose();expect(dispose).toHaveBeenCalledOnce();
});
it('handles load failure without a retry loop and supports explicit retry',async()=>{
 let fail=true;const load=vi.fn(async()=>{if(fail)throw new Error('offline');return ()=>({dispose(){}});}),resource=createRegionalResource(load,()=>{});
 resource.update(true,true);await new Promise(r=>setTimeout(r,0));expect(resource.status().error).toBe(true);resource.update(true,true);expect(load).toHaveBeenCalledOnce();fail=false;resource.retry();await new Promise(r=>setTimeout(r,0));expect(load).toHaveBeenCalledTimes(2);expect(resource.value()).toBeDefined();resource.dispose();
});
it('reports factory failure and retries without an unhandled rejection',async()=>{
 let fail=true;const resource=createRegionalResource(async()=>()=>{if(fail)throw new Error('init');return {dispose(){}};},()=>{});
 resource.update(true);await new Promise(r=>setTimeout(r,0));expect(resource.status().error).toBe(true);expect(resource.value()).toBeUndefined();fail=false;resource.retry();expect(resource.value()).toBeDefined();expect(resource.status().error).toBe(false);resource.dispose();
});
