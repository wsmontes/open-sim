import {expect,test} from 'vitest';
import {createAdaptiveDetail} from '../src/presentation/adaptive-detail';
test('regional render overload coarsens detail but does not penalize the near zoom band',()=>{
 const c=createAdaptiveDetail(4);const before=c.demand(.001);c.render(.001,900,0,1000);
 expect(c.demand(.001).zoomBias).toBeGreaterThan(before.zoomBias);
 expect(c.demand(1).zoomBias).toBe(0);
});
test('owned byte pressure reduces detail and recovery needs sustained cheap work',()=>{
 const c=createAdaptiveDetail(2);c.render(.001,1,100*1024*1024,0);const reduced=c.demand(.001).zoomBias;
 c.render(.001,1,0,100);expect(c.demand(.001).zoomBias).toBe(reduced);
 for(let i=1;i<=12;i++)c.render(.001,2,0,1000+i*1000);
 expect(c.demand(.001).zoomBias).toBeLessThan(reduced);
});
test('slow loads limit concurrency independently of cached map detail',()=>{
 const c=createAdaptiveDetail(4),detail=c.demand(.001).zoomBias;c.load(2500,false);
 expect(c.demand(.001).concurrency).toBe(1);expect(c.demand(.001).zoomBias).toBe(detail);
 for(let i=0;i<12;i++)c.load(20,true);expect(c.demand(.001).concurrency).toBeGreaterThan(1);
});
test('byte pressure is measured against the device raster budget, not a fixed figure',()=>{
 // 60 MB of retained raster plus geometry is what a healthy 4-8 GB machine reports; it must not coarsen.
 const c=createAdaptiveDetail(undefined),deviceBudget=c.demand(.35).cacheBytes;
 expect(deviceBudget).toBeGreaterThan(60*1024*1024);
 c.render(.35,5,60*1024*1024,0);expect(c.demand(.35).zoomBias).toBe(0);
 c.render(.35,5,deviceBudget+1,2000);expect(c.demand(.35).zoomBias).toBeGreaterThan(0);
});
test('the revision marks demand changes so a stream need not be polled every frame',()=>{
 const c=createAdaptiveDetail(4),start=c.revision;
 c.render(.001,5,0,0);c.render(.001,5,0,1000);expect(c.revision).toBe(start);
 c.render(.001,900,0,2000);expect(c.revision).toBeGreaterThan(start);
});
