import type {GameState,SavedGame} from '../core/model';
import {WORLD_PROTOCOL, WIRE_VERSION, failed, ok} from '../world/model';
import type {DatasetTerm, JsonValue, WorldBundle, WorldResult} from '../world/model';
import type {ContentHasher, WorldCodec} from '../world/ports';

// Turning a local save into a portable world. The durable state becomes one addressed object; the camera stays behind
// (it is local, not shared, spec R11) and history starts here: this package does not reconstruct a past the save never
// recorded, so its origin says exactly that.
export async function importLegacy(
 save: SavedGame,
 hasher: ContentHasher,
 codec: WorldCodec,
 terms: readonly DatasetTerm[] = [],
): Promise<WorldResult<WorldBundle>> {
 const state = save.state;
 if (!Number.isSafeInteger(state.seed) || state.formatVersion !== 1) return failed('MALFORMED', 'Partida local inválida');
 const value: JsonValue = {kind: 'city-state', state: state as unknown as JsonValue};
 const ref = await hasher.ref(codec.encode(value));
 const bundle: WorldBundle = {
  envelope: {worldProtocol: WORLD_PROTOCOL, wireVersion: WIRE_VERSION, kind: 'bundle'},
  definition: {
   worldId: state.worldId,
   branchId: 'main',
   origin: {kind: 'legacy-save', note: 'A história começa aqui: o pacote não reconstrói um passado que o save não registrou.'},
   profiles: ['city'],
   rules: {family: 'city', version: state.rulesVersion},
  },
  objects: [{ref, value}],
  terms: terms.length ? [...terms] : sourcesOf(state).map(source => ({source})),
  completeness: {complete: true, missing: []},
  extensions: {},
 };
 return ok(bundle);
}
// The frozen bases remember which provider they came from; that is what a bundle can honestly claim before the
// capture task adds licence and attribution text.
function sourcesOf(state: GameState): string[] {
 const sources = new Set<string>();
 for (const id of Object.keys(state.chunks).sort()) sources.add(state.chunks[id]!.base.source);
 return [...sources];
}
