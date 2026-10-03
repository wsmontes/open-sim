// @vitest-environment jsdom
import {expect,test} from 'vitest';
import {CAR_PERIOD,lifeAt} from '../src/presentation/street-life';
import type {CellLife} from '../src/presentation/street-life';

// Street life is a pure function of the cell, how busy it is and the animation clock. These tests defend exactly that:
// two clients painting the same town cannot disagree, because nothing about the traffic is stored, sent or decided by
// the player — and the street keeps moving without ever becoming a fact of the world.
const cell=(over:Partial<CellLife>={}):CellLife=>({x:12,y:34,stage:2,social:false,road:'street',...over});
const traffic=(stage:number,social:boolean,motion:number,cells=400,road:CellLife['road']='street')=>{
 let cars=0,walkers=0,cyclists=0;
 for(let x=0;x<cells;x+=1){
  const life=lifeAt({x,y:0,stage,social,road},motion);
  if(life?.kind==='car')cars+=1;
  if(life?.kind==='walker')walkers+=1;
  if(life?.kind==='cyclist')cyclists+=1;
 }
 return {cars,walkers,cyclists};
};

test('the same town shows the same street to every client, at every zoom of time',()=>{
 for(const motion of [0,0.37,3.5,91.25,1e6])
  for(const x of [0,17,65535,4194303])
   for(const stage of [0,1,2,3])
    expect(lifeAt(cell({x,stage}),motion)).toEqual(lifeAt(cell({x,stage}),motion));
});

test('a car keeps its identity and its lane while the clock carries it along',()=>{
 const at=(motion:number)=>lifeAt(cell({x:3,y:9,stage:3}),motion);
 const clocks=[0,0.3,0.6,0.9,1.2];
 const found=clocks.map(at);
 const car=found.find(life=>life!==null);
 expect(car).toBeTruthy();
 // What a cell carries is decided by the map, never by the clock: the same cell holds the same car throughout.
 for(const life of found){
  if(!life)continue;
  expect(life.kind).toBe(car!.kind);
  expect(life.colour).toBe(car!.colour);
  expect(life.lane).toBe(car!.lane);
  expect(life.cross).toBe(car!.cross);
 }
 // One period later that car is back where it started, so the street is a loop and not a leak.
 for(let i=0;i<clocks.length;i+=1){
  const later=at(clocks[i]!+CAR_PERIOD);
  if(later&&found[i])expect(later.along).toBeCloseTo(found[i]!.along,6);
 }
});

test('an empty lane stays empty, and a busy street is the one that carries traffic',()=>{
 // Nothing built facing the road: a country lane with no reason for anyone to be on it.
 expect(traffic(0,false,0)).toEqual({cars:0,walkers:0,cyclists:0});
 // The taller what faces the road, the more of it there is.
 const quiet=traffic(1,false,0).cars,busy=traffic(3,false,0).cars;
 expect(busy).toBeGreaterThan(quiet);
 // A shop or a park puts people on foot, and only then.
 expect(traffic(2,true,0).walkers).toBeGreaterThan(0);
 expect(traffic(2,false,0).walkers).toBe(0);
});

test('a street with a destination keeps people on it even where nothing is built yet',()=>{
 // A quiet lane beside a shop: the corners the roll would have left empty still carry someone, on every client.
 const beside=traffic(0,true,0),nothing=traffic(0,false,0);
 expect(nothing.walkers).toBe(0);
 expect(beside.walkers).toBeGreaterThan(0);
 const here=traffic(0,true,0,400),there=traffic(0,true,0,400);
 expect(here).toEqual(there);
});

test('the street keeps its bearings whatever the clock says',()=>{
 // The clock is a free running real number: a paused game, a clock that jumped, a long session. Wherever along the
 // road a car lands, it has to land *on* the road.
 for(const motion of [-5,0,0.5,1e9])
  for(let x=0;x<120;x+=1){
   const life=lifeAt(cell({x,y:x,stage:3,social:true}),motion);
   if(!life)continue;
   expect(life.along).toBeGreaterThanOrEqual(0);
   expect(life.along).toBeLessThan(1);
  }
});

test('the road class decides how much traffic the same city shows, and a highway carries through traffic',()=>{
 const on=(road:CellLife['road'],stage:number)=>traffic(stage,false,0,400,road).cars;
 const street=on('street',2),avenue=on('avenue',2),highway=on('highway',2);
 expect(avenue).toBeGreaterThan(street);
 expect(highway).toBeGreaterThan(street);
 // A highway with nothing built yet still carries what is passing through; a street with nothing built carries nobody.
 expect(traffic(0,false,0,400,'highway').cars).toBeGreaterThan(0);
 expect(traffic(0,false,0,400,'street').cars).toBe(0);
 // Nobody walks along a highway, however busy it is.
 expect(traffic(3,true,0,400,'highway').walkers).toBe(0);
 expect(traffic(3,true,0,400,'avenue').walkers).toBeGreaterThan(0);
});

test('a bicycle belongs to the avenue, and there is one kind of life per road',()=>{
 // The class of the road is what kind of city it is: bikes appear where there is an avenue to ride along, and never on
 // a street or a highway. It is the third silhouette on the street, not a third colour of the same one.
 expect(traffic(2,true,0,400,'avenue').cyclists).toBeGreaterThan(0);
 expect(traffic(2,true,0,400,'street').cyclists).toBe(0);
 expect(traffic(2,true,0,400,'highway').cyclists).toBe(0);
});
