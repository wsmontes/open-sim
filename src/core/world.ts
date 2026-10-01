import type {BaseChunk,Cell,CellCoord,GameState,ManagedChunk,Tool} from './model';
import {isRoadTool,roadToolClass} from './model';
import {ROAD_CLASS,roadClassOf} from './model';
import {cellIndex,chunkId} from './coordinates';
export const occupied = (c:Cell) => !!c.building && c.building!=='park' && c.building!=='power' && (c.stage??0)>0;
export function cellEconomy(c:Cell){
 // A road costs what its class costs to keep: an avenue is swept and lit like the street it replaced, a highway is a
 // piece of infrastructure the city pays for all month.
 return (occupied(c)?({residential:4,commercial:6,industrial:8,park:0,power:0}[c.building!]):0)
  -(c.road?ROAD_CLASS[roadClassOf(c)].upkeep:0)-(c.building==='park'?2:0)-(c.building==='power'?20:0);
}
// What a tool writes into a cell. One function, because the preview and the command have to agree down to the byte the
// world is hashed from: a preview that placed a slightly different cell would quote a city that does not exist.
export function placement(tool:Tool,terrain:Cell['terrain']):Cell {
 if(isRoadTool(tool)){
  const kind=roadToolClass(tool);
  // A street writes no class at all, which is what keeps every map and save written before the classes valid.
  return {terrain,road:true,...(kind==='street'?{}:{roadClass:kind}),origin:'player'};
 }
 return {terrain,building:tool,stage:tool==='park'||tool==='power'?1:0,origin:'player'};
}
export function adopt(base:BaseChunk):ManagedChunk{return {base,edits:{},baseEnergy:base.cells.filter(occupied).length*2,balanceAdjustment:-base.cells.reduce((sum,c)=>sum+cellEconomy(c),0)};}
export function getCell(s:GameState,p:CellCoord):Cell|undefined{const chunk=s.chunks[chunkId(p)];return chunk ? chunk.edits[cellIndex(p)]??chunk.base.cells[cellIndex(p)]:undefined;}
export function effectiveCells(chunk:ManagedChunk):Cell[]{return chunk.base.cells.map((c,i)=>chunk.edits[i]??c);}
