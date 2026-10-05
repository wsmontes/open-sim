import {expect,test,vi} from 'vitest';
import {createFrameScheduler,type FrameNeed} from '../src/presentation/frame-scheduler';

function harness(sequence:FrameNeed[]){
 const frames:Array<(now:number)=>void>=[],timers:Array<()=>void>=[],cancelled:number[]=[];
 let now=0,draws=0;
 const scheduler=createFrameScheduler({
  draw:()=>sequence[Math.min(draws++,sequence.length-1)]??{moving:false,ambient:false},
  request:callback=>{frames.push(callback);return frames.length;},
  cancel:id=>{cancelled.push(id);},
  delay:callback=>{timers.push(callback);return timers.length as unknown as ReturnType<typeof setTimeout>;},
  clearDelay:vi.fn(),
  visible:()=>true,
  now:()=>now,
 });
 return{
  scheduler,frames,timers,cancelled,
  draw(at:number){const cb=frames.shift();if(!cb)throw new Error('no frame queued');now=at;cb(at);},
  runTimer(){const cb=timers.shift();if(!cb)throw new Error('no timer queued');cb();},
  get draws(){return draws;},
 };
}

test('one invalidation draws once and sleeps when nothing moves',()=>{
 const h=harness([{moving:false,ambient:false}]);
 h.scheduler.invalidate();
 expect(h.frames).toHaveLength(1);
 h.draw(16);
 expect(h.draws).toBe(1);
 expect(h.frames).toHaveLength(0);
 expect(h.timers).toHaveLength(0);
 expect(h.scheduler.running()).toBe(false);
});

test('camera movement keeps animation-frame cadence until it settles',()=>{
 const h=harness([{moving:true,ambient:false},{moving:false,ambient:false}]);
 h.scheduler.invalidate();
 h.draw(16);
 expect(h.frames).toHaveLength(1);
 expect(h.timers).toHaveLength(0);
 h.draw(32);
 expect(h.scheduler.running()).toBe(false);
 expect(h.draws).toBe(2);
});

test('ambient animation is throttled and input preempts its timer',()=>{
 const h=harness([{moving:false,ambient:true},{moving:false,ambient:false}]);
 h.scheduler.invalidate();
 h.draw(16);
 expect(h.frames).toHaveLength(0);
 expect(h.timers).toHaveLength(1);
 h.scheduler.invalidate();
 // The ambient timer was cancelled and input gets a real animation frame immediately.
 expect(h.frames).toHaveLength(1);
 h.draw(32);
 expect(h.scheduler.running()).toBe(false);
});

test('frame delta is capped after a long suspension',()=>{
 const frames:Array<(now:number)=>void>=[];
 const seconds:number[]=[];
 const scheduler=createFrameScheduler({
  draw:(_now,dt)=>{seconds.push(dt);return{moving:seconds.length<2,ambient:false};},
  request:callback=>{frames.push(callback);return frames.length;},
  cancel:()=>{},
  visible:()=>true,
  now:()=>0,
 });
 scheduler.invalidate();
 frames.shift()!(100);
 frames.shift()!(10_000);
 expect(seconds).toEqual([0,.25]);
});

test('fps statistics decay while an idle renderer sleeps',()=>{
 const frames:Array<(now:number)=>void>=[];
 let now=0;
 const scheduler=createFrameScheduler({
  draw:()=>({moving:false,ambient:false}),
  request:callback=>{frames.push(callback);return frames.length;},cancel:()=>{},visible:()=>true,now:()=>now,
 });
 scheduler.invalidate();
 now=10;frames.shift()!(10);
 expect(scheduler.stats().fps).toBe(1);
 now=1200;
 expect(scheduler.stats().fps).toBe(0);
});

test('skipped render callbacks do not count as canvas draws',()=>{
 const frames:Array<(now:number)=>void>=[];
 const scheduler=createFrameScheduler({
  draw:()=>({moving:false,ambient:false,drawn:false}),
  request:cb=>{frames.push(cb);return 1;},cancel:()=>{},visible:()=>true,now:()=>1,
 });
 scheduler.invalidate();frames.shift()!(1);
 expect(scheduler.stats().frames).toBe(1);expect(scheduler.stats().drawn).toBe(0);
});
