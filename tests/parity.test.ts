import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect,test} from 'vitest';
import {runPlaythrough} from '../src/surfaces/text/playthrough';
import type {Playthrough} from '../src/surfaces/text/playthrough';
import {createPlayHost} from '../tools/play-host';

// Node ↔ browser parity (spec 2026-10-01 §6, §7). The browser page tests/browser/play.html runs this same playthrough
// through the same portable client and host (createPlayHost: fixture map, in-memory stores, manual clock) and prints
// the semantic hash; `tools/play.ts --script` prints it too. A browser is not available here, so the proof on the Node
// side is this: the host the parity page imports produces a stable, pinned hash and transcript. If the client or the
// host drifts, this fails before the two runtimes can disagree.
const PARITY = 'construir-e-crescer';
// The hash the Node host prints for the parity playthrough (`npx tsx tools/play.ts --script
// tests/playthroughs/construir-e-crescer.json`). The browser page must print the same string.
const EXPECTED_HASH = 'f3eb4917da2bc1addde013ec3176bad5e9f578585aa89d711a359eafa9cd5c75';

test(`parity playthrough ${PARITY} has the pinned semantic hash the browser page must match`, async () => {
 const script = JSON.parse(readFileSync(join(import.meta.dirname, 'playthroughs', `${PARITY}.json`), 'utf8')) as Playthrough;
 const report = await runPlaythrough(script, createPlayHost());
 expect(report.failure).toBeNull();
 expect(report.ok).toBe(true);
 expect(report.semanticHash).toBe(EXPECTED_HASH);
});
