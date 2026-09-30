import type { BaseChunk, Cell, Command, GameState } from '../../src/core/model';
export const blank = (id = '0:0'): BaseChunk => ({ id, source: 'synthetic-test', normalizerVersion: 1, cells: Array.from({length:1024}, (): Cell => ({terrain:'land'})) });
export const command = (state: GameState, action: Command['action']): Command => ({version:1, worldId:state.worldId,actorId:'local-player',sequence:(state.actors['local-player'] ?? 0)+1,expectedRevision:state.revision,action});
