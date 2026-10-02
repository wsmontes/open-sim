// Parity in the browser (spec 2026-10-01 §6, §7): the same playthrough the Node host runs with `tools/play.ts
// --script` runs here through the same portable client — a synthetic map, a manual clock and in-memory stores — and
// prints the per-step transcript, the report and the semantic hash. The hash and the transcript must be identical to
// Node's, which is what proves the game (not only the core) is the same on both runtimes. Nothing goes to the network
// beyond fetching the fixture Vite serves; the map is the synthetic fixture, not OSM.
import {createPlayHost} from '../../tools/play-host';
import {runPlaythrough} from '../../src/surfaces/text/playthrough';
import type {Playthrough} from '../../src/surfaces/text/playthrough';

const output = document.getElementById('resultado');
const failure = document.getElementById('erro');
if (!output || !failure) throw new Error('Página sem elementos de resultado');

// The query decides which playthrough to run; the default is the build-and-grow acceptance script.
const which = new URLSearchParams(location.search).get('roteiro') ?? 'construir-e-crescer';
try {
 const response = await fetch(`/tests/playthroughs/${which}.json`);
 if (!response.ok) throw new Error(`Falha ao buscar o roteiro: HTTP ${response.status}`);
 const playthrough = (await response.json()) as Playthrough;
 // The same host the terminal and the test suite use: a fixture map, in-memory saves and world storage, manual time.
 const report = await runPlaythrough(playthrough, createPlayHost());
 const lines = report.steps.map(
  step => `${step.failure ? '✗' : '✓'} ${String(step.index + 1).padStart(3)} ${JSON.stringify(step.step)}${step.failure ? `\n      ${step.failure}` : ''}`,
 );
 lines.push('');
 lines.push(`${report.ok ? 'OK' : 'FALHOU'} · ${report.title} · hash semântico ${report.semanticHash}`);
 if (report.failure) lines.push(report.failure);
 output.textContent = lines.join('\n');
} catch (error) {
 failure.textContent = error instanceof Error ? error.message : String(error);
}
