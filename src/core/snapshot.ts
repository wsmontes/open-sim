import type {BaseChunk,Cell,Components,GameState,ManagedChunk,SavedGame,ViewState} from './model';
import {CHUNK,chunkOrigin} from './coordinates';
import {FORMAT_VERSION,RULES_VERSION,VIEW_ZOOM_MAX,VIEW_ZOOM_MIN} from './model';
import {assertJsonSafe,canonicalJson,cloneJson,isComponentKey,isEntityId} from './protocol';
import {isPlainObject,RESERVED_KEYS as RESERVED} from './guards';
export const SAVE_VERSION = 1;
const TERRAIN = ['land','water','green'];
const BUILDINGS = ['residential','commercial','industrial','park','power'];
const ROAD_CLASSES = ['street','avenue','highway'];
const ORIGINS = ['imported','player'];
export function encodeSave(value: SavedGame): string {return canonicalJson(value);}
export function decodeSave(value: unknown): SavedGame {
 let raw = value;
 if (typeof raw === 'string') {try {raw = JSON.parse(raw);} catch {throw new Error('Save ilegível');}}
 if (!isPlainObject(raw)) throw new Error('Save inválido');
 if (raw.version !== SAVE_VERSION) throw new Error('Versão de save desconhecida');
 return {...extras(raw,['version','state','view']), version:1, state:gameState(raw.state), view:viewState(raw.view)};
}
// Anything this client does not implement is carried through untouched: another profile's fields must survive a
// load-and-save cycle here, which is what lets two clients share one world without agreeing on every component.
function extras(source: Record<string,unknown>, known: readonly string[]): Record<string,unknown> {
 const kept: Record<string,unknown> = {};
 for (const key of Object.keys(source)) {
  if (RESERVED.includes(key)) throw new Error(`Campo reservado: ${key}`);
  if (known.includes(key)) continue;
  assertJsonSafe(source[key], `Campo ${key}`);
  kept[key] = cloneJson(source[key]);
 }
 return kept;
}
function components(value: unknown): Components {
 if (!isPlainObject(value)) throw new Error('Componentes inválidos');
 const rebuilt: Components = {};
 for (const key of Object.keys(value)) {
  if (!isComponentKey(key)) throw new Error(`Namespace inválido: ${key}`);
  const namespace = value[key];
  if (!isPlainObject(namespace)) throw new Error(`Namespace inválido: ${key}`);
  const entities: Record<string,unknown> = {};
  for (const entity of Object.keys(namespace)) {
   if (!isEntityId(entity)) throw new Error(`Identificador inválido: ${entity}`);
   assertJsonSafe(namespace[entity], `Componente ${key}/${entity}`);
   entities[entity] = cloneJson(namespace[entity]);
  }
  rebuilt[key] = entities;
 }
 return rebuilt;
}
function safeCount(value: unknown, label: string): number {
 if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} inválido`);
 return value as number;
}
function safeInteger(value: unknown, label: string): number {
 if (!Number.isSafeInteger(value)) throw new Error(`${label} inválido`);
 return value as number;
}
function cell(value: unknown, label: string): Cell {
 if (!isPlainObject(value)) throw new Error(`${label}: célula inválida`);
 if (!TERRAIN.includes(value.terrain as string)) throw new Error(`${label}: terreno inválido`);
 if (value.road !== undefined && typeof value.road !== 'boolean') throw new Error(`${label}: via inválida`);
 if (value.roadClass !== undefined && !ROAD_CLASSES.includes(value.roadClass as string)) throw new Error(`${label}: classe de via inválida`);
 if (value.roadClass !== undefined && value.road !== true) throw new Error(`${label}: classe de via sem via`);
 if (value.building !== undefined && !BUILDINGS.includes(value.building as string)) throw new Error(`${label}: ocupação inválida`);
 if (value.stage !== undefined && (!Number.isSafeInteger(value.stage) || (value.stage as number) < 0 || (value.stage as number) > 8)) throw new Error(`${label}: estágio inválido`);
 if (value.origin !== undefined && !ORIGINS.includes(value.origin as string)) throw new Error(`${label}: origem inválida`);
 const rebuilt: Cell = {terrain:value.terrain as Cell['terrain']};
 if (value.road !== undefined) rebuilt.road = value.road as boolean;
 if (value.roadClass !== undefined) rebuilt.roadClass = value.roadClass as NonNullable<Cell['roadClass']>;
 if (value.building !== undefined) rebuilt.building = value.building as NonNullable<Cell['building']>;
 if (value.stage !== undefined) rebuilt.stage = value.stage as number;
 if (value.origin !== undefined) rebuilt.origin = value.origin as NonNullable<Cell['origin']>;
 return {...extras(value,['terrain','road','roadClass','building','stage','origin']), ...rebuilt} as Cell;
}
function managedChunk(id: string, value: unknown): ManagedChunk {
 try {chunkOrigin(id);} catch {throw new Error('Endereço de trecho inválido');}
 if (!isPlainObject(value)) throw new Error('Trecho inválido');
 const base = value.base, edits = value.edits;
 if (!isPlainObject(base) || base.id !== id) throw new Error('Base do trecho não corresponde ao endereço');
 if (base.normalizerVersion !== 1) throw new Error('Versão do normalizador desconhecida');
 if (typeof base.source !== 'string' || !base.source) throw new Error('Fonte do trecho inválida');
 if (!Array.isArray(base.cells) || base.cells.length !== CHUNK * CHUNK) throw new Error('Trecho deve ter 1024 células');
 if (!isPlainObject(edits)) throw new Error('Edições do trecho inválidas');
 const rebuilt: Record<string,Cell> = {};
 for (const key of Object.keys(edits)) {
  if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= CHUNK * CHUNK || RESERVED.includes(key)) throw new Error('Índice de edição inválido');
  rebuilt[key] = cell(edits[key], `Edição ${key}`);
 }
 const frozen: BaseChunk = {id, source:base.source, normalizerVersion:1, cells:base.cells.map((c,i)=>cell(c,`Célula ${i}`))};
 return {...extras(value,['base','edits','baseEnergy','balanceAdjustment']), base:{...extras(base,['id','source','normalizerVersion','cells']), ...frozen}, edits:rebuilt, baseEnergy:safeCount(value.baseEnergy,'Energia de base'), balanceAdjustment:safeInteger(value.balanceAdjustment,'Ajuste de saldo')};
}
function actors(value: unknown): Record<string,number> {
 if (!isPlainObject(value)) throw new Error('Atores inválidos');
 const rebuilt: Record<string,number> = {};
 for (const key of Object.keys(value)) {
  if (!/^[-\w]{1,80}$/.test(key) || RESERVED.includes(key)) throw new Error(`Ator inválido: ${key}`);
  rebuilt[key] = safeCount(value[key],'Contador de ator');
 }
 return rebuilt;
}
function chunks(value: unknown): Record<string,ManagedChunk> {
 if (!isPlainObject(value)) throw new Error('Trechos inválidos');
 const rebuilt: Record<string,ManagedChunk> = {};
 for (const id of Object.keys(value)) rebuilt[id] = managedChunk(id, value[id]);
 return rebuilt;
}
// The rules a save may have been written under and still be opened: everything the game itself has run. A world is the
// same shape under them, so an older save is stamped with what the rules mean today and starts behaving like every
// other city — the same way a game update migrates what a player had. An unknown *future* version is refused rather
// than guessed at, and a branch written under other rules stays refused by the sessions that would have to share it.
const OPENABLE_RULES: readonly number[] = [1, RULES_VERSION];
function gameState(value: unknown): GameState {
 if (!isPlainObject(value)) throw new Error('Estado inválido');
 if (value.formatVersion !== 1) throw new Error('Versão de formato desconhecida');
 if (typeof value.rulesVersion !== 'number' || !OPENABLE_RULES.includes(value.rulesVersion)) throw new Error('Versão de regras desconhecida');
 if (typeof value.worldId !== 'string' || !value.worldId.length || value.worldId.length > 80) throw new Error('Mundo inválido');
 return {...extras(value,['formatVersion','rulesVersion','worldId','seed','revision','tick','money','chunks','actors','components']), formatVersion:FORMAT_VERSION as 1, rulesVersion:RULES_VERSION as 3, worldId:value.worldId, seed:safeInteger(value.seed,'Semente'), revision:safeCount(value.revision,'Revisão'), tick:safeCount(value.tick,'Relógio'), money:safeCount(value.money,'Saldo'), chunks:chunks(value.chunks), actors:actors(value.actors), components:components(value.components ?? {})};
}
function viewState(value: unknown): ViewState {
 if (!isPlainObject(value)) throw new Error('Visão inválida');
 if (typeof value.place !== 'string') throw new Error('Lugar inválido');
 if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('Posição da câmera inválida');
 if (!Number.isFinite(value.zoom) || (value.zoom as number) < VIEW_ZOOM_MIN || (value.zoom as number) > VIEW_ZOOM_MAX) throw new Error('Zoom inválido');
 if (value.speed !== 0 && value.speed !== 1 && value.speed !== 2) throw new Error('Velocidade inválida');
 return {...extras(value,['x','y','zoom','speed','place','rotation']), x:value.x as number, y:value.y as number, zoom:value.zoom as number, speed:value.speed as ViewState['speed'], place:value.place, rotation:viewRotation(value.rotation)};
}
// Saves written before the view could be turned carry no bearing at all and simply mean north up. A stored one has to
// be a real bearing inside (-PI, PI]. The camera folds its angles into that same window, but running the fold again
// here would add a rounding step and make a stored angle wobble on every save, so an angle already in range survives
// untouched (only -PI folds to PI, and -0 to 0, which is the one canonical form pair the window has).
function viewRotation(value: unknown): number {
 if (value === undefined) return 0;
 if (typeof value !== 'number' || !Number.isFinite(value) || value < -Math.PI || value > Math.PI) throw new Error('Rotação inválida');
 return value === -Math.PI ? Math.PI : value + 0;
}
