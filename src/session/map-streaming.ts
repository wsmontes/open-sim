import type {MapLevel} from './ports';
export type MapDemand={visible:readonly string[];detail:readonly string[];nearby:readonly string[]};
export function createMapStreaming(config:{load(ids:readonly string[],level:MapLevel):Promise<void>;concurrency?:number;available?:(id:string,level:MapLevel)=>boolean;onError?:(error:unknown)=>void}){
 let demand:MapDemand={visible:[],detail:[],nearby:[]},destroyed=false,active=0;
 const ready=new Map<string,MapLevel>(),pending=new Set<string>(),failed=new Set<string>(),waiters:Array<()=>void>=[];
 const work=()=>{
  const candidates:[string,MapLevel][]=[...demand.visible.map(id=>[id,'overview'] as [string,MapLevel]),...demand.detail.map(id=>[id,'detail'] as [string,MapLevel]),...demand.nearby.map(id=>[id,'detail'] as [string,MapLevel])];
  return candidates.filter(([id,level])=>!pending.has(id)&&!failed.has(id)&&!(config.available?config.available(id,level):(ready.get(id)==='detail'||ready.get(id)===level)));
 };
 const drain=()=>{
  if(destroyed&&active===0){for(const resolve of waiters.splice(0))resolve();return;}
  while(!destroyed&&active<(config.concurrency??4)){
   const next=work()[0];if(!next)break;const [id,level]=next;pending.add(id);active++;
   void config.load([id],level).then(()=>ready.set(id,level),error=>{failed.add(id);config.onError?.(error);}).finally(()=>{pending.delete(id);active--;drain();});
  }
  if(active===0&&(!work().length||destroyed))for(const resolve of waiters.splice(0))resolve();
 };
 return{
  updateDemand(next:MapDemand){if(destroyed)return;demand=next;drain();},
  retry(){failed.clear();drain();},
  idle():Promise<void>{return active===0&&(!work().length||destroyed)?Promise.resolve():new Promise(resolve=>waiters.push(resolve));},
  destroy(){destroyed=true;demand={visible:[],detail:[],nearby:[]};drain();},
 };
}
