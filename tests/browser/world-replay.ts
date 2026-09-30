// The browser half of the conformance proof (tests/browser/world-replay.html). It fetches the very same synthetic
// package the Node runner reads from disk and runs the very same replay: if the canonical bytes and the addresses differ
// between the two runtimes, this page shows it. The glue is deliberately not shared with tools/world-replay.ts — the
// shared part is the replay itself, and what differs (file vs HTTP, stdout vs DOM) is what a runtime is.
import {createJcsCodec} from '../../src/adapters/codec/jcs';
import {bytesHasher,sha256Hex} from '../../src/adapters/hash/content';
import {replayFixture} from '../../src/world/world-replay';
import type {ConformancePackage,ReplayReport} from '../../src/world/world-replay';

declare global {
 interface Window {
  // Left on the page so an automated run reads the same report a person reads on screen.
  __osimReplay?: ReplayReport;
 }
}

const output = document.getElementById('resultado');
const failure = document.getElementById('erro');
if (!output || !failure) throw new Error('Página sem elementos de resultado');
try {
 const response = await fetch('/tests/fixtures/federated-world/conformance.json');
 if (!response.ok) throw new Error(`Falha ao buscar o pacote: HTTP ${response.status}`);
 const pkg = await response.json() as ConformancePackage;
 const report = await replayFixture(pkg, {codec:createJcsCodec(), hasher:bytesHasher(), hashText:sha256Hex});
 if (!report.ok) throw new Error(`Replay recusado (${report.error.code}): ${report.error.message}`);
 window.__osimReplay = report.value;
 // The whole canonical text is shown, not only the hash: two runtimes that disagree are meant to be diffable.
 output.textContent = JSON.stringify(report.value);
} catch (error) {
 failure.textContent = error instanceof Error ? error.message : String(error);
}
