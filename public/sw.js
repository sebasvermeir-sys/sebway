// Service worker: makes Sebway installable and lets it open offline.
// App files: network first (so updates show immediately), cached copy when offline.
// Live data (/api/*): always from the network, never cached.
const CACHE = "sebway-v49";
const SHELL = ["/", "/styles.css", "/theme.js", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/icon-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Push from the server: disruption on a saved route, pass reminder or test.
self.addEventListener("push", (event) => {
  let msg = { title: "Sebway", body: "" };
  try {
    msg = { ...msg, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: msg.tag,
      renotify: Boolean(msg.tag && msg.renotify),
      data: { url: msg.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) return open.navigate(url).then((w) => (w ?? open).focus());
      return self.clients.openWindow(url);
    }),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Live data and videos go straight to the network (iOS streams videos in byte ranges, which a
  // cached full copy would break).
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) return;

  const key = event.request.mode === "navigate" ? "/" : event.request;
  event.respondWith(
    // "no-cache" = always ask the server if the file changed (cheap 304 when it didn't), so updates
    // show up on the next open instead of an old copy coming from the browser's HTTP cache.
    fetch(url.href, { cache: "no-cache" })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key)),
  );
});
