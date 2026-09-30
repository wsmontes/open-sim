export type Speed = 0|1|2;
// Only one participant orders a session: the host, or the player alone. A replica applies the ticks it receives as
// commits, so a clock that fired here would invent a second authority over the same branch (spec §7.5).
export type ClockRole = 'local'|'host'|'replica';
export type TickClock = {setSpeed(speed:Speed):void;setHidden(hidden:boolean):void;setRole(role:ClockRole):void;role():ClockRole;level():Speed;stop():void};
const PERIOD:Record<Speed,number>={0:0,1:1000,2:500};
export function createTickClock(onTick:()=>void):TickClock {
 let speed:Speed=0,hidden=false,role:ClockRole='local',stopped=false,cancel:()=>void=()=>{};
 // Any change of speed, visibility or authority rebuilds the interval, so time spent paused, hidden or following
 // somebody else's clock is never replayed.
 const schedule=()=>{
  cancel();
  if(stopped||hidden||speed===0||role==='replica')return;
  const id=setInterval(onTick,PERIOD[speed]);
  cancel=()=>clearInterval(id);
 };
 return {
  setSpeed(next){if(stopped||next===speed)return;speed=next;schedule();},
  setHidden(next){if(stopped||next===hidden)return;hidden=next;schedule();},
  setRole(next){if(stopped||next===role)return;role=next;schedule();},
  role:()=>role,
  level:()=>speed,
  stop(){stopped=true;cancel();},
 };
}
