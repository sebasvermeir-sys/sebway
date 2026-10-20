// Service worker: makes Sebway installable and lets it open offline.
// App files: network first (so updates show immediately), the saved copy when the network fails or is
// very slow. Live data (/api/*) always comes from the network and is never saved.
//
// Fail-safe on purpose (a Home Screen app on iPhone shows a blank screen when a page load fails):
// - the page request is passed on unchanged, so redirects from Wi-Fi login or filter pages are handled
//   by the browser instead of breaking the load;
// - only real answers are saved (200, same site, no redirects, no error pages);
// - files are saved one by one at install, so one failed download doesn't leave nothing saved;
// - a page load always gets an answer: the network, else the saved app, else a small
//   "can't connect" page with a Try Again button. Never nothing.
const CACHE = "sebway-v53";
const SHELL = ["/", "/styles.css", "/theme.js", "/app.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/icon-maskable-512.png"];
/** A page load waits this long for the network before showing the saved app (slow Wi-Fi). */
const NAV_TIMEOUT_MS = 6000;

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Sebway</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font-family:-apple-system,system-ui,sans-serif;background:#f3f5fb;color:#0b1430;text-align:center}
@media (prefers-color-scheme:dark){body{background:#050505;color:#f2f4f8}}h1{font-size:1.4rem;margin:0 0 8px}p{opacity:.75;margin:0 0 20px;line-height:1.4}
a{display:inline-block;min-width:44px;padding:14px 22px;border-radius:14px;background:#1f3a93;color:#fff;font-weight:700;text-decoration:none}</style></head>
<body><main><h1>Sebway can't connect</h1><p>Check your internet (or the Wi-Fi login page), then try again.</p><a href="/">Try Again</a></main></body></html>`;

/** Worth saving: a normal answer from Sebway itself. */
const saveable = (res) => res && res.ok && res.status === 200 && !res.redirected && res.type === "basic";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((path) => fetch(path, { cache: "no-cache" }).then((res) => (saveable(res) ? c.put(path, res) : null)))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Push from the server: disruption on a saved route, pass reminder, live journey step or test.
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

/** Save a copy in the background (never blocks the answer). */
function remember(key, res) {
  if (!saveable(res)) return;
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
}

/** Page loads: network (request unchanged), else the saved app, else the offline page. */
async function navigate(event) {
  const network = fetch(event.request).then((res) => {
    remember("/", res);
    return res;
  });
  const saved = () => caches.match("/");
  try {
    // Slow Wi-Fi: after a while, show the saved app if we have one (the network copy still gets saved).
    const timeout = new Promise((resolve) => setTimeout(() => saved().then((r) => r && resolve(r)), NAV_TIMEOUT_MS));
    return await Promise.race([network, timeout]);
  } catch {
    return (await saved()) ?? new Response(OFFLINE_PAGE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
}

/** App files: network first ("no-cache" = ask the server if it changed), else the saved copy. */
async function file(event) {
  try {
    const res = await fetch(event.request.url, { cache: "no-cache" });
    remember(event.request, res);
    return res;
  } catch {
    return (await caches.match(event.request, { ignoreSearch: true })) ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Live data and videos go straight to the network (iOS streams videos in byte ranges, which a
  // saved full copy would break).
  if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) return;
  event.respondWith(event.request.mode === "navigate" ? navigate(event) : file(event));
});
