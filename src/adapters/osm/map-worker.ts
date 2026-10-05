import type {BaseChunk} from '../../core/model';
import type {GeographicTile} from '../../presentation/geographic-map';
import {decodeVisualTile,decodeTile,type DecodedTile} from './decode';
import {normalizeChunk} from './normalize';

type Request={id:string;kind:'chunk'|'visual';chunk:string;source:string;cacheSource?:string;zoom:number;tileX:number;tileY:number;bytes:ArrayBuffer|null};
type Response={id:string;kind?:'chunk'|'visual';visual?:GeographicTile;chunk?:BaseChunk;missing?:true;error?:string;decodeMs?:number|null;normalizeMs?:number;reused?:boolean};
type Scope={
 onmessage:((event:MessageEvent<Request>)=>void)|null;
 postMessage(message:Response):void;
};

const visuals=new Map<string,GeographicTile>();
const cache=new Map<string,DecodedTile>();
const keyOf=(request:Request)=>`${request.cacheSource??request.source}:${request.zoom}:${request.tileX}:${request.tileY}`;

function handle(request:Request):Response{
 const key=keyOf(request);
 if(request.kind==='visual'){
  let visual=visuals.get(key);const reused=Boolean(visual);let decodeMs:number|null=null;
  if(!visual){if(!request.bytes)return{id:request.id,missing:true};const started=performance.now();visual=decodeVisualTile(new Uint8Array(request.bytes),request.zoom,request.tileX,request.tileY);decodeMs=performance.now()-started;}
  visuals.delete(key);visuals.set(key,visual);while(visuals.size>32)visuals.delete(visuals.keys().next().value!);
  return{id:request.id,kind:'visual',visual,decodeMs,reused};
 }
 let decoded=cache.get(key),reused=true,decodeMs:number|null=null;
 if(decoded){cache.delete(key);cache.set(key,decoded);}
 else{
  if(!request.bytes)return{id:request.id,missing:true};
  reused=false;
  const started=performance.now();
  decoded=decodeTile(new Uint8Array(request.bytes),request.zoom,request.tileX,request.tileY);
  decodeMs=performance.now()-started;
  cache.set(key,decoded);while(cache.size>32)cache.delete(cache.keys().next().value!);
 }
 const started=performance.now();
 const chunk=normalizeChunk(request.chunk,decoded.byChunk.get(request.chunk)??[],request.source);
 return{id:request.id,kind:'chunk',chunk,decodeMs,normalizeMs:performance.now()-started,reused};
}

const scope=self as unknown as Scope;
scope.onmessage=event=>{
 let response:Response;
 try{response=handle(event.data);}
 catch(error){response={id:event.data.id,error:error instanceof Error?error.message:String(error)};}
 scope.postMessage(response);
};
