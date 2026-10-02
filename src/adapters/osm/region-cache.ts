import type {MapLevel} from '../../session/ports';
export type RegionRequest={bounds:{west:number;south:number;east:number;north:number};levels:readonly MapLevel[];maxBytes:number};
export type RegionTile={key:string;zoom:number;x:number;y:number};
export type RegionCoverage={required:number;stored:number;bytes:number;failures:number;complete:boolean;stopped:boolean};
export type RegionSource={zooms?:{overview:number;detail:number};read(key:string):Promise<Uint8Array|null>;fetch(tile:RegionTile):Promise<Uint8Array>;write(key:string,bytes:Uint8Array):Promise<void>};
export function tilesForRegion(request:RegionRequest,zooms={overview:11,detail:14}):RegionTile[]{
 const {west,east,south,north}=request.bounds;
 if(![west,east,south,north,request.maxBytes].every(Number.isFinite)||south>north||south< -85.05112878||north>85.05112878||west< -180||west>180||east< -180||east>180||request.maxBytes<=0)throw new Error('Região inválida');
 const tiles=new Map<string,RegionTile>();
 for(const level of request.levels){
  if(level!=='detail'&&level!=='overview')throw new Error('Resolução inválida');
  const zoom=zooms[level];
  if(!Number.isInteger(zoom)||zoom<0||zoom>22)throw new Error('Resolução inválida');
  const n=2**zoom;
  const x=(lon:number)=>Math.min(n-1,Math.floor((lon+180)/360*n));
  const y=(lat:number)=>Math.max(0,Math.min(n-1,Math.floor((1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n)));
  const spans=west<=east?[[west,east]]:[[west,180],[-180,east]];
  for(const [a,b] of spans)for(let tx=x(a);tx<=x(b);tx++)for(let ty=y(north);ty<=y(south);ty++){
   const key=`${zoom}:${tx}:${ty}`;tiles.set(key,{key,zoom,x:tx,y:ty});
   if(tiles.size>8192)throw new Error('Região grande demais; selecione uma área menor');
  }
 }
 return [...tiles.values()];
}
export async function prepareRegion(request:RegionRequest,source:RegionSource,onProgress:(coverage:RegionCoverage)=>void,signal?:AbortSignal):Promise<RegionCoverage>{
 const tiles=tilesForRegion(request,source.zooms),progress:RegionCoverage={required:tiles.length,stored:0,bytes:0,failures:0,complete:false,stopped:false};
 const report=()=>onProgress({...progress});
 for(const tile of tiles){
  if(signal?.aborted){progress.stopped=true;break;}
  try{
   let bytes=await source.read(tile.key);
   if(!bytes?.byteLength){
    bytes=await source.fetch(tile);
    if(signal?.aborted){progress.stopped=true;break;}
    if(progress.bytes+bytes.byteLength>request.maxBytes){progress.stopped=true;break;}
    await source.write(tile.key,bytes);
    const verified=await source.read(tile.key);
    if(!verified?.byteLength)throw new Error('Mapa não foi guardado');bytes=verified;
   }
   if(progress.bytes+bytes.byteLength>request.maxBytes){progress.stopped=true;break;}
   progress.bytes+=bytes.byteLength;progress.stored++;
  }catch{progress.failures++;}
  report();
 }
 // Recheck because bounded cache eviction can remove an earlier tile while later tiles are written.
 let stored=0,bytes=0;for(const tile of tiles){const kept=await source.read(tile.key).catch(()=>null);if(kept?.byteLength){stored++;bytes+=kept.byteLength;}}
 progress.stored=stored;progress.bytes=bytes;progress.complete=stored===tiles.length&&!progress.stopped;report();return {...progress};
}
