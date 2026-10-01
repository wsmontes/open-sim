import type {BaseChunk} from '../../core/model';
import {decodeTile,type DecodedTile} from './decode';
import {normalizeChunk} from './normalize';

type Request={id:string;chunk:string;source:string;zoom:number;tileX:number;tileY:number;bytes:ArrayBuffer|null};
type Response={id:string;chunk?:BaseChunk;missing?:true;error?:string;decodeMs?:number|null;normalizeMs?:number;reused?:boolean};
type Scope={
 onmessage:((event:MessageEvent<Request>)=>void)|null;
 postMessage(message:Response):void;
};

const cache=new Map<string,DecodedTile>();
const keyOf=(request:Request)=>`${request.zoom}:${request.tileX}:${request.tileY}`;

function handle(request:Request):Response{
 const key=keyOf(request);
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
 return{id:request.id,chunk,decodeMs,normalizeMs:performance.now()-started,reused};
}

const scope=self as unknown as Scope;
scope.onmessage=event=>{
 let response:Response;
 try{response=handle(event.data);}
 catch(error){response={id:event.data.id,error:error instanceof Error?error.message:String(error)};}
 scope.postMessage(response);
};
