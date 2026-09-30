// The explorer profile (spec §6.1.7, §4 of docs/world-protocol.md): a second game on the same entities and places. It
// owns its own namespaces, and every change it makes enters the world through the same door as anybody else's — the
// core's ordinary commands, with sequence, revision, atomicity and deduplication — so a profile can never reach into
// another profile's fields by writing them directly.
import type {BaseChunk,Command,Components,GameState} from '../../core/model';
import {applyCommand} from '../../core/commands';
import type {ExtensionDeclaration} from '../../core/protocol';
import {isEntityId} from '../../core/protocol';
import {POPULATION_NAMESPACE} from '../../world/materialization';
import type {WorldResult} from '../../world/model';
import {failed,ok} from '../../world/model';

export const EXPLORER_ACTOR = 'explorer';
export const EXPLORER_RULES: {family: string; version: number} = {family:'explorer',version:1};
// What this profile writes: the detail of a person it materialized, a vehicle it keeps, and the movement of both. The
// movement is declared ephemeral, because a walker crossing the square is not history (spec §7.3, protocol §24).
export const EXPLORER_EXTENSIONS: readonly ExtensionDeclaration[] = [
 {key:'x.explorer.character',version:1,durable:true},
 {key:'x.explorer.vehicle',version:1,durable:true},
 {key:'x.explorer.motion',version:1,durable:false},
];
// The population contract and the core vocabulary are shared with the city, so both write them: everything else has to
// be declared by this profile before it can be touched.
const SHARED: readonly string[] = [POPULATION_NAMESPACE,'osim.transform','osim.existence','osim.name'];
export function writableByExplorer(key: string): boolean {
 return SHARED.includes(key) || EXPLORER_EXTENSIONS.some(extension => extension.key === key);
}

// Writing is all-or-nothing: the commands are applied to a state this function discards unless every one of them is
// accepted, so a refused component leaves no half-saved character behind.
export function applyExplorerWrites(
 state: GameState,
 components: Components,
 actorId = EXPLORER_ACTOR,
 available: readonly BaseChunk[] = [],
): WorldResult<GameState> {
 for (const key of Object.keys(components)) {
  if (!writableByExplorer(key)) return failed('PERMISSION',`O perfil explorador não declara o namespace ${key}`);
 }
 let next = state;
 for (const key of Object.keys(components).sort()) {
  const namespace = components[key]!;
  for (const entity of Object.keys(namespace).sort()) {
   if (!isEntityId(entity)) return failed('MALFORMED',`Identificador inválido no componente ${key}: ${entity}`);
   const command: Command = {
    version:1,
    worldId:next.worldId,
    actorId,
    sequence:(next.actors[actorId] ?? 0) + 1,
    expectedRevision:next.revision,
    action:{type:'component',key,entity,value:namespace[entity]},
   };
   const result = applyCommand(next,command,available);
   if (result.status !== 'applied') return failed('CONFLICT',`O perfil explorador não conseguiu escrever ${key}/${entity}: ${result.reason ?? result.status}`);
   next = result.state;
  }
 }
 return ok(next);
}
