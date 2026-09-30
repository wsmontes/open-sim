// The reference explorer (spec §6.1.7; §4 of docs/world-protocol.md). A second profile opens a world the city exported,
// materializes people out of the aggregate, keeps its own detail about them and hands the world back — without
// importing one line of the city's user interface, of the browser or of the presentation layer.
//
// It never invents an address. The bundle's objects keep the addresses they were read with, and what this profile
// decided is returned in the preserved extension space: the caller publishes it through the profile's own commands and
// commits it, because owning bytes, receipts and head is the repository's job and not a profile's (spec §9.2).
import type {Components,GameState} from '../../core/model';
import {assertJsonSafe,isEntityId} from '../../core/protocol';
import type {MaterializeRequest,SharedPopulation} from '../../world/materialization';
import {dematerialize,materialize,populationChanges,populationOf} from '../../world/materialization';
import type {WorldBundle,WorldResult} from '../../world/model';
import {failed,ok} from '../../world/model';
import {EXPLORER_RULES,writableByExplorer} from './commands';

export type ExplorerAction =
 | ({type:'materialize'} & MaterializeRequest)
 | {type:'dematerialize';characters:readonly string[]}
 | {type:'write';key:string;entity:string;value:unknown};
// What the explorer decided, in the bundle's extension space: the components the caller has to publish, and the record
// of what was done. `components` includes the population reservation and the core components of every character, so a
// city that understands none of this profile still reads 60 people and four entities.
export type ExplorerPending = {
 profile:{family:string;version:number};
 components:Components;
 records:readonly string[];
};
export const EXPLORER_PENDING = 'x.explorer.pending';
// The rules this profile knows how to write against. Another family is read, never written: a world under rules nobody
// here implements is a world this profile can open its eyes on and nothing more.
const CITY_RULES = {family:'city',version:1};
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
// The place a version points at, read the way any other client reads it: the bundle carries values, and the one that
// declares a city state is the one this profile may change. Exported because a caller that only wants to look at the
// world asks the same question `runExplorer` does.
export function explorerState(bundle: WorldBundle): GameState | null {
 for (const object of bundle.objects) {
  if (!record(object.value) || object.value['kind'] !== 'city-state') continue;
  const state = record(object.value['state']) ? object.value['state'] as Record<string, unknown> : null;
  if (!state || state['worldId'] !== bundle.definition.worldId || typeof state['revision'] !== 'number') return null;
  return object.value['state'] as unknown as GameState;
 }
 return null;
}
const pendingValue = (pending: ExplorerPending): Record<string, unknown> => ({
 profile:{family:pending.profile.family,version:pending.profile.version},
 components:{...pending.components},
 records:[...pending.records],
});

export function runExplorer(bundle: WorldBundle,actions: readonly ExplorerAction[]): WorldResult<WorldBundle> {
 const state = explorerState(bundle);
 if (!state) return failed('NOT_FOUND','O pacote não carrega um estado de cidade que este perfil saiba abrir');
 // Reading a world is not writing in it: opening one is always possible, and the rules below decide whether this
 // profile may change it.
 if (!actions.length) return ok(bundle);
 const rules = bundle.definition.rules;
 if (rules.family !== CITY_RULES.family || rules.version !== CITY_RULES.version) {
  return failed('WORLD_PROTOCOL_UNSUPPORTED',`O pacote roda ${rules.family} v${rules.version} e este explorador implementa ${CITY_RULES.family} v${CITY_RULES.version}: este mundo entra como leitura, sem escrita`);
 }
 const opened: SharedPopulation = populationOf(state);
 let population = opened;
 const writes: Components = {}, records: string[] = [];
 for (const action of actions) {
  if (action.type === 'materialize') {
   const reserved = materialize(population,action);
   if (!reserved.ok) return reserved;
   population = reserved.value;
   records.push(`materialize:${action.id}@${action.cell}#${action.count}`);
   continue;
  }
  if (action.type === 'dematerialize') {
   const returned = dematerialize(population,action.characters);
   if (!returned.ok) return returned;
   population = returned.value;
   records.push(`dematerialize:${action.characters.length}`);
   continue;
  }
  if (!writableByExplorer(action.key)) return failed('PERMISSION',`O perfil explorador não declara o namespace ${action.key}`);
  if (!isEntityId(action.entity)) return failed('MALFORMED',`Identificador inválido no componente ${action.key}: ${action.entity}`);
  try {
   assertJsonSafe(action.value,`O componente ${action.key}`);
  } catch (error) {
   return failed('MALFORMED',error instanceof Error ? error.message : `O componente ${action.key} é inválido`);
  }
  writes[action.key] = {...(writes[action.key] ?? {}),[action.entity]:action.value};
  records.push(`write:${action.key}@${action.entity}`);
 }
 // What the caller has to publish: the difference this profile made to the shared population (including the people it
 // returned) and its own additive namespaces.
 const components: Components = {...populationChanges(opened,population)};
 for (const key of Object.keys(writes).sort()) components[key] = {...(components[key] ?? {}),...writes[key]!};
 // Reading is not writing: a visit that changed nothing hands the package back exactly as it arrived.
 if (!records.length) return ok(bundle);
 const pending: ExplorerPending = {profile:{...EXPLORER_RULES},components,records};
 try {
  assertJsonSafe(pendingValue(pending),'O que o explorador decidiu');
 } catch (error) {
  return failed('MALFORMED',error instanceof Error ? error.message : 'O que o explorador decidiu não é JSON simples');
 }
 // A definition names the profiles that took part. A package that already carries a head keeps the tree it came with,
 // so there the registration is what the caller commits; the characters themselves are state either way.
 const profiles = bundle.definition.profiles.includes(EXPLORER_RULES.family) ? bundle.definition.profiles : [...bundle.definition.profiles,EXPLORER_RULES.family];
 return ok({
  ...bundle,
  definition:{...bundle.definition,profiles},
  extensions:{...bundle.extensions,[EXPLORER_PENDING]:pendingValue(pending) as WorldBundle['extensions'][string]},
 });
}
export function explorerPending(bundle: WorldBundle): WorldResult<ExplorerPending> {
 const value = bundle.extensions[EXPLORER_PENDING];
 if (!record(value)) return failed('NOT_FOUND','Este pacote não traz o que o perfil explorador decidiu');
 const profile = record(value['profile']) ? value['profile'] as Record<string, unknown> : null;
 const components = record(value['components']) ? value['components'] : null;
 if (!profile || typeof profile['family'] !== 'string' || !Number.isSafeInteger(profile['version']) || !components) return failed('MALFORMED','O que o explorador decidiu está incompleto');
 const namespaces: Components = {};
 for (const key of Object.keys(components)) {
  const namespace = record(components[key]) ? components[key] as Record<string, unknown> : null;
  if (!namespace || !writableByExplorer(key)) return failed('MALFORMED',`O explorador decidiu escrever ${key}, que não é dele`);
  namespaces[key] = {...namespace};
 }
 const records = Array.isArray(value['records']) && value['records'].every(entry => typeof entry === 'string') ? [...value['records']] as string[] : [];
 return ok({profile:{family:profile['family'],version:profile['version'] as number},components:namespaces,records});
}
