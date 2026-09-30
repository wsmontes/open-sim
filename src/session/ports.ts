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
// What a device reports about what it has already written (spec §6.3). The local session's own save status satisfies
// `PersistenceReport`, so a live session reports the same words without the presentation layer importing the session
// implementation: one vocabulary for "salvando", "salvo neste dispositivo" and the failure that is not a save.
export type PersistenceState = 'unsaved' | 'saving' | 'saved' | 'error';
export type PersistenceStatus = { state: PersistenceState; message: string; blocked: boolean };
export type PersistenceReport = { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string; blocked: boolean };
export function persistenceOf(report: PersistenceReport): PersistenceStatus {
 return { state: report.status === 'idle' ? 'unsaved' : report.status, message: report.message ?? '', blocked: report.blocked };
}
