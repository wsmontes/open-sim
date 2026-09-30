import type {BaseChunk,SavedGame} from '../core/model';
// Two levels of the same provider: 'detail' carries buildings and everything the economy can adopt, while
// 'overview' is a coarser tile of the same place (water, land use, main roads) used to paint a wide view at once
// before the detail arrives. The source only promises what a level actually carries.
export type MapLevel = 'detail' | 'overview';
export interface MapSource {
 loadChunk(id: string, level?: MapLevel): Promise<BaseChunk>;
 attribution: { text: string; url: string };
}
export interface SaveStore {
 read(slot: string): Promise<unknown | null>;
 write(slot: string, data: SavedGame): Promise<void>;
}
export type ChunkStatus =
 | { status: 'loading'; level: MapLevel }
 | { status: 'ready'; base: BaseChunk; level: MapLevel }
 | { status: 'error'; message: string };
