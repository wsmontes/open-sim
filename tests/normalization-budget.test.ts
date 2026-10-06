import {expect,test} from 'vitest';
import {PbfWriter} from 'pbf';
import {createMainMapDecoder} from '../src/adapters/osm/map-decoder';
import {normalizeChunk,normalizeChunkAsync} from '../src/adapters/osm/normalize';
import type {MapFeature} from '../src/adapters/osm/normalize';
const dense=()=>{const p=new PbfWriter(),g=[9,0,0,79994];for(let i=0;i<9999;i++)g.push(2,0);p.writeMessage(3,(_v,l)=>{l.writeStringField(1,'streets');l.writeVarintField(5,4096);l.writeVarintField(15,2);l.writeMessage(2,(_v,f)=>{f.writeVarintField(3,2);f.writePackedVarint(4,g);},null);},null);return p.finish();};
test('normalization rejects oversized geometry rather than importing an incomplete chunk',async()=>{const decoder=createMainMapDecoder(32,{cacheBytes:1024,geometryBytes:1024});await expect(decoder.decode({id:'0:0',source:'test',zoom:14,tileX:0,tileY:0,bytes:async()=>dense()})).rejects.toMatchObject({name:'ResourcePressure'});expect(decoder.stats().retainedBytes).toBe(0);});
test('async normalization yields and remains identical to synchronous cell import',async()=>{const features:MapFeature[]=[{layer:'buildings',kind:'residential',bridge:false,type:3,geometry:[[{x:0,y:0},{x:32,y:0},{x:32,y:32},{x:0,y:32},{x:0,y:0}]]}];let yielded=false;setTimeout(()=>yielded=true,0);const result=await normalizeChunkAsync('0:0',features,'test');expect(yielded).toBe(true);expect(result).toEqual(normalizeChunk('0:0',features,'test'));});
