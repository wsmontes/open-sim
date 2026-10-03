import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {runPlaythrough} from '../src/surfaces/text/playthrough';
import type {Playthrough} from '../src/surfaces/text/playthrough';
import {createPlayHost,semanticHash} from '../tools/play-host';

// Node ↔ browser parity (spec 2026-10-01 §6, §7). The browser page tests/browser/play.html runs this same playthrough
// through the same portable client and host (createPlayHost: fixture map, in-memory stores, manual clock) and prints
// the semantic hash; `tools/play.ts --script` prints it too. A browser is not available here, so the proof on the Node
// side is this: the host the parity page imports produces a stable, pinned hash and transcript. If the client or the
// host drifts, this fails before the two runtimes can disagree.
const PARITY = 'construir-e-crescer';
// The hash the Node host prints for the parity playthrough (`npx tsx tools/play.ts --script
// tests/playthroughs/construir-e-crescer.json`). The browser page must print the same string.
const EXPECTED_HASH = 'fd7682a96d4ccc956d31f125488415475d3b151a63816cec2c7419c99c86fb18';
const RULES4_HASH = '6f3d299e76570cb02590c597b2c9e60186b1bacc7f9e44bbc8951991af7ab3d2';

test(`parity playthrough ${PARITY} has the pinned semantic hash the browser page must match`, async () => {
 const script = JSON.parse(readFileSync(join(import.meta.dirname, 'playthroughs', `${PARITY}.json`), 'utf8')) as Playthrough;
 const host=createPlayHost();
 const report = await runPlaythrough(script, host);
 expect(report.failure).toBeNull();
 expect(report.ok).toBe(true);
 expect(report.semanticHash).toBe(EXPECTED_HASH);
 const state=host.last()!.view().state!;
 // Version 5 adds explicit calibration; without it every durable field matches the rules-4 playthrough.
 expect(await semanticHash({...state,rulesVersion:4} as unknown as typeof state)).toBe(RULES4_HASH);
});
