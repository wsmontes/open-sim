import {expect,it,vi} from 'vitest';
import {createBuildingRaster} from '../src/surfaces/canvas/building-raster';
it('creates one drawing context for many independently owned snapshots and resets transforms',()=>{
 let contexts=0,created=0;const transforms:number[]=[],ctx={setTransform:(a:number)=>transforms.push(a)},bitmaps:{width:number;height:number;close:ReturnType<typeof vi.fn>}[]=[];
 const factory=()=>{created++;return {width:1,height:1,getContext(){contexts++;return ctx;},transferToImageBitmap(this:{width:number;height:number}){const image={width:this.width,height:this.height,close:vi.fn()};bitmaps.push(image);return image;}} as unknown as OffscreenCanvas;};
 const raster=createBuildingRaster(factory);
 for(let i=0;i<300;i++){const image=raster.capture(10+i%2,20,()=>{});expect(image?.width).toBe(10+i%2);}
 expect(created).toBe(1);expect(contexts).toBe(1);expect(bitmaps).toHaveLength(300);expect(transforms).toHaveLength(300);expect(transforms.every(x=>x===1)).toBe(true);
 raster.clear();expect(bitmaps[0].close).not.toHaveBeenCalled();expect(raster.stats().contexts).toBe(0);
});
it('keeps separately owned canvases when immutable snapshots are unavailable',()=>{
 let created=0;const factory=()=>{created++;return {width:1,height:1,getContext:()=>({setTransform(){}})} as unknown as OffscreenCanvas;};
 const raster=createBuildingRaster(factory),first=raster.capture(10,20,()=>{}),second=raster.capture(30,40,()=>{});
 expect(first).not.toBe(second);expect(first?.width).toBe(10);expect(second?.width).toBe(30);expect(created).toBe(2);raster.clear();expect(first?.width).toBe(10);
});
