// The build replaces these values with a content version and its complete local asset manifest.
const BUILD='__SHELL_BUILD__';
const ASSETS=/* shell-assets */ [];
const PREFIX='open-sim-shell-',CACHE=PREFIX+BUILD;
const base=new URL('./',self.location.href),urls=new Set(ASSETS.map(path=>new URL(path,base).href));
const reported=new Map();
async function prune(){
 const pages=(await self.clients.matchAll({type:'window',includeUncontrolled:true})).filter(page=>page.url.startsWith(base.href));
 // Unknown pages may still use an older build: retain their caches until they identify their scripts or leave.
 if(pages.some(page=>!reported.has(page.id))){for(const page of pages)page.postMessage({type:'shell-identify'});return;}
 const scripts=pages.flatMap(page=>reported.get(page.id));
 for(const name of await caches.keys()){
  if(name===CACHE||!name.startsWith(PREFIX))continue;
  const cache=await caches.open(name);
  if((await Promise.all(scripts.map(url=>cache.match(url)))).some(Boolean))continue;
  await caches.delete(name);
 }
}
self.addEventListener('install',event=>{
 // Cache.addAll commits only when every asset succeeds. A broken install leaves the previous worker active.
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)));
});
self.addEventListener('activate',event=>{
 // No skipWaiting: existing tabs finish using their own build.
 event.waitUntil(prune().then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==base.origin||!url.href.startsWith(base.href))return;
 const navigation=request.mode==='navigate';
 const hashedAsset=url.pathname.startsWith(new URL('assets/',base).pathname);
 if(!navigation&&!urls.has(url.href)&&!hashedAsset)return;
 event.respondWith((async()=>{
  try{
   const cache=await caches.open(CACHE);
   const saved=await cache.match(navigation?base.href:request,{ignoreVary:true});
   if(saved)return saved;
   if(hashedAsset)for(const name of await caches.keys()){
    if(name===CACHE||!name.startsWith(PREFIX))continue;
    const retained=await (await caches.open(name)).match(request,{ignoreVary:true});
    if(retained)return retained;
   }
  }catch{}
  try{return await fetch(request);}catch{return Response.error();}
 })());
});
self.addEventListener('message',event=>{
 if(event.data?.type!=='shell-identify'||!event.source?.id||!Array.isArray(event.data.scripts))return;
 const scripts=event.data.scripts.filter(url=>typeof url==='string'&&url.startsWith(base.href)).slice(0,32);
 reported.set(event.source.id,scripts);
 event.waitUntil(prune());
});
