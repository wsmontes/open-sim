export function createFrameMerge<T>(){
 let left:readonly T[]|undefined,right:readonly T[]|undefined,snapshot:readonly T[]=Object.freeze([]);
 return (a:readonly T[],b:readonly T[]):readonly T[]=>{if(left===a&&right===b)return snapshot;left=a;right=b;return snapshot=Object.freeze([...a,...b]);};
}
