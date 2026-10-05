export type FrameSample={at:number;intervalMs:number;workMs:number;phases:Readonly<Record<string,number>>;presented:boolean};
export function createPerformanceSamples(capacity=1800){
 const limit=Math.max(1,Math.floor(capacity)),samples=new Array<FrameSample>(limit);let count=0,cursor=0;
 const copy=(s:FrameSample):FrameSample=>({...s,phases:{...s.phases}});
 return {record(sample:FrameSample){samples[cursor]=copy(sample);cursor=(cursor+1)%limit;count=Math.min(count+1,limit);},snapshot():readonly FrameSample[]{return Array.from({length:count},(_,i)=>copy(samples[(cursor-count+i+limit)%limit]));},clear(){count=0;cursor=0;}};
}
