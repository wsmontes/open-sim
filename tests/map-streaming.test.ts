import {expect,test} from 'vitest';
import {createMapStreaming} from '../src/session/map-streaming';
test('visible demand overtakes queued background and duplicate demands coalesce',async()=>{
 const calls:string[]=[],release:Array<()=>void>=[];
 const stream=createMapStreaming({concurrency:1,load:async(ids,level)=>{calls.push(`${level}:${ids[0]}`);await new Promise<void>(r=>release.push(r));}});
 stream.updateDemand({visible:['a'],detail:[],nearby:['b','c']});await Promise.resolve();
 stream.updateDemand({visible:['a','d'],detail:[],nearby:['b','c']});
 release.shift()!();await new Promise(r=>setTimeout(r,0));expect(calls).toEqual(['overview:a','overview:d']);
 stream.destroy();release.shift()!();await stream.idle();
});
