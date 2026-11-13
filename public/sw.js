/* DCE service worker: caches the app shell after the first visit so the app reloads offline.
   Same-origin GET requests only; nothing is ever sent anywhere else. */
const CACHE = 'dce-shell-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req.mode === 'navigate' ? '/index.html' : req, res.clone());
      return res;
    } catch {
      const hit = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('/index.html') : undefined);
      if (hit) return hit;
      return new Response('Offline and not cached yet.', { status: 503 });
    }
  })());
});
