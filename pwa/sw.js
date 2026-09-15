/* Patroni service worker.
   The page and its images are cached so the app opens instantly and keeps
   working on a bad signal — which is the normal condition on the Batumi
   coast road and in a plane seat on the way to view a property. */
const V = 'patroni-v3';
const SHELL = ['/', '/index.html', '/favicon.svg',
               '/pwa/icon-192.png', '/pwa/icon-512.png', '/pwa/manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // fonts and CDNs handle themselves

  /* Renders and photographs never change once published, so serve them from
     the cache immediately and never wait on the network. */
  if (url.pathname.startsWith('/img/') || url.pathname.startsWith('/pwa/')) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(V).then(c => c.put(req, copy));
      return res;
    }).catch(() => hit)));
    return;
  }

  /* The page itself: try the network so a new deployment is picked up the
     next time the app is opened, and fall back to the cached copy offline. */
  e.respondWith(fetch(req).then(res => {
    const copy = res.clone();
    caches.open(V).then(c => c.put(req, copy));
    return res;
  }).catch(() => caches.match(req).then(hit => hit || caches.match('/index.html'))));
});
