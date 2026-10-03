import {expect,test} from 'vitest';
import {createGame,applyCommand} from '../src/core/commands';
import {describeCell,isPowered,stepSimulation,summarize} from '../src/core/simulation';
import type {GameState} from '../src/core/model';
import {blank,command} from './fixtures/world';
import {adopt} from '../src/core/world';
function setup(){const b=blank();b.cells[0]={terrain:'land',road:true};b.cells[1]={terrain:'land',building:'residential',stage:0,origin:'player'};b.cells[2]={terrain:'land',building:'power',stage:1};return createGame('world',42,b);}
// Growth follows demand now, and demand is decided when the month closes: a zone waits for the first month before it
// can become a home, and then it still needs the street, the power and a reason for somebody to move in.
test('a home appears only with a street, power and a month of demand behind it',()=>{
 const s=setup();
 expect(summarize(stepSimulation(s)).population).toBe(0);
 const grow=(from:typeof s)=>{let city=from;for(let i=0;i<35;i+=1)city=stepSimulation(city);return city;};
 expect(summarize(grow(s)).population).toBe(4);
 for(const index of [0,2]){const b=setup();b.chunks['0:0'].base.cells[index]={terrain:'land'};expect(summarize(grow(b)).population).toBe(0);}
 const taxed=setup();
 taxed.components['city.economy']={policy:{tax:20}};
 expect(summarize(grow(taxed)).population).toBe(0);
});
test('imported homes start occupied with baseline energy and survive demolition correctly',()=>{const b=blank();b.cells[0]={terrain:'land',building:'residential',stage:1,origin:'imported'};let s=createGame('w',1,b);expect(summarize(s)).toMatchObject({population:4,energySupply:2,energyUsed:2,income:0});s=applyCommand(s,command(s,{type:'demolish',cells:[{x:0,y:0}]}),[]).state;expect(summarize(s).population).toBe(0);});
test('tick order and region insertion order cannot change economic results',()=>{const a=setup();const b=blank('2:0');b.cells[0]={terrain:'land',building:'commercial',stage:1};a.chunks['2:0']=adopt(b);const reverse={...a,chunks:Object.fromEntries(Object.entries(a.chunks).reverse())};let x=a,y=reverse;for(let i=0;i<30;i++){x=stepSimulation(x);y=stepSimulation(y);}expect(summarize(x)).toEqual(summarize(y));expect(x.chunks).toEqual(y.chunks);expect(summarize(x).jobs).toBe(6);});
test('tick command advances logical time once even on retry',()=>{const s=setup(),c=command(s,{type:'tick'}),a=applyCommand(s,c,[]);expect(a.state.tick).toBe(1);expect(applyCommand(a.state,c,[]).state.tick).toBe(1);});
// Rules 4: power travels through what is built. The same home, street and plant, with the plant moved one cell away
// across open land, never grows — and joining the gap with a road brings it back.
test('a lot grows only where the grid reaches it from a plant',()=>{
 const grow=(from:GameState)=>{let city=from;for(let i=0;i<35;i+=1)city=stepSimulation(city);return city;};
 const apart=()=>{const b=blank();b.cells[0]={terrain:'land',road:true};b.cells[1]={terrain:'land',building:'residential',stage:0,origin:'player'};b.cells[3]={terrain:'land',building:'power',stage:1};return b;};
 const cut=createGame('world',42,apart());
 expect(isPowered(cut,{x:1,y:0})).toBe(false);
 expect(summarize(grow(cut)).population).toBe(0);
 const joined=apart();joined.cells[2]={terrain:'land',road:true};
 const linked=createGame('world',42,joined);
 expect(isPowered(linked,{x:1,y:0})).toBe(true);
 expect(summarize(grow(linked)).population).toBe(4);
});
test('the inspector says whether a building is on the grid',()=>{
 const s=setup();
 expect(describeCell(s,{x:1,y:0})?.powered).toBe(true);
 expect(describeCell(s,{x:5,y:5})?.powered).toBeUndefined();
});
