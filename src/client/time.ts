// Wall-clock time reaches the client through this port and nowhere else (spec 2026-10-01 §5.4). The browser hands it
// `performance.now` and `setTimeout`; a test or the terminal hands it a manual clock, so thirty seconds of a city
// take no seconds at all and run the same way every time.
export type Cancel = () => void;
export type TimePort = {
 now(): number;
 after(ms: number, fn: () => void): Cancel;
 every(ms: number, fn: () => void): Cancel;
 // Wall-clock time in epoch milliseconds, the source of the ISO strings a version or a scenario fork is stamped with
 // (spec 2026-10-01: no `Date` in src/client). `now()` is monotonic for debounces; `wall()` is the calendar instant.
 wall(): number;
};

// The one place a client turns wall-clock time into the ISO-8601 instant a version or a scenario records.
export function isoOf(time: TimePort): string {
 return new Date(time.wall()).toISOString();
}

// One pending run per window: a burst of calls coalesces into a single run that reads the newest state when it fires,
// so a periodic tick arriving every `wait` ms can never starve the save it keeps asking for.
export type Debounced = (() => void) & {cancel(): void};
export function debounce(time: TimePort, wait: number, task: () => void): Debounced {
 let cancel: Cancel | null = null;
 const schedule = () => {
  if (cancel) return;
  cancel = time.after(wait, () => { cancel = null; task(); });
 };
 return Object.assign(schedule, {cancel() { cancel?.(); cancel = null; }});
}

export type ManualTime = TimePort & {
 // Moves the clock forward, firing every timer that falls due in order of its due time (and of creation for a tie),
 // and lets the promises each one started settle before the next fires.
 advance(ms: number): Promise<void>;
 pending(): number;
};
type Timer = {id: number; due: number; fn: () => void; every: number};
const settle = async () => { for (let round = 0; round < 50; round += 1) await Promise.resolve(); };

export function createManualTime(start = 0): ManualTime {
 let now = start, counter = 0;
 // A fixed, deterministic wall-clock epoch so the ISO strings a version or scenario records are the same every run.
 // 2026-01-01T00:00:00Z, advanced by the same manual clock, so "later" is still later without a real calendar.
 const WALL_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
 const timers = new Map<number, Timer>();
 const add = (ms: number, fn: () => void, every: number): Cancel => {
  const id = (counter += 1);
  timers.set(id, {id, due: now + Math.max(0, ms), fn, every});
  return () => { timers.delete(id); };
 };
 const next = (limit: number): Timer | null => {
  let best: Timer | null = null;
  for (const timer of timers.values()) {
   if (timer.due > limit) continue;
   if (!best || timer.due < best.due || (timer.due === best.due && timer.id < best.id)) best = timer;
  }
  return best;
 };
 return {
  now: () => now,
  wall: () => WALL_EPOCH + now,
  after: (ms, fn) => add(ms, fn, 0),
  every: (ms, fn) => add(ms, fn, Math.max(1, ms)),
  pending: () => timers.size,
  async advance(ms) {
   const target = now + Math.max(0, ms);
   await settle();
   for (let timer = next(target); timer; timer = next(target)) {
    now = timer.due;
    if (timer.every) timer.due += timer.every;
    else timers.delete(timer.id);
    timer.fn();
    await settle();
   }
   now = target;
   await settle();
  },
 };
}
