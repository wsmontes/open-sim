import {expect,test} from 'vitest';
import {buildingFootprints,buildingAppearance,roadConnections,footprintEdited,pointInside} from '../src/presentation/city-art';
import type {GeographicFeature} from '../src/presentation/geographic-map';
const ring=(x:number,y:number,w:number,h:number)=>[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h},{x,y}];
test('two imported buildings remain two footprints, with courtyards kept as holes',()=>{
 const outer=ring(0,0,10,8),hole=ring(2,2,2,2).reverse(),other=ring(20,0,3,3);
 const feature:GeographicFeature={layer:'buildings',kind:'',bridge:false,type:3,geometry:[outer,hole,other]};
 const buildings=buildingFootprints(feature);
 expect(buildings).toHaveLength(2);
 expect(buildings[0].rings).toEqual([outer,hole]);expect(buildings[1].rings).toEqual([other]);
});
test('building art has distinct massing and palettes for houses, offices and industry',()=>{
 const house=buildingAppearance('residential',1,1),office=buildingAppearance('commercial',5,2),factory=buildingAppearance('industrial',1,3);
 expect(new Set([house.roof,office.roof,factory.roof]).size).toBe(3);
 expect(office.floors).toBeGreaterThan(house.floors);
 expect(buildingAppearance('residential',1,4)).not.toEqual(house);
});
test('a straight road only connects to neighbouring roads along its own axis',()=>{
 const connections=roadConnections({x:5,y:5},p=>p.y===5?{terrain:'land',road:true}:null);
 expect(connections).toEqual({east:true,west:true,north:false,south:false});
});
test('player edits suppress imported footprints only when they intersect occupied area',()=>{
 const footprint=buildingFootprints({layer:'buildings',kind:'',bridge:false,type:3,geometry:[ring(10,10,4,4),ring(11,11,1,1).reverse()]})[0];
 expect(footprintEdited(footprint,[{x:10,y:10}])).toBe(true);
 expect(footprintEdited(footprint,[{x:20,y:20}])).toBe(false);
 expect(footprintEdited(footprint,[{x:11,y:11}])).toBe(false);
});

test('tile seam fragments form one building while neighbouring buildings stay separate',async()=>{
 const {assembledFootprints}=await import('../src/presentation/city-art');
 const rect=(a:number,b:number)=>({layer:'buildings',kind:'',bridge:false,type:3,geometry:[[{x:a,y:10},{x:b,y:10},{x:b,y:14},{x:a,y:14},{x:a,y:10}]]});
 const tiles=[{z:14,x:0,y:0,features:[rect(254,256.5)]},{z:14,x:1,y:0,features:[rect(255.5,259),rect(259,262)]}];
 const buildings=assembledFootprints(tiles);
 expect(buildings).toHaveLength(2);
 expect(buildings[0].minX).toBe(254);expect(buildings[0].maxX).toBe(259);expect(buildings[0].area).toBe(20);
});

test('demolition removes only the edited cell from a real footprint',async()=>{
 const {remainingFootprints}=await import('../src/presentation/city-art');
 const feature={layer:'buildings',kind:'',bridge:false,type:3,geometry:[[{x:10,y:10},{x:14,y:10},{x:14,y:14},{x:10,y:14},{x:10,y:10}]]};
 const footprint=buildingFootprints(feature)[0],remaining=remainingFootprints(footprint,[{x:10,y:10}]);
 expect(remaining).toHaveLength(1);
 expect(pointInside({x:10.5,y:10.5},remaining[0].rings)).toBe(false);
 expect(pointInside({x:13.5,y:13.5},remaining[0].rings)).toBe(true);
});
