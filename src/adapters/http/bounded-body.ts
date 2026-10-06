import {ResourcePressure} from '../../core/resource-pressure';
export {ResourcePressure} from '../../core/resource-pressure';
export async function boundedResponseBytes(response:Response,maxBytes:number,signal?:AbortSignal):Promise<Uint8Array>{
 if(signal?.aborted)throw new DOMException('Aborted','AbortError');
 const advertised=Number(response.headers?.get('Content-Length'));
 if(advertised>maxBytes){await response.body?.cancel();throw new ResourcePressure();}
 // Non-streaming test/custom transports can only be validated after their allocation.
 if(!response.body){const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.byteLength>maxBytes)throw new ResourcePressure();if(signal?.aborted)throw new DOMException('Aborted','AbortError');return bytes;}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 const aborted=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',aborted,{once:true});
 try{
  for(;;){const {done,value}=await reader.read();if(signal?.aborted)throw new DOMException('Aborted','AbortError');if(done)break;size+=value.byteLength;if(size>maxBytes)throw new ResourcePressure();chunks.push(value);}
  const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}return result;
 }catch(error){await reader.cancel().catch(()=>{});throw error;}
 finally{signal?.removeEventListener('abort',aborted);reader.releaseLock();}
}
