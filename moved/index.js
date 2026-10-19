// The old address after Sebway moved to https://sebway.app.
// - Pages: "Sebway has moved" with a Move button. The button carries this phone's device id (and name,
//   theme, tutorial seen) to the new address in the #fragment, which browsers never send to a server.
//   Same device id = the saved places, routes, boards and passes come along. The Claude key does not.
// - Shared trip links (?share=…) forward to the new address. /api/* answers 410 Moved.
// - /sw.js: a tiny service worker that clears the old app's cache, still shows notifications, and opens
//   sebway.app when one is tapped.
const NEW = "https://sebway.app";

const SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("push", (e) => {
  let m = { title: "Sebway", body: "" };
  try { m = { ...m, ...e.data.json() }; } catch {}
  e.waitUntil(self.registration.showNotification(m.title, { body: m.body, icon: "${NEW}/icons/icon-192.png", tag: m.tag, data: { url: m.url || "/" } }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.openWindow("${NEW}" + (e.notification.data?.url || "/")));
});
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sebway has moved</title>
<meta name="theme-color" content="#183a8e">
<link rel="icon" href="${NEW}/icons/icon-192.png">
<style>
  :root { color-scheme: light dark; --bg: #f3f5fb; --card: #fff; --text: #0b1430; --muted: #4a5470; --accent: #1f3a93; }
  @media (prefers-color-scheme: dark) { :root { --bg: #050505; --card: #12151d; --text: #f2f4f8; --muted: #aab3c5; --accent: #7d9cf0; } }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--text); font: -apple-system-body; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width: min(100%, 26rem); background: var(--card); border-radius: 22px; padding: 24px 20px; box-shadow: 0 10px 30px rgb(0 0 0 / 0.12); text-align: center; }
  img { width: 64px; height: 64px; border-radius: 16px; }
  h1 { font-size: 1.6rem; margin: 14px 0 6px; }
  p { color: var(--muted); line-height: 1.45; margin: 8px 0; }
  a.btn { display: flex; align-items: center; justify-content: center; min-height: 52px; margin: 18px 0 8px; border-radius: 14px; background: #1f3a93; color: #fff; font-weight: 800; font-size: 1.1rem; text-decoration: none; }
  a.btn:active { filter: brightness(0.92); }
  ol { text-align: left; color: var(--muted); padding-left: 1.3em; line-height: 1.5; }
  strong { color: var(--text); }
</style>
</head>
<body>
<main>
  <img src="${NEW}/icons/icon-192.png" alt="">
  <h1>Sebway has moved</h1>
  <p>Sebway now lives at <strong>sebway.app</strong>. Same app, new home.</p>
  <a class="btn" id="move" href="${NEW}/">Move to sebway.app</a>
  <p id="carry">Your places, saved routes, boards and passes come along.</p>
  <ol>
    <li>Tap <strong>Move to sebway.app</strong>.</li>
    <li>iPhone: in Safari, tap Share → <strong>Add to Home Screen</strong>.</li>
    <li>In Settings: paste your Claude key again and turn alerts on.</li>
    <li>Delete this old icon.</li>
  </ol>
</main>
<script>
  // Read what the old app kept on this phone (new names first, then the old "semmute." ones).
  function read(k) {
    try {
      var v = localStorage.getItem("sebway." + k);
      if (v === null) v = localStorage.getItem("semmute." + k);
      return v === null ? null : JSON.parse(v);
    } catch (e) { return null; }
  }
  var d = read("deviceId");
  if (d) {
    var data = { d: d, n: read("userName") || undefined, t: read("theme") || undefined, tut: read("tutorialDone") || undefined };
    var bytes = new TextEncoder().encode(JSON.stringify(data));
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var b64 = btoa(bin).replace(/[+]/g, "-").replace(/[/]/g, "_").replace(/=+$/, "");
    document.getElementById("move").href = "${NEW}/#move=" + b64;
  } else {
    document.getElementById("carry").textContent = "Open it and add it to your Home Screen.";
  }
  // Replace the old app's service worker with the tiny one (clears its cache).
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
</script>
</body>
</html>`;

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cache-Control": "no-cache",
};

export default {
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/sw.js") return new Response(SW, { headers: { ...SECURITY, "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: { code: "MOVED", message: `Sebway moved to ${NEW}. Open it there.`, retryable: false } }, { status: 410, headers: SECURITY });
    }
    const share = url.searchParams.get("share");
    if (share) return Response.redirect(`${NEW}/?share=${encodeURIComponent(share)}`, 302);
    return new Response(PAGE, { headers: { ...SECURITY, "Content-Type": "text/html; charset=utf-8" } });
  },
};
