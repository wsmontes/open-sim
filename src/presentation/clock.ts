export type Speed = 0|1|2|3;
// Presentation movement shares pause/speed with the partida, with bounded catch-up after hidden tabs.
export const motionSeconds=(elapsed:number,speed:Speed):number=>Number.isFinite(elapsed)&&elapsed>0?Math.min(.25,elapsed*speed):0;
// Only one participant orders a session: the host, or the player alone. A replica applies the ticks it receives as
// commits, so a clock that fired here would invent a second authority over the same branch (spec §7.5).
export type ClockRole = 'local'|'host'|'replica';
export type TickClock = {setSpeed(speed:Speed):void;setHidden(hidden:boolean):void;setRole(role:ClockRole):void;role():ClockRole;level():Speed;stop():void};
// A repeating timer, injected so a host decides what time is: the browser's interval, or a manual clock a test advances.
export type Every = (ms:number,fn:()=>void)=>()=>void;
// The platform interval is reached through globalThis, so this module still compiles for runtimes that declare no timers.
type Timers={setInterval(fn:()=>void,ms:number):unknown;clearInterval(id:unknown):void};
const intervalEvery:Every=(ms,fn)=>{const timers=globalThis as unknown as Timers,id=timers.setInterval(fn,ms);return ()=>timers.clearInterval(id);};
// 3× exists because a growth step is five ticks and a month is thirty: at 2× a quiet city still took fifteen seconds
// to close a month, and there was no way to hurry past waiting.
export const TICK_PERIOD_MS:Record<Speed,number>={0:0,1:1000,2:500,3:333};
export function createTickClock(onTick:()=>void,every:Every=intervalEvery):TickClock {
 let speed:Speed=0,hidden=false,role:ClockRole='local',stopped=false,cancel:()=>void=()=>{};
 // Any change of speed, visibility or authority rebuilds the interval, so time spent paused, hidden or following
 // somebody else's clock is never replayed.
 const schedule=()=>{
  cancel();
  cancel=()=>{};
  if(stopped||hidden||speed===0||role==='replica')return;
  cancel=every(TICK_PERIOD_MS[speed],onTick);
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
