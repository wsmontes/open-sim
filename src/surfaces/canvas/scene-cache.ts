import {buildingRaster,type BuildingPixels} from './building-raster';
import {createResourceCache} from '../../core/resource-cache';
export const createSceneCache=createResourceCache;
// Immutable pixels do not retain a drawing context/command queue per building.
// Cap pixel handles separately; unsupported snapshot hosts retain the tighter canvas cap.
const maxRasterEntries=typeof OffscreenCanvas!=='undefined'&&typeof OffscreenCanvas.prototype.transferToImageBitmap==='function'?2048:256;
const rasterCache=createSceneCache<{canvas:BuildingPixels}>(128*1024*1024,value=>{if('close' in value.canvas)value.canvas.close();else {value.canvas.width=0;value.canvas.height=0;}},maxRasterEntries);
export const sceneRasterCache={...rasterCache,clear(){rasterCache.clear();buildingRaster.clear();}};
