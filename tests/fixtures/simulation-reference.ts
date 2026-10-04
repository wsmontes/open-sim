// A frozen copy of the simulation core as it stood before the per-chunk memo (commit d2f2776), used by
// tests/simulation-memo.test.ts as the reference the memoised tick must agree with, and by tools/bench-tick.ts as
// the "before" measurement. It is a fixture: nothing imports it in production, and it must keep behaving exactly like
// the release it was cut from.
import type {Action,BaseChunk,Cell,CellCoord,CityStats,Command,CommandResult,Demand,GameState,ManagedChunk,MonthlyLedger,RoadClass,Tool} from '../../src/core/model';
import {BORROW_MAX,COST,FORMAT_VERSION,RULES_VERSION,ROAD_CLASS,SERVICES_DEFAULT,SERVICES_MAX,SERVICES_MIN,TAX_DEFAULT,TAX_MAX,TAX_MIN,isRoadTool,roadClassOf} from '../../src/core/model';
import {adopt,cellEconomy,effectiveCells,getCell,occupied,placement} from '../../src/core/world';
import {assertJsonSafe,cloneJson,isComponentKey,isEntityId} from '../../src/core/protocol';
import {CHUNK,WORLD,cellIndex,chunkId,coordAt,validCell,wrapX} from '../../src/core/coordinates';

// --- the shape of the city's economy ---------------------------------------------------------------------------
// Three demands the player can move, one tax rate, land value that follows what was built and where, a monthly
// budget, and a debt ladder. The rules come from the genre's public sources (Micropolis's demand valves and tax
// table, Cities: Skylines' service level curve and land-value lags, SimCity 4's share of the population in work) and
// from real municipal finance for the magnitudes: property tax as the main local revenue, debt priced by how deep the
// city is in it. Everything here is a pure function of the world state, in a fixed order, with no clock and no
// randomness beyond the deterministic `variant` — a session's two clients must agree.
export {TAX_DEFAULT,TAX_MIN,TAX_MAX,TAX_DEFAULT as TAX, SERVICES_DEFAULT,SERVICES_MIN,SERVICES_MAX} from '../../src/core/model';
// The city profile keeps its own numbers under one namespace, exactly like `chunks` keeps the map: a client that does
// not implement this profile leaves them alone, and a save carries them without the core knowing what they mean.
const ECONOMY='city.economy';
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const whole=(value:number)=>Math.round(value);
export type Policy={tax:number;services:number;debt:number;valves:Demand;months:number};
const DEFAULT_POLICY:Policy={tax:TAX_DEFAULT,services:SERVICES_DEFAULT,debt:0,valves:{residential:0,commercial:0,industrial:0},months:0};
const num=(value:unknown,fallback:number,min:number,max:number):number=>typeof value==='number'&&Number.isFinite(value)?clamp(value,min,max):fallback;
// The player writes policy as a component; anything unreadable is ignored instead of obeyed, so a hostile or broken
// client cannot put the city's books into a state the game cannot show.
export function policyOf(state:GameState):Policy {
 const entry=state.components[ECONOMY];
 const raw=entry&&typeof entry==='object'&&!Array.isArray(entry)?(entry as Record<string,unknown>)['policy']:null;
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {...DEFAULT_POLICY,valves:{...DEFAULT_POLICY.valves}};
 const source=raw as Record<string,unknown>;
 const valves=source['valves']&&typeof source['valves']==='object'&&!Array.isArray(source['valves'])?source['valves'] as Record<string,unknown>:{};
 return {
  tax:whole(num(source['tax'],TAX_DEFAULT,TAX_MIN,TAX_MAX)),
  services:whole(num(source['services'],SERVICES_DEFAULT,SERVICES_MIN,SERVICES_MAX)),
  debt:Math.max(0,whole(num(source['debt'],0,0,100_000_000))),
  valves:{residential:whole(num(valves['residential'],0,-200,200)),commercial:whole(num(valves['commercial'],0,-200,200)),industrial:whole(num(valves['industrial'],0,-200,200))},
  months:Math.max(0,whole(num(source['months'],0,0,100_000_000))),
 };
}
export function withPolicy(state:GameState,policy:Policy):GameState {
 const entry=state.components[ECONOMY];
 const value={...(entry&&typeof entry==='object'&&!Array.isArray(entry)?entry as Record<string,unknown>:{}),policy:{tax:policy.tax,services:policy.services,debt:policy.debt,months:policy.months,valves:{...policy.valves}}};
 return {...state,components:{...state.components,[ECONOMY]:value}};
}

// --- land value -------------------------------------------------------------------------------------------------
// Derived, never stored: value is a consequence of the map, so a client that loads the same world computes the same
// value, and a building that disappears takes its contribution with it. Peace and quiet pays, industry next door does
// not, and distance from the middle costs — the shape of every bid-rent model and of Micropolis's terrain scan.
const LAND_MIN=1,LAND_MAX=250;
// A cell reader for one state that remembers the region it last resolved. The neighbourhood scans below read ~145
// cells around each lot, and nearly all of them share the lot's region: building a `chunkId` string per neighbour was
// most of their cost. The answer is exactly `getCell`'s — same region, same edit-over-base rule.
type Reader=(x:number,y:number)=>Cell|undefined;
function readerOf(s:GameState):Reader {
 let lastX=Number.NaN,lastY=Number.NaN,chunk:ManagedChunk|undefined;
 return (x,y)=>{
  const wx=wrapX(x),rx=Math.floor(wx/CHUNK),ry=Math.floor(y/CHUNK);
  if(rx!==lastX||ry!==lastY){lastX=rx;lastY=ry;chunk=s.chunks[`${rx}:${ry}`];}
  if(!chunk)return undefined;
  const i=(y%CHUNK)*CHUNK+(wx%CHUNK);
  return chunk.edits[i]??chunk.base.cells[i];
 };
}
// Everything a pass over the city needs that does not change during the pass. The centre and the aggregate used to be
// recomputed per lot — the centre walks up to 4,096 buildings, so every land value made the whole city quadratic.
type Context={read:Reader;centre:CellCoord;aggregate:Aggregate};
function contextOf(s:GameState):Context {
 const read=readerOf(s),centre=cityCentre(s);
 return {read,centre,aggregate:aggregate(s,read,centre)};
}
export function landValueAt(s:GameState,p:CellCoord):number {return landValueWith(readerOf(s),cityCentre(s),p);}
function landValueWith(read:Reader,centre:CellCoord,p:CellCoord):number {
 let parks=0,commerce=0,industry=0,avenues=0,highways=0;
 for(let dy=-8;dy<=8;dy++)for(let dx=-8;dx<=8;dx++){
  const reach=Math.abs(dx)+Math.abs(dy);
  if(reach>8)continue;
  const c=read(p.x+dx,p.y+dy);
  if(!c)continue;
  if(c.building==='park')parks+=1;
  else if(c.building==='commercial'&&occupied(c))commerce+=1;
  else if(c.building==='industrial'&&occupied(c))industry+=1;
  // Roads shape a neighbourhood as much as the buildings do: an avenue is a shop's address and a highway is a wall.
  // Reach is what separates them: an avenue is felt on its own street, a highway is felt through the block.
  if(c.road){
   const kind=roadClassOf(c);
   if(kind==='avenue'&&reach<=2)avenues+=1;
   else if(kind==='highway'&&reach<=3)highways+=1;
  }
 }
 const distance=Math.abs(p.x-centre.x)+Math.abs(p.y-centre.y);
 const raw=40+Math.min(60,parks*6)+Math.min(30,commerce*2)-Math.min(70,industry*7)-Math.min(30,distance/256)+Math.min(18,avenues*6)-Math.min(36,highways*9);
 return clamp(whole(raw),LAND_MIN,LAND_MAX);
}
// The middle of what was built, recomputed from the buildings themselves: a city that grows south moves its own
// centre, and nothing has to be stored to remember where it was.
function cityCentre(s:GameState):CellCoord {
 let sumX=0,sumY=0,count=0;
 for(const id of Object.keys(s.chunks).sort()){
  const cells=effectiveCells(s.chunks[id]!);
  for(let i=0;i<cells.length;i+=1){
   const cell=cells[i]!;
   if(!occupied(cell))continue;
   const p=coordAt(id,i);
   sumX+=p.x;sumY+=p.y;count+=1;
   if(count>=4096)return {x:whole(sumX/count),y:whole(sumY/count)};
  }
 }
 return count?{x:whole(sumX/count),y:whole(sumY/count)}:{x:0,y:0};
}

// --- the three demands -----------------------------------------------------------------------------------------
// Micropolis's shape: a valve per zone, moved every month by how far the city is from what that zone wants, minus
// what the tax costs. Two rules keep it pleasant instead of punishing: growth never stops outright (the valve floors
// above the point where nothing happens) and the tax is only expensive once it is high.
const VALVE_STEP=600,VALVE_RANGE=200,WORKERS_SHARE=0.5;
export function taxEffect(taxPercent:number):number {
 // A cheap city grows on its own, a neutral one at the default rate is steady, and a dear one pays for it in growth:
 // the table's shape is Micropolis's `taxTable`, re-anchored so the default tax is the calm point.
 return taxPercent<=TAX_DEFAULT?(TAX_DEFAULT-taxPercent)*22:-(taxPercent-TAX_DEFAULT)*70;
}
export type Aggregate={population:number;jobs:number;workers:number;housing:number;landValueAverage:number;serviceLevel:number;roadCells:number;parkCells:number;powerCells:number};
function aggregate(s:GameState,read:Reader=readerOf(s),centre:CellCoord=cityCentre(s)):Aggregate {
 let population=0,jobs=0,housing=0,landSum=0,landCount=0,roadCells=0,parkCells=0,powerCells=0;
 for(const id of Object.keys(s.chunks).sort()){
  const chunk=s.chunks[id]!;
  const cells=effectiveCells(chunk);
  for(let i=0;i<cells.length;i+=1){
   const cell=cells[i]!;
   if(cell.road)roadCells+=1;
   if(!occupied(cell))continue;
   const p=coordAt(id,i);
   landSum+=landValueWith(read,centre,p);landCount+=1;
   if(cell.building==='residential'){const residents=4*(cell.stage??0);population+=residents;housing+=4;continue;}
   if(cell.building==='commercial'){jobs+=6*(cell.stage??0);continue;}
   if(cell.building==='industrial'){jobs+=10*(cell.stage??0);continue;}
   if(cell.building==='park'){parkCells+=1;continue;}
   if(cell.building==='power'){powerCells+=1;continue;}
  }
 }
 // Services are read from the city's own policy: the level the player pays for is the level the city gets, and
 // hardcoding the default here was quietly making the whole slider cost money without changing anything.
 return {population,jobs,workers:whole(population*WORKERS_SHARE),housing,landValueAverage:landCount?whole(landSum/landCount):0,serviceLevel:serviceLevelOf(policyOf(s).services),roadCells,parkCells,powerCells};
}
// Cities: Skylines' budget curve: below 100% the level falls with the square of what was spent, above it the extra
// money buys less and less. The number is a multiplier around 1, which is what the rest of the model wants.
export function serviceLevelOf(services:number):number {
 const budget=clamp(services,SERVICES_MIN,SERVICES_MAX)/100;
 const level=budget<1?budget*budget:3*budget-budget*budget-1;
 return Math.round(level*100)/100;
}
function nextValves(a:Aggregate,policy:Policy):Demand {
 // A brand-new city has no jobs and no workers, and a ratio built from both would be flat zero demand forever — the
 // place has to want its first residents on its own. Roads and open land attract a first few dozen people, and the
 // jobs that follow are what keep them coming.
 const wanted=Math.max(24,a.jobs*2);
 const ratioResidential=clamp(wanted/Math.max(8,a.workers),0.5,2);
 const shops=a.jobs>0?a.jobs*(1/3):0;
 const ratioCommercial=clamp(1+(a.population*0.3-shops)/Math.max(8,shops),0.5,2);
 const unemployment=a.workers>0?Math.max(0,a.workers-a.jobs)/a.workers:0;
 const ratioIndustrial=clamp(1+unemployment*2-0.2,0.5,2);
 const move=(valve:number,ratio:number)=>clamp(whole(valve+(ratio-1)*VALVE_STEP+taxEffect(policy.tax)),-VALVE_RANGE,VALVE_RANGE);
 return {residential:move(policy.valves.residential,ratioResidential),commercial:move(policy.valves.commercial,ratioCommercial),industrial:move(policy.valves.industrial,ratioIndustrial)};
}

// --- the monthly budget ----------------------------------------------------------------------------------------
// Real municipal finance in miniature: property tax on the land that exists is the main revenue, a share of it comes
// from the level of government above, services and the upkeep of what was built are the expense, and the debt is
// priced by how deep the city is in it. The magnitudes are calibrated so that a small city at the default tax roughly
// balances, which is what makes the first loan a decision instead of a formality.
// The property tax is charged on the land each resident stands on, so what one resident pays is `land × rate`. The
// calibration constant is chosen so that a plain plot at the default rate covers the services of that same resident:
// a small town in the middle of the slider roughly balances, which is what makes the first loan a decision instead of
// a formality. Good land — parks, shops, a short walk from the middle — pays several times what a plot next to
// industry does, and that gap is the game.
const TRANSFER_SHARE=0.2,CAPITAL_PER_CELL=0.4,PARK_UPKEEP=0.6,PER_CAPITA=18,TAX_PER_POINT=5;
export function monthlyBudget(s:GameState,policy=policyOf(s),a:Aggregate=aggregate(s)):MonthlyLedger {
 const taxRevenue=(a.population*a.landValueAverage/120)*policy.tax*TAX_PER_POINT;
 const revenue=whole(taxRevenue*(1+TRANSFER_SHARE));
 const serviceCost=a.population*PER_CAPITA*(policy.services/100);
 const upkeep=a.roadCells*CAPITAL_PER_CELL+a.parkCells*PARK_UPKEEP;
 const debtService=whole(policy.debt*interestRateFor(s,policy.debt,a)/100/12);
 const expense=whole(serviceCost+upkeep+debtService);
 return {revenue,expense,net:revenue-expense};
}
// The ladder every credit committee uses: the deeper the debt is relative to what the city collects, the more it
// costs to borrow. The cap is a rate, not a refusal, so a desperate city can still borrow — at a price.
export function interestRateFor(s:GameState,debt:number,a:Aggregate=aggregate(s)):number {
 const revenue=Math.max(1,whole((a.population*a.landValueAverage/120)*policyOf(s).tax*TAX_PER_POINT*(1+TRANSFER_SHARE))*12);
 const ratio=debt/Math.max(1,revenue);
 if(ratio<1)return 3.5;
 if(ratio<1.6)return 5.5;
 if(ratio<2.2)return 8;
 return 12;
}
export function ratingFor(s:GameState,debt:number,a:Aggregate=aggregate(s)):'A'|'B'|'C'|'D' {
 const rate=interestRateFor(s,debt,a);
 return rate<=3.5?'A':rate<=5.5?'B':rate<=8?'C':'D';
}

// --- what the screen shows -------------------------------------------------------------------------------------
export function economyOf(s:GameState):CityStats['economy'] {return economyWith(s,aggregate(s));}
function economyWith(s:GameState,a:Aggregate):CityStats['economy'] {
 const policy=policyOf(s);
 const monthly=monthlyBudget(s,policy,a);
 const interestRate=interestRateFor(s,policy.debt,a);
 const rating=ratingFor(s,policy.debt,a);
 return {
  taxPercent:policy.tax,
  servicesPercent:policy.services,
  serviceLevel:serviceLevelOf(policy.services),
  demand:{...policy.valves},
  landValueAverage:a.landValueAverage,
  monthly,
  debt:policy.debt,
  interestRate,
  rating,
  // A month in the red is a decision waiting to be made, so it is a sentence with the three ways out rather than a
  // number the player has to interpret.
  crisis:monthly.net<0&&s.money<=0?'A cidade gastou mais do que arrecadou e o caixa acabou. Corte serviços, aumente o imposto ou tome um empréstimo.':null,
 };
}

// What the world says about one cell, in the words the interface needs and the rules the simulation already applies:
// a house holds four people per floor, a shop six jobs and a factory ten, land value is what the neighbourhood makes of
// it, and a road is the class it was built as. Nothing here is new arithmetic — it is the same rules, asked about a
// single cell — which is the only way a card about a building can be trusted to agree with the city around it.
export type CellReading = {
 terrain:'land'|'water'|'green';
 road?:RoadClass;
 building?:Tool;
 stage?:number;
 origin?:'imported'|'player';
 occupied:boolean;
 residents:number;
 jobs:number;
 landValue:number;
 // Whether a plant reaches this cell through the grid — only said of something built, where it decides growth.
 powered?:boolean;
};
export function describeCell(s:GameState,p:CellCoord):CellReading|null {
 const cell=getCell(s,p);
 if(!cell)return null;
 const building=cell.building as Tool|undefined;
 const stage=cell.stage??0;
 const working=!!building&&building!=='park'&&building!=='power'&&stage>0;
 return {
  terrain:cell.terrain,
  ...(cell.road?{road:roadClassOf(cell)}:{}),
  ...(building?{building}:{}),
  ...(cell.stage!==undefined?{stage:cell.stage}:{}),
  ...(cell.origin?{origin:cell.origin}:{}),
  occupied:working,
  residents:working&&building==='residential'?4*stage:0,
  jobs:working?building==='commercial'?6*stage:building==='industrial'?10*stage:0:0,
  landValue:landValueAt(s,p),
  ...(building&&building!=='park'?{powered:isPowered(s,p)}:{}),
 };
}

// --- the tick -------------------------------------------------------------------------------------------------
export function happinessAt(s:GameState,p:CellCoord):number {return happinessWith(readerOf(s),p);}
function happinessWith(read:Reader,p:CellCoord):number {
 let parks=0,industry=false;
 for(let dy=-8;dy<=8;dy++)for(let dx=-8;dx<=8;dx++){
  if(Math.abs(dx)+Math.abs(dy)>8)continue;
  const c=read(p.x+dx,p.y+dy);
  if(c?.building==='park')parks++;if(c?.building==='industrial'&&occupied(c))industry=true;
 }
 return Math.min(100,Math.max(0,60+Math.min(20,parks*5)-(industry?10:0)));
}
export function referenceSummarize(s:GameState):CityStats {return summarizeWith(s,contextOf(s));}
function summarizeWith(s:GameState,ctx:Context):CityStats {
 const stats:CityStats={money:s.money,population:0,jobs:0,energySupply:0,energyUsed:0,happiness:60,income:0,managed:Object.keys(s.chunks).length,economy:economyWith(s,ctx.aggregate)};
 let happy=0;
 for(const id of Object.keys(s.chunks).sort()){
  const ch=s.chunks[id];stats.energySupply+=ch.baseEnergy;stats.income+=ch.balanceAdjustment;
  effectiveCells(ch).forEach((c,i)=>{
   stats.income+=cellEconomy(c);
   if(c.building==='power')stats.energySupply+=64;
   if(!occupied(c))return;
   stats.energyUsed+=2;
   if(c.building==='residential'){stats.population+=4;happy+=happinessWith(ctx.read,coordAt(id,i))*4;}
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
// --- the power grid -------------------------------------------------------------------------------------------
// Power travels: a plant feeds what it touches, and anything built — a road, a house, a shop — carries it on to its
// neighbours, the way SimCity's zones conduct. Open land and water break the line. A plant in the wrong place now
// powers nothing, which is the decision the global pool never asked for. Only the cells of administered regions are
// part of the grid, so the answer is the same on every client and independent of what the camera has loaded.
const conducts=(c:Cell|undefined):boolean=>!!c&&(!!c.road||!!c.building);
const gridKey=(x:number,y:number)=>y*WORLD+x;
const gridCache=new WeakMap<GameState,Set<number>>();
export function poweredCells(s:GameState):ReadonlySet<number> {
 const cached=gridCache.get(s);
 if(cached)return cached;
 const read=readerOf(s),powered=new Set<number>(),queue:number[]=[];
 for(const id of Object.keys(s.chunks).sort()){
  const cells=effectiveCells(s.chunks[id]!);
  for(let i=0;i<cells.length;i+=1){
   if(cells[i]!.building!=='power')continue;
   const p=coordAt(id,i),key=gridKey(p.x,p.y);
   if(!powered.has(key)){powered.add(key);queue.push(p.x,p.y);}
  }
 }
 for(let head=0;head<queue.length;head+=2){
  const x=queue[head]!,y=queue[head+1]!;
  for(const [dx,dy] of NEIGHBOURS){
   const ny=y+dy;if(ny<0||ny>=WORLD)continue;
   const nx=wrapX(x+dx),key=gridKey(nx,ny);
   if(powered.has(key)||!conducts(read(nx,ny)))continue;
   powered.add(key);queue.push(nx,ny);
  }
 }
 gridCache.set(s,powered);
 return powered;
}
export const isPowered=(s:GameState,p:CellCoord):boolean=>poweredCells(s).has(gridKey(wrapX(p.x),p.y));
const NEIGHBOURS=[[1,0],[-1,0],[0,1],[0,-1]] as const;

// How tall a building is allowed to be: the stage the player sees is the zone's level, and it is what the demand, the
// land under it and the services it gets can pay for. One step per growth turn keeps the city readable.
const MAX_STAGE=3;
function stageFor(tool:Tool,cell:{stage?:number},land:number,serviceLevel:number,valve:number,access:number):number {
 if(tool==='park'||tool==='power')return 1;
 const current=cell.stage??0;
 // What the city would like to build, capped by what the street it faces can carry: the road class is the ceiling.
 // The ladders are the land the lot sits on and what the services reach it, and the numbers are inside what the land
 // formula above can actually produce (40 base, at most +60 from parks and +30 from shops): a threshold nobody can
 // reach is a floor of the city that never gets built.
 const wanted=Math.min(access,land>=95&&serviceLevel>=1.05?3:land>=70&&serviceLevel>=0.95?2:1);
 if(valve<=0)return current;
 if(valve<-40&&current>0)return current; // a struggling zone keeps what it has instead of growing
 const cap=clamp(wanted,1,MAX_STAGE);
 return Math.min(cap,current+1);
}
export function referenceStepSimulation(state:GameState):GameState {
 const policy=policyOf(state);
 const ctx=contextOf(state);
 const aggregateNow=ctx.aggregate;
 let next={...state,tick:state.tick+1,chunks:{...state.chunks}};
 // Growth every five ticks, one building per region, chosen the same way on every client: a city that grows in one
 // deterministic step at a time is a city two clients can agree on.
 if(next.tick%5===0){
  const stats=summarizeWith(state,ctx);let energy=stats.energySupply-stats.energyUsed;
  const grid=poweredCells(state);
  const valveOf=(tool:Tool)=>tool==='residential'?policy.valves.residential:tool==='commercial'?policy.valves.commercial:tool==='industrial'?policy.valves.industrial:0;
  for(const id of Object.keys(state.chunks).sort()){
   const chunk=state.chunks[id];
   const candidates=effectiveCells(chunk);
   for(let i=0;i<candidates.length;i++){
    const c=candidates[i];if(!c.building||c.stage===undefined||c.building==='park'||c.building==='power'||energy<2)continue;
    const p=coordAt(id,i);
    // Access is what the road facing the lot can carry: a street stops the city at two floors, an avenue lets it rise,
    // and a highway frontage is somewhere nobody builds tall. No road at all means no access.
    let access=0;
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const){
     const facing=ctx.read(p.x+dx,p.y+dy);
     if(facing?.road)access=Math.max(access,ROAD_CLASS[roadClassOf(facing)].height);
    }
    if(!access)continue;
    // And a lot only grows on the grid: a plant has to reach it through roads and buildings.
    if(!grid.has(gridKey(wrapX(p.x),p.y)))continue;
    // A zone grows when its own demand is positive and it can pay the upkeep of one more floor; residential also
    // needs somebody willing to live there, which is what its valve is measuring.
    const valve=valveOf(c.building);
    if(valve<=0&&(c.stage??0)>=1)continue;
    if(c.building==='residential'&&(valve<=0||happinessWith(ctx.read,p)<40))continue;
    const land=landValueWith(ctx.read,ctx.centre,p);
    if(land<45&&valve<20)continue;
    const stage=stageFor(c.building,c,land,aggregateNow.serviceLevel,valve,access);
    if(stage===(c.stage??0))continue;
    const current=next.chunks[id];next.chunks[id]={...current,edits:{...current.edits,[i]:{...c,stage}}};
    // A lot that becomes occupied starts drawing its 2 units (summarize counts occupancy, not floors). Until rules 4
    // this added the energy instead of spending it, so a growth step could never run the pool dry.
    if((c.stage??0)===0&&stage>0)energy-=2;
    break; // One new building per region per growth step keeps the pace gentle.
   }
  }
 }
 // The month: demand moves, the books close, and a city that cannot pay is left empty-handed rather than in debt to
 // nobody. Both happen on the same tick so the player sees one consequence per month, not a slow leak.
 if(next.tick%30===0){
  const valves=nextValves(aggregateNow,policy);
  next=withPolicy(next,{...policy,valves,months:policy.months+1});
  const monthly=monthlyBudget(next,{...policy,valves},aggregate(next));
  const after=next.money+monthly.net;
  next={...next,money:after>=0?whole(after):0};
 }
 return next;
}

// --- the command layer, frozen with the core (was src/core/commands.ts) ----------------------------------------
export function referenceCreateGame(worldId:string,seed:number,initial:BaseChunk):GameState {
 return {formatVersion:FORMAT_VERSION as 1,rulesVersion:RULES_VERSION as 4,worldId,seed,revision:0,tick:0,money:20000,chunks:{[initial.id]:adopt(initial)},actors:{},components:{}};
}
export function referenceApplyCommand(state:GameState,c:Command,available:readonly BaseChunk[]):CommandResult {
 const reject=(reason:string):CommandResult=>({state,status:'rejected',reason});
 if(c.version!==1||c.worldId!==state.worldId||!/^[-\w]{1,80}$/.test(c.actorId)||['__proto__','constructor','prototype'].includes(c.actorId)||!Number.isSafeInteger(c.sequence)||c.sequence<1) return reject('Comando inválido');
 const last=state.actors[c.actorId]??0;
 if(c.sequence<=last)return{state,status:'duplicate'};
 if(c.sequence!==last+1||c.expectedRevision!==state.revision)return reject('A partida mudou. Tente novamente.');
 const a:Action=c.action;
 if(!a||!['build','demolish','tick','component','policy'].includes(a.type))return reject('Ação inválida');
 let next:GameState={...state,chunks:{...state.chunks},actors:{...state.actors}};
 if(a.type==='tick')return {status:'applied',state:{...referenceStepSimulation(state),revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}}};
 if(a.type==='component'){
  if(!isComponentKey(a.key))return reject('Namespace inválido');
  if(!isEntityId(a.entity))return reject('Identificador inválido');
  try{assertJsonSafe(a.value,'Valor do componente');}catch(error){return reject((error as Error).message);}
  const namespace={...next.components[a.key]};
  if(a.value===null)delete namespace[a.entity];else namespace[a.entity]=cloneJson(a.value);
  next={...next,components:{...next.components,[a.key]:namespace}};
  return {status:'applied',state:{...next,revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}}};
 }
 if(a.type==='policy'){
  const policy=policyOf(state);
  const tax=a.tax===undefined?policy.tax:Math.round(a.tax);
  const services=a.services===undefined?policy.services:Math.round(a.services);
  const borrow=a.borrow===undefined?0:a.borrow;
  if(!Number.isFinite(tax)||tax<TAX_MIN||tax>TAX_MAX)return reject('Imposto fora do intervalo');
  if(!Number.isFinite(services)||services<SERVICES_MIN||services>SERVICES_MAX)return reject('Serviços fora do intervalo');
  if(!Number.isFinite(borrow)||borrow<0||borrow>BORROW_MAX||Math.round(borrow)!==borrow)return reject('Empréstimo inválido');
  if(tax===policy.tax&&services===policy.services&&borrow===0)return reject('Nada a mudar');
  const changed=withPolicy({...next,money:next.money+borrow},{...policy,tax,services,debt:policy.debt+borrow});
  return {status:'applied',state:{...changed,revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}}};
 }
 if(!Array.isArray(a.cells)||!a.cells.length||a.cells.length>1024||a.cells.some(p=>!p||!validCell(p)))return reject('Seleção inválida');
 if(a.type==='build'&&!Object.hasOwn(COST,a.tool))return reject('Ferramenta inválida');
 const unique=[...new Map(a.cells.map(p=>[`${p.x}:${p.y}`,p])).values()];
 let cost=0;
 for(const p of unique){
  const id=chunkId(p); if(!next.chunks[id]){const base=available.find(b=>b.id===id);if(!base)return reject('Espere o mapa carregar');next.chunks[id]=adopt(base);}
  const old=getCell(next,p)!;const chunk=next.chunks[id];
  if(a.type==='build'){
   if(old.terrain==='water')return reject('Não é possível construir na água');
   if(isRoadTool(a.tool)&&old.road)continue;
   if(old.building||old.road)return reject('Demolir primeiro para liberar o terreno');
   cost+=COST[a.tool];
   next.chunks[id]={...chunk,edits:{...chunk.edits,[cellIndex(p)]:placement(a.tool,old.terrain)}};
  }else{
   if(!old.building&&!old.road)continue;
   cost+=COST.demolish;next.chunks[id]={...chunk,edits:{...chunk.edits,[cellIndex(p)]:{terrain:old.terrain}}};
  }
 }
 if(cost>state.money)return reject('Dinheiro insuficiente');
 next={...next,money:state.money-cost,revision:state.revision+1,actors:{...state.actors,[c.actorId]:c.sequence}};
 return {state:next,status:'applied'};
}
