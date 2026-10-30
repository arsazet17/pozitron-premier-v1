const C='pozitron-premier-v1.0.0';

const STATIC=[
  './?v=1.0.0',
  './index.html?v=1.0.0',
  './styles.css?v=1.0.0',
  './update-app.css?v=1.0.0',
  './app.js?v=1.0.0',
  './update-app.js?v=1.0.0',
  './engine.js',
  './manifest.webmanifest?v=1.0.0',
  './icons/icon-192.png?v=1.0.0'
];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(C)
      .then(c=>Promise.all(STATIC.map(u=>fetch(u,{cache:'no-store'}).then(r=>{
        if(r.ok) return c.put(u,r.clone());
      }).catch(()=>{}))))
  );
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k.startsWith('pozitron-premier-')&&k!==C).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  const url=new URL(e.request.url);
  if(url.origin!==self.location.origin) return;
  // Всегда сначала сеть. Кэш — только запасной вариант без интернета.
  e.respondWith(
    fetch(e.request,{cache:'no-store'})
      .then(resp=>{
        if(resp.ok){const copy=resp.clone();caches.open(C).then(c=>c.put(e.request,copy)).catch(()=>{});}
        return resp;
      })
      .catch(async()=>{
        const hit=await caches.match(e.request,{ignoreSearch:url.pathname.endsWith('.json')});
        if(hit) return hit;
        if(e.request.mode==='navigate') return (await caches.match('./index.html?v=1.0.0'))||caches.match('./?v=1.0.0');
        throw new Error('offline and no cache');
      })
  );
});
