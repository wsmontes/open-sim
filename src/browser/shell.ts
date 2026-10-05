// Installation is separate from game startup: saves and regions work even when service workers are unavailable.
export function installShell(){
 if(!('serviceWorker' in navigator))return ()=>{};
 const identify=(event:MessageEvent)=>{
  if(event.data?.type!=='shell-identify')return;
  const scripts=[...document.querySelectorAll<HTMLScriptElement>('script[src]')].map(node=>node.src);
  (event.source as ServiceWorker|null)?.postMessage({type:'shell-identify',scripts});
 };
 navigator.serviceWorker.addEventListener('message',identify);
 void navigator.serviceWorker.register(new URL('sw.js',document.baseURI).href).then(async()=>{
  const registration=await navigator.serviceWorker.ready;
  registration.active?.postMessage({type:'shell-identify',scripts:[...document.querySelectorAll<HTMLScriptElement>('script[src]')].map(node=>node.src)});
 }).catch(()=>{});
 return ()=>navigator.serviceWorker.removeEventListener('message',identify);
}
