// Comparing two versions of the same place (spec §5.2 "Comparar", §5.4). A difference carries where it came from: the
// frozen data a provider published, the overlay a player decided, the simulation, or the metadata of the version
// itself. Keeping those apart is the whole point — a cell a later capture drew can never be presented as work somebody
// did here, and a player's park can never pass as provider data.
import type {Cell,ManagedChunk,Tool} from '../core/model';
import type {ObjectRef,JsonValue} from '../world/model';
import type {Checkpoint} from '../session/world-repository';
import {CITY_PROFILE} from '../world/city-profile';
import {sameCell,sameJson} from '../world/changes';
import {coordAt} from '../core/coordinates';

export type VersionSide={worldId:string;branchId:string;commit:ObjectRef;generation:number};
export type DiffPlace={chunkId:string;index:number;x:number;y:number};
export type DiffLayer='real'|'player';
export type CellDifference={at:DiffPlace;layer:DiffLayer;origin?:Cell['origin'];opaque:boolean;before?:Cell;after?:Cell};
// A region that exists only on one side is reported as such: its whole terrain is not enumerated cell by cell, because
// the region appearing (or leaving) is the difference, and only the overlay it brought is listed.
export type RegionDifference={
 chunkId:string;
 added:boolean;
 removed:boolean;
 baseChanged:boolean;
 source:string;
 cells:readonly CellDifference[];
 real:number;
 player:number;
};
export type FieldDelta<T>={before:T;after:T};
export type ActorDelta={actorId:string;before:number;after:number};
export type ComponentDelta={key:string;entity:string;kind:'added'|'removed'|'changed'};
export type WorldDiff={
 base:VersionSide;
 other:VersionSide;
 regions:readonly RegionDifference[];
 counts:{real:number;player:number;simulation:number;metadata:number};
 summary:{added:number;removed:number;changed:number};
 simulation:{money:FieldDelta<number>;tick:FieldDelta<number>;revision:FieldDelta<number>};
 metadata:{worldId:FieldDelta<string>;seed:FieldDelta<number>;rules:FieldDelta<string>;revision:FieldDelta<number>;actors:readonly ActorDelta[];components:readonly ComponentDelta[]};
 // What the player differences would cost to redo through the profile's own price table. It is an estimate for the
 // review; the authoritative quote of a project comes from `prepareProject`.
 estimate:{cost:number;built:number;removed:number};
};

const sideOf=(checkpoint:Checkpoint):VersionSide=>({worldId:checkpoint.head.worldId,branchId:checkpoint.head.branchId,commit:checkpoint.head.commit,generation:checkpoint.head.generation});
function placeOf(chunkId:string,index:number):DiffPlace{
 try{const at=coordAt(chunkId,index);return {chunkId,index,x:at.x,y:at.y};}
 catch{return {chunkId,index,x:0,y:0};}
}
function difference(chunkId:string,index:number,was:Cell|undefined,now:Cell|undefined,layer:DiffLayer,origin:Cell['origin']|undefined,opaque:boolean):CellDifference{
 const found:CellDifference={at:placeOf(chunkId,index),layer,opaque};
 if(origin!==undefined)found.origin=origin;
 if(was)found.before=was;
 if(now)found.after=now;
 return found;
}
// An overlay difference belongs to the layer that painted it: a cell the provider imported inside the overlay is real
// data, a cell a player decided is their work, and one with no declared origin is reported opaque instead of being
// attributed to either side.
function overlayDifference(chunkId:string,index:number,was:Cell|undefined,now:Cell|undefined):CellDifference{
 const marker=now?.origin??was?.origin;
 return difference(chunkId,index,was,now,marker==='imported'?'real':'player',marker,marker===undefined);
}
const editIndexes=(...chunks:readonly ManagedChunk[]):number[]=>{
 const indexes=new Set<number>();
 for(const chunk of chunks)for(const key of Object.keys(chunk.edits))indexes.add(Number(key));
 return [...indexes].sort((a,b)=>a-b);
};
const toolOf=(cell:Cell|undefined):Tool|null=>cell?.road?(cell.roadClass==='avenue'?'avenue':cell.roadClass==='highway'?'highway':'road'):(cell?.building??null);
const compareChunks=(a:string,b:string)=>(Number(a.split(':')[0])-Number(b.split(':')[0]))||(Number(a.split(':')[1])-Number(b.split(':')[1]));
const jsonValue=(value:unknown):JsonValue=>value as JsonValue;

export function diffWorlds(base:Checkpoint,other:Checkpoint):WorldDiff{
 const regions:RegionDifference[]=[];
 const ids=[...new Set([...Object.keys(base.state.chunks),...Object.keys(other.state.chunks)])].sort(compareChunks);
 for(const chunkId of ids){
  const was=base.state.chunks[chunkId],now=other.state.chunks[chunkId];
  const cells:CellDifference[]=[];
  if(was&&now){
   for(let index=0;index<was.base.cells.length;index++){
    const before=was.base.cells[index],after=now.base.cells[index];
    if(before&&after&&!sameCell(before,after))cells.push(difference(chunkId,index,before,after,'real',after.origin??before.origin,false));
   }
   for(const index of editIndexes(was,now)){
    const before=was.edits[String(index)]??was.base.cells[index],after=now.edits[String(index)]??now.base.cells[index];
    if(before&&after&&!sameCell(before,after))cells.push(overlayDifference(chunkId,index,before,after));
   }
  }else if(now){
   // A region only the other version has: what the overlay declared, layer by layer.
   for(const index of editIndexes(now)){const cell=now.edits[String(index)];if(cell)cells.push(overlayDifference(chunkId,index,undefined,cell));}
  }else if(was){
   for(const index of editIndexes(was)){const cell=was.edits[String(index)];if(cell)cells.push(overlayDifference(chunkId,index,cell,undefined));}
  }
  const added=!was&&!!now,removed=!!was&&!now;
  const baseChanged=!!was&&!!now&&(was.base.source!==now.base.source||was.base.normalizerVersion!==now.base.normalizerVersion||cells.some(cell=>cell.layer==='real'));
  if(!cells.length&&!added&&!removed&&!baseChanged)continue;
  const present=now??was!;
  regions.push({
   chunkId,added,removed,baseChanged,source:present.base.source,cells,
   real:cells.filter(cell=>cell.layer==='real').length,
   player:cells.filter(cell=>cell.layer==='player').length,
  });
 }
 const real=regions.reduce((sum,region)=>sum+region.real,0);
 const player=regions.reduce((sum,region)=>sum+region.player,0);
 const actors:ActorDelta[]=[];
 for(const actorId of [...new Set([...Object.keys(base.state.actors),...Object.keys(other.state.actors)])].sort()){
  const before=base.state.actors[actorId]??0,after=other.state.actors[actorId]??0;
  if(before!==after)actors.push({actorId,before,after});
 }
 const components:ComponentDelta[]=[];
 const namespaces=[...new Set([...Object.keys(base.state.components),...Object.keys(other.state.components)])].sort();
 for(const key of namespaces){
  const before=base.state.components[key]??{},after=other.state.components[key]??{};
  for(const entity of [...new Set([...Object.keys(before),...Object.keys(after)])].sort()){
   const was=before[entity],now=after[entity];
   if(was===undefined&&now===undefined)continue;
   if(was===undefined)components.push({key,entity,kind:'added'});
   else if(now===undefined)components.push({key,entity,kind:'removed'});
   else if(!sameJson(jsonValue(was),jsonValue(now)))components.push({key,entity,kind:'changed'});
  }
 }
 const simulation={money:{before:base.state.money,after:other.state.money},tick:{before:base.state.tick,after:other.state.tick},revision:{before:base.state.revision,after:other.state.revision}};
 const metadata={
  worldId:{before:base.head.worldId,after:other.head.worldId},
  seed:{before:base.state.seed,after:other.state.seed},
  rules:{before:`${base.definition.rules.family} v${base.definition.rules.version}`,after:`${other.definition.rules.family} v${other.definition.rules.version}`},
  revision:{before:base.state.revision,after:other.state.revision},
  actors,components,
 };
 const fields=(counts:readonly boolean[])=>counts.filter(Boolean).length;
 const counts={
  real,player,
  simulation:fields([simulation.money.before!==simulation.money.after,simulation.tick.before!==simulation.tick.after]),
  metadata:fields([
   metadata.worldId.before!==metadata.worldId.after,metadata.seed.before!==metadata.seed.after,
   metadata.rules.before!==metadata.rules.after,metadata.revision.before!==metadata.revision.after,
  ])+actors.length+components.length,
 };
 let cost=0,built=0,removed=0;
 for(const region of regions)for(const cells of region.cells){
  if(cells.layer!=='player')continue;
  const gained=toolOf(cells.after),lost=toolOf(cells.before);
  if(gained&&gained!==lost){built+=1;cost+=CITY_PROFILE.costs[gained];}
  if(lost&&!gained){removed+=1;cost+=CITY_PROFILE.costs.demolish;}
 }
 return {
  base:sideOf(base),other:sideOf(other),regions,counts,
  summary:{added:regions.filter(region=>region.added).length,removed:regions.filter(region=>region.removed).length,changed:regions.filter(region=>!region.added&&!region.removed).length},
  simulation,metadata,estimate:{cost,built,removed},
 };
}
