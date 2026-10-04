import {createSpatialIndex} from '../../presentation/spatial-index';
export type ScreenBounds={x:number;y:number;width:number;height:number};
export type SceneCommand={depth:number;bounds:ScreenBounds;draw:()=>void};
const intersects=(a:ScreenBounds,b:ScreenBounds)=>a.x+a.width>=b.x&&a.x<=b.x+b.width&&a.y+a.height>=b.y&&a.y<=b.y+b.height;
export function dirtyRegions(input:readonly ScreenBounds[],width:number,height:number):ScreenBounds[]|null{
 const result:ScreenBounds[]=[];
 for(const b of input){const x=Math.max(0,b.x),y=Math.max(0,b.y),right=Math.min(width,b.x+b.width),bottom=Math.min(height,b.y+b.height);if(right<=x||bottom<=y)continue;let r={x,y,width:right-x,height:bottom-y};for(let i=0;i<result.length;){const a=result[i];if(intersects(a,r)){const x=Math.min(a.x,r.x),y=Math.min(a.y,r.y);r={x,y,width:Math.max(a.x+a.width,r.x+r.width)-x,height:Math.max(a.y+a.height,r.y+r.height)-y};result.splice(i,1);i=0;}else i++;}result.push(r);}
 return result.length>32||result.reduce((area,b)=>area+b.width*b.height,0)>width*height*.4?null:result;
}
export function createSceneCompositor(){
 let key:object|undefined,previous:readonly ScreenBounds[]=[],staticBuilds=0,dirtyCount=0,index:ReturnType<typeof createSpatialIndex<SceneCommand>>|undefined;
 return {compose(ctx:CanvasRenderingContext2D,nextKey:object,width:number,height:number,ground:()=>void,statics:readonly SceneCommand[],dynamic:readonly SceneCommand[]){
  const changed=key!==nextKey;
  if(changed){staticBuilds++;key=nextKey;index=createSpatialIndex(statics.map(c=>({bounds:{minX:c.bounds.x,minY:c.bounds.y,maxX:c.bounds.x+c.bounds.width,maxY:c.bounds.y+c.bounds.height},value:c})),128);}
  const current=dynamic.map(c=>c.bounds),dirty=changed?null:dirtyRegions([...previous,...current],width,height);previous=current;
  if(dirty?.length===0){dirtyCount=0;return;}
  dirtyCount=dirty?.length??1;
  if(dirty){ctx.save();ctx.beginPath();for(const r of dirty)ctx.rect(r.x,r.y,r.width,r.height);ctx.clip();}
  ground();
  const candidates=dirty?[...new Set(dirty.flatMap(r=>index!.query({minX:r.x,minY:r.y,maxX:r.x+r.width,maxY:r.y+r.height})))]:statics;
  const ordered=[...candidates,...dynamic].sort((a,b)=>a.depth-b.depth);for(const command of ordered)command.draw();
  if(dirty)ctx.restore();
 },clear(){key=undefined;previous=[];index=undefined;dirtyCount=0;},stats:()=>({staticBuilds,dirtyRegions:dirtyCount,bytes:0})};
}
