import {expect,test} from 'vitest';
import {resourcePolicy} from '../src/presentation/resource-policy';
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
 const c=createAdaptiveDetail(undefined),p=resourcePolicy(undefined),deviceBudget=p.rasterBytes+p.sceneGeometryBytes;
 expect(c.demand(.35).cacheBytes).toBe(p.geographicEncodedBytes);
 expect(deviceBudget).toBeGreaterThan(60*1024*1024);
 c.render(.35,5,60*1024*1024,0);expect(c.demand(.35).zoomBias).toBe(0);
 c.render(.35,5,deviceBudget+1,2000);expect(c.demand(.35).zoomBias).toBeGreaterThan(0);
});
test('the revision marks demand changes so a stream need not be polled every frame',()=>{
 const c=createAdaptiveDetail(4),start=c.revision;
 c.render(.001,5,0,0);c.render(.001,5,0,1000);expect(c.revision).toBe(start);
 c.render(.001,900,0,2000);expect(c.revision).toBeGreaterThan(start);
});
test('near-view overload preserves building-source zoom while bounding demand',()=>{
 const c=createAdaptiveDetail(2);c.render(.35,900,0,0);expect(c.demand(.35).minimumZoom).toBe(14);expect(c.demand(.001).minimumZoom).toBe(0);
});
test('a paused view can cautiously probe recovery using one fresh cheap result',()=>{const c=createAdaptiveDetail(4);c.render(.001,900,0,0);c.render(.001,5,0,2000);const before=c.demand(.001).zoomBias;c.probe(.001,5000);expect(c.demand(.001).zoomBias).toBe(before);c.probe(.001,32000);expect(c.demand(.001).zoomBias).toBe(before-1);c.render(.001,900,0,32001);expect(c.demand(.001).zoomBias).toBe(before);c.probe(.001,64000);expect(c.demand(.001).zoomBias).toBe(before);});
test('actual resource pressure can lower the source ceiling after the count budget bottoms out',()=>{const c=createAdaptiveDetail(2);for(let i=0;i<5;i++)c.pressure(.35,i*1000);const demand=c.demand(.35);expect(demand.maxTiles).toBe(4);expect(demand.maximumZoom).toBeLessThan(14);expect(demand.minimumZoom).toBeLessThan(14);});
test('ongoing animation can recover source detail after sustained healthy work',()=>{const c=createAdaptiveDetail(4);c.pressure(.35,0);expect(c.demand(.35).maximumZoom).toBe(13);for(let i=1;i<=200;i++){c.render(.35,2,0,i*100);c.probe(.35,i*100);}expect(c.demand(.35).maximumZoom).toBe(14);});
test('an expensive source-quality trial rolls back its source ceiling immediately',()=>{const c=createAdaptiveDetail(4);c.pressure(.35,0);for(let i=1;i<=10;i++)c.render(.35,2,0,i*1000);expect(c.demand(.35).maximumZoom).toBe(14);c.render(.35,900,0,10001);expect(c.demand(.35).maximumZoom).toBe(13);});
