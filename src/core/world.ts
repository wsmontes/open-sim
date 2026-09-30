import type {BaseChunk,Cell,CellCoord,GameState,ManagedChunk} from './model';
import {cellIndex,chunkId} from './coordinates';
export const occupied = (c:Cell) => !!c.building && c.building!=='park' && c.building!=='power' && (c.stage??0)>0;
export function cellEconomy(c:Cell){return (occupied(c)?({residential:4,commercial:6,industrial:8,park:0,power:0}[c.building!]):0)-(c.road?1:0)-(c.building==='park'?2:0)-(c.building==='power'?20:0);}
export function adopt(base:BaseChunk):ManagedChunk{return {base,edits:{},baseEnergy:base.cells.filter(occupied).length*2,balanceAdjustment:-base.cells.reduce((sum,c)=>sum+cellEconomy(c),0)};}
export function getCell(s:GameState,p:CellCoord):Cell|undefined{const chunk=s.chunks[chunkId(p)];return chunk ? chunk.edits[cellIndex(p)]??chunk.base.cells[cellIndex(p)]:undefined;}
export function effectiveCells(chunk:ManagedChunk):Cell[]{return chunk.base.cells.map((c,i)=>chunk.edits[i]??c);}
