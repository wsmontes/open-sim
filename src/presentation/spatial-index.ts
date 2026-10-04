export type Bounds={minX:number;minY:number;maxX:number;maxY:number};
export const overlaps=(a:Bounds,b:Bounds)=>a.maxX>=b.minX&&a.minX<=b.maxX&&a.maxY>=b.minY&&a.minY<=b.maxY;
export function createSpatialIndex<T>(entries:readonly {bounds:Bounds;value:T}[],bucketSize:number){
 if(!Number.isFinite(bucketSize)||bucketSize<=0)throw new Error('Invalid bucket size');
 const buckets=new Map<string,number[]>(),wide:number[]=[];
 const range=(b:Bounds)=>({x0:Math.floor(b.minX/bucketSize),x1:Math.floor(b.maxX/bucketSize),y0:Math.floor(b.minY/bucketSize),y1:Math.floor(b.maxY/bucketSize)});
 entries.forEach(({bounds},i)=>{const {x0,x1,y0,y1}=range(bounds);if(![x0,x1,y0,y1].every(Number.isFinite)||(x1-x0+1)*(y1-y0+1)>4096){wide.push(i);return;}for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const key=`${x}:${y}`,list=buckets.get(key)??[];list.push(i);buckets.set(key,list);}});
 return {query(bounds:Bounds):readonly T[]{const {x0,x1,y0,y1}=range(bounds);if(![x0,x1,y0,y1].every(Number.isFinite))return [];if((x1-x0+1)*(y1-y0+1)>4096)return entries.filter(e=>overlaps(e.bounds,bounds)).map(e=>e.value);const candidates=new Set(wide);for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)for(const i of buckets.get(`${x}:${y}`)??[])candidates.add(i);return [...candidates].sort((a,b)=>a-b).filter(i=>overlaps(entries[i].bounds,bounds)).map(i=>entries[i].value);}};
}
