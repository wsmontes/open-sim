export type Speed = 0|1|2;
export type TickClock = {setSpeed(speed:Speed):void;setHidden(hidden:boolean):void;level():Speed;stop():void};
const PERIOD:Record<Speed,number>={0:0,1:1000,2:500};
export function createTickClock(onTick:()=>void):TickClock {
 let speed:Speed=0,hidden=false,stopped=false,cancel:()=>void=()=>{};
 // Any change of speed or visibility rebuilds the interval, so time spent paused or hidden is never replayed.
 const schedule=()=>{
  cancel();
  if(stopped||hidden||speed===0)return;
  const id=setInterval(onTick,PERIOD[speed]);
  cancel=()=>clearInterval(id);
 };
 return {
  setSpeed(next){if(stopped||next===speed)return;speed=next;schedule();},
  setHidden(next){if(stopped||next===hidden)return;hidden=next;schedule();},
  level:()=>speed,
  stop(){stopped=true;cancel();},
 };
}
