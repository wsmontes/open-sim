import type {TimePort} from '../../client/time';

// The runtime's own clock and timers, for hosts that play in real time: the browser, or the terminal when asked to.
export function systemTime(): TimePort {
 return {
  now: () => performance.now(),
  wall: () => Date.now(),
  after: (ms, fn) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
  every: (ms, fn) => { const id = setInterval(fn, ms); return () => clearInterval(id); },
 };
}
