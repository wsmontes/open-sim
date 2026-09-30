import {replayScenario} from '../../src/core/replay';
import {canonicalJson} from '../../src/core/snapshot';

const output = document.getElementById('resultado');
const failure = document.getElementById('erro');
if (!output || !failure) throw new Error('Página sem elementos de resultado');
try {
 const response = await fetch('/tests/fixtures/portable-scenario.json');
 if (!response.ok) throw new Error(`Falha ao buscar o cenário: HTTP ${response.status}`);
 // Same core, same scenario: the canonical state must match the Node executor.
 output.textContent = canonicalJson(replayScenario(await response.json()));
} catch (error) {
 failure.textContent = error instanceof Error ? error.message : String(error);
}
