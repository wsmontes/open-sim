import {readFileSync} from 'node:fs';
import {replayScenario} from '../src/core/replay';
import {canonicalJson} from '../src/core/protocol';

// Independent replay executor: it holds no simulation logic.
function fail(message: string): never {
 process.stderr.write(`${message}\n`);
 return process.exit(1);
}
const [file] = process.argv.slice(2);
if (!file) fail('Uso: npx tsx tools/replay.ts <arquivo-do-cenário>');
let raw: string;
try {raw = readFileSync(file, 'utf8');} catch {fail(`Não foi possível ler o cenário: ${file}`);}
try {process.stdout.write(canonicalJson(replayScenario(JSON.parse(raw))));} catch (error) {
 fail(`Cenário inválido: ${error instanceof Error ? error.message : String(error)}`);
}
