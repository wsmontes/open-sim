import {PbfReader} from 'pbf';
import type {Point} from '../../presentation/camera';
export type GeometryBudget={maxPoints:number;tolerance:number;maxFeatures?:number};
type Span={start:number;end:number};
// Index public MVT fields, without using private vector-tile offsets or allocating geometry points.
export function geometrySpans(bytes:Uint8Array):Map<string,Array<Span|undefined>>{
 const out=new Map<string,Array<Span|undefined>>(),pbf=new PbfReader(bytes);
 pbf.readFields((tag,result,p)=>{
  if(tag!==3)return;
  const layer=p.readMessage((tag,layer,p)=>{
   if(tag===1)layer.name=p.readString();
   if(tag===2){const feature=p.readMessage((tag,feature,p)=>{if(tag===4){const end=p.readVarint()+p.pos;feature.span={start:p.pos,end};p.pos=end;}},{span:undefined as Span|undefined});layer.features.push(feature.span);}
  },{name:'',features:[] as Array<Span|undefined>});result.set(layer.name,layer.features);
 },out);
 return out;
}
// Consume command deltas directly. Only retained points get objects; neither loadGeometry nor a second mapped
// array is created. Reject the entire feature at the cap so an open/truncated polygon cannot masquerade as land.
export function budgetedGeometry(bytes:Uint8Array,span:Span|undefined,originX:number,originY:number,scale:number,budget:GeometryBudget):Point[][]|undefined{
 if(!span)throw new Error('Feature has no geometry');
 const pbf=new PbfReader(bytes);pbf.pos=span.start;
 const rings:Point[][]=[];let ring:Point[]|undefined,x=0,y=0,points=0,lastX=0,lastY=0,pending=false;
 const add=(px:number,py:number)=>{if(points>=budget.maxPoints)return false;ring!.push({x:px,y:py});points++;pending=false;return true;};
 const finish=()=>{if(!ring)return true;if(pending&&!add(lastX,lastY))return false;rings.push(ring);ring=undefined;return true;};
 while(pbf.pos<span.end){
  const command=pbf.readVarint(),kind=command&7,count=command>>>3;
  for(let i=0;i<count;i++){
   if(kind===1||kind===2){
    if(pbf.pos>=span.end)throw new Error('Truncated geometry');x+=pbf.readSVarint();if(pbf.pos>=span.end)throw new Error('Truncated geometry');y+=pbf.readSVarint();const px=originX+x*scale,py=originY+y*scale;
    if(kind===1){if(!finish())return;ring=[];lastX=px;lastY=py;if(!add(lastX,lastY))return;}
    else if(ring){lastX=px;lastY=py;const last=ring[ring.length-1];if(budget.tolerance<=0||Math.hypot(lastX-last.x,lastY-last.y)>=budget.tolerance){if(!add(lastX,lastY))return;}else pending=true;}
   }else if(kind===7){if(ring){if(pending&&!add(lastX,lastY))return;const first=ring[0];if(!add(first.x,first.y))return;}}
   else throw new Error(`Unknown geometry command ${kind}`);
  }
 }
 if(!finish())return;return rings;
}
