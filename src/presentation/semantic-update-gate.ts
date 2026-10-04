export function createSemanticUpdateGate(intervalMs=200){
 let lastKey:string|undefined,lastAt=-Infinity;
 return {shouldUpdate(key:string,now:number,immediate=false){if(lastKey===key&&!immediate)return false;if(!immediate&&now-lastAt<intervalMs)return false;lastKey=key;lastAt=now;return true;},retryAfter(key:string,now:number){return lastKey===key?null:Math.max(0,intervalMs-(now-lastAt));},reset(){lastKey=undefined;lastAt=-Infinity;}};
}
