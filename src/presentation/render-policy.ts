import {resourcePolicy} from './resource-policy';
export type RenderPolicy={totalRasterBytes:number;workerRasterBytes:number;dynamicAgents:number;vessels:number;aircraft:number;waterHz:number;dynamicFps:number};
export function renderPolicy(memoryGb:number|undefined,width:number,height:number):RenderPolicy{
 const low=memoryGb!==undefined&&memoryGb<=2,medium=memoryGb!==undefined&&memoryGb<=4,totalRasterBytes=resourcePolicy(memoryGb).rasterBytes;
 // Working surface, returned bitmap, displayed bitmap, GPU texture and input/reprojection buffer.
 const reserved=Math.max(0,width)*Math.max(0,height)*4*5;
 return {totalRasterBytes,workerRasterBytes:Math.max(0,totalRasterBytes-reserved),dynamicAgents:low?120:medium?240:480,vessels:low?8:24,aircraft:low?4:8,waterHz:low?2:5,dynamicFps:low?20:30};
}
export function renderPixelRatio(deviceRatio:number,memoryGb:number|undefined,width:number,height:number):number{
 const budget=renderPolicy(memoryGb,0,0).totalRasterBytes,area=Math.max(1,width)*Math.max(1,height),maxPixels=budget*.6/(4*5);
 return Math.max(.01,Math.min(2,Math.max(1,deviceRatio),Math.sqrt(maxPixels/area)));
}
