import type {TerrainManifest,TerrainTile} from '../presentation/terrain-model';
import {createTerrainController} from '../client/terrain-controller';
import {cellSpace,type Camera,type Viewport} from '../presentation/camera';
import {toGeo} from '../core/coordinates';
import {GLOBE_ZOOM} from '../presentation/geographic-map';

export function createTerrainStream(manifest:TerrainManifest,load:(id:string,signal:AbortSignal)=>Promise<TerrainTile>,invalidate:()=>void){
 const controller=createTerrainController();let selection='',abort=new AbortController(),generation=0;
 return {
  update(camera:Camera,viewport:Viewport){
   // A height margin includes slopes that rise into the viewport from behind its flat footprint.
   const corners=[[0,-viewport.height],[viewport.width,-viewport.height],[0,viewport.height*2],[viewport.width,viewport.height*2]].map(([x,y])=>toGeo(cellSpace({x,y},camera)));
   const west=Math.min(...corners.map(p=>p.lon)),east=Math.max(...corners.map(p=>p.lon)),south=Math.min(...corners.map(p=>p.lat)),north=Math.max(...corners.map(p=>p.lat));
   const entries=camera.zoom<GLOBE_ZOOM?[]:manifest.tiles.filter(t=>t.bounds.east>=west&&t.bounds.west<=east&&t.bounds.north>=south&&t.bounds.south<=north);
   const key=entries.map(t=>t.id).join('|');if(key===selection)return;selection=key;abort.abort();abort=new AbortController();const mine=++generation,signal=abort.signal;
   const ticket=controller.setRegion(entries.length?'Q24639':null);
   if(!entries.length){invalidate();return;}
   // Publish atomically: source preference and edge heights cannot vary with arrival order.
   void Promise.allSettled(entries.map(t=>load(t.id,signal))).then(results=>{
    if(mine!==generation||signal.aborted)return;
    controller.setTiles(results.flatMap(r=>r.status==='fulfilled'?[r.value]:[]),ticket);invalidate();
   });
  },
  scene(){return {tiles:controller.tiles(),sample:controller.sample,revision:controller.revision()};},
  status:controller.status,
  dispose(){generation++;abort.abort();controller.dispose();},
 };
}
