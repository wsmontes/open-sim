import type {WorldView} from './canvas-renderer';
const water=new WeakMap<object,boolean>();
function hasWater(view:WorldView){const tiles=view.geography?.tiles;if(!tiles||view.camera.zoom<.125)return false;let known=water.get(tiles);if(known===undefined){known=tiles.some(t=>!!t.encoded||t.features.some(f=>f.layer==='ocean'||f.layer==='water_polygons'));water.set(tiles,known);}return known;}
export function sameSceneFrame(a:WorldView|null|undefined,b:WorldView):boolean{
 return !!a&&a.light===b.light&&a.geography?.revision===b.geography?.revision&&a.terrain?.revision===b.terrain?.revision&&a.mobility===b.mobility&&a.signals===b.signals&&a.vessels===b.vessels&&a.aircraft===b.aircraft&&a.camera.x===b.camera.x&&a.camera.y===b.camera.y&&a.camera.zoom===b.camera.zoom&&a.camera.rotation===b.camera.rotation&&a.viewport.width===b.viewport.width&&a.viewport.height===b.viewport.height&&a.state===b.state&&a.chunks===b.chunks&&a.tool===b.tool&&a.preview===b.preview&&a.previewAffordable===b.previewAffordable&&a.hover?.x===b.hover?.x&&a.hover?.y===b.hover?.y&&(!hasWater(b)||Math.floor(a.motion*(b.quality?.waterHz??5))===Math.floor(b.motion*(b.quality?.waterHz??5)));
}
