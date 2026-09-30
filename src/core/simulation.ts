import type {CellCoord,CityStats,GameState} from './model';
import {cellEconomy,effectiveCells,getCell,occupied} from './world';
import {coordAt,wrapX} from './coordinates';
export function happinessAt(s:GameState,p:CellCoord):number {
 let parks=0,industry=false;
 for(let dy=-8;dy<=8;dy++)for(let dx=-8;dx<=8;dx++){
  if(Math.abs(dx)+Math.abs(dy)>8)continue;
  const c=getCell(s,{x:wrapX(p.x+dx),y:p.y+dy});
  if(c?.building==='park')parks++;if(c?.building==='industrial'&&occupied(c))industry=true;
 }
 return Math.min(100,Math.max(0,60+Math.min(20,parks*5)-(industry?10:0)));
}
export function summarize(s:GameState):CityStats {
 const stats:CityStats={money:s.money,population:0,jobs:0,energySupply:0,energyUsed:0,happiness:60,income:0,managed:Object.keys(s.chunks).length};
 let happy=0;
 for(const id of Object.keys(s.chunks).sort()){
  const ch=s.chunks[id];stats.energySupply+=ch.baseEnergy;stats.income+=ch.balanceAdjustment;
  effectiveCells(ch).forEach((c,i)=>{
   stats.income+=cellEconomy(c);
   if(c.building==='power')stats.energySupply+=64;
   if(!occupied(c))return;
   stats.energyUsed+=2;
   if(c.building==='residential'){stats.population+=4;happy+=happinessAt(s,coordAt(id,i))*4;}
   if(c.building==='commercial')stats.jobs+=6;
   if(c.building==='industrial')stats.jobs+=10;
  });
 }
 if(stats.population)stats.happiness=Math.round(happy/stats.population);
 // A materialized person left the aggregate they were counted in, and counting both would make a city of 64 people
 // report 68 (spec §3.4, protocol §34). The count is of *people*, so two clients deriving the same slot do not move it
 // twice, and it is read from the contract namespace instead of making the city understand the profile that wrote it.
 // Income, energy and jobs are untouched: the buildings did not change.
 stats.population=Math.max(0,stats.population-materializedPeople(s));
 return stats;
}
// The shared population contract (§3 of docs/world-protocol.md): one entry per reservation, each carrying the people
// it holds. A value this client cannot read is not counted — a wrong count here would move the city's own number.
const MATERIALIZED='population.materialized';
function materializedPeople(state:GameState):number {
 const namespace=state.components[MATERIALIZED];
 if(!namespace)return 0;
 const people=new Set<string>();
 for(const entry of Object.values(namespace)){
  if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
  const ids=(entry as Record<string,unknown>)['ids'];
  if(!Array.isArray(ids)||!ids.every(id=>typeof id==='string'))continue;
  for(const id of ids)people.add(id);
 }
 return people.size;
}
export function stepSimulation(state:GameState):GameState {
 let next={...state,tick:state.tick+1,chunks:{...state.chunks}};
 if(next.tick%5===0){
  const stats=summarize(state);let energy=stats.energySupply-stats.energyUsed,pop=stats.population,jobs=stats.jobs;
  for(const id of Object.keys(state.chunks).sort()){
   const chunk=state.chunks[id];
   const candidates=effectiveCells(chunk);
   for(let i=0;i<candidates.length;i++){
    const c=candidates[i];if(!c.building||c.stage!==0||c.building==='park'||c.building==='power'||energy<2)continue;
    const p=coordAt(id,i);
    const road=[[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>getCell(state,{x:wrapX(p.x+dx),y:p.y+dy})?.road);
    if(!road)continue;
    if(c.building==='residential'&&(pop+4>Math.max(16,jobs*2)||happinessAt(state,p)<40))continue;
    const current=next.chunks[id];next.chunks[id]={...current,edits:{...current.edits,[i]:{...c,stage:1}}};
    energy-=2;if(c.building==='residential')pop+=4;if(c.building==='commercial')jobs+=6;if(c.building==='industrial')jobs+=10;
    break; // One new building per region per growth step keeps the pace gentle.
   }
  }
 }
 if(next.tick%30===0)next={...next,money:next.money+summarize(next).income};
 return next;
}
