// Apply the saved Light/Dark choice before the first paint (Auto = follow the phone).
// Its own file (not inline) so the Content-Security-Policy can allow scripts from Sebway only.
try {
  var t = JSON.parse(localStorage.getItem("sebway.theme") || localStorage.getItem("semmute.theme")); // old name before the move
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
