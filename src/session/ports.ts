import type {BaseChunk,SavedGame} from '../core/model';
export interface MapSource { loadChunk(id:string):Promise<BaseChunk>; attribution:{text:string;url:string} }
export interface SaveStore { read(slot:string):Promise<unknown|null>; write(slot:string,data:SavedGame):Promise<void> }
export type ChunkStatus = {status:'loading'} | {status:'ready';base:BaseChunk} | {status:'error';message:string};
