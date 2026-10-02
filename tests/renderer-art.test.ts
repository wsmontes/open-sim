// @vitest-environment jsdom
import {expect,test} from 'vitest';
import {render} from '../src/surfaces/canvas/canvas-renderer';
import type {WorldView} from '../src/surfaces/canvas/canvas-renderer';
import {createGame} from '../src/core/commands';
import type {Building,Cell} from '../src/core/model';
import {blank} from './fixtures/world';

// What the city looks like is decided by the canvas calls a frame makes, so the art is tested on those: which colours
// a building is painted in, and what shapes it is made of. A colour or a shape that changes on purpose changes here.
type Call={op:string;args:unknown[]};
const METHODS=['beginPath','moveTo','lineTo','closePath','fill','stroke','arc','ellipse','fillRect','strokeRect','setLineDash'];
function record(view:WorldView):Call[]{
 const calls:Call[]=[],target:Record<string,unknown>={};
 for(const name of METHODS)target[name]=(...args:unknown[])=>{calls.push({op:name,args});};
 const written:Record<string,unknown>={};
 const ctx=new Proxy(target,{get:(o,k)=>(k in o?o[k as string]:written[k as string]),set:(_o,k,v)=>{written[k as string]=v;calls.push({op:`=${String(k)}`,args:[v]});return true;}}) as unknown as CanvasRenderingContext2D;
 render(ctx,view);
 return calls;
}
// One building alone on a blank region, with the camera put on it whatever the bearing, near enough for every detail.
function lone(kind:Building,rotation=0,stage=2,at=5):WorldView{
 const base=blank();
 base.cells[at*32+at]={terrain:'land',building:kind,stage,origin:'player'} as Cell;
 const c=Math.cos(rotation),s=Math.sin(rotation),zoom=1.6,u=c*at-s*at,v=s*at+c*at;
 return {camera:{x:300-(u-v)*32*zoom,y:200-(u+v)*16*zoom,zoom,rotation},viewport:{width:600,height:400},state:createGame('art',1,base),chunks:new Map(),tool:'explore',hover:null,preview:[],previewAffordable:true,seed:1,motion:0};
}
// Every solid colour that filled something, minus the ground (the same for every kind) and the translucent shadow
// and smoke, which are light, not material.
const fills=(calls:Call[]):Set<string>=>{
 const ground=new Set(fillsOf(record(emptyView())));
 return new Set(fillsOf(calls).filter(colour=>!ground.has(colour)&&!colour.startsWith('rgba')));
};
const fillsOf=(calls:Call[]):string[]=>{
 const out:string[]=[];let current='';
 for(const call of calls){if(call.op==='=fillStyle')current=String(call.args[0]);else if(call.op==='fill'||call.op==='fillRect')out.push(current);}
 return out;
};
const emptyView=():WorldView=>({...lone('residential'),state:createGame('art',1,blank())});

test('each kind of building is painted in its own walls, not a shared beige',()=>{
 const house=fills(record(lone('residential'))),shop=fills(record(lone('commercial'))),factory=fills(record(lone('industrial')));
 for(const [a,b] of [[house,shop],[house,factory],[shop,factory]] as const){
  expect([...a].filter(colour=>b.has(colour))).toEqual([]);
 }
});

test('the light is fixed to the world: turning the camera half round shows the other two faces in other shades',()=>{
 // At one bearing the viewer sees the south and east faces; turned by 180° it sees north and west. With the light
 // carried by the building (the old `i%2`) both views were painted in the same two colours.
 const front=fills(record(lone('commercial',0))),back=fills(record(lone('commercial',Math.PI)));
 expect(front.size).toBeGreaterThan(1);
 const walls=(set:Set<string>)=>[...set].filter(colour=>!back.has(colour)||!front.has(colour));
 expect(walls(front).length).toBeGreaterThan(0);
 expect(walls(back).length).toBeGreaterThan(0);
});

test('houses, shops and factories have different silhouettes',()=>{
 // The sequence of shapes a lone building is drawn with: a hip roof is triangles, a shop carries a roof box and a
 // factory a chimney. Three kinds, three different drawings.
 const shapes=(kind:Building)=>record(lone(kind)).filter(call=>!call.op.startsWith('=')).map(call=>call.op).join(',');
 const house=shapes('residential'),shop=shapes('commercial'),factory=shapes('industrial');
 expect(new Set([house,shop,factory]).size).toBe(3);
 // The hip roof: a path of exactly three points, closed and filled.
 expect(house).toContain('beginPath,moveTo,lineTo,lineTo,closePath,fill');
});

test('lots of the same kind are not all the same width',()=>{
 // A building's ground shadow is its footprint: the screen distance between its east and west corners is the lot's
 // width. Across a diagonal of addresses there is more than one.
 const widths=new Set<number>();
 for(let at=2;at<14;at++){
  const calls=record(lone('residential',0,1,at));
  const shadow=calls.findIndex(call=>call.op==='=fillStyle'&&String(call.args[0]).startsWith('rgba(35'));
  const corners=calls.slice(shadow).filter(call=>call.op==='moveTo'||call.op==='lineTo').slice(0,4);
  widths.add(Math.round(((corners[1]!.args[0] as number)-(corners[3]!.args[0] as number))*10));
 }
 expect(widths.size).toBeGreaterThan(1);
});
