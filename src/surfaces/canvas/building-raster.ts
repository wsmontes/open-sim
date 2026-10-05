export type BuildingPixels=ImageBitmap|OffscreenCanvas;
// Only pixels escape this owner. Transfer flushes drawing commands and leaves a reusable context.
export function createBuildingRaster(factory:()=>OffscreenCanvas=()=>new OffscreenCanvas(1,1)){
 let surface:OffscreenCanvas|undefined,context:OffscreenCanvasRenderingContext2D|null|undefined;
 return {
  capture(width:number,height:number,draw:(ctx:OffscreenCanvasRenderingContext2D)=>void):BuildingPixels|undefined{
   if(width<=0||height<=0)return;
   const canvas=surface??factory(),ctx=surface?context:canvas.getContext('2d');
   if(!ctx){canvas.width=0;canvas.height=0;return;}
   const transferable=typeof canvas.transferToImageBitmap==='function';
   if(transferable){surface=canvas;context=ctx;}
   // Resizing resets all styles/clips as well as the transform, including same-size captures.
   canvas.width=width;canvas.height=height;ctx.setTransform(1,0,0,1,0,0);draw(ctx);
   return transferable?canvas.transferToImageBitmap():canvas;
  },
  clear(){if(surface){surface.width=0;surface.height=0;}surface=undefined;context=undefined;},
  stats:()=>({contexts:surface?1:0}),
 };
}
export const buildingRaster=createBuildingRaster();
