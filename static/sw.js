// A minimal service worker to satisfy the PWA install criteria.
//
// It caches NOTHING on purpose. There was already an incident where a static file changed but the
//   phone kept biting old code (hence ?v=N on index.html), and an SW cache makes that far
//   stickier. Registering a fetch listener without calling respondWith lets the browser
//   fetch from the network as usual - install criteria met, no cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
