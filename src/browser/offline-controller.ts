import type {OsmSource} from '../adapters/osm/provider';
import type {RegionRequest} from '../adapters/osm/region-cache';
import {toGeo} from '../core/coordinates';
import type {Point} from '../presentation/camera';
export function attachOfflineRegion(root:HTMLElement,maps:OsmSource,center:()=>Point){
 const start=root.querySelector<HTMLButtonElement>('#offline-prepare')!,stop=root.querySelector<HTMLButtonElement>('#offline-stop')!,status=root.querySelector<HTMLElement>('#offline-status')!;
 let abort:AbortController|null=null,request:RegionRequest|null=null;
 const prepare=async()=>{
  if(abort)return;
  const geo=toGeo(center());
  // 12 km square centred on the viewpoint; bounds and budget remain explicit and inspectable.
  const latitude=6/111.32,longitude=latitude/Math.max(.1,Math.cos(geo.lat*Math.PI/180));
  const wrap=(lon:number)=>((lon+180)%360+360)%360-180;
  request??={bounds:{west:wrap(geo.lon-longitude),east:wrap(geo.lon+longitude),south:Math.max(-85.05112878,geo.lat-latitude),north:Math.min(85.05112878,geo.lat+latitude)},levels:['overview','detail'],maxBytes:64*1024*1024};
  abort=new AbortController();start.disabled=true;stop.hidden=false;
  try{
   const coverage=await maps.prepareRegion(request,p=>{status.textContent=`Guardado: ${p.stored}/${p.required} tiles · ${(p.bytes/1048576).toFixed(1)} MB`;},abort.signal);
   status.textContent+=coverage.complete?' · Região pronta para offline':coverage.stopped?' · Pausado; continue para retomar':' · Incompleto; tente novamente';
   if(coverage.complete){request=null;start.textContent='Guardar outra região';}else start.textContent='Continuar download';
  }catch(error){status.textContent=error instanceof Error?error.message:String(error);}
  finally{abort=null;start.disabled=false;stop.hidden=true;}
 };
 const pause=()=>abort?.abort();start.addEventListener('click',prepare);stop.addEventListener('click',pause);
 return()=>{pause();start.removeEventListener('click',prepare);stop.removeEventListener('click',pause);};
}
