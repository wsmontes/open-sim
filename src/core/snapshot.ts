import type {BaseChunk,Cell,GameState,ManagedChunk,SavedGame,ViewState} from './model';
import {CHUNK,chunkOrigin} from './coordinates';
export const SAVE_VERSION = 1;
const RESERVED = ['__proto__','constructor','prototype'];
const TERRAIN = ['land','water','green'];
const BUILDINGS = ['residential','commercial','industrial','park','power'];
const ORIGINS = ['imported','player'];
const plain = (value: unknown): value is Record<string,unknown> => {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const proto = Object.getPrototypeOf(value) as unknown;
 return proto === Object.prototype || proto === null;
};
export function encodeSave(value: SavedGame): string {return canonicalJson(value);}
// Object keys sorted, no whitespace, trailing newline: the same text for the same value in any runtime.
export function canonicalJson(value: unknown): string {return canonical(value) + '\n';}
function canonical(value: unknown): string {
 if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
 if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if (typeof value === 'object') {
  const source = value as Record<string,unknown>;
  return `{${Object.keys(source).filter(k=>source[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonical(source[k])}`).join(',')}}`;
 }
 throw new Error('Valor não serializável');
}
export function decodeSave(value: unknown): SavedGame {
 let raw = value;
 if (typeof raw === 'string') {try {raw = JSON.parse(raw);} catch {throw new Error('Save ilegível');}}
 if (!plain(raw)) throw new Error('Save inválido');
 if (raw.version !== SAVE_VERSION) throw new Error('Versão de save desconhecida');
 return {version:1, state:gameState(raw.state), view:viewState(raw.view)};
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
 if (!plain(value)) throw new Error(`${label}: célula inválida`);
 if (!TERRAIN.includes(value.terrain as string)) throw new Error(`${label}: terreno inválido`);
 if (value.road !== undefined && typeof value.road !== 'boolean') throw new Error(`${label}: via inválida`);
 if (value.building !== undefined && !BUILDINGS.includes(value.building as string)) throw new Error(`${label}: ocupação inválida`);
 if (value.stage !== undefined && (!Number.isSafeInteger(value.stage) || (value.stage as number) < 0 || (value.stage as number) > 8)) throw new Error(`${label}: estágio inválido`);
 if (value.origin !== undefined && !ORIGINS.includes(value.origin as string)) throw new Error(`${label}: origem inválida`);
 const rebuilt: Cell = {terrain:value.terrain as Cell['terrain']};
 if (value.road !== undefined) rebuilt.road = value.road as boolean;
 if (value.building !== undefined) rebuilt.building = value.building as NonNullable<Cell['building']>;
 if (value.stage !== undefined) rebuilt.stage = value.stage as number;
 if (value.origin !== undefined) rebuilt.origin = value.origin as NonNullable<Cell['origin']>;
 return rebuilt;
}
function managedChunk(id: string, value: unknown): ManagedChunk {
 try {chunkOrigin(id);} catch {throw new Error('Endereço de trecho inválido');}
 if (!plain(value)) throw new Error('Trecho inválido');
 const base = value.base, edits = value.edits;
 if (!plain(base) || base.id !== id) throw new Error('Base do trecho não corresponde ao endereço');
 if (base.normalizerVersion !== 1) throw new Error('Versão do normalizador desconhecida');
 if (typeof base.source !== 'string' || !base.source) throw new Error('Fonte do trecho inválida');
 if (!Array.isArray(base.cells) || base.cells.length !== CHUNK * CHUNK) throw new Error('Trecho deve ter 1024 células');
 if (!plain(edits)) throw new Error('Edições do trecho inválidas');
 const rebuilt: Record<string,Cell> = {};
 for (const key of Object.keys(edits)) {
  if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= CHUNK * CHUNK || RESERVED.includes(key)) throw new Error('Índice de edição inválido');
  rebuilt[key] = cell(edits[key], `Edição ${key}`);
 }
 const frozen: BaseChunk = {id, source:base.source, normalizerVersion:1, cells:base.cells.map((c,i)=>cell(c,`Célula ${i}`))};
 return {base:frozen, edits:rebuilt, baseEnergy:safeCount(value.baseEnergy,'Energia de base'), balanceAdjustment:safeInteger(value.balanceAdjustment,'Ajuste de saldo')};
}
function actors(value: unknown): Record<string,number> {
 if (!plain(value)) throw new Error('Atores inválidos');
 const rebuilt: Record<string,number> = {};
 for (const key of Object.keys(value)) {
  if (!/^[-\w]{1,80}$/.test(key) || RESERVED.includes(key)) throw new Error(`Ator inválido: ${key}`);
  rebuilt[key] = safeCount(value[key],'Contador de ator');
 }
 return rebuilt;
}
function chunks(value: unknown): Record<string,ManagedChunk> {
 if (!plain(value)) throw new Error('Trechos inválidos');
 const rebuilt: Record<string,ManagedChunk> = {};
 for (const id of Object.keys(value)) rebuilt[id] = managedChunk(id, value[id]);
 return rebuilt;
}
function gameState(value: unknown): GameState {
 if (!plain(value)) throw new Error('Estado inválido');
 if (value.formatVersion !== 1) throw new Error('Versão de formato desconhecida');
 if (value.rulesVersion !== 1) throw new Error('Versão de regras desconhecida');
 if (typeof value.worldId !== 'string' || !value.worldId.length || value.worldId.length > 80) throw new Error('Mundo inválido');
 return {formatVersion:1, rulesVersion:1, worldId:value.worldId, seed:safeInteger(value.seed,'Semente'), revision:safeCount(value.revision,'Revisão'), tick:safeCount(value.tick,'Relógio'), money:safeCount(value.money,'Saldo'), chunks:chunks(value.chunks), actors:actors(value.actors)};
}
function viewState(value: unknown): ViewState {
 if (!plain(value)) throw new Error('Visão inválida');
 if (typeof value.place !== 'string') throw new Error('Lugar inválido');
 if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error('Posição da câmera inválida');
 if (!Number.isFinite(value.zoom) || (value.zoom as number) < 0.5 || (value.zoom as number) > 3) throw new Error('Zoom inválido');
 if (value.speed !== 0 && value.speed !== 1 && value.speed !== 2) throw new Error('Velocidade inválida');
 return {x:value.x as number, y:value.y as number, zoom:value.zoom as number, speed:value.speed as ViewState['speed'], place:value.place};
}
