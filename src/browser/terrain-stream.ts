import type {TerrainManifest,TerrainTile} from '../presentation/terrain-model';
import {createTerrainController} from '../client/terrain-controller';
import {cellSpace,type Camera,type Viewport} from '../presentation/camera';
import {toGeo} from '../core/coordinates';
import {GLOBE_ZOOM,geographicFocus} from '../presentation/geographic-map';

export function createTerrainStream(manifest:TerrainManifest,load:(id:string,signal:AbortSignal)=>Promise<TerrainTile>,invalidate:()=>void,options:{maxBytes?:number;concurrency?:number}={}){
 const controller=createTerrainController();let selection='',abort=new AbortController(),generation=0,disposed=false,limited=false,selectionLimited=false,bytes=0;
 const maxBytes=options.maxBytes??8*1024*1024;
 return {
  update(camera:Camera,viewport:Viewport){
   if(disposed)return;
   // A height margin includes slopes that rise into the viewport from behind its flat footprint.
   const corners=[[0,-viewport.height],[viewport.width,-viewport.height],[0,viewport.height*2],[viewport.width,viewport.height*2]].map(([x,y])=>toGeo(cellSpace({x,y},camera)));
   const west=Math.min(...corners.map(p=>p.lon)),east=Math.max(...corners.map(p=>p.lon)),south=Math.min(...corners.map(p=>p.lat)),north=Math.max(...corners.map(p=>p.lat));
   const visible=camera.zoom<GLOBE_ZOOM?[]:manifest.tiles.filter(t=>t.bounds.east>=west&&t.bounds.west<=east&&t.bounds.north>=south&&t.bounds.south<=north);
   const focus=geographicFocus(camera,viewport),entries=[...visible].sort((a,b)=>Math.hypot((a.bounds.west+a.bounds.east)/2-focus.lon,(a.bounds.south+a.bounds.north)/2-focus.lat)-Math.hypot((b.bounds.west+b.bounds.east)/2-focus.lon,(b.bounds.south+b.bounds.north)/2-focus.lat)).slice(0,Math.floor(maxBytes/(65*65*5)));
   const key=entries.map(t=>t.id).join('|');if(key===selection&&selectionLimited===(entries.length<visible.length))return;selection=key;limited=selectionLimited=entries.length<visible.length;bytes=0;abort.abort();abort=new AbortController();const mine=++generation,signal=abort.signal;
   controller.setRegion(null);const ticket=controller.setRegion(entries.length?'Q24639':null);
   if(!entries.length){invalidate();return;}
   // Publish atomically: source preference and edge heights cannot vary with arrival order.
   const loaded:TerrainTile[]=[];let cursor=0,owned=0;signal.addEventListener('abort',()=>{loaded.length=0;},{once:true});
   const run=async()=>{while(cursor<entries.length&&!signal.aborted){const entry=entries[cursor++];try{const tile=await load(entry.id,signal);if(signal.aborted||mine!==generation)return;const cost=tile.heightsM.byteLength+tile.valid.byteLength;if(owned+cost<=maxBytes){loaded.push(tile);owned+=cost;}else limited=true;}catch{if(!signal.aborted)limited=true;}}};
   void Promise.all(Array.from({length:Math.min(entries.length,options.concurrency??2)},run)).then(()=>{
    if(disposed||mine!==generation||signal.aborted)return;
    bytes=owned;controller.setTiles(loaded.sort((a,b)=>entries.findIndex(t=>t.id===a.id)-entries.findIndex(t=>t.id===b.id)),ticket);invalidate();
   });
  },
  scene(){return {tiles:controller.tiles(),sample:controller.sample,revision:controller.revision()};},
  status:()=>({...controller.status(),bytes,limited}),
  dispose(){disposed=true;bytes=0;generation++;abort.abort();controller.dispose();},
 };
}
