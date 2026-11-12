// The service worker: PWA install criteria + Web Push.
//
// It caches NOTHING on purpose. There was already an incident where a static file changed but the
//   phone kept biting old code (hence ?v=N on index.html), and an SW cache makes that far
//   stickier. Registering a fetch listener without calling respondWith lets the browser
//   fetch from the network as usual - install criteria met, no cache.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

// A pane needs you (server.py /api/push/send -> push.py). Shown even when webterm is closed.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "webterm", {
    body: d.body || "",
    tag: d.tag || "webterm",
    renotify: true,                 // a newer alert from the same pane buzzes again
    icon: "/static/icon-192.png",
    // Android draws the status-bar badge as a mask: an opaque icon becomes a white square.
    badge: "/static/badge-96.png",
    data: { url: d.url || "/" },
  }));
});

// Tap -> the pane it came from. An open webterm window is reused (it switches pane on the
// message); otherwise a new one opens on `/?sid=...`, which app.js reads at boot.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin);
  const sid = url.searchParams.get("sid");
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (w) {
      try { await w.focus(); } catch (_) {}
      if (sid) w.postMessage({ t: "goto", sid });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(url.href);
  })());
});
