// Only application assets are cached here; geography stays in its provider's IndexedDB store.
const CACHE='open-sim-shell-v1';
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.add('./')));});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith(new URL('./',self.location).pathname))return;
 if(url.pathname.includes('/@')||url.pathname.includes('/src/')||url.pathname.includes('/node_modules/'))return;
 event.respondWith((async()=>{
  const cache=await caches.open(CACHE);
  try{
   const response=await fetch(request);
   if(response.ok)try{await cache.put(request,response.clone());}catch{}
   return response;
  }catch{
   const saved=await cache.match(request,{ignoreVary:true});
   if(saved)return saved;
   if(request.mode==='navigate'){const home=await cache.match('./',{ignoreVary:true});if(home)return home;}
   return Response.error();
  }
 })());
});
self.addEventListener('message',event=>{
 if(event.data?.type!=='cache-shell')return;
 const urls=event.data.urls;
 if(!Array.isArray(urls))return;
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  for(const value of urls){
   const url=new URL(value,self.location.href);
   if(url.origin!==self.location.origin)continue;
   try{const response=await fetch(url);if(response.ok)await cache.put(url,response);}catch{}
  }
 })());
});
