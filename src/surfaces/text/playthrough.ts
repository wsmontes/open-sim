import type {CellCoord,GameState} from '../../core/model';
import type {CityClient,ClientView} from '../../client/city-client';
import type {Intent,IntentResult} from '../../client/intents';
import type {ManualTime} from '../../client/time';
import {chunkId,chunkOrigin} from '../../core/coordinates';
import {cardText} from '../../presentation/card-text';
import {parseCommand} from './parse';
import {transcript} from './render';

// A playthrough is a player's session written down: what they typed or asked, how long they waited, and what they
// expected to see (spec 2026-10-01 §7). It runs on the client through the text surface, with a manual clock, so the
// same file gives the same answers in Node, in the browser and in the test suite.
export type Value = number | string | boolean | null;
export type Matcher = Value | {min?: number; max?: number} | {contains: string} | {is: string} | {plus: [string | number, string | number]};
// A step may name the player it is for with `as` (spec 2026-10-01 §7): a playthrough that opens a cooperative session
// drives two clients that share one in-memory transport and registry. A step with no `as` goes to the lone/host
// player, which is the single-player playthroughs' behaviour unchanged.
export type Step =
 | {say: string; as?: string}
 | {do: Intent; as?: string}
 | {wait: number; as?: string}
 | {expect: Record<string, Matcher>; as?: string}
 | {remember: Record<string, string>; as?: string}
 | {reopen: true}
 | {note: string};
export type Playthrough = {version: 1; title: string; seed?: number; steps: Step[]; final?: {semanticHash?: string}};

export type Opened = {client: CityClient; time: ManualTime; origin: CellCoord};
export type PlaythroughHost = {
 // Opens the game on the host's storage. A second call is the player reloading the page: same storage, new client.
 open(): Promise<Opened>;
 semanticHash(state: GameState): Promise<string>;
 // Multi-player playthroughs (spec §7): a named player gets its own client over the shared in-memory transport and
 // registry. A host that does not support cooperative play leaves this off, and a playthrough with `as` is a refusal.
 openPlayer?(name: string): Promise<Opened>;
 // Drain the shared transport so a replica sees what the host just confirmed; a single-player host leaves it off.
 settle?(): Promise<void>;
};
export type StepReport = {index: number; step: Step; transcript: string; failure?: string};
export type PlaythroughReport = {ok: boolean; title: string; steps: StepReport[]; semanticHash: string | null; failure: string | null};

// What an expectation can read: the view, with the card spelled out in the words the player reads and the answer to
// the last thing the player asked.
function readable(view: ClientView, last: IntentResult): Record<string, unknown> {
 return {
  ...view,
  card: view.card ? {...cardText(view.card.cell, view.card.reading), ...view.card.reading} : null,
  result: last,
  tick: view.state?.tick ?? 0,
  revision: view.state?.revision ?? 0,
 };
}
function at(source: unknown, path: string): unknown {
 let value = source;
 for (const part of path.split('.')) {
  if (value === null || value === undefined) return undefined;
  value = (value as Record<string, unknown>)[part];
 }
 return value;
}
function numberOf(token: string | number, memory: ReadonlyMap<string, unknown>): number {
 if (typeof token === 'number') return token;
 const negative = token.startsWith('-'), name = negative ? token.slice(1) : token;
 const found = name.startsWith('$') ? memory.get(name.slice(1)) : Number(name);
 if (typeof found !== 'number' || !Number.isFinite(found)) throw new Error(`"${token}" não é um número lembrado`);
 return negative ? -found : found;
}
function check(actual: unknown, matcher: Matcher, memory: ReadonlyMap<string, unknown>): string | null {
 const shown = JSON.stringify(actual);
 if (matcher === null || typeof matcher !== 'object') return actual === matcher ? null : `esperava ${JSON.stringify(matcher)}, veio ${shown}`;
 if ('contains' in matcher) return typeof actual === 'string' && actual.includes(matcher.contains) ? null : `esperava texto com "${matcher.contains}", veio ${shown}`;
 if ('is' in matcher) {
  const expected = memory.get(matcher.is.replace(/^\$/, ''));
  return JSON.stringify(actual) === JSON.stringify(expected) ? null : `esperava ${JSON.stringify(expected)} (${matcher.is}), veio ${shown}`;
 }
 if ('plus' in matcher) {
  const expected = numberOf(matcher.plus[0], memory) + numberOf(matcher.plus[1], memory);
  return actual === expected ? null : `esperava ${expected} (${matcher.plus.join(' + ')}), veio ${shown}`;
 }
 if (typeof actual !== 'number') return `esperava um número, veio ${shown}`;
 if (matcher.min !== undefined && actual < matcher.min) return `esperava ao menos ${matcher.min}, veio ${actual}`;
 if (matcher.max !== undefined && actual > matcher.max) return `esperava no máximo ${matcher.max}, veio ${actual}`;
 return null;
}

export async function runPlaythrough(script: Playthrough, host: PlaythroughHost): Promise<PlaythroughReport> {
 const steps: StepReport[] = [];
 const memory = new Map<string, unknown>();
 // A world package the player "exported" lives in memory here, keyed by the file name, so a playthrough can export a
 // version and then import it — the host writes no real file and reads none, exactly as spec §7 asks.
 const files = new Map<string, Uint8Array>();
 // One client per named player, all over the host's shared transport and registry (spec §7). The default player (a
 // step with no `as`) is the lone/host client; a named one is opened on first use. The last answer is per player, so
 // a replica's refusal is not read as the host's acceptance.
 const DEFAULT = '';
 const players = new Map<string, Opened>();
 const answers = new Map<string, IntentResult>();
 const openFor = async (name: string): Promise<Opened> => {
  const existing = players.get(name);
  if (existing) return existing;
  const opened = name === DEFAULT || !host.openPlayer ? await host.open() : await host.openPlayer(name);
  await opened.client.start();
  await opened.client.idle();
  players.set(name, opened);
  answers.set(name, {ok: true, message: ''});
  return opened;
 };
 const first = await openFor(DEFAULT);
 // Draining the shared transport and then letting every open client re-read the version its session confirmed: a
 // replica only sees the host's build once the frames were delivered and it refreshed. A single-player host leaves
 // `settle` off and this is a no-op.
 const settle = async () => {
  if (!host.settle) return;
  await host.settle();
  for (const opened of players.values()) { await opened.client.syncSession(); await opened.client.idle(); }
 };
 const perform = async (opened: Opened, name: string, intents: readonly Intent[]) => {
  for (const intent of intents) {
   answers.set(name, await opened.client.do(intent));
   await opened.client.idle();
   await settle();
   await opened.client.idle();
  }
 };
 const finish = async (failure: string | null): Promise<PlaythroughReport> => {
  // The semantic hash is the default player's city — the single-player playthroughs' hash is unchanged. A cooperative
  // playthrough asserts the shared state through `expect`, so the final hash stays the host's own version.
  const state = first.client.view().state;
  const report = {ok: !failure, title: script.title, steps, semanticHash: state ? await host.semanticHash(state) : null, failure};
  for (const opened of players.values()) opened.client.stop();
  return report;
 };
 for (const [index, step] of script.steps.entries()) {
  let failure: string | undefined;
  const name = 'as' in step && step.as ? step.as : DEFAULT;
  try {
   if ('note' in step) {
    // A note is a comment: it names nothing to do and reads nothing.
   } else if ('reopen' in step) {
    // The player closes the tab: the client saves as the page would on `pagehide`, and a new one opens on the same
    // storage with nothing carried over. Reopen is the lone player's; a cooperative playthrough does not use it.
    const opened = players.get(DEFAULT)!;
    opened.client.saveNow();
    await opened.client.idle();
    opened.client.stop();
    const reopened = await host.open();
    await reopened.client.start();
    await reopened.client.idle();
    players.set(DEFAULT, reopened);
    answers.set(DEFAULT, {ok: true, message: ''});
   } else {
    const opened = await openFor(name);
    const last = answers.get(name) ?? {ok: true, message: ''};
    if ('say' in step) {
     // Coordinates in a typed command are relative to the region under the camera, so "casa 3,4" builds where the
     // player is looking after an "ir" — the same cell under the same character on the map window.
     const origin = chunkOrigin(chunkId(opened.client.view().center));
     const parsed = parseCommand(step.say, origin);
     if ('error' in parsed) answers.set(name, {ok: false, message: parsed.error});
     else if (parsed.exportFile) {
      answers.set(name, await opened.client.do({do: 'export'}));
      await opened.client.idle();
      const bytes = opened.client.view().export?.bytes;
      if (bytes) files.set(parsed.exportFile, bytes);
     } else if (parsed.importFile) {
      const bytes = files.get(parsed.importFile);
      if (!bytes) answers.set(name, {ok: false, message: `Nenhum pacote em ${parsed.importFile}`});
      else { answers.set(name, await opened.client.do({do: 'import', bytes})); await opened.client.idle(); await settle(); }
     } else {
      await perform(opened, name, parsed.intents);
      if (parsed.wait) { await opened.time.advance(parsed.wait); await opened.client.idle(); await settle(); }
     }
    } else if ('do' in step) await perform(opened, name, [step.do]);
    else if ('wait' in step) { await opened.time.advance(step.wait); await opened.client.idle(); await settle(); }
    else if ('remember' in step) {
     const view = readable(opened.client.view(), last);
     for (const [key, path] of Object.entries(step.remember)) memory.set(key, at(view, path));
    } else if ('expect' in step) {
     const view = readable(opened.client.view(), last);
     const problems = Object.entries(step.expect).flatMap(([path, matcher]) => {
      const problem = check(at(view, path), matcher, memory);
      return problem ? [`${path}: ${problem}`] : [];
     });
     if (problems.length) failure = problems.join('; ');
    }
   }
  } catch (error) {
   failure = error instanceof Error ? error.message : String(error);
  }
  const shown = players.get(name) ?? first;
  steps.push({index, step, transcript: transcript(shown.client.view()), ...(failure ? {failure} : {})});
  if (failure) return finish(`passo ${index + 1}: ${failure}`);
 }
 const report = await finish(null);
 if (script.final?.semanticHash && report.semanticHash !== script.final.semanticHash) {
  return {...report, ok: false, failure: `hash semântico ${report.semanticHash} ≠ ${script.final.semanticHash}`};
 }
 return report;
}
