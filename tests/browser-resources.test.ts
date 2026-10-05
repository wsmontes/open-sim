// @vitest-environment jsdom
import {expect,test,vi} from 'vitest';
import {createLocalResources} from '../src/browser/resources';

test('missing and failing storage APIs report unknown without stopping the host',async()=>{
 const missing=createLocalResources({navigator:{},matchMedia:undefined});
 expect(await missing.storage()).toEqual({usage:null,quota:null,persistent:null});
 expect(await missing.persist()).toBeNull();
 const broken=createLocalResources({navigator:{storage:{estimate:async()=>{throw new Error('disabled');},persisted:async()=>{throw new Error('disabled');},persist:async()=>{throw new Error('disabled');}}}});
 expect(await broken.storage()).toEqual({usage:null,quota:null,persistent:null});
 expect(await broken.persist()).toBeNull();
});

test('storage reports approximate usage and persistence with changing motion preferences',async()=>{
 const media={matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()};
 const resources=createLocalResources({navigator:{storage:{estimate:async()=>({usage:100,quota:1000}),persisted:async()=>true,persist:async()=>false},connection:{saveData:true},deviceMemory:2,hardwareConcurrency:2},matchMedia:()=>media});
 expect(await resources.storage()).toEqual({usage:100,quota:1000,persistent:true});
 expect(await resources.persist()).toBe(false);
 expect(resources.preferences()).toMatchObject({reducedMotion:false,saveData:true});
 media.matches=true;expect(resources.preferences().reducedMotion).toBe(true);
});
