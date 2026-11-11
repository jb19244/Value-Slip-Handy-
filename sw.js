// Value Slip ist offline: dieser Service Worker raeumt die alten Value-Slip-Caches weg und meldet sich ab.
// Trade Check hat einen eigenen Service Worker unter ./trade/ und ist davon nicht betroffen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('valueslip-')).map((k) => caches.delete(k))))
    .then(() => self.registration.unregister())
    .then(() => self.clients.matchAll())
    .then((cs) => cs.forEach((c) => c.navigate && c.navigate('./trade/'))));
});
