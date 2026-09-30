import {expect,test} from 'vitest';
import {decodeSave,encodeSave} from '../src/core/snapshot';
import {applyCommand,createGame} from '../src/core/commands';
import {blank,command} from './fixtures/world';
import type {SavedGame} from '../src/core/model';
import {VIEW_ZOOM_MAX,VIEW_ZOOM_MIN} from '../src/core/model';
function saved():SavedGame{
 const b=blank();b.cells[0]={terrain:'land',road:true,origin:'imported'};b.cells[33]={terrain:'land',building:'residential',stage:2,origin:'imported'};
 const game=createGame('mundo',7,b);
 const built=applyCommand(game,command(game,{type:'build',tool:'park',cells:[{x:2,y:2}]}),[]).state;
 return {version:1,state:applyCommand(built,command(built,{type:'tick'}),[]).state,view:{x:12.5,y:-3.5,zoom:1.25,speed:1,place:'São Paulo'}};
}
test('encodeSave is canonical, stable, round trippable and never mutates',()=>{
 const x=saved(), before=encodeSave(x);
 expect(encodeSave(x)).toBe(before);
 expect(before.startsWith('{"state":')).toBe(true);
 expect(before.endsWith('\n')).toBe(true);
 expect(before).not.toContain(': ');
 const reordered:SavedGame={version:1,view:{zoom:x.view.zoom,speed:x.view.speed,place:x.view.place,y:x.view.y,x:x.view.x},state:x.state};
 expect(encodeSave(reordered)).toBe(before);
 const decoded=decodeSave(JSON.parse(before));
 expect(decoded).toEqual(x);
 expect(decodeSave(before)).toEqual(decoded);
 const aliases=decodeSave(before);
 aliases.state.money=1;aliases.state.chunks['0:0'].base.cells[0].terrain='water';aliases.state.chunks['0:0'].edits['66'].building='power';aliases.view.x=99;
 expect(encodeSave(x)).toBe(before);
});
test('decodeSave rejects every malformed snapshot',()=>{
 const rows:[string,(x:any)=>void][]=[
  ['unknown save version',x=>{x.version=2;}],
  ['unknown format version',x=>{x.state.formatVersion=2;}],
  ['unknown rules version',x=>{x.state.rulesVersion=0;}],
  ['missing state',x=>{delete x.state;}],
  ['missing view',x=>{delete x.view;}],
  ['view is not an object',x=>{x.view='nada';}],
  ['non finite money',x=>{x.state.money=NaN;}],
  ['negative money',x=>{x.state.money=-1;}],
  ['fractional money',x=>{x.state.money=1.5;}],
  ['empty world id',x=>{x.state.worldId='';}],
  ['long world id',x=>{x.state.worldId='m'.repeat(81);}],
  ['zoom out of range',x=>{x.view.zoom=9;}],
  ['tiny zoom',x=>{x.view.zoom=0.01;}],
  ['unknown speed',x=>{x.view.speed=3;}],
  ['infinite camera',x=>{x.view.x=Infinity;}],
  ['non finite seed',x=>{x.state.seed=NaN;}],
  ['fractional tick',x=>{x.state.tick=0.5;}],
  ['negative revision',x=>{x.state.revision=-1;}],
  ['short chunk',x=>{x.state.chunks['0:0'].base.cells=x.state.chunks['0:0'].base.cells.slice(0,1023);}],
  ['chunk key mismatch',x=>{x.state.chunks['9:9']=x.state.chunks['0:0'];}],
  ['malformed chunk key',x=>{x.state.chunks['zero']=x.state.chunks['0:0'];}],
  ['unknown normalizer version',x=>{x.state.chunks['0:0'].base.normalizerVersion=2;}],
  ['cell index out of range',x=>{x.state.chunks['0:0'].edits['1025']={terrain:'land'};}],
  ['junk cell index',x=>{x.state.chunks['0:0'].edits['1a']={terrain:'land'};}],
  ['reserved edit key',x=>{x.state.chunks['0:0'].edits['constructor']={terrain:'land'};}],
  ['unknown terrain',x=>{x.state.chunks['0:0'].base.cells[5]={terrain:'lava'};}],
  ['missing terrain',x=>{delete x.state.chunks['0:0'].base.cells[5].terrain;}],
  ['unknown building',x=>{x.state.chunks['0:0'].base.cells[5]={terrain:'land',building:'casino'};}],
  ['negative stage',x=>{x.state.chunks['0:0'].base.cells[5]={terrain:'land',building:'park',stage:-1};}],
  ['stage too high',x=>{x.state.chunks['0:0'].base.cells[5]={terrain:'land',building:'park',stage:9};}],
  ['unknown origin',x=>{x.state.chunks['0:0'].base.cells[5]={terrain:'land',origin:'alien'};}],
  ['non boolean road',x=>{x.state.chunks['0:0'].base.cells[5]={terrain:'land',road:1};}],
  ['reserved actor',x=>{x.state.actors={['__proto__']:1};}],
  ['negative actor counter',x=>{x.state.actors={'local-player':-1};}],
  ['fractional actor counter',x=>{x.state.actors={'local-player':0.5};}],
  ['non finite base energy',x=>{x.state.chunks['0:0'].baseEnergy=NaN;}],
  ['non finite balance adjustment',x=>{x.state.chunks['0:0'].balanceAdjustment=NaN;}],
  ['missing edits',x=>{delete x.state.chunks['0:0'].edits;}],
  ['map instead of chunks',x=>{x.state.chunks=new Map();}],
  ['set instead of edits',x=>{x.state.chunks['0:0'].edits=new Set();}],
  ['map instead of actors',x=>{x.state.actors=new Map();}],
  ['date instead of view',x=>{x.view=new Date();}],
  ['function field',x=>{x.view.place=()=>{};}],
  ['undefined field',x=>{x.state.money=undefined;}],
 ];
 for(const [name,mutate] of rows){const x:any=saved();mutate(x);expect(()=>decodeSave(x),name).toThrow();}
 expect(()=>decodeSave('not json')).toThrow();
 expect(()=>decodeSave(null)).toThrow();
 expect(()=>decodeSave([])).toThrow();
});
test('a decoded save keeps working with the core commands',()=>{
 const restored=decodeSave(encodeSave(saved())), before=restored.state.money;
 const replay=applyCommand(restored.state,{version:1,worldId:'mundo',actorId:'local-player',sequence:3,expectedRevision:restored.state.revision,action:{type:'build',tool:'park',cells:[{x:3,y:3}]}},[]);
 expect(replay.status).toBe('applied');expect(replay.state.money).toBe(before-30);
});

test('the snapshot accepts exactly the zoom range the camera can produce',()=>{
 for(const zoom of [VIEW_ZOOM_MIN,0.2,0.5,1.25,VIEW_ZOOM_MAX]){
  const x=saved();x.view={...x.view,zoom};
  expect(decodeSave(JSON.parse(encodeSave(x))).view.zoom,`zoom ${zoom}`).toBe(zoom);
 }
 for(const zoom of [VIEW_ZOOM_MIN/2,VIEW_ZOOM_MAX+0.01]){const x=saved();x.view={...x.view,zoom};expect(()=>decodeSave(x),`zoom ${zoom}`).toThrow('Zoom inválido');}
});
