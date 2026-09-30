import {applyCommand,createGame} from './commands';
import type {BaseChunk,Command,GameState} from './model';
import {canonicalJson} from './snapshot';
import {CHUNK,chunkOrigin} from './coordinates';

// A scenario is a portable, re-executable document: initial chunk, seed and ordered
// commands must produce the same GameState in Node and in the browser.
// `worldId` is part of the format (the plan's sketch omitted it) because createGame
// needs one and every command envelope carries its own.
// Only the core is used here: no DOM, Node, HTTP or clock.
export type Scenario = { version: 1; worldId: string; seed: number; initial: BaseChunk; commands: Command[] };

const plain = (value: unknown): value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function initialChunk(value: unknown): BaseChunk {
 if (!plain(value)) throw new Error('Trecho inicial inválido');
 if (typeof value.id !== 'string' || !value.id.length) throw new Error('Trecho inicial sem identificador');
 if (value.normalizerVersion !== 1) throw new Error('Versão do normalizador desconhecida no trecho inicial');
 if (typeof value.source !== 'string' || !value.source.length) throw new Error('Trecho inicial sem fonte');
 try {chunkOrigin(value.id);} catch {throw new Error('Endereço do trecho inicial inválido');}
 if (!Array.isArray(value.cells) || value.cells.length !== CHUNK * CHUNK) throw new Error(`Trecho inicial deve ter ${CHUNK * CHUNK} células`);
 return value as unknown as BaseChunk;
}
function envelope(value: unknown, worldId: string, position: number): Command {
 const label = `Comando ${position + 1}`;
 if (!plain(value)) throw new Error(`${label}: envelope inválido`);
 if (value.version !== 1) throw new Error(`${label}: versão de comando não suportada`);
 if (value.worldId !== worldId) throw new Error(`${label}: mundo diferente de "${worldId}"`);
 if (typeof value.actorId !== 'string' || !value.actorId.length) throw new Error(`${label}: ator inválido`);
 if (!Number.isSafeInteger(value.sequence)) throw new Error(`${label}: sequência inválida`);
 if (!Number.isSafeInteger(value.expectedRevision)) throw new Error(`${label}: revisão esperada inválida`);
 if (!plain(value.action)) throw new Error(`${label}: ação inválida`);
 return value as unknown as Command;
}
export function replayScenario(scenario: unknown): GameState {
 if (!plain(scenario)) throw new Error('Cenário inválido');
 if (scenario.version !== 1) throw new Error(`Versão de cenário não suportada: ${String(scenario.version)}`);
 if (typeof scenario.worldId !== 'string' || !scenario.worldId.length) throw new Error('Cenário sem mundo');
 if (!Number.isSafeInteger(scenario.seed)) throw new Error('Semente do cenário inválida');
 if (!Array.isArray(scenario.commands)) throw new Error('Cenário sem lista de comandos');
 let state = createGame(scenario.worldId, scenario.seed as number, initialChunk(scenario.initial));
 for (let i = 0; i < scenario.commands.length; i++) {
  const command = envelope(scenario.commands[i], scenario.worldId, i);
  const result = applyCommand(state, command, []);
  // A resent envelope is tolerated: it changes nothing and is not charged again.
  if (result.status === 'duplicate') continue;
  if (result.status === 'rejected') throw new Error(`Comando ${i + 1} rejeitado: ${result.reason} (sequência ${command.sequence})`);
  state = result.state;
 }
 return state;
}
