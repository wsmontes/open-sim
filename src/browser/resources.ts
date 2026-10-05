type Storage={estimate?():Promise<{usage?:number;quota?:number}>;persisted?():Promise<boolean>;persist?():Promise<boolean>};
type Media={readonly matches:boolean;addEventListener?(type:'change',listener:()=>void):void;removeEventListener?(type:'change',listener:()=>void):void};
type Environment={navigator:{storage?:Storage;deviceMemory?:number;hardwareConcurrency?:number;connection?:{saveData?:boolean}};matchMedia?:(query:string)=>Media};
export type LocalStorageInfo={usage:number|null;quota:number|null;persistent:boolean|null};
export function createLocalResources(environment:Environment={navigator,matchMedia:window.matchMedia?.bind(window)}){
 let motion:Media|undefined;
 try{motion=environment.matchMedia?.('(prefers-reduced-motion: reduce)');}catch{}
 const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
 const preferences=()=>({
  reducedMotion:motion?.matches??false,saveData:environment.navigator.connection?.saveData??false,
  memoryGiB:number(environment.navigator.deviceMemory),processors:number(environment.navigator.hardwareConcurrency),
 });
 return {
  preferences,
  async storage():Promise<LocalStorageInfo>{
   const storage=environment.navigator.storage;
   const [estimate,persistent]=await Promise.allSettled([
    Promise.resolve().then(()=>storage?.estimate?.()),Promise.resolve().then(()=>storage?.persisted?.()),
   ]);
   return {usage:estimate.status==='fulfilled'?number(estimate.value?.usage):null,quota:estimate.status==='fulfilled'?number(estimate.value?.quota):null,persistent:persistent.status==='fulfilled'&&typeof persistent.value==='boolean'?persistent.value:null};
  },
  async persist():Promise<boolean|null>{try{return await environment.navigator.storage?.persist?.()??null;}catch{return null;}},
  subscribe(listener:()=>void){motion?.addEventListener?.('change',listener);return ()=>motion?.removeEventListener?.('change',listener);},
 };
}

export function showStorageInfo(node:HTMLElement|null,info:LocalStorageInfo){
 if(!node)return;
 const used=info.usage===null?'uso indisponível':`${(info.usage/1048576).toFixed(1)} MB usados`;
 const quota=info.quota===null?'':` de aproximadamente ${(info.quota/1048576).toFixed(0)} MB`;
 const persistence=info.persistent===true?'Armazenamento protegido contra remoção automática.':info.persistent===false?'O navegador pode liberar dados locais quando faltar espaço.':'Proteção do armazenamento indisponível.';
 node.textContent=`${used}${quota}. ${persistence}`;
}
