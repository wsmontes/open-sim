import type {BaseChunk} from '../../core/model';
import {createNormalizationCache} from './normalization-cache';
import {ResourcePressure} from '../../core/resource-pressure';
import {normalizeChunk} from './normalize';

type Request={id:string;chunk:string;source:string;zoom:number;tileX:number;tileY:number;bytes:ArrayBuffer|null;cacheBytes:number;geometryBytes:number};
type Response={id:string;chunk?:BaseChunk;missing?:true;error?:string;decodeMs?:number|null;normalizeMs?:number;reused?:boolean;resourcePressure?:boolean};
type Scope={
 onmessage:((event:MessageEvent<Request>)=>void)|null;
 postMessage(message:Response):void;
};

const cache=createNormalizationCache(16*1024*1024);
const keyOf=(request:Request)=>`${request.zoom}:${request.tileX}:${request.tileY}`;

function handle(request:Request):Response{
 cache.setLimit(request.cacheBytes);const key=keyOf(request);
 let decoded=cache.get(key),reused=true,decodeMs:number|null=null;
 if(!decoded){
  if(!request.bytes)return{id:request.id,missing:true};
  reused=false;
  const started=performance.now();
  decoded=cache.decode(key,new Uint8Array(request.bytes),request.zoom,request.tileX,request.tileY,request.geometryBytes);
  decodeMs=performance.now()-started;
 }
 const started=performance.now();
 const chunk=normalizeChunk(request.chunk,decoded,request.source);
 return{id:request.id,chunk,decodeMs,normalizeMs:performance.now()-started,reused};
}

const scope=self as unknown as Scope;
scope.onmessage=event=>{
 let response:Response;
 try{response=handle(event.data);}
 catch(error){response={id:event.data.id,error:error instanceof Error?error.message:String(error),resourcePressure:error instanceof ResourcePressure};}
 scope.postMessage(response);
};
