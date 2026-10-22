// Sebway app: trip search, disruptions, chat and settings. No build step, plain ES modules.

const $ = (sel) => document.querySelector(sel);

/** HIG: respect Reduce Motion (no smooth scrolling animations). */
const scrollMode = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// ---------- Storage (can be unavailable in private mode, so never assume it works) ----------

// The app was called Semmute before: move this phone's saved data to the new names once.
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("semmute.")) continue;
    const renamed = `sebway.${k.slice("semmute.".length)}`;
    if (localStorage.getItem(renamed) === null) localStorage.setItem(renamed, localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch {}

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`sebway.${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(`sebway.${key}`, JSON.stringify(value)); } catch {}
  },
  remove(key) {
    try { localStorage.removeItem(`sebway.${key}`); } catch {}
  },
};

// Moved from the old workers.dev address: the "Move to sebway.app" button passes this phone's
// device id (and name, theme, tutorial seen) in the #fragment, which never reaches a server. With the
// same device id, saved places, routes, boards and passes reload from the server. The Claude key is
// never moved: it has to be pasted again.
const movedIn = (() => {
  const m = /^#move=([A-Za-z0-9_-]{10,2000})$/.exec(location.hash);
  if (!m) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.d ?? "")) {
      store.set("deviceId", data.d.toLowerCase());
      store.remove("userData"); // reload saved places/routes from the server for this device
    }
    if (typeof data.n === "string" && data.n.trim()) store.set("userName", data.n.trim().slice(0, 30));
    if (data.t === "light" || data.t === "dark") {
      store.set("theme", data.t);
      document.documentElement.dataset.theme = data.t;
    }
    if (data.tut) store.set("tutorialDone", true);
  } catch {}
  history.replaceState(null, "", location.pathname + location.search);
  return true;
})();

// ---------- Personal data: saved routes, boards, passes ----------
// Kept on the device and copied to the server (by device id) so saved routes can be checked for
// disruptions in the background. The Claude key is never part of this.

const EMPTY_DATA = { version: 1, places: [], routes: [], boards: [], passes: [], walk_min: 10 };
let userData = { ...EMPTY_DATA, ...store.get("userData", { walk_min: store.get("walkMin", 10) }) };
let syncTimer;

function saveUserData() {
  store.set("userData", userData);
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const { version, places, routes, boards, passes, walk_min } = userData;
    api("/api/me", { method: "PUT", body: { version, places, routes, boards, passes, walk_min } }).catch(() => {
      // Offline or rate-limited: the local copy is the source of truth; next save retries.
    });
  }, 800);
}

/** First run on this device (or after clearing storage): pick up what the server has. */
async function loadUserDataFromServer() {
  if (store.get("userData")) return;
  try {
    const remote = await api("/api/me");
    if (remote.updated_at) {
      userData = { ...EMPTY_DATA, ...remote };
      store.set("userData", userData);
      renderHome();
    }
  } catch {}
}

const newId = () => crypto.randomUUID().slice(0, 8);

function deviceId() {
  let id = store.get("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    store.set("deviceId", id);
  }
  return id;
}

// ---------- Formatting ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" });
const hhmm = (iso) => (iso ? timeFmt.format(new Date(iso)) : "–");

const SOURCE_NAMES = { irail: "iRail (SNCB)", stib: "STIB", delijn: "De Lijn", transitous: "Transitous" };
const sourceName = (s) => String(s ?? "").split(",").map((p) => SOURCE_NAMES[p] ?? p).join(" · ");

function sourceLine(meta) {
  if (!meta) return "";
  const stale = meta.stale ? ` · <span class="stale">may be outdated</span>` : "";
  return `<p class="source">Data: ${esc(sourceName(meta.source))} · ${hhmm(meta.fetched_at)}${stale}</p>`;
}

/** Shown time is the real (expected) time when known, else the timetable time. */
const shownTime = (t) => t?.expected ?? t?.scheduled;

function delayHtml(t) {
  if (t?.delay_min > 0) return ` <span class="delay">+${t.delay_min}</span>`;
  return "";
}

function statusPill(t, cancelled) {
  if (cancelled) return `<span class="pill bad">Cancelled</span>`;
  if (!t?.realtime) return `<span class="pill plain">Timetable</span>`;
  if (t.delay_min > 0) return `<span class="pill late">+${t.delay_min} min</span>`;
  return `<span class="pill ok">On time</span>`;
}

/**
 * The word on a platform sign, like the real ones: "Spoor" in Flanders, "Voie" in Wallonia, "Gleis" in
 * the German-speaking east, and in bilingual Brussels the two alternate (odd Voie, even Spoor), as on
 * SBB's signs in bilingual stations. Worked out from the station's position (rough language border).
 */
function platformWord(stop, n, mode = "train") {
  const lat = Number(stop?.lat);
  const lon = Number(stop?.lon);
  // Buses and trams stop at a bay, not a railway track: Perron (NL) / Quai (FR) / Steig (DE).
  const [nl, fr, de] = mode === "bus" || mode === "tram" ? ["Perron", "Quai", "Steig"] : ["Spoor", "Voie", "Gleis"];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return mode === "bus" || mode === "tram" ? "Bay" : "Platform";
  if (lat > 50.76 && lat < 50.92 && lon > 4.24 && lon < 4.49) return Number.parseInt(n, 10) % 2 ? fr : nl;
  if (lon > 5.95 && lat > 50.2 && lat < 50.78) return de;
  return lat >= 50.755 ? nl : fr;
}

/** Platform as a station sign: navy square, white inner border, small word, big number. */
function platformHtml(p, stop, size = "sm", mode = "train") {
  if (!p) return "";
  const n = p.actual ?? p.scheduled;
  if (!n) return "";
  const word = platformWord(stop, n, mode);
  const changed = p.changed ? ` changed` : "";
  return ` <span class="plat ${size}${changed}" role="img" aria-label="Platform ${esc(n)}${p.changed ? ", changed" : ""}" title="${p.changed ? "Platform changed" : `Platform ${esc(n)}`}"><span class="plat-in"><small>${esc(p.changed ? "New" : word)}</small><b>${esc(n)}</b></span></span>`;
}

/** Red warning triangle (strikes): urgent, like a road sign. */
const RED_TRIANGLE = `<svg class="tri" viewBox="0 0 24 22" aria-hidden="true"><path d="M12 2.2 22.6 20.3H1.4z" fill="#fff" stroke="#e3001b" stroke-width="2.4" stroke-linejoin="round"/><path d="M12 8.6v5.6" stroke="#e3001b" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="17.1" r="1.45" fill="#e3001b"/></svg>`;

const MODE_LABEL = { train: "Train", metro: "Metro", tram: "Tram", bus: "Bus" };

// Line icons for each mode (24×24, stroke = currentColor), used on labels and the home divider.
const MODE_ICON_PATHS = {
  train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 10h14M12 3v7M8 21l2-4M16 21l-2-4"/><circle cx="8.5" cy="13.5" r="1" fill="currentColor"/><circle cx="15.5" cy="13.5" r="1" fill="currentColor"/>',
  tram: '<path d="M9 2h6M12 2v4"/><rect x="5" y="6" width="14" height="12" rx="2"/><path d="M5 12h14M8 22l1.5-4M16 22l-1.5-4"/><circle cx="8.5" cy="15" r="1" fill="currentColor"/><circle cx="15.5" cy="15" r="1" fill="currentColor"/>',
  bus: '<rect x="4" y="3" width="16" height="15" rx="2"/><path d="M4 11h16M7 18v2.5M17 18v2.5"/><circle cx="8" cy="14.5" r="1" fill="currentColor"/><circle cx="16" cy="14.5" r="1" fill="currentColor"/>',
  metro: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7.5 16.5v-9l4.5 5.5 4.5-5.5v9"/>',
};
const modeIcon = (mode) =>
  MODE_ICON_PATHS[mode]
    ? `<svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MODE_ICON_PATHS[mode]}</svg>`
    : "";

/** "Leave in 7 min (by 16:50)": recomputed every few seconds from the leave-by time. */
function leaveText(leaveIso, departIso) {
  const now = Date.now();
  const mins = Math.round((new Date(leaveIso).getTime() - now) / 60_000);
  const departed = departIso && new Date(departIso).getTime() < now;
  if (departed) return { text: "Departed", cls: "gone" };
  if (mins > 60) return { text: `Leave by ${hhmm(leaveIso)}`, cls: "" };
  if (mins >= 1) return { text: `Leave in ${mins} min · by ${hhmm(leaveIso)}`, cls: mins <= 5 ? "soon" : "" };
  if (mins >= -1) return { text: "Leave now", cls: "now" };
  return { text: `Should have left at ${hhmm(leaveIso)}: hurry`, cls: "late" };
}

function updateCountdowns() {
  for (const el of document.querySelectorAll("[data-leave-by]")) {
    const { text, cls } = leaveText(el.dataset.leaveBy, el.dataset.departs);
    el.textContent = text;
    el.className = `leave-by ${cls}`;
  }
}
setInterval(updateCountdowns, 15_000);

// ---------- API ----------

class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = error?.code ?? "HTTP_ERROR";
    this.candidates = error?.candidates ?? [];
    this.retryable = error?.retryable ?? true;
  }
}

async function api(path, { method = "GET", body, headers = {}, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: { "X-Device-Id": deviceId(), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError(0, { code: "OFFLINE", message: "No connection. Check your internet and try again." });
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, data?.error);
  decodeShapes(data);
  return data;
}

/** Door-to-door trips arrive with encoded route shapes; decode them once here (cheap on the phone). */
function decodeShapes(data) {
  for (const j of data?.journeys ?? []) {
    for (const l of j.legs ?? []) if (l.path_enc && !l.path) l.path = decodePolyline(l.path_enc.points, l.path_enc.precision);
    if (j.walk_paths_enc && !j.walk_paths) j.walk_paths = j.walk_paths_enc.map((w) => decodePolyline(w.points, w.precision));
  }
}

function decodePolyline(str, precision = 7, max = 200) {
  const factor = 10 ** precision;
  const pts = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    pts.push([lat / factor, lon / factor]);
  }
  if (pts.length <= max) return pts;
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, k) => pts[Math.round(k * step)]);
}

const qs = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

// ---------- Navigation ----------

const views = ["trip", "boards", "chat", "settings", "journey", "shared"];

function showView(name) {
  for (const v of views) $(`#view-${v}`).hidden = v !== name;
  for (const b of document.querySelectorAll(".tabbar button")) {
    // The journey screen belongs to the Trip tab.
    if (b.dataset.view === (name === "journey" ? "trip" : name)) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  if (name !== "journey" && name !== "shared") store.set("view", name);
  window.scrollTo({ top: 0 });
  if (name === "chat") {
    renderChat();
    window.scrollTo({ top: document.body.scrollHeight });
  }
  if (name === "settings") renderSettings();
  if (name === "boards") renderBoards();
  else stopBoardRefresh();
  if (name === "trip") {
    renderHome();
    renderJourneyBanner();
  }
  if (name === "journey") enterJourneyView();
  else leaveJourneyView();
  if (name !== "shared") stopSharedView();
}

for (const b of document.querySelectorAll(".tabbar button")) b.addEventListener("click", () => showView(b.dataset.view));

// ---------- Fields with an icon ----------
// A field tagged data-icon="…" becomes one rounded box: icon, small label, then the input
// (the stop/date/time fields of the Trip form, boards and settings).

const FIELD_ICONS = {
  origin: '<circle cx="12" cy="10" r="2.6"/><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/>',
  pin: '<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.6" fill="currentColor"/>',
  when: '<path d="M4 12h11M11 7l5 5-5 5"/><path d="M20 5v14"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01" stroke-width="2.6"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  stop: '<path d="M12 21V10"/><rect x="6.5" y="3" width="11" height="7" rx="1.8"/><path d="M9 21h6"/>',
  bus: '<rect x="5" y="3.5" width="14" height="14" rx="3"/><path d="M5 11h14M8.5 20.5v-3M15.5 20.5v-3"/><path d="M8.5 14.3h.01M15.5 14.3h.01" stroke-width="2.6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/>',
  walk: '<circle cx="13.5" cy="3.75" r="1.75" fill="currentColor" stroke="none"/><path d="M12.5 7.5l-1.5 6"/><path d="M11 13.5l-2.5 3.5-1 4"/><path d="M11 13.5l3 3 .5 4.5"/><path d="M8 10.5l4-3 2.5 3 2.5 1"/>',
  ticket: '<path d="M3.5 8.5v-2A1.5 1.5 0 0 1 5 5h14a1.5 1.5 0 0 1 1.5 1.5v2a2.5 2.5 0 0 0 0 5v2A1.5 1.5 0 0 1 19 17H5a1.5 1.5 0 0 1-1.5-1.5v-2a2.5 2.5 0 0 0 0-5z"/><path d="M14.5 5.5v11" stroke-dasharray="1.6 2.2"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
};
const iconSvg = (name, cls) =>
  `<svg class="${cls}" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FIELD_ICONS[name] ?? ""}</svg>`;

for (const label of document.querySelectorAll("label.field[data-icon]")) {
  const body = document.createElement("div");
  body.className = "ifield-body";
  body.append(...label.childNodes);
  label.classList.add("ifield");
  label.innerHTML = iconSvg(label.dataset.icon, "ifield-icon");
  label.append(body);
  for (const chip of body.querySelectorAll(".now-chip")) label.append(chip); // sits at the right edge of the box
  if (body.querySelector("select")) label.insertAdjacentHTML("beforeend", '<svg class="ifield-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>');
}

// ---------- Trip form ----------

/** From field has focus (the "Use My Current Location" option shows while choosing a start). */
let fromFocused = false;

const form = {
  mode: store.get("tripMode", "train"),
  get from() { return $("#from").value.trim(); },
  get to() { return $("#to").value.trim(); },
};

const MODE_UI = {
  train: { from: "From station", to: "To station", fromPh: "Bruxelles-Midi", toPh: "Gent-Sint-Pieters", fromOp: "sncb", toOp: "sncb" },
  // Door to door: any stop or station in Belgium (SNCB, STIB, De Lijn, TEC), planned by Transitous.
  commute: { from: "From", to: "To", fromPh: "Stop, address or place", toPh: "Stop, address or place", fromOp: undefined, toOp: undefined, places: true },
};

function applyMode(mode) {
  form.mode = mode;
  store.set("tripMode", mode);
  const ui = MODE_UI[mode];
  for (const b of document.querySelectorAll("#trip-form .seg button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  $("#from-label").textContent = ui.from;
  $("#to-label").textContent = ui.to;
  $("#from").placeholder = ui.fromPh;
  $("#to").placeholder = ui.toPh;
  const last = store.get(`last.${mode}`, {});
  setStop($("#from"), last.from, last.fromId, last.fromLat, last.fromLon);
  setStop($("#to"), last.to, last.toId, last.toLat, last.toLon);
  updateMyLocation();
}

for (const b of document.querySelectorAll("#trip-form .seg button")) b.addEventListener("click", () => applyMode(b.dataset.mode));

// Swap keeps everything each field knew (stop id, coordinates, the ✓ line), so no new lookup is needed.
$("#swap").addEventListener("click", async () => {
  const [f, t] = [$("#from"), $("#to")];
  // Tapping swap right after typing first finishes that field's lookup, so its result lands in the right field.
  await Promise.all([f.pending, t.pending]);
  const snap = (input) => {
    const hint = hintEl(input);
    return { value: input.value, data: { ...input.dataset }, hint: hint && !hint.hidden ? [hint.textContent, hint.className.replace("stop-hint", "").trim()] : ["", ""] };
  };
  const put = (input, x) => {
    setStop(input, x.value);
    Object.assign(input.dataset, x.data);
    stopHint(input, ...x.hint);
  };
  const [a, b] = [snap(f), snap(t)];
  put(f, b);
  put(t, a);
});

// × in each stop field: empty it and put the cursor there, ready for a new place.
for (const btn of document.querySelectorAll("[data-clear]")) {
  btn.addEventListener("click", () => {
    const input = $(`#${btn.dataset.clear}`);
    setStop(input, "");
    $(`#${btn.dataset.clear}-list`).innerHTML = "";
    input.focus();
  });
}

// Door to door can start from where you are: the phone's GPS, used once for this search only.
// Offered under From only while you're choosing a start (From empty or being typed in), like Maps.
function updateMyLocation() {
  const btn = document.getElementById("my-location");
  if (!btn) return;
  const canUse = Boolean(MODE_UI[form.mode]?.places) && "geolocation" in navigator;
  btn.hidden = !canUse || !(fromFocused || !$("#from").value.trim());
}
$("#from").addEventListener("focus", () => {
  fromFocused = true;
  updateMyLocation();
});
$("#from").addEventListener("blur", () => {
  // Wait a moment so a tap on the suggestion still lands.
  setTimeout(() => {
    fromFocused = false;
    updateMyLocation();
  }, 250);
});
$("#from").addEventListener("input", updateMyLocation);
$("#my-location").addEventListener("click", () => {
  const btn = $("#my-location");
  btn.disabled = true;
  stopHint($("#from"), "Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      const { latitude: lat, longitude: lon } = pos.coords;
      setStop($("#from"), "My location", undefined, Number(lat.toFixed(5)), Number(lon.toFixed(5)));
      stopHint($("#from"), "📍 Your current location", "ok");
      fromFocused = false;
      updateMyLocation();
    },
    (err) => {
      btn.disabled = false;
      stopHint($("#from"), err.code === 1 ? "Location is off for Sebway. Allow it in your phone's settings, or type an address." : "Couldn't find your location. Type an address instead.", "warn");
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
  );
});

// Date: today or later. Empty means today.
const todayIso = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Brussels" });
$("#date").min = todayIso();

// Grey hint inside empty date/time fields ("Today", "Now", "Pick a date").
function refreshGhosts() {
  // The time box follows "Plan by": Departure time (empty = now) or Arrival time (pick one).
  const arrive = $("#when-type").value === "arrive";
  $("#time-label").textContent = arrive ? "Arrival time" : "Departure time";
  $("#time").dataset.ghost = arrive ? "Pick a time" : "Now";
  const timeGhost = $("#time").parentElement.querySelector(".ghost");
  if (timeGhost) timeGhost.textContent = $("#time").dataset.ghost;
  $("#time").closest(".when-time")?.classList.toggle("arrive", arrive);
  for (const input of document.querySelectorAll("input[data-ghost]")) input.parentElement.classList.toggle("is-empty", !input.value);
  // "↺ Now" only when another date or time is picked (empty already means now).
  const now = document.getElementById("now");
  if (now) now.hidden = !$("#date").value && !$("#time").value;
}
for (const input of document.querySelectorAll("input[data-ghost]")) {
  const ghost = document.createElement("span");
  ghost.className = "ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.textContent = input.dataset.ghost;
  input.after(ghost);
  for (const ev of ["input", "change", "blur"]) input.addEventListener(ev, refreshGhosts);
}
refreshGhosts();
$("#when-type").addEventListener("change", refreshGhosts);

$("#now").addEventListener("click", (e) => {
  e.preventDefault(); // inside the Time label: don't open the time picker
  $("#date").value = "";
  $("#time").value = "";
  $("#when-type").value = "depart"; // "now" means leaving now
  refreshGhosts();
  // Show it worked: refresh the results for now, if any are on screen.
  if ($("#results").children.length && form.from && form.to) searchTrip();
});

// ---------- Stop fields: suggestions while typing, auto-select when you leave the field ----------
// When a field loses focus, Sebway looks the name up, fills in the exact stop and remembers its id.
// Searches then use the id, so spelling ("Trône", "Trone / Troon") no longer matters.

const OPERATOR_NAME = { sncb: "SNCB", stib: "STIB", delijn: "De Lijn", tec: "TEC", other: "Other" };
const normName = (x) => String(x ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

/** The status line under a stop field (below the box for icon fields). */
function hintEl(input, create = false) {
  const box = input.closest(".ifield");
  const field = input.closest(".field") ?? input.parentElement;
  let el = box ? (box.nextElementSibling?.classList.contains("stop-hint") ? box.nextElementSibling : null) : field.querySelector(".stop-hint");
  if (!el && create) {
    el = document.createElement("p");
    el.className = "stop-hint";
    el.setAttribute("role", "status");
    if (box) box.after(el);
    else field.append(el);
  }
  return el;
}

function stopHint(input, text = "", cls = "") {
  const el = hintEl(input, true);
  el.textContent = text;
  el.className = `stop-hint ${cls}`;
  el.hidden = !text;
}

/** Remember an already-known stop on a field (e.g. from a saved route), without a lookup. */
function setStop(input, name, id, lat, lon) {
  input.value = name ?? "";
  for (const k of ["stopId", "stopName", "stopLat", "stopLon"]) delete input.dataset[k];
  if (id) {
    input.dataset.stopId = id;
    input.dataset.stopName = name;
  }
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    input.dataset.stopLat = lat;
    input.dataset.stopLon = lon;
    input.dataset.stopName = name;
  }
  stopHint(input);
  if (input.id === "from") updateMyLocation();
}

/** Coordinates of the selected stop, if the field still shows it. */
function stopCoords(input) {
  if (input.dataset.stopName !== input.value.trim() || !input.dataset.stopLat) return {};
  return { lat: Number(input.dataset.stopLat), lon: Number(input.dataset.stopLon) };
}

/** What to send to the API for a field: the resolved id when we have one, else the typed text. */
const stopArg = (input) => (input.dataset.stopId && input.dataset.stopName === input.value.trim() ? input.dataset.stopId : input.value.trim());

/** Addresses and places picked from the suggestions (door to door), by label. */
const placeMap = new Map();
const hasPlaces = () => Boolean(MODE_UI[form.mode].places);

function setPlace(input, p) {
  setStop(input, p.label, undefined, p.lat, p.lon);
  stopHint(input, `📍 ${p.kind === "address" ? "Address" : "Place"} · ${p.label}`, "ok");
}

/** Bias address search towards the other field (or Belgium's middle when it's empty). */
function nearFor(input) {
  const other = input.id === "from" ? $("#to") : $("#from");
  const c = stopCoords(other);
  return c.lat ? `${c.lat},${c.lon}` : undefined;
}

/** Look the typed name up and select the best match. Returns false when nothing matches.
 *  Door to door also accepts addresses and places ("Wetstraat 16", "Atomium"). */
async function resolveStop(input, operator) {
  const q = input.value.trim();
  if (!q) return true;
  if (input.dataset.stopName === q && (input.dataset.stopId || input.dataset.stopLat)) return true;
  if (hasPlaces() && placeMap.has(q)) {
    setPlace(input, placeMap.get(q));
    return true;
  }
  const placesPromise = hasPlaces()
    ? api(`/api/places?${qs({ q, near: nearFor(input) })}`).then((d) => d.places ?? []).catch(() => [])
    : Promise.resolve([]);
  let stops = [];
  let stopErr;
  try {
    ({ stops } = await api(`/api/stops?${qs({ q, operator })}`));
  } catch (err) {
    stopErr = err;
  }
  const places = await placesPromise;
  if (input.value.trim() !== q) return true; // the field changed meanwhile: this answer is stale
  const exact = stops.find((st) => normName(st.name) === normName(q) || Object.values(st.names ?? {}).some((n) => normName(n) === normName(q)));
  // A house number means an address; otherwise a stop with that name wins over a place.
  const looksLikeAddress = /\d/.test(q);
  if (!exact && places.length && (looksLikeAddress || !stops.length)) {
    setPlace(input, places[0]);
    return true;
  }
  const best = exact ?? stops[0];
  if (best) {
    setStop(input, best.name, best.id, best.lat, best.lon);
    stopHint(input, `✓ ${best.name} · ${OPERATOR_NAME[best.operator] ?? best.operator}`, "ok");
    return true;
  }
  delete input.dataset.stopId;
  if (!stopErr || stopErr.code === "STOP_NOT_FOUND" || stopErr.code === "NO_RESULTS") {
    if (form.mode === "train") {
      stopHint(input, `No station called “${q}”. For an address or place, use Door to Door.`, "bad");
      offerDoorToDoor();
    } else {
      stopHint(input, `Nothing found for “${q}”. Try a stop name, a street with number, or a place.`, "bad");
    }
    return false;
  }
  // The operator's data is down: keep the text and say so, instead of claiming the stop doesn't exist.
  const who = OPERATOR_NAME[operator] ?? "Transit";
  stopHint(input, stopErr.code?.startsWith("UPSTREAM") ? `Couldn't check this stop: ${who} data is unavailable right now.` : "Couldn't check this stop right now.", "warn");
  return true;
}

/** Train mode only knows stations: offer to plan the same trip door to door, keeping what was typed. */
function offerDoorToDoor() {
  const results = $("#results");
  results.innerHTML = `<div class="notice">Train mode searches stations only. Door to Door finds any address, place or stop in Belgium and the nearest stops to it.
    <p><button type="button" class="btn small" id="go-d2d">Switch to Door to Door</button></p></div>`;
  $("#go-d2d").addEventListener("click", () => {
    const [f, t] = [form.from, form.to];
    applyMode("commute");
    setStop($("#from"), f);
    setStop($("#to"), t);
    searchTrip();
  });
}

/** Suggestions wait until you've stopped typing for this long (not at every short pause). */
const SUGGEST_PAUSE_MS = 800;

function attachStopField(input, list, operatorFor) {
  let timer;
  let controller;
  input.addEventListener("input", () => {
    avoidRail = false;
    for (const k of ["stopId", "stopName", "stopLat", "stopLon"]) delete input.dataset[k];
    stopHint(input);
    clearTimeout(timer);
    controller?.abort();
    list.innerHTML = ""; // no stale suggestions while you're still typing
    const q = input.value.trim();
    if (q.length < 3) return;
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const signal = controller.signal;
        const [data, placeData] = await Promise.all([
          api(`/api/stops?${qs({ q, operator: operatorFor() })}`, { signal }).catch(() => ({ stops: [] })),
          hasPlaces() && q.length >= 3 ? api(`/api/places?${qs({ q, near: nearFor(input) })}`, { signal }).catch(() => ({ places: [] })) : { places: [] },
        ]);
        if (signal.aborted) return;
        const stopNames = new Set(data.stops.map((st) => normName(st.name)));
        const places = (placeData.places ?? []).filter((p) => !stopNames.has(normName(p.label)));
        for (const p of places) placeMap.set(p.label, p);
        // Addresses first when a house number was typed, stops first otherwise.
        const stopOpts = data.stops.slice(0, 6).map((st) => `<option value="${esc(st.name)}">${esc(OPERATOR_NAME[st.operator] ?? "")}</option>`);
        const placeOpts = places.slice(0, 5).map((p) => `<option value="${esc(p.label)}">📍 ${p.kind === "address" ? "Address" : "Place"}</option>`);
        list.innerHTML = (/\d/.test(q) ? [...placeOpts, ...stopOpts] : [...stopOpts, ...placeOpts]).join("");
      } catch {
        // Suggestions are optional; typing still works.
      }
    }, SUGGEST_PAUSE_MS);
  });
  // Leaving the field (or picking a suggestion) selects the stop.
  input.addEventListener("change", () => {
    input.pending = resolveStop(input, operatorFor()).finally(() => (input.pending = null));
  });
}
attachStopField($("#from"), $("#from-list"), () => MODE_UI[form.mode].fromOp);
attachStopField($("#to"), $("#to-list"), () => MODE_UI[form.mode].toOp);

$("#trip-form").addEventListener("submit", (e) => {
  e.preventDefault();
  searchTrip();
});

let tripController;
let refreshTimer;
/** SNCB strike day: the user chose to plan door to door without trains (cleared when the trip changes). */
let avoidRail = false;
const REFRESH_MS = 60_000;

/** Live searches ("now") refresh every minute while the Trip tab is on screen, so alerts stay current. */
function scheduleRefresh(live) {
  clearTimeout(refreshTimer);
  if (!live) return;
  refreshTimer = setTimeout(() => {
    if (document.visibilityState === "visible" && !$("#view-trip").hidden) searchTrip({ quiet: true });
    else scheduleRefresh(true);
  }, REFRESH_MS);
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && store.get("liveSearch") && !$("#view-trip").hidden) searchTrip({ quiet: true });
});

async function searchTrip({ quiet = false } = {}) {
  if (!form.from || !form.to) return;
  if (!quiet) {
    const ok = await Promise.all([resolveStop($("#from"), MODE_UI[form.mode].fromOp), resolveStop($("#to"), MODE_UI[form.mode].toOp)]);
    if (ok.includes(false)) {
      if (!$("#go-d2d")) $("#results").innerHTML = "";
      return;
    }
  }
  const from = stopArg($("#from"));
  const to = stopArg($("#to"));
  const time = $("#time").value || undefined;
  const date = $("#date").value && $("#date").value !== todayIso() ? $("#date").value : undefined;
  const mode = form.mode;
  const live = !time && !date;
  store.set("liveSearch", live);

  const fc = stopCoords($("#from"));
  const tc = stopCoords($("#to"));
  const last = { from: form.from, to: form.to, fromId: $("#from").dataset.stopId, toId: $("#to").dataset.stopId, fromLat: fc.lat, fromLon: fc.lon, toLat: tc.lat, toLon: tc.lon };
  // "My location" is only valid now: don't bring back an old position next time.
  if (form.from === "My location") Object.assign(last, { from: "", fromLat: undefined, fromLon: undefined });
  store.set(`last.${mode}`, last);

  tripController?.abort();
  tripController = new AbortController();
  const results = $("#results");
  if (!quiet) results.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span>Checking live data…</div>`;
  $("#search").disabled = true;

  if (!quiet) {
    $("#disruptions-title").hidden = false;
    $("#disruptions").innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span>Checking every station on your trip…</div>`;
  }

  try {
    const arriveBy = $("#when-type").value === "arrive" ? "true" : undefined;
    lastRequest =
      mode === "train"
        ? { path: "/api/journey", params: { from, to, date, time, arrive_by: arriveBy, results: 4, walk: userData.walk_min }, toName: form.to }
        : { path: "/api/trip", params: { from, to, from_lat: fc.lat, from_lon: fc.lon, from_name: form.from, to_lat: tc.lat, to_lon: tc.lon, to_name: form.to, date, time, arrive_by: arriveBy, avoid: avoidRail ? "rail" : undefined }, toName: form.to, toCoords: tc };
    const data = await api(`${lastRequest.path}?${qs(lastRequest.params)}`, { signal: tripController.signal });

    if (!data.journeys?.length) {
      results.innerHTML = `<div class="notice">No connections found for this time. Try a later time.</div>${sourceLine(data.meta)}`;
      return;
    }
    const warnings = data.warnings?.length
      ? `<details class="alerts card"><summary><strong>${data.warnings.length} service alert${data.warnings.length > 1 ? "s" : ""} on this route</strong></summary>${data.warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</details>`
      : "";
    const liveLine = live ? `<p class="source">● Live · updates every minute · last ${hhmm(data.meta?.fetched_at)}</p>` : "";
    currentJourneys = data.journeys;
    const disruptionsById = new Map((data.route_disruptions?.items ?? []).map((d) => [d.id, d]));
    const credit = data.meta?.source === "transitous" ? transitousCredit() : "";
    results.innerHTML = saveRouteButton(mode, form.from, form.to) + strikeBanner(data, mode) + summaryBanner(data.journeys) + warnings + data.journeys.map((j, i) => journeyCard(j, disruptionsById, i)).join("") + sourceLine(data.meta) + credit + liveLine;
    renderRouteDisruptions(data.route_disruptions);
    scheduleRefresh(live);
  } catch (err) {
    if (err.name === "AbortError") return;
    if (!quiet) renderRouteDisruptions(null);
    // A failed background refresh keeps the last results on screen and tries again later.
    if (quiet) return scheduleRefresh(live);
    results.innerHTML = errorNotice(err, mode === "train" ? "SNCB" : "Transit");
    for (const btn of results.querySelectorAll("[data-pick]")) {
      btn.addEventListener("click", () => {
        const target = btn.dataset.field === "to" ? $("#to") : $("#from");
        setStop(target, btn.dataset.pick, btn.dataset.pickId);
        searchTrip();
      });
    }
  } finally {
    $("#search").disabled = false;
  }
}

/** Required credit for the door-to-door planner (transitous.org/api). */
const transitousCredit = () =>
  `<p class="source">Door-to-door routes by <a href="https://transitous.org/sources/" target="_blank" rel="noopener">Transitous</a>, from the open timetables of SNCB, STIB, De Lijn and TEC and OpenStreetMap.</p>`;

/** Top-of-results alert: the next trip has a problem, or the best option isn't the first one. */
const OP_LABEL = { sncb: "SNCB", stib: "STIB", delijn: "De Lijn", tec: "TEC" };
const opNames = (ops) => ops.map((o) => OP_LABEL[o] ?? o.toUpperCase()).join(" and ");

/** Strike day: how many trips may not run, and a way to plan without trains (SNCB strikes). */
function strikeBanner(data, mode) {
  if (data.avoid === "rail") {
    return `<div class="banner strike" role="status"><strong>Trips without trains</strong><div>Because of the SNCB strike: metro, tram and bus only.</div><div class="choices"><button type="button" class="btn small" data-strike-all>Show All Trips</button></div></div>`;
  }
  const hit = data.journeys.filter((j) => j.strike);
  if (!hit.length) return "";
  const ops = [...new Set(hit.flatMap((j) => j.strike.operators))];
  const all = hit.length === data.journeys.length;
  const what = all ? `All these trips use ${opNames(ops)}` : `${hit.length} of ${data.journeys.length} trips use ${opNames(ops)} (shown last)`;
  const action = ops.includes("sncb")
    ? `<div class="choices"><button type="button" class="btn small btn-avoid" data-strike-avoid>${mode === "train" ? "Plan Without Trains" : "Avoid Trains"}</button></div>`
    : "";
  return `<div class="banner strike" role="alert"><strong>${RED_TRIANGLE}${esc(opNames(ops))} strike · ${esc(hit[0].strike.when)}</strong><div>${what} and may not run. Strike notices rarely say which ones will run, so check before you leave.</div>${action}</div>`;
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-strike-avoid]")) {
    avoidRail = true;
    // Train mode only knows trains: plan the same trip door to door instead.
    if (form.mode === "train") {
      const [f, t] = [$("#from"), $("#to")];
      const keep = [f, t].map((i) => ({ v: i.value, d: { ...i.dataset } }));
      applyMode("commute");
      [f, t].forEach((i, k) => {
        setStop(i, keep[k].v);
        Object.assign(i.dataset, keep[k].d);
      });
    }
    searchTrip();
  }
  if (e.target.closest("[data-strike-all]")) {
    avoidRail = false;
    searchTrip();
  }
});

function summaryBanner(journeys) {
  const first = journeys[0]?.analysis;
  if (!first || first.level === "ok") return "";
  const label = first.level === "at_risk" ? "Your next connection is tight" : first.level === "cancelled" ? "Your next trip is cancelled" : "Your next connection will be missed";
  const alt = first.alternative
    ? `Best option: the ${hhmm(first.alternative.departure)}, arriving ${hhmm(first.alternative.arrival)}.`
    : first.level === "at_risk"
      ? "You can still make it if you go straight to the next stop."
      : "No working alternative in these results. Try a later time.";
  return `<div class="banner ${first.level === "at_risk" ? "warn" : "bad"}" role="alert"><strong>${label}</strong><div>${alt}</div></div>`;
}

function errorNotice(err, operatorName) {
  if (err.code === "STOP_AMBIGUOUS" && err.candidates.length) {
    // Work out which field the ambiguous name came from.
    const field = err.message.includes(`"${form.to}"`) ? "to" : "from";
    const choices = err.candidates
      .slice(0, 6)
      .map((c) => `<button type="button" class="btn small" data-pick="${esc(c.name)}" data-pick-id="${esc(c.id)}" data-field="${field}">${esc(c.name)}</button>`)
      .join("");
    return `<div class="notice"><strong>Which stop do you mean?</strong><div class="choices">${choices}</div></div>`;
  }
  if (err.code === "NO_RESULTS") return `<div class="notice">No connections found. Try another time.</div>`;
  const retry = `<div class="choices"><button type="button" class="btn small" data-retry>Try Again</button></div>`;
  if (err.code === "STOP_NOT_FOUND") return `<div class="notice error">A stop couldn't be found. Check the spelling. If the name is right, STIB or De Lijn data may be down for a moment.${retry}</div>`;
  if (err.code === "OFFLINE") return `<div class="notice error">${esc(err.message)}${retry}</div>`;
  if (err.code === "RATE_LIMITED") return `<div class="notice error">${esc(err.message)}</div>`;
  if (err.code?.startsWith("UPSTREAM")) return `<div class="notice error">${esc(operatorName)} data not available right now.${retry}</div>`;
  return `<div class="notice error">${esc(err.message || "Something went wrong.")}${retry}</div>`;
}

// ---------- Journey card ----------

function alertHtml(a) {
  if (!a?.message) return "";
  const cls = a.level === "at_risk" ? "warn" : "bad";
  const icon = a.level === "at_risk" ? "⚠️" : "⛔";
  const alt = a.alternative
    ? `<div class="alert-alt">Take the ${hhmm(a.alternative.departure)} instead: arrives ${hhmm(a.alternative.arrival)}${a.alternative.later_min ? ` (${a.alternative.later_min} min later)` : ""}.</div>`
    : a.level === "at_risk" ? "" : `<div class="alert-alt">No other working connection in these results. Try a later time.</div>`;
  return `<div class="alert ${cls}" role="alert"><div><span aria-hidden="true">${icon}</span> ${esc(a.message)}</div>${alt}</div>`;
}

function journeyCard(j, disruptionsById = new Map(), mapIndex = null) {
  const dep = j.departure;
  const arr = j.arrival;
  const a = j.analysis;
  const delayedDep = dep.delay_min > 0 && dep.scheduled;
  const transfers = j.transfers === 0 ? "Direct" : `${j.transfers} change${j.transfers > 1 ? "s" : ""}`;
  // No countdown for a trip that won't work: the alert points to the alternative instead.
  const leave = a?.leave_by && (a.level === "ok" || a.level === "at_risk")
    ? (() => {
        const { text, cls } = leaveText(a.leave_by, shownTime(dep));
        const walk = j.walk_start_min ? ` <span class="small">· ${j.walk_start_min} min walk to ${esc(j.legs[0].from.name)}</span>` : "";
        const arrive = j.arrive_at ? ` <span class="small">· arrive ${hhmm(j.arrive_at)}</span>` : "";
        return `<div class="leave-row"><span class="leave-by ${cls}" data-leave-by="${esc(a.leave_by)}" data-departs="${esc(shownTime(dep) ?? "")}">${text}</span>${walk}${arrive}</div>`;
      })()
    : "";
  const alerts = (j.alerts ?? [])
    .map((x) => (typeof x === "string" ? x : x?.title ?? x?.description ?? x?.text))
    .filter(Boolean);
  const best = j.strike ? `<span class="pill bad pill-tri">${RED_TRIANGLE}May not run</span>` : a?.recommended && a.level === "ok" ? `<span class="pill best">Best option</span>` : "";
  const strike = j.strike ? `<div class="strike-line">${RED_TRIANGLE}${esc(opNames(j.strike.operators))} strike (${esc(j.strike.when)}): this trip uses ${esc(opNames(j.strike.operators))}.</div>` : "";
  // Sebway moved the start earlier so the change to the train isn't a sprint.
  const s = j.safer_start;
  const lw = j.less_walking;
  const lessWalk = lw
    ? `<div class="safer-start">🚌 Takes a bus instead of ${lw.saved_min} more minutes of walking${lw.later_min > 0 ? ` (arrives ${lw.later_min} min later)` : ""}.</div>`
    : "";
  const safer = s
    ? `<div class="safer-start">🛟 Safer start: leave ${s.earlier_min ? `${s.earlier_min} min earlier` : "a bit earlier"} and get ${s.change_min} min to change at ${esc(s.at)}, instead of ${Math.max(0, s.original_change_min)}.</div>`
    : "";

  return `
    <article class="card journey${j.cancelled ? " cancelled" : ""}${a ? ` level-${a.level}` : ""}">
      <div class="journey-head">
        <div>
          <div class="journey-times"><span class="nowrap">${hhmm(shownTime(dep))} → ${hhmm(shownTime(arr))}</span>${delayedDep ? ` <s>${hhmm(dep.scheduled)}</s>` : ""}</div>
          <div class="journey-sub">${j.duration_min} min · ${transfers}</div>
        </div>
        <div class="pills">${best}${statusPill(dep, j.cancelled)}</div>
      </div>
      ${strike}
      ${alertHtml(a)}
      ${tripDisruptionsHtml(j, disruptionsById)}
      ${leave}
      ${safer}
      ${lessWalk}
      <ol class="legs">${j.legs.map((leg, i) => legHtml(leg, j.legs[i - 1], a?.transfers?.find((t) => t.leg_index === i))).join("")}</ol>
      ${alerts.length ? `<div class="alerts">${alerts.map((x) => `<div>${esc(x)}</div>`).join("")}</div>` : ""}
      ${mapIndex === null ? "" : `<div class="map-row"><button type="button" class="btn small start-journey" data-start-journey="${mapIndex}">▶ Start Journey</button><button type="button" class="btn small" data-map="${mapIndex}">🗺 Show on Map</button></div><div class="map" id="map-${mapIndex}" hidden></div>`}
    </article>`;
}

function legHtml(leg, prev, check) {
  let transfer = "";
  if (leg.transfer_before && prev) {
    const t = leg.transfer_before;
    const min = check?.available_min ?? t.expected_min ?? t.scheduled_min;
    const level = check?.level ?? "ok";
    const cls = level === "broken" ? "broken" : level === "at_risk" ? "tight" : "";
    const need = check ? `, need ${check.needed_min}` : "";
    const label =
      level === "broken"
        ? `Connection missed at ${esc(t.at.name)} (${min} min)`
        : `Change at ${esc(t.at.name)} · ${min} min${t.walk_min ? ` incl. ${t.walk_min} min walk` : ""}${level === "at_risk" ? ` (tight${need})` : ""}`;
    transfer = `<li class="transfer ${cls}">${label}${check && !check.realtime ? ` <span class="small">· timetable</span>` : ""}</li>`;
  }
  const title = [leg.vehicle_id ?? leg.line, leg.direction ? `→ ${leg.direction}` : ""].filter(Boolean).join(" ");
  return `${transfer}
    <li class="leg">
      <span class="mode ${esc(leg.mode)}">${modeIcon(leg.mode)}<span>${esc(MODE_LABEL[leg.mode] ?? leg.mode)}</span></span>
      <div>
        <div class="leg-title">${esc(title || MODE_LABEL[leg.mode])}${leg.cancelled ? ` <span class="pill bad">Cancelled</span>` : ""}</div>
        <div class="leg-stop"><time>${hhmm(shownTime(leg.departure))}</time><span>${esc(leg.from.name)}${delayHtml(leg.departure)}</span>${platformHtml(leg.departure.platform, leg.from, "sm", leg.mode)}</div>
        <div class="leg-stop"><time>${hhmm(shownTime(leg.arrival))}</time><span>${esc(leg.to.name)}${delayHtml(leg.arrival)}</span>${platformHtml(leg.arrival.platform, leg.to, "sm", leg.mode)}</div>
        ${leg.departure.realtime ? "" : `<div class="small muted">Timetable time, no live data</div>`}
        ${leg.note ? `<div class="small leg-note">ⓘ ${esc(leg.note)}</div>` : ""}
      </div>
    </li>`;
}

// ---------- Departure board (used in chat data) ----------

function boardHtml(data) {
  const rows = (data.departures ?? []).slice(0, 8).map((d) => `
    <li>
      <span class="mode ${esc(d.mode)}" aria-label="${esc(MODE_LABEL[d.mode] ?? d.mode)} ${esc(d.line ?? "")}">${modeIcon(d.mode)}<span>${esc(d.line ?? MODE_LABEL[d.mode])}</span></span>
      <div><strong>${esc(d.direction ?? "")}</strong></div>${platformHtml(d.platform, data.stop, "sm", d.mode) || "<span></span>"}
      <div style="text-align:right"><strong>${hhmm(shownTime(d))}</strong><br>${statusPill(d, d.cancelled)}</div>
    </li>`);
  return `<div class="card"><div class="small muted">${esc(data.stop?.name ?? "")}</div><ul class="board">${rows.join("")}</ul>${sourceLine(data.meta)}</div>`;
}

// ---------- Disruptions ----------

const SEVERITY_RANK = { major: 0, minor: 1, info: 2 };
let disruptionController;

/** Run several disruption lookups, merge them (no duplicates), strikes first, then by severity. */
async function fetchDisruptions(queries, signal) {
  const settled = await Promise.allSettled(queries.map((q) => api(`/api/disruptions?${qs(q)}`, { signal })));
  const seen = new Map();
  const metas = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    metas.push(r.value.meta);
    for (const d of r.value.disruptions ?? []) if (!seen.has(d.id)) seen.set(d.id, { ...d, _planned: queries[settled.indexOf(r)].type === "planned" });
  }
  const list = [...seen.values()].sort(
    (a, b) => (a.type === "strike" ? -1 : 0) - (b.type === "strike" ? -1 : 0) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  return { list, metas, failed: settled.every((r) => r.status === "rejected") };
}

// ---------- Route map (Leaflet + OpenStreetMap, loaded on first use) ----------

let currentJourneys = [];
let lastRequest = null;
let leafletLoading;

function loadLeaflet() {
  leafletLoading ??= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    css.integrity = "sha384-c6Rcwz4e4CITMbu/NBmnNS8yN2sC3cUElMEMfP3vqqKFp7GOYaaBBCqmaWBjmkjb";
    css.crossOrigin = "anonymous";
    document.head.append(css);
    const js = document.createElement("script");
    js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    js.integrity = "sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO";
    js.crossOrigin = "anonymous";
    js.onload = () => resolve(window.L);
    js.onerror = () => {
      leafletLoading = null;
      reject(new Error("Map could not load. Check your connection."));
    };
    document.head.append(js);
  });
  return leafletLoading;
}

const sameStop = (a, b) => a.id === b.id || a.name.toLowerCase() === b.name.toLowerCase();

/** Points for one leg. Trains follow their real stops (from train status); other legs are a straight line. */
async function legPoints(leg) {
  if (leg.path?.length > 1) return { points: leg.path, stops: [] };
  const ends = [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]];
  if (leg.mode !== "train" || !leg.vehicle_id) return { points: ends, stops: [] };
  try {
    const status = await api(`/api/train?${qs({ id: leg.vehicle_id, date: (shownTime(leg.departure) ?? "").slice(0, 10) || undefined })}`);
    const i = status.stops.findIndex((s) => sameStop(s.stop, leg.from));
    const k = status.stops.findIndex((s, n) => n > i && sameStop(s.stop, leg.to));
    if (i < 0 || k < 0) return { points: ends, stops: [] };
    const slice = status.stops.slice(i, k + 1);
    return { points: slice.map((s) => [s.stop.lat, s.stop.lon]), stops: slice.slice(1, -1).map((s) => s.stop) };
  } catch {
    return { points: ends, stops: [] };
  }
}

async function showMap(index, button) {
  const j = currentJourneys[index];
  const box = document.getElementById(`map-${index}`);
  if (!j || !box) return;
  if (!box.hidden) {
    box.hidden = true;
    button.textContent = "🗺 Show on Map";
    return;
  }
  box.hidden = false;
  button.textContent = "Hide Map";
  if (box.dataset.ready) return;
  box.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span>Loading map…</div>`;
  try {
    const [L, legs] = await Promise.all([loadLeaflet(), Promise.all(j.legs.map(legPoints))]);
    box.innerHTML = "";
    const map = L.map(box, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const css = getComputedStyle(document.documentElement);
    const colour = (mode) => css.getPropertyValue(`--${mode}`).trim() || "#19398d";
    const all = [];
    j.legs.forEach((leg, n) => {
      const { points, stops } = legs[n];
      all.push(...points);
      L.polyline(points, { color: colour(leg.mode), weight: 5, opacity: 0.9 }).addTo(map);
      for (const s of stops) L.circleMarker([s.lat, s.lon], { radius: 3, color: colour(leg.mode), weight: 2, fillOpacity: 1 }).bindTooltip(s.name).addTo(map);
      const label = `${MODE_LABEL[leg.mode] ?? leg.mode} ${leg.vehicle_id ?? leg.line ?? ""}`.trim();
      const isFirst = n === 0;
      L.circleMarker([leg.from.lat, leg.from.lon], { radius: 7, color: "#fff", weight: 2, fillColor: isFirst ? css.getPropertyValue("--ok").trim() : css.getPropertyValue("--warn").trim(), fillOpacity: 1 })
        .bindPopup(`<strong>${esc(leg.from.name)}</strong><br>${hhmm(shownTime(leg.departure))} · ${esc(label)}`)
        .addTo(map);
      if (n === j.legs.length - 1) {
        L.circleMarker([leg.to.lat, leg.to.lon], { radius: 7, color: "#fff", weight: 2, fillColor: css.getPropertyValue("--bad").trim(), fillOpacity: 1 })
          .bindPopup(`<strong>${esc(leg.to.name)}</strong><br>arrive ${hhmm(shownTime(leg.arrival))}`)
          .addTo(map);
      }
    });
    for (const w of j.walk_paths ?? []) {
      if (w.length < 2) continue;
      all.push(...w);
      L.polyline(w, { color: css.getPropertyValue("--muted").trim(), weight: 3, dashArray: "4 6", opacity: 0.9 }).addTo(map);
    }
    map.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
    box.dataset.ready = "1";
  } catch (err) {
    box.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

$("#results").addEventListener("click", (e) => {
  const b = e.target.closest("[data-map]");
  if (b) showMap(Number(b.dataset.map), b);
});

/** On a trip card: strikes and incidents that involve a station on this trip. */
function tripDisruptionsHtml(j, byId) {
  const list = (j.disruption_ids ?? []).map((id) => byId.get(id)).filter(Boolean);
  if (!list.length) return "";
  const strike = list.some((d) => d.type === "strike");
  const head = strike
    ? `${RED_TRIANGLE}Strike involving a station on this trip`
    : `⚠️ ${list.length} disruption${list.length > 1 ? "s" : ""} involve${list.length > 1 ? "" : "s"} a station on this trip`;
  const items = list
    .slice(0, 4)
    .map((d) => `<li><span class="badge ${d.type === "strike" ? "strike" : esc(d.severity)}">${d.type === "strike" ? `${RED_TRIANGLE}Strike` : d.severity === "major" ? "Major" : "Incident"}</span> ${esc(d.operator === "stib" ? d.description : d.title)}</li>`)
    .join("");
  return `<details class="trip-disruptions ${strike ? "bad" : "warn"}"><summary>${head}</summary><ul>${items}</ul><p class="small">Check whether it concerns your train before you go. Full details below.</p></details>`;
}

/** Panel under the results: everything found for the stations on the trip, with what was checked. */
function renderRouteDisruptions(rd) {
  const box = $("#disruptions");
  if (!rd) {
    box.innerHTML = "";
    $("#disruptions-title").hidden = true;
    return;
  }
  const checked = rd.checked?.length ? `<p class="source">Checked: ${esc(rd.checked.join(", "))} + national strikes</p>` : "";
  if (!rd.items.length) {
    box.innerHTML = `<div class="notice">No disruptions reported for the stations on this trip.</div>${checked}${sourceLine(rd.meta)}`;
    return;
  }
  box.innerHTML = `<div class="card">${rd.items.slice(0, 10).map(disruptionHtml).join("")}</div>${checked}${sourceLine(rd.meta)}`;
}

async function loadDisruptions(stations, extra = []) {
  disruptionController?.abort();
  disruptionController = new AbortController();
  const box = $("#disruptions");
  $("#disruptions-title").hidden = false;
  box.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span>Checking disruptions…</div>`;

  const queries = [...stations.map((station) => ({ station, limit: 5 })), ...extra.map((q) => ({ ...q, limit: 5 }))];
  const { list, metas, failed } = await fetchDisruptions(queries, disruptionController.signal);
  if (disruptionController.signal.aborted) return;
  const meta = metas[0];
  if (failed) {
    box.innerHTML = `<div class="notice error">Disruption data not available, try again.</div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = `<div class="notice">No disruptions reported${stations.length ? ` for ${esc(stations.join(" or "))}` : ""}.</div>${sourceLine(meta)}`;
    return;
  }
  box.innerHTML = `<div class="card">${list.slice(0, 8).map(disruptionHtml).join("")}</div>${sourceLine(meta)}`;
}

// ---------- News feed: strikes, incidents and planned works from the official sources ----------

let newsItems = null;
let newsMetas = [];
let newsFilter = "all";

async function loadNews() {
  const box = $("#news");
  box.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span>Loading news…</div>`;
  const { list, metas, failed } = await fetchDisruptions([
    { type: "incident", limit: 15 },
    { type: "planned", limit: 15 },
    { operator: "stib", limit: 15 },
  ]);
  if (failed) {
    box.innerHTML = `<div class="notice error">News not available right now, try again.</div>`;
    return;
  }
  newsItems = list;
  newsMetas = metas;
  renderNews();
}

function renderNews() {
  const box = $("#news");
  if (!newsItems) return;
  const filters = {
    all: () => true,
    strike: (d) => d.type === "strike",
    sncb: (d) => d.operator === "sncb" && !d._planned,
    stib: (d) => d.operator === "stib",
    planned: (d) => d._planned || d.type === "works",
  };
  const shown = newsItems.filter(filters[newsFilter]);
  const sources = [...new Set(newsMetas.map((m) => sourceName(m.source)))].join(" · ");
  const when = newsMetas[0] ? hhmm(newsMetas[0].fetched_at) : "";
  const footer = `<p class="source">Data: ${esc(sources)} · ${when}</p>`;
  if (!shown.length) {
    const empty = newsFilter === "strike" ? "No strikes announced right now." : "Nothing to report here right now.";
    box.innerHTML = `<div class="notice">${empty}</div>${footer}`;
    return;
  }
  box.innerHTML = `<div class="card">${shown.slice(0, 15).map(disruptionHtml).join("")}</div>${footer}`;
}

for (const b of document.querySelectorAll("#news-filters button")) {
  b.addEventListener("click", () => {
    newsFilter = b.dataset.filter;
    for (const x of document.querySelectorAll("#news-filters button")) x.setAttribute("aria-pressed", String(x === b));
    renderNews();
  });
}

function disruptionHtml(d) {
  // STIB titles are just lists of lines; their description is the readable part.
  const headline = d.operator === "stib" ? d.description : d.title;
  const body = d.operator === "stib" ? "" : d.description;
  const badgeText = d.type === "strike" ? `${RED_TRIANGLE}Strike` : d.type === "works" ? "Works" : d.severity === "major" ? "Major" : d.type === "incident" ? "Incident" : "Info";
  const badgeCls = d.type === "strike" ? "strike" : d.severity;
  const until = d.valid_until ? ` · until ${new Date(d.valid_until).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/Brussels" })}` : "";
  const lines = d.lines?.length ? ` · ${esc(d.lines.slice(0, 5).join(", "))}` : "";
  return `
    <details class="disruption">
      <summary>
        <div class="disruption-head">
          <span class="badge ${esc(badgeCls)}">${badgeText}</span>
          <span class="small muted">${esc(d.operator.toUpperCase())}${lines}${until}</span>
        </div>
        <div class="disruption-title">${esc(headline)}</div>
      </summary>
      ${body ? `<p>${esc(body)}</p>` : ""}
      ${d.url ? `<p><a href="${esc(d.url)}" target="_blank" rel="noopener">Official source</a></p>` : ""}
    </details>`;
}

// ---------- Chat ----------

const CHAT_KEY = "chat";
const MAX_SAVED = 30;
let chat = store.get(CHAT_KEY, []);
let chatBusy = false;

const TOOL_NAMES = {
  plan_journey: "Train planner",
  commute_check: "Door to door",
  departures: "Departures",
  arrivals: "Arrivals",
  train_status: "Train status",
  disruptions: "Disruptions",
  find_stop: "Stop search",
  composition: "Train composition",
};

/** Minimal, safe markdown: escape first, then bold and bullet lists. */
function renderMarkdown(text) {
  const blocks = [];
  let list = [];
  const flush = () => {
    if (list.length) blocks.push(`<ul>${list.map((l) => `<li>${l}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of text.split("\n")) {
    const line = esc(raw).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const item = line.match(/^\s*[-•*]\s+(.*)$/);
    if (item) list.push(item[1]);
    else {
      flush();
      if (line.trim()) blocks.push(`<p>${line}</p>`);
    }
  }
  flush();
  return blocks.join("");
}

function sourcesHtml(sources, index) {
  if (!sources?.length) return "";
  const chips = sources.map((s) => {
    const name = TOOL_NAMES[s.tool] ?? s.tool;
    if (!s.ok) return `<span class="chip">✕ ${esc(name)} unavailable</span>`;
    const when = s.meta ? ` · ${esc(sourceName(s.meta.source))} ${hhmm(s.meta.fetched_at)}` : "";
    return `<span class="chip">✓ ${esc(name)}${when}</span>`;
  });
  const showable = sources.some((s) => s.ok && (s.data?.journeys?.length || s.data?.departures?.length));
  const toggle = showable ? `<button type="button" class="chip" data-show-data="${index}">Show Data</button>` : "";
  return `<div class="sources">${chips.join("")}${toggle}</div><div class="chat-data" id="chat-data-${index}" hidden></div>`;
}

function renderChat() {
  const log = $("#chat-log");
  if (!chat.length && !chatBusy) {
    const hasKey = Boolean(store.get("claudeKey"));
    log.innerHTML = `
      <div class="notice">
        <strong>Ask about any trip in Belgium.</strong>
        <p class="small muted" style="margin:4px 0 12px">Answers use live SNCB, STIB and De Lijn data. Every time comes from a source shown under the reply.</p>
        ${hasKey ? "" : `<p class="small" style="margin:0 0 12px">First add your Claude API key in <button type="button" class="linkish" data-goto="settings">Settings</button>.</p>`}
        <div class="suggestions">
          <button type="button" data-ask="Midi to Gent, now?">Midi to Gent, now?</button>
          <button type="button" data-ask="When is the next metro at Trône?">Next metro at Trône?</button>
          <button type="button" data-ask="Any strikes or big disruptions today?">Strikes today?</button>
        </div>
      </div>`;
  } else {
    log.innerHTML = chat
      .map((m, i) => {
        if (m.role === "user") return `<div class="bubble user">${esc(m.content)}</div>`;
        if (m.role === "error") return `<div class="bubble error">${esc(m.content)}${m.code === "CLAUDE_KEY_MISSING" || m.code === "CLAUDE_KEY_INVALID" ? ` <button type="button" class="linkish" data-goto="settings">Open Settings</button>` : ""}</div>`;
        const by = m.model ? `<div class="answered-by">Answered by ${/haiku/i.test(m.model) ? "Claude Haiku (quick answer)" : "Claude Sonnet"}</div>` : "";
        return `<div class="bubble assistant">${renderMarkdown(m.content)}${sourcesHtml(m.sources, i)}${by}</div>`;
      })
      .join("") + (chatBusy ? `<div class="loading"><span class="spinner" aria-hidden="true"></span>Checking live data…</div>` : "");
  }

  for (const b of log.querySelectorAll("[data-ask]")) b.addEventListener("click", () => sendChat(b.dataset.ask));
  for (const b of log.querySelectorAll("[data-goto]")) b.addEventListener("click", () => showView(b.dataset.goto));
  for (const b of log.querySelectorAll("[data-show-data]")) {
    b.addEventListener("click", () => {
      const i = Number(b.dataset.showData);
      const box = $(`#chat-data-${i}`);
      if (box.hidden) {
        box.innerHTML = chat[i].sources
          .filter((s) => s.ok && s.data)
          .map((s) =>
            s.data.journeys?.length
              ? s.data.journeys.slice(0, 3).map((j) => journeyCard(j)).join("") + sourceLine(s.data.meta)
              : s.data.departures?.length
                ? boardHtml(s.data)
                : "",
          )
          .join("");
      }
      box.hidden = !box.hidden;
      b.textContent = box.hidden ? "Show Data" : "Hide Data";
    });
  }
}

async function sendChat(text) {
  const content = text.trim();
  if (!content || chatBusy) return;
  const key = store.get("claudeKey");

  chat.push({ role: "user", content });
  if (!key) {
    chat.push({ role: "error", code: "CLAUDE_KEY_MISSING", content: "Add your Claude API key in Settings to use the chat." });
    saveChat();
    renderChat();
    return;
  }

  chatBusy = true;
  renderChat();
  window.scrollTo({ top: document.body.scrollHeight, behavior: scrollMode() });

  // Only real user/assistant turns go to the server, never error bubbles.
  const messages = chat.filter((m) => m.role === "user" || m.role === "assistant").map((m) => ({ role: m.role, content: m.content }));
  try {
    const data = await api("/api/chat", { method: "POST", body: { messages }, headers: { "X-Claude-Key": key } });
    // Keep only what the "Show data" view needs, so saved history stays small.
    const sources = data.sources.map((s) => ({ tool: s.tool, ok: s.ok, meta: s.meta, data: slimData(s.data) }));
    chat.push({ role: "assistant", content: data.reply, sources, model: data.model });
  } catch (err) {
    // Drop the unanswered question from what we send next time, but keep it visible.
    chat.push({ role: "error", code: err.code, content: err.message || "Chat is not available right now. Try again." });
  } finally {
    chatBusy = false;
    saveChat();
    renderChat();
    window.scrollTo({ top: document.body.scrollHeight, behavior: scrollMode() });
  }
}

function slimData(d) {
  if (!d) return undefined;
  if (d.journeys) return { meta: d.meta, journeys: d.journeys.slice(0, 3) };
  if (d.departures) return { meta: d.meta, stop: d.stop, departures: d.departures.slice(0, 8) };
  return undefined;
}

function saveChat() {
  chat = chat.slice(-MAX_SAVED);
  // The API needs the history to start with a user message.
  while (chat.length && chat[0].role !== "user") chat.shift();
  store.set(CHAT_KEY, chat);
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  sendChat(input.value);
  input.value = "";
  input.style.height = "";
});
$("#chat-input").addEventListener("keydown", (e) => {
  // Enter sends on desktop; Shift+Enter adds a line.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#chat-form").requestSubmit();
  }
});
$("#chat-input").addEventListener("input", (e) => {
  e.target.style.height = "";
  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
});

// ---------- Settings ----------

$("#walk-min").addEventListener("change", (e) => {
  const n = Math.min(90, Math.max(0, Number.parseInt(e.target.value, 10) || 0));
  e.target.value = n;
  userData.walk_min = n;
  saveUserData();
});

function renderSettings() {
  const key = store.get("claudeKey");
  $("#walk-min").value = userData.walk_min;
  // Filled every time Settings opens (the name may have been typed in the tutorial meanwhile).
  if (document.activeElement !== $("#user-name")) $("#user-name").value = store.get("userName") ?? "";
  renderRoutesManage();
  renderPassesManage();
  renderPush();
  $("#claude-key").value = key ?? "";
  setKeyStatus(key ? "Key saved on this device." : "No key yet.", key ? "ok" : "");
  renderInstall();
}

function setKeyStatus(text, cls = "") {
  const el = $("#key-status");
  el.textContent = text;
  el.className = `status-line ${cls}`;
}

$("#key-show").addEventListener("click", () => {
  const input = $("#claude-key");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("#key-show").textContent = show ? "Hide" : "Show";
});

$("#key-save").addEventListener("click", async () => {
  const key = $("#claude-key").value.trim();
  if (!key.startsWith("sk-ant-")) {
    setKeyStatus("That doesn't look like a Claude API key (it starts with sk-ant-).", "bad");
    return;
  }
  $("#key-save").disabled = true;
  setKeyStatus("Checking…");
  try {
    await api("/api/claude-key/check", { method: "POST", headers: { "X-Claude-Key": key } });
    store.set("claudeKey", key);
    setKeyStatus("Key works and is saved on this device. ✓", "ok");
  } catch (err) {
    setKeyStatus(err.code === "CLAUDE_KEY_INVALID" ? "Claude did not accept this key. Check it and try again." : err.message, "bad");
  } finally {
    $("#key-save").disabled = false;
  }
});

$("#key-remove").addEventListener("click", () => {
  if (!store.get("claudeKey")) return setKeyStatus("No key saved on this device.");
  if (!confirm("Remove your Claude API key from this device? The chat stops working until you add it again.")) return;
  store.remove("claudeKey");
  $("#claude-key").value = "";
  setKeyStatus("Key removed from this device.");
});

$("#chat-clear").addEventListener("click", () => {
  chat = [];
  store.remove(CHAT_KEY);
  $("#chat-clear").textContent = "Chat History Cleared ✓";
});

// ---------- Your name (greeting only, stays on this phone) ----------
$("#user-name").value = store.get("userName") ?? "";
$("#user-name").addEventListener("change", () => {
  const name = $("#user-name").value.trim().slice(0, 30);
  if (name) store.set("userName", name);
  else store.remove("userName");
  toast(name ? `Hi ${name}!` : "Name removed");
});

// ---------- Privacy: Delete My Data ----------

$("#delete-data").addEventListener("click", async () => {
  if (!confirm("Delete all your Sebway data? Saved routes, boards, passes, alerts, chat history and your Claude key will be removed from this phone and from Sebway's server. This can't be undone.")) return;
  const btn = $("#delete-data");
  btn.disabled = true;
  $("#delete-status").textContent = "Deleting…";
  try {
    await api("/api/me", { method: "DELETE" });
    const sub = await currentSubscription().catch(() => null);
    await sub?.unsubscribe().catch(() => {});
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("sebway.")) localStorage.removeItem(k);
    } catch {}
    $("#delete-status").textContent = "All your data is deleted. Restarting…";
    setTimeout(() => location.replace("/"), 1200);
  } catch (err) {
    btn.disabled = false;
    $("#delete-status").textContent = `Couldn't delete right now (${err.message || "no connection"}). Try again.`;
  }
});

// ---------- Appearance: Auto / Light / Dark ----------

const THEME_COLOURS = { light: "#f3f5fb", dark: "#050505" };

function applyTheme(choice) {
  const root = document.documentElement;
  if (choice === "light" || choice === "dark") root.dataset.theme = choice;
  else delete root.dataset.theme;
  // Status bar colour: forced choice wins over the phone setting.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.dataset.auto ??= meta.content;
    meta.content = choice === "light" || choice === "dark" ? THEME_COLOURS[choice] : meta.dataset.auto;
  }
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-pressed", String(b.dataset.themeChoice === choice));
}

for (const b of document.querySelectorAll("[data-theme-choice]")) {
  b.addEventListener("click", () => {
    const choice = b.dataset.themeChoice;
    if (choice === "auto") store.remove("theme");
    else store.set("theme", choice);
    applyTheme(choice);
  });
}
applyTheme(store.get("theme", "auto"));

// ---------- Push notifications ----------

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function setPushStatus(text, cls = "") {
  const el = $("#push-status");
  el.textContent = text;
  el.className = `status-line ${cls}`;
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function renderPush() {
  const on = $("#push-on");
  const test = $("#push-test");
  const off = $("#push-off");
  if (!pushSupported()) {
    on.hidden = true;
    test.hidden = off.hidden = true;
    setPushStatus(
      isIos() && !isStandalone()
        ? "On iPhone, first add Sebway to your Home Screen (see Install below), then open it from there to turn on alerts."
        : "This browser can't receive notifications.",
    );
    return;
  }
  const sub = await currentSubscription();
  const enabled = Boolean(sub) && Notification.permission === "granted";
  on.hidden = enabled;
  test.hidden = off.hidden = !enabled;
  if (Notification.permission === "denied") setPushStatus("Notifications are blocked for Sebway. Allow them in your device settings, then try again.", "bad");
  else setPushStatus(enabled ? "Alerts are on for this device. ✓" : "Alerts are off.", enabled ? "ok" : "");
}

function urlBase64ToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

$("#push-on").addEventListener("click", async () => {
  $("#push-on").disabled = true;
  try {
    // Must be called straight from the tap, or iOS refuses.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushStatus("Notifications were not allowed.", "bad");
      return;
    }
    const { publicKey } = await api("/api/push/key");
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(publicKey) }));
    await api("/api/push/subscription", { method: "PUT", body: { subscription: sub.toJSON() } });
    // Make sure the server has the saved routes and passes it should check.
    saveUserData();
    setPushStatus("Alerts are on for this device. ✓", "ok");
  } catch (err) {
    setPushStatus(`Could not turn on alerts: ${err.message}`, "bad");
  } finally {
    $("#push-on").disabled = false;
    renderPush();
  }
});

$("#push-test").addEventListener("click", async () => {
  $("#push-test").disabled = true;
  setPushStatus("Sending…");
  try {
    await api("/api/push/test", { method: "POST" });
    setPushStatus("Test alert sent. It should appear in a few seconds.", "ok");
  } catch (err) {
    setPushStatus(err.message, "bad");
  } finally {
    $("#push-test").disabled = false;
  }
});

$("#push-off").addEventListener("click", async () => {
  try {
    const sub = await currentSubscription();
    await sub?.unsubscribe();
    await api("/api/push/subscription", { method: "DELETE" });
  } catch {}
  renderPush();
});

// ---------- Install (PWA) ----------

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  renderInstall();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  renderInstall();
});

function renderInstall() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const text = $("#install-text");
  const btn = $("#install-btn");
  btn.hidden = !installPrompt;
  if (standalone) text.textContent = "Sebway is installed on this device. ✓";
  else if (installPrompt) text.textContent = "Install Sebway as an app on this device.";
  else if (ios) text.innerHTML = "On iPhone: open this page in <strong>Safari</strong>, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.";
  else text.innerHTML = "In Chrome or Edge: use the <strong>install icon</strong> in the address bar, or the menu → <strong>Install Sebway</strong>.";
}

$("#install-btn").addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  renderInstall();
});

// ---------- Saved routes ----------

const sameRoute = (r, mode, from, to) => r.mode === mode && r.from.toLowerCase() === from.toLowerCase() && r.to.toLowerCase() === to.toLowerCase();

function saveRouteButton(mode, from, to) {
  const saved = userData.routes.find((r) => sameRoute(r, mode, from, to));
  return `<div class="results-actions">${
    saved
      ? `<button type="button" class="btn small fav-saved" data-edit-route="${esc(saved.id)}">${esc(saved.emoji ?? "★")} ${esc(saved.name)}</button>`
      : `<button type="button" class="btn small" data-save-route>☆ Save Route</button>`
  }</div>`;
}

$("#results").addEventListener("click", (e) => {
  const edit = e.target.closest("[data-edit-route]")?.dataset.editRoute;
  if (edit) return openRouteSheet(userData.routes.find((r) => r.id === edit));
  if (!e.target.closest("[data-save-route]")) return;
  const fromId = $("#from").dataset.stopName === form.from ? $("#from").dataset.stopId : undefined;
  const toId = $("#to").dataset.stopName === form.to ? $("#to").dataset.stopId : undefined;
  const fc = stopCoords($("#from"));
  const tc = stopCoords($("#to"));
  openRouteSheet(null, {
    mode: form.mode, from: form.from, to: form.to,
    ...(fromId ? { from_id: fromId } : {}), ...(toId ? { to_id: toId } : {}),
    ...(fc.lat !== undefined ? { from_lat: fc.lat, from_lon: fc.lon } : {}), ...(tc.lat !== undefined ? { to_lat: tc.lat, to_lon: tc.lon } : {}),
  });
});

// ---------- Favourites: places and routes ----------
// Save places (Home, School, Work… : an address, a place or a stop) and Sebway makes the routes between
// them (Home ⇄ each other place). You can also save a specific route from the results. Saving and
// editing happen in a bottom sheet with one-tap labels; no typing needed.

const PLACE_PRESETS = [
  { label: "Home", emoji: "🏠" },
  { label: "Studies", emoji: "🎓" },
  { label: "Work", emoji: "💼" },
  { label: "Gym", emoji: "🏋️" },
];
const EMOJIS = ["🏠", "🎓", "💼", "🏋️", "❤️", "⭐", "🛒", "🍽️", "⚽", "🎵", "🏥", "✈️", "👵", "🐶"];
const MAX_PLACES = 8;
const MAX_ROUTES = 16;
const placeByLabel = (label) => userData.places.find((p) => normName(p.label) === normName(label));
const hubPlace = () => placeByLabel("Home") ?? userData.places[0];

/** Routes between your places, made by the app: Home ⇄ each other place (up to 4). Keeps your order. */
function syncAutoRoutes() {
  const hub = hubPlace();
  const pairs = hub ? userData.places.filter((p) => p.id !== hub.id).slice(0, 4).flatMap((p) => [[hub, p], [p, hub]]) : [];
  const want = new Map(pairs.map(([a, b]) => [`${a.id}>${b.id}`, [a, b]]));
  const make = ([a, b], id) => ({
    id, auto: true, from_place: a.id, to_place: b.id, name: `${a.label} → ${b.label}`, emoji: b.emoji, mode: "commute", from: a.name, to: b.name,
    ...(a.stop_id ? { from_id: a.stop_id } : {}), ...(b.stop_id ? { to_id: b.stop_id } : {}),
    ...(Number.isFinite(a.lat) ? { from_lat: a.lat, from_lon: a.lon } : {}), ...(Number.isFinite(b.lat) ? { to_lat: b.lat, to_lon: b.lon } : {}),
  });
  const next = [];
  for (const r of userData.routes) {
    if (!r.auto) next.push(r);
    else if (want.has(`${r.from_place}>${r.to_place}`)) {
      next.push(make(want.get(`${r.from_place}>${r.to_place}`), r.id));
      want.delete(`${r.from_place}>${r.to_place}`);
    }
  }
  for (const pair of want.values()) next.push(make(pair, newId()));
  userData.routes = next.slice(0, MAX_ROUTES);
}

function favouritesChanged(message) {
  syncAutoRoutes();
  saveUserData();
  if (!$("#view-trip").hidden) renderHome();
  if (!$("#view-settings").hidden) renderRoutesManage();
  if (message) toast(message);
}

function toast(text, ms = 2200) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = text;
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ----- Bottom sheet -----
function openSheet(html, onMount) {
  closeSheet();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="sheet-handle" aria-hidden="true"></div>${html}</div>`;
  document.body.append(overlay);
  document.body.classList.add("tut-open");
  requestAnimationFrame(() => overlay.classList.add("show"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest("[data-sheet-cancel]")) closeSheet();
  });
  onMount(overlay.querySelector(".sheet"));
}
function closeSheet() {
  const o = document.querySelector(".sheet-overlay");
  if (!o) return;
  o.remove();
  document.body.classList.remove("tut-open");
}
document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());

/** Label chips (Home, School, Work, Gym, Custom) + custom name and emoji. */
function labelPicker(current, customPlaceholder) {
  const preset = current && PLACE_PRESETS.find((p) => normName(p.label) === normName(current.label));
  const custom = current && !preset;
  return `<div class="sheet-chips" role="group" aria-label="Label">${PLACE_PRESETS.map(
    (p) => `<button type="button" class="pick${preset?.label === p.label ? " on" : ""}" data-pick-label="${p.label}" data-pick-emoji="${p.emoji}" aria-pressed="${preset?.label === p.label}">${p.emoji} ${p.label}</button>`,
  ).join("")}<button type="button" class="pick${custom ? " on" : ""}" data-pick-custom aria-pressed="${Boolean(custom)}">➕ Custom…</button></div>
  <div class="sheet-custom"${custom ? "" : " hidden"}>
    <input class="sheet-name" maxlength="30" placeholder="${esc(customPlaceholder)}" aria-label="Name" value="${esc(custom ? current.label : "")}">
    <div class="emoji-row" role="group" aria-label="Emoji">${EMOJIS.map((e) => `<button type="button" class="emoji${custom && current.emoji === e ? " on" : ""}" data-emoji="${e}" aria-label="Emoji ${e}">${e}</button>`).join("")}</div>
  </div>`;
}

/** Wires the picker; returns a reader giving { label, emoji } or null when nothing is chosen. */
function mountPicker(sheet, onChange = () => {}) {
  let choice = null;
  const on = sheet.querySelector(".pick.on");
  if (on?.dataset.pickLabel) choice = { label: on.dataset.pickLabel, emoji: on.dataset.pickEmoji };
  const customBox = sheet.querySelector(".sheet-custom");
  const nameInput = sheet.querySelector(".sheet-name");
  const custom = () => ({ label: nameInput.value.trim(), emoji: sheet.querySelector(".emoji.on")?.dataset.emoji ?? "⭐" });
  if (on?.hasAttribute("data-pick-custom")) choice = "custom";
  sheet.addEventListener("click", (e) => {
    const pick = e.target.closest(".pick");
    if (pick) {
      for (const b of sheet.querySelectorAll(".pick")) {
        b.classList.toggle("on", b === pick);
        b.setAttribute("aria-pressed", String(b === pick));
      }
      choice = pick.dataset.pickLabel ? { label: pick.dataset.pickLabel, emoji: pick.dataset.pickEmoji } : "custom";
      customBox.hidden = choice !== "custom";
      if (choice === "custom") nameInput.focus();
      onChange();
    }
    const em = e.target.closest(".emoji");
    if (em) for (const b of sheet.querySelectorAll(".emoji")) b.classList.toggle("on", b === em);
  });
  nameInput.addEventListener("input", onChange);
  return () => (choice === "custom" ? (custom().label ? custom() : null) : choice);
}

/**
 * Add a tile (＋) or edit one: search an address or stop (with suggestions), then pick a label and emoji.
 * Editing keeps the address unless you search a new one.
 */
function openPlaceSheet(existing) {
  let spot = existing ? { name: existing.name, stop_id: existing.stop_id, lat: existing.lat, lon: existing.lon } : null;
  openSheet(
    `<h2 class="sheet-title">${existing ? esc(`${existing.emoji} ${existing.label}`) : "Add a place"}</h2>
     <label class="sheet-label" for="place-q">Address or stop</label>
     <input class="sheet-input" id="place-q" autocomplete="off" enterkeyhint="search" placeholder="e.g. Rue Neuve 1, Basic-Fit Gent or Trône" value="${esc(existing?.name ?? "")}">
     <ul class="sheet-results" role="listbox" aria-label="Suggestions"></ul>
     <label class="sheet-label">Name</label>
     ${labelPicker(existing, "Name, e.g. Grandma")}
     <p class="sheet-note" hidden></p>
     <div class="sheet-actions">
       <button type="button" class="btn primary" data-sheet-save>${existing ? "Save" : "Add Tile"}</button>
       ${existing ? `<button type="button" class="btn danger" data-sheet-delete>Delete</button>` : ""}
       <button type="button" class="btn" data-sheet-cancel>Cancel</button>
     </div>`,
    (sheet) => {
      const q = sheet.querySelector("#place-q");
      const list = sheet.querySelector(".sheet-results");
      const note = sheet.querySelector(".sheet-note");
      let timer;
      let ctrl;
      q.addEventListener("input", () => {
        spot = null;
        clearTimeout(timer);
        const text = q.value.trim();
        ctrl?.abort();
        list.innerHTML = ""; // no stale suggestions while you're still typing
        if (text.length < 3) return;
        timer = setTimeout(async () => {
          ctrl?.abort();
          ctrl = new AbortController();
          const [stops, places] = await Promise.all([
            api(`/api/stops?${qs({ q: text })}`, { signal: ctrl.signal }).then((d) => d.stops ?? []).catch(() => []),
            text.length >= 3 ? api(`/api/places?${qs({ q: text })}`, { signal: ctrl.signal }).then((d) => d.places ?? []).catch(() => []) : [],
          ]);
          if (ctrl.signal.aborted) return;
          const items = [
            ...stops.slice(0, 4).map((st) => ({ icon: st.operator === "sncb" ? "🚉" : "🚏", name: st.name, sub: OPERATOR_NAME[st.operator] ?? "", stop_id: st.id, lat: st.lat, lon: st.lon })),
            ...places.filter((pl) => !stops.some((st) => normName(st.name) === normName(pl.label))).slice(0, 4).map((pl) => ({ icon: "📍", name: pl.label, sub: pl.kind === "address" ? "Address" : "Place", lat: pl.lat, lon: pl.lon })),
          ];
          list.innerHTML = items.length
            ? items.map((it, i) => `<li><button type="button" class="sheet-result" data-i="${i}" role="option"><span aria-hidden="true">${it.icon}</span><span><strong>${esc(it.name)}</strong><small>${esc(it.sub)}</small></span></button></li>`).join("")
            : `<li class="sheet-empty">Nothing found. Try a street with number, a place or a stop name.</li>`;
          list.onclick = (e) => {
            const btn = e.target.closest(".sheet-result");
            if (!btn) return;
            const it = items[Number(btn.dataset.i)];
            spot = { name: it.name, ...(it.stop_id ? { stop_id: it.stop_id } : {}), lat: it.lat, lon: it.lon };
            q.value = it.name;
            list.innerHTML = `<li class="sheet-picked">✓ ${esc(it.icon)} ${esc(it.name)}</li>`;
          };
        }, SUGGEST_PAUSE_MS);
      });
      if (!existing) setTimeout(() => q.focus(), 300);
      const read = mountPicker(sheet, () => {
        const c = read();
        const clash = c && placeByLabel(c.label);
        note.hidden = !(clash && clash.id !== existing?.id);
        note.textContent = clash ? `You already have ${clash.emoji} ${clash.label}: it will be replaced.` : "";
      });
      sheet.querySelector("[data-sheet-save]").addEventListener("click", () => {
        if (!spot) return toast("Pick an address or stop from the suggestions");
        const c = read();
        if (!c) return toast("Pick a name first");
        const clash = placeByLabel(c.label);
        const fields = { label: c.label.slice(0, 30), emoji: c.emoji, name: spot.name, stop_id: spot.stop_id, lat: spot.lat, lon: spot.lon };
        for (const k of ["stop_id", "lat", "lon"]) if (fields[k] === undefined) delete fields[k];
        if (existing) {
          for (const k of ["stop_id", "lat", "lon"]) delete existing[k];
          Object.assign(existing, fields);
          if (clash && clash.id !== existing.id) userData.places = userData.places.filter((p) => p.id !== clash.id);
        } else if (clash) {
          for (const k of ["stop_id", "lat", "lon"]) delete clash[k];
          Object.assign(clash, fields);
        } else {
          if (userData.places.length >= MAX_PLACES) return toast(`You can have up to ${MAX_PLACES} tiles`);
          userData.places.push({ id: newId(), ...fields });
        }
        closeSheet();
        favouritesChanged(`${c.emoji} ${c.label} ${existing ? "saved" : "added"}`);
      });
      sheet.querySelector("[data-sheet-delete]")?.addEventListener("click", () => {
        if (!confirm(`Delete ${existing.emoji} ${existing.label}?`)) return;
        userData.places = userData.places.filter((p) => p.id !== existing.id);
        closeSheet();
        favouritesChanged(`${existing.label} deleted`);
      });
    },
  );
}

/**
 * Tap a tile: choose where from (where you are now, or another tile) and when (now, soon, or a time,
 * leaving or arriving), then the trips to that place show up below.
 */
function openTripSheet(place) {
  const others = userData.places.filter((p) => p.id !== place.id);
  const whenChips = [["now", "Now"], ["15", "In 15 min"], ["30", "In 30 min"], ["60", "In 1 hour"], ["pick", "Pick a time…"]];
  openSheet(
    `<h2 class="sheet-title">${esc(place.emoji)} To ${esc(place.label)}</h2>
     <p class="sheet-sub">${esc(place.name)}</p>
     <div class="sheet-label">From</div>
     <div class="sheet-chips" data-group="from">
       <button type="button" class="pick on" data-from="here" aria-pressed="true">📍 Where I am</button>
       ${others.map((p) => `<button type="button" class="pick" data-from="${esc(p.id)}" aria-pressed="false">${esc(p.emoji)} ${esc(p.label)}</button>`).join("")}
       <button type="button" class="pick" data-from="type" aria-pressed="false">✏️ Somewhere else</button>
     </div>
     <div class="sheet-label">When</div>
     <div class="sheet-chips" data-group="when">${whenChips.map(([v, t], i) => `<button type="button" class="pick${i ? "" : " on"}" data-when="${v}" aria-pressed="${!i}">${t}</button>`).join("")}</div>
     <div class="sheet-time" hidden>
       <div class="seg" role="group" aria-label="Plan by"><button type="button" data-arrive="0" aria-pressed="true">Departure</button><button type="button" data-arrive="1" aria-pressed="false">Arrival</button></div>
       <div class="sheet-time-row"><input type="date" class="sheet-input" id="sheet-date" aria-label="Date" min="${todayIso()}" value="${todayIso()}"><input type="time" class="sheet-input" id="sheet-time" aria-label="Time"></div>
     </div>
     <div class="sheet-actions">
       <button type="button" class="btn primary" data-trip-go>Show Trips</button>
       <button type="button" class="btn" data-sheet-cancel>Cancel</button>
     </div>`,
    (sheet) => {
      let from = "here";
      let when = "now";
      let arrive = false;
      const timeBox = sheet.querySelector(".sheet-time");
      const timeIn = sheet.querySelector("#sheet-time");
      timeIn.value = brusselsHm(new Date(Date.now() + 30 * 60_000));
      sheet.addEventListener("click", (e) => {
        const chip = e.target.closest(".pick");
        if (chip) {
          const group = chip.closest("[data-group]");
          for (const b of group.querySelectorAll(".pick")) {
            b.classList.toggle("on", b === chip);
            b.setAttribute("aria-pressed", String(b === chip));
          }
          if (chip.dataset.from) from = chip.dataset.from;
          if (chip.dataset.when) {
            when = chip.dataset.when;
            timeBox.hidden = when !== "pick";
          }
        }
        const seg = e.target.closest("[data-arrive]");
        if (seg) {
          arrive = seg.dataset.arrive === "1";
          for (const b of sheet.querySelectorAll("[data-arrive]")) b.setAttribute("aria-pressed", String(b === seg));
        }
      });
      sheet.querySelector("[data-trip-go]").addEventListener("click", () => {
        applyMode("commute");
        setStop($("#to"), place.name, place.stop_id, place.lat, place.lon);
        // When
        $("#when-type").value = when === "pick" && arrive ? "arrive" : "depart";
        if (when === "now") {
          $("#date").value = "";
          $("#time").value = "";
        } else if (when === "pick") {
          $("#date").value = sheet.querySelector("#sheet-date").value === todayIso() ? "" : sheet.querySelector("#sheet-date").value;
          $("#time").value = timeIn.value;
        } else {
          $("#date").value = "";
          $("#time").value = brusselsHm(new Date(Date.now() + Number(when) * 60_000));
        }
        refreshGhosts();
        closeSheet();
        // From
        const go = () => {
          searchTrip();
          $("#results").scrollIntoView({ behavior: scrollMode(), block: "start" });
        };
        const start = userData.places.find((p) => p.id === from);
        if (start) {
          setStop($("#from"), start.name, start.stop_id, start.lat, start.lon);
          return go();
        }
        const ask = (msg) => {
          setStop($("#from"), "");
          stopHint($("#from"), msg, "warn");
          $("#trip-form").scrollIntoView({ behavior: scrollMode(), block: "start" });
          $("#from").focus();
        };
        if (from === "type" || !navigator.geolocation) return ask(`Where do you start? Type a stop or address, then Search.`);
        stopHint($("#from"), "Finding your location…");
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setStop($("#from"), "My location", undefined, Number(pos.coords.latitude.toFixed(5)), Number(pos.coords.longitude.toFixed(5)));
            go();
          },
          () => ask("Couldn't get your location. Type where you start, then Search."),
          { timeout: 8000, maximumAge: 300_000 },
        );
      });
    },
  );
}

/** Save a route from the results (with the way back) or edit a saved one. */
function openRouteSheet(existing, draft) {
  const r = existing ?? draft;
  if (!r) return;
  // Editing "To School" shows the School chip; any other name shows as a custom label.
  const stripped = existing?.name.replace(/^To /, "");
  const isPreset = PLACE_PRESETS.some((p) => p.label === stripped);
  const current = existing ? { label: isPreset ? stripped : existing.name, emoji: existing.emoji ?? "⭐" } : null;
  const back = !existing;
  openSheet(
    `<h2 class="sheet-title">${esc(existing ? `${existing.emoji ?? "★"} ${existing.name}` : `Save “${r.from} → ${r.to}”`)}</h2>
     ${existing ? `<p class="sheet-sub">${esc(r.from)} → ${esc(r.to)}${existing.auto ? " · made from your places" : ""}</p>` : `<p class="sheet-sub">Where does this trip take you?</p>`}
     ${labelPicker(current, "Name, e.g. Grandma's")}
     ${back ? `<label class="sheet-check"><input type="checkbox" id="sheet-back" checked> Also save the way back</label>` : ""}
     <div class="sheet-actions">
       <button type="button" class="btn primary" data-sheet-save>Save</button>
       ${existing && !existing.auto ? `<button type="button" class="btn danger" data-sheet-delete>Delete</button>` : ""}
       <button type="button" class="btn" data-sheet-cancel>Cancel</button>
     </div>`,
    (sheet) => {
      const read = mountPicker(sheet);
      sheet.querySelector("[data-sheet-save]").addEventListener("click", () => {
        const c = read();
        if (!c) return toast("Pick a label first");
        // New routes and preset labels read "To School"; a custom name on an existing route is kept as typed.
        const preset = PLACE_PRESETS.some((p) => p.label === c.label);
        const name = (existing?.auto || (existing && !preset) ? c.label : `To ${c.label}`).slice(0, 80);
        if (existing) {
          Object.assign(existing, { name, emoji: c.emoji });
        } else {
          const wantBack = sheet.querySelector("#sheet-back")?.checked;
          const pinned = userData.routes.length + (wantBack ? 2 : 1);
          if (pinned > MAX_ROUTES) return toast(`You can save up to ${MAX_ROUTES} routes`);
          userData.routes.push({ id: newId(), name, emoji: c.emoji, ...draft });
          if (wantBack) {
            const rev = { mode: draft.mode, from: draft.to, to: draft.from, ...(draft.to_id ? { from_id: draft.to_id } : {}), ...(draft.from_id ? { to_id: draft.from_id } : {}), ...(draft.to_lat !== undefined ? { from_lat: draft.to_lat, from_lon: draft.to_lon } : {}), ...(draft.from_lat !== undefined ? { to_lat: draft.from_lat, to_lon: draft.from_lon } : {}) };
            if (!userData.routes.some((x) => sameRoute(x, rev.mode, rev.from, rev.to))) userData.routes.push({ id: newId(), name: `From ${c.label}`.slice(0, 80), emoji: "↩️", ...rev });
          }
        }
        closeSheet();
        favouritesChanged(`Saved: ${c.emoji} ${name}`);
        const actions = document.querySelector("#results .results-actions");
        if (actions) actions.outerHTML = saveRouteButton(form.mode, form.from, form.to);
      });
      sheet.querySelector("[data-sheet-delete]")?.addEventListener("click", () => {
        if (!confirm(`Delete “${existing.name}”?`)) return;
        userData.routes = userData.routes.filter((x) => x.id !== existing.id);
        closeSheet();
        favouritesChanged(`“${existing.name}” deleted`);
        const actions = document.querySelector("#results .results-actions");
        if (actions) actions.outerHTML = saveRouteButton(form.mode, form.from, form.to);
      });
    },
  );
}

let homeController;

// ---------- Home cockpit ----------
// A greeting with your name, your next trip (the saved route you usually take at this time of day)
// as a big live card, and your other saved routes as one-tap favourites with their next departure.

const brusselsHourNow = (d = new Date()) => {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Brussels" }).format(d).split(":").map(Number);
  return h + m / 60;
};
const sameName = (a, b) => normName(a) === normName(b);

/** Remember the hour a saved route is used, so the cockpit learns your routine (last 20 uses, on this phone). */
function recordRouteUse(id) {
  const use = store.get("routeUse", {});
  use[id] = [...(use[id] ?? []), Math.round(brusselsHourNow() * 10) / 10].slice(-20);
  store.set("routeUse", use);
}

function greeting(now = new Date()) {
  const h = brusselsHourNow(now);
  const hi = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const name = store.get("userName");
  return `${hi}${name ? `, ${name}` : ""}`;
}

let favEditing = false;

/** Your tiles (places) as squares + a ＋ tile; saved routes as chips underneath. */
function favouritesHtml() {
  const ed = favEditing;
  const del = (attr, id, label) => (ed ? `<span class="fav-del" ${attr}="${esc(id)}" role="button" aria-label="Delete ${esc(label)}">−</span>` : "");
  const short = (name) => esc(name.split(",")[0]);
  const area = (name) => esc(name.split(",").slice(1).join(",").trim());
  const tiles = userData.places
    .map(
      (p) => `<button type="button" class="tile${ed ? " editing" : ""}" data-place="${esc(p.id)}" data-id="${esc(p.id)}" aria-label="${esc(p.label)}: ${esc(p.name)}">
        ${del("data-fav-del-place", p.id, p.label)}
        <span class="tile-emoji" aria-hidden="true">${esc(p.emoji)}</span>
        <span class="tile-name">${esc(p.label)}</span>
        <span class="tile-addr">${short(p.name)}${area(p.name) ? `<br>${area(p.name)}` : ""}</span>
      </button>`,
    )
    .join("");
  const add = !ed && userData.places.length < MAX_PLACES ? `<button type="button" class="tile add" data-add-place><span class="tile-emoji" aria-hidden="true">＋</span><span class="tile-name">Add a place</span><span class="tile-addr">Home, Studies, Gym…</span></button>` : "";
  const routes = userData.routes.filter((r) => !r.auto);
  const routeChips = routes
    .map((r) => `<button type="button" class="fav-chip${ed ? " editing" : ""}" data-route="${esc(r.id)}" data-id="${esc(r.id)}">${del("data-fav-del-route", r.id, r.name)}<span class="fav-emoji" aria-hidden="true">${esc(r.emoji ?? "★")}</span><span class="fav-name">${esc(r.name)}</span>${ed ? "" : `<span class="fav-next" id="route-status-${esc(r.id)}"></span>`}</button>`)
    .join("");
  const editBtn = userData.places.length || routes.length ? `<button type="button" class="linkish fav-edit" data-fav-edit>${ed ? "Done" : "Edit"}</button>` : "";
  return `<section class="favs${ed ? " editing" : ""}" aria-label="My places">
    <div class="fav-head"><h2 class="section-title">My places</h2>${editBtn}</div>
    ${ed ? `<p class="fav-tip">Drag to reorder · tap to change · − to delete</p>` : ""}
    <div class="tiles" data-reorder="places">${tiles}${add}</div>
    ${routeChips ? `<h2 class="section-title">Saved routes</h2><div class="fav-row" data-reorder="routes">${routeChips}</div>` : ""}
  </section>`;
}

/** Drag to reorder chips in edit mode (pointer events, so it works with touch too). */
function enableReorder(row, onDone) {
  for (const el of row.querySelectorAll("[data-id]")) {
    el.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".fav-del")) return;
      const x0 = e.clientX;
      const y0 = e.clientY;
      let dragging = false;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) {
          dragging = true;
          el.classList.add("dragging");
        }
        if (!dragging) return;
        const others = [...row.querySelectorAll("[data-id]")].filter((o) => o !== el);
        const after = others.find((o) => {
          const r = o.getBoundingClientRect();
          return ev.clientY < r.top || (ev.clientY <= r.bottom && ev.clientX < r.left + r.width / 2);
        });
        if (after) row.insertBefore(el, after);
        else row.append(el);
      };
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        if (!dragging) return;
        el.classList.remove("dragging");
        el.dataset.dragged = "1";
        setTimeout(() => delete el.dataset.dragged, 50);
        onDone([...row.querySelectorAll("[data-id]")].map((o) => o.dataset.id));
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
  }
}

/** Trip tab top: greeting, your place tiles, saved routes, pass countdowns. */
function renderHome() {
  renderPassesStrip();
  const box = $("#saved-routes");
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Brussels" });
  homeController?.abort();
  box.innerHTML = `<header class="greet"><h2 class="greet-hi">${esc(greeting())}</h2><p class="greet-sub">${esc(today)}</p></header>${favouritesHtml()}`;
  if (favEditing) {
    const pRow = box.querySelector('[data-reorder="places"]');
    const rRow = box.querySelector('[data-reorder="routes"]');
    if (pRow) enableReorder(pRow, (ids) => { userData.places.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)); favouritesChanged(); });
    if (rRow) enableReorder(rRow, (ids) => { userData.routes.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)); favouritesChanged(); });
    return;
  }
  homeController = new AbortController();
  for (const r of userData.routes) if (!r.auto) loadRouteStatus(r, homeController.signal);
}

$("#saved-routes").addEventListener("click", (e) => {
  if (e.target.closest("[data-fav-edit]")) {
    favEditing = !favEditing;
    return renderHome();
  }
  if (e.target.closest("[data-add-place]")) return openPlaceSheet(null);
  const delPlace = e.target.closest("[data-fav-del-place]")?.dataset.favDelPlace;
  if (delPlace) {
    const p = userData.places.find((x) => x.id === delPlace);
    if (p && confirm(`Delete ${p.emoji} ${p.label}?`)) {
      userData.places = userData.places.filter((x) => x.id !== delPlace);
      favouritesChanged(`${p.label} deleted`);
    }
    return;
  }
  const delRoute = e.target.closest("[data-fav-del-route]")?.dataset.favDelRoute;
  if (delRoute) {
    const r = userData.routes.find((x) => x.id === delRoute);
    if (r && confirm(`Delete “${r.name}”?`)) {
      userData.routes = userData.routes.filter((x) => x.id !== delRoute);
      favouritesChanged(`“${r.name}” deleted`);
    }
    return;
  }
  const item = e.target.closest("[data-place], [data-route]");
  if (!item || item.dataset.dragged) return;
  if (item.dataset.place) {
    const p = userData.places.find((x) => x.id === item.dataset.place);
    if (p) return favEditing ? openPlaceSheet(p) : openTripSheet(p);
  }
  const r = userData.routes.find((x) => x.id === item.dataset.route);
  if (r) return favEditing ? openRouteSheet(r) : openRoute(r.id);
});

async function loadRouteStatus(r, signal, big = false) {
  const el = () => document.getElementById(`route-status-${r.id}`);
  try {
    const data =
      r.mode === "train"
        ? await api(`/api/journey?${qs({ from: r.from_id ?? r.from, to: r.to_id ?? r.to, results: 3, walk: userData.walk_min })}`, { signal })
        : await api(`/api/trip?${qs({ from: r.from, to: r.to, from_lat: r.from_lat, from_lon: r.from_lon, to_lat: r.to_lat, to_lon: r.to_lon, disruptions: "0" })}`, { signal });
    const now = Date.now();
    const next = (data.journeys ?? []).find((j) => new Date(shownTime(j.departure)).getTime() > now - 60_000) ?? data.journeys?.[0];
    if (!el()) return;
    if (!next) {
      el().innerHTML = big ? `<span class="nc-muted">No trips found right now</span>` : "";
      return;
    }
    const a = next.analysis;
    const status =
      next.strike ? `<span class="pill bad pill-tri">${RED_TRIANGLE}May not run</span>`
      : a?.level === "broken" ? `<span class="pill bad">Connection missed</span>`
      : a?.level === "cancelled" ? `<span class="pill bad">Cancelled</span>`
      : a?.level === "at_risk" ? `<span class="pill late">Tight change</span>`
      : statusPill(next.departure, next.cancelled);
    if (!big) {
      el().innerHTML = `${hhmm(shownTime(next.departure))}${a && a.level !== "ok" ? " ⚠︎" : ""}`;
      return;
    }
    const lt = a?.leave_by && (a.level === "ok" || a.level === "at_risk") ? leaveText(a.leave_by, shownTime(next.departure)) : null;
    const firstRide = next.legs[0];
    const train = next.legs.find((l) => l.mode === "train" && l.departure.platform);
    const instead = a?.alternative ? `<div class="nc-alt">Best alternative: the ${hhmm(a.alternative.departure)}, arrives ${hhmm(a.alternative.arrival)}</div>` : "";
    el().innerHTML = `
      <div class="nc-main">
        ${lt ? `<span class="nc-leave leave-by" data-leave-by="${esc(a.leave_by)}" data-departs="${esc(shownTime(next.departure) ?? "")}">${lt.text}</span>` : `<span class="nc-leave">${hhmm(shownTime(next.departure))}</span>`}
        <span class="nc-times">${hhmm(shownTime(next.departure))} → ${hhmm(next.arrive_at ?? shownTime(next.arrival))}</span>
      </div>
      <div class="nc-row">
        <span class="mode ${esc(firstRide.mode)}">${modeIcon(firstRide.mode)}<span>${esc(firstRide.line ?? MODE_LABEL[firstRide.mode])}</span></span>
        ${train ? `<span class="nc-plat">${esc(train.vehicle_id ?? "Train")}${platformHtml(train.departure.platform, train.from, "md")}</span>` : ""}
        ${status}
      </div>
      ${instead}`;
  } catch (err) {
    if (err.name === "AbortError" || !el()) return;
    el().innerHTML = big ? `<span class="nc-muted">Live data not available</span>` : "";
  }
}

function openRoute(id) {
  const r = userData.routes.find((x) => x.id === id);
  if (!r) return;
  recordRouteUse(r.id);
  applyMode(r.mode);
  setStop($("#from"), r.from, r.from_id, r.from_lat, r.from_lon);
  setStop($("#to"), r.to, r.to_id, r.to_lat, r.to_lon);
  $("#date").value = "";
  $("#time").value = "";
  refreshGhosts();
  searchTrip();
  $("#results").scrollIntoView({ behavior: scrollMode(), block: "start" });
}

function renderRoutesManage() {
  const box = $("#routes-manage");
  const places = userData.places;
  const routes = userData.routes.filter((r) => !r.auto); // routes made from places stay in the background (alerts)
  if (!places.length && !routes.length) {
    box.innerHTML = `<p class="small muted" style="margin:0">Nothing saved yet. Add places with the <strong>＋</strong> tile on the Trip tab, or tap <strong>☆ Save Route</strong> above search results.</p>`;
    return;
  }
  const row = (emoji, title, sub, attr, id) => `
    <div class="manage-row">
      <div><strong>${esc(emoji)} ${esc(title)}</strong><div class="small muted">${esc(sub)}</div></div>
      <div class="manage-actions"><button type="button" class="btn small" ${attr}="${esc(id)}">Edit</button></div>
    </div>`;
  box.innerHTML =
    (places.length ? `<h3 class="manage-sub">My places</h3>${places.map((p) => row(p.emoji, p.label, p.name, "data-edit-place", p.id)).join("")}` : "") +
    (routes.length ? `<h3 class="manage-sub">Saved routes</h3>${routes.map((r) => row(r.emoji ?? "★", r.name, `${r.from} → ${r.to} · ${r.mode === "commute" ? "Door to door" : "Train"}`, "data-edit-route", r.id)).join("")}` : "");
}

$("#routes-manage").addEventListener("click", (e) => {
  const place = e.target.closest("[data-edit-place]")?.dataset.editPlace;
  const route = e.target.closest("[data-edit-route]")?.dataset.editRoute;
  if (place) {
    const p = userData.places.find((x) => x.id === place);
    if (p) openPlaceSheet(p);
  } else if (route) {
    const r = userData.routes.find((x) => x.id === route);
    if (r) openRouteSheet(r);
  }
});

// ---------- Passes ----------

const DAY_MS = 86_400_000;

/** Whole days left including today, in Brussels time. 0 = last valid day is today; negative = expired. */
function daysLeft(validUntil) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date());
  return Math.round((Date.parse(validUntil) - Date.parse(today)) / DAY_MS);
}

const fmtDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function passStatus(p) {
  const d = daysLeft(p.valid_until);
  if (d < 0) return { cls: "bad", text: `Expired ${-d} day${d === -1 ? "" : "s"} ago` };
  if (d === 0) return { cls: "bad", text: "Last day today" };
  if (d <= p.remind_days) return { cls: "warn", text: `Renew soon: ${d} day${d === 1 ? "" : "s"} left` };
  return { cls: "ok", text: `${d} days left` };
}

/** Where each operator sells and renews season tickets (checked 19 Oct 2026). */
const PASS_OPS = {
  sncb: { name: "SNCB", badge: "SNCB", logo: "/logos/sncb.svg", renew: "https://www.belgiantrain.be/en/products/abonnements/renew-my-abonnement" },
  stib: { name: "STIB", badge: "STIB", logo: "/logos/stib.svg", renew: "https://www.stib-mivb.be/home/buy/product-catalog-season-pass" },
  delijn: { name: "De Lijn", badge: "De Lijn", logo: "/logos/delijn.svg", renew: "https://www.delijn.be/nl/content/vervoerbewijzen/abonnementen/" },
  tec: { name: "TEC", badge: "TEC", logo: "/logos/tec.svg", renew: "https://www.letec.be/tarifs" },
  other: { name: "Other", badge: "Pass", renew: null },
};

/** One pass as a card: operator badge, name, big countdown, and a button to renew it on the operator's site. */
function passCard(p, { manage = false } = {}) {
  const s = passStatus(p);
  const op = PASS_OPS[p.operator] ?? PASS_OPS.other;
  const d = daysLeft(p.valid_until);
  const count = d < 0 ? `<span class="pass-num">0</span><span class="pass-unit">expired</span>` : `<span class="pass-num">${d}</span><span class="pass-unit">day${d === 1 ? "" : "s"} left</span>`;
  const renew = op.renew
    ? `<a class="btn small${s.cls === "ok" ? "" : " renew-now"}" href="${op.renew}" target="_blank" rel="noopener">Renew on ${esc(op.name)} <span aria-hidden="true">↗</span></a>`
    : "";
  const remove = manage ? `<button type="button" class="btn small" data-delete-pass="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button>` : "";
  return `
    <article class="pass ${s.cls}">
      <div class="pass-top">
        ${op.logo
          ? `<span class="op-badge op-logo" aria-hidden="true"><img src="${op.logo}" alt="" width="44" height="44"></span>`
          : `<span class="op-badge op-${esc(p.operator)}" aria-hidden="true">${esc(op.badge)}</span>`}
        <div class="pass-main">
          <div class="pass-name">${esc(p.name)}</div>
          <div class="pass-sub">${esc(op.name)} · valid until ${fmtDate(p.valid_until)}</div>
        </div>
        <div class="pass-count">${count}</div>
      </div>
      ${s.cls === "ok" ? "" : `<p class="pass-status">${s.text}</p>`}
      ${manage ? `<p class="pass-sub">Reminder ${p.remind_days} day${p.remind_days === 1 ? "" : "s"} before it ends</p>` : ""}
      ${renew || remove ? `<div class="pass-actions">${renew}${remove}</div>` : ""}
    </article>`;
}

/** Trip tab: only passes that need renewing (all of them are in Settings), so the planner stays on top. */
function renderPassesStrip() {
  const box = $("#passes-strip");
  box.innerHTML = userData.passes
    .filter((p) => passStatus(p).cls !== "ok")
    .sort((a, b) => a.valid_until.localeCompare(b.valid_until))
    .map((p) => passCard(p))
    .join("");
}

function renderPassesManage() {
  const box = $("#passes-manage");
  box.innerHTML = userData.passes.length
    ? `<div class="pass-list">${userData.passes.map((p) => passCard(p, { manage: true })).join("")}</div>`
    : `<p class="small muted" style="margin-top:0">Add your season ticket or school pass to get a countdown, a reminder before it runs out, and a link to renew it.</p>`;
}

$("#passes-manage").addEventListener("click", (e) => {
  const id = e.target.closest("[data-delete-pass]")?.dataset.deletePass;
  const p = userData.passes.find((x) => x.id === id);
  if (!p || !confirm(`Remove "${p.name}"?`)) return;
  userData.passes = userData.passes.filter((x) => x.id !== id);
  saveUserData();
  renderPassesManage();
});

$("#pass-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (userData.passes.length >= 5) return alert("You can track up to 5 passes.");
  userData.passes.push({
    id: newId(),
    name: $("#pass-name").value.trim().slice(0, 80),
    operator: $("#pass-operator").value,
    valid_until: $("#pass-until").value,
    remind_days: Math.min(60, Math.max(0, Number.parseInt($("#pass-remind").value, 10) || 0)),
  });
  saveUserData();
  e.target.reset();
  refreshGhosts();
  renderPassesManage();
});

// ---------- Departure boards ----------

let boardTimer;
let boardController;
const BOARD_REFRESH_MS = 45_000;

function stopBoardRefresh() {
  clearTimeout(boardTimer);
  boardController?.abort();
}

// Boards can be folded (one summary line) and show 4 rows unless "Show all" is on.
// The choice is remembered per board on this device.
const BOARD_ROWS = 4;
const boardData = new Map(); // board id → last departures, or { error } html
const boardState = () => store.get("boardState", {}); // id → "collapsed" | "all"
function setBoardState(id, value) {
  const all = boardState();
  if (value) all[id] = value;
  else delete all[id];
  store.set("boardState", all);
}

const CHEVRON = `<svg class="chev" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

function renderBoards() {
  stopBoardRefresh();
  const box = $("#boards");
  if (!userData.boards.length) {
    box.innerHTML = `<div class="notice">Add the stops you use most, like your metro stop, your station and your bus stop in Gent. Each one shows its next departures, live.</div>`;
    return;
  }
  const state = boardState();
  const allCollapsed = userData.boards.every((b) => state[b.id] === "collapsed");
  const toggleAll = userData.boards.length > 1
    ? `<div class="boards-actions"><button type="button" class="btn small" id="boards-toggle-all">${allCollapsed ? "Expand All" : "Collapse All"}</button></div>`
    : "";
  box.innerHTML = toggleAll + userData.boards
    .map((b) => {
      const open = state[b.id] !== "collapsed";
      return `
      <section class="card board-card">
        <div class="board-head">
          <h3><button type="button" class="board-toggle" data-board-toggle="${esc(b.id)}" aria-expanded="${open}" aria-controls="board-${esc(b.id)}">${CHEVRON}<span>${esc(b.stop)}${b.operator ? ` <span class="small muted">${esc(OPERATOR_NAME[b.operator] ?? b.operator.toUpperCase())}</span>` : ""}</span></button></h3>
          <button type="button" class="btn small" data-delete-board="${esc(b.id)}" aria-label="Remove ${esc(b.stop)}">✕</button>
        </div>
        <div id="board-${esc(b.id)}">${boardData.has(b.id) ? "" : `<div class="loading"><span class="spinner" aria-hidden="true"></span>Loading…</div>`}</div>
      </section>`;
    })
    .join("");
  for (const b of userData.boards) if (boardData.has(b.id)) renderBoardBody(b);
  refreshBoards();
}

function renderBoardBody(b) {
  const el = document.getElementById(`board-${b.id}`);
  const data = boardData.get(b.id);
  if (!el || !data) return;
  const state = boardState()[b.id];
  if (data.error) {
    el.innerHTML = state === "collapsed" ? `<p class="board-summary">Data not available right now</p>` : data.error;
    return;
  }
  const { rows, ended, source } = boardItems(data);
  if (state === "collapsed") {
    el.innerHTML = `<p class="board-summary">${rows.length ? rows.slice(0, 3).map((r) => r.short).join(" · ") : "No departures right now"}</p>`;
    return;
  }
  if (!rows.length) {
    el.innerHTML = `<p class="muted">No departures right now.</p>${ended}${source}`;
    return;
  }
  const showAll = state === "all";
  const visible = showAll ? rows : rows.slice(0, BOARD_ROWS);
  const more = rows.length > BOARD_ROWS
    ? `<button type="button" class="btn small board-more" data-board-more="${esc(b.id)}">${showAll ? "Show Fewer" : `Show All (${rows.length})`}</button>`
    : "";
  el.innerHTML = `<ul class="board">${visible.map((r) => r.html).join("")}</ul>${more}${ended}${source}`;
}

async function refreshBoards() {
  boardController?.abort();
  boardController = new AbortController();
  const signal = boardController.signal;
  await Promise.all(userData.boards.map((b) => loadBoard(b, signal)));
  if (signal.aborted) return;
  boardTimer = setTimeout(() => {
    if (document.visibilityState === "visible" && !$("#view-boards").hidden) refreshBoards();
  }, BOARD_REFRESH_MS);
}

async function loadBoard(b, signal) {
  try {
    const data = await api(`/api/departures?${qs({ stop: b.stop_id ?? b.stop, operator: b.operator, limit: 12 })}`, { signal });
    boardData.set(b.id, data);
  } catch (err) {
    if (err.name === "AbortError") return;
    boardData.set(b.id, { error: errorNotice(err, OPERATOR_NAME[b.operator] ?? "Transit") });
  }
  renderBoardBody(b);
}

/** Rows for one stop (departures that already left are hidden), each with a one-line summary. */
function boardItems(data) {
  const now = Date.now();
  const upcoming = (data.departures ?? []).filter((d) => new Date(shownTime(d)).getTime() > now - 60_000);
  const waitText = (d) => {
    const mins = Math.max(0, Math.round((new Date(shownTime(d)).getTime() - now) / 60_000));
    return mins === 0 ? "now" : `${mins} min`;
  };
  const chip = (d) =>
    `<span class="mode ${esc(d.mode)}" aria-label="${esc(MODE_LABEL[d.mode] ?? d.mode)} ${esc(d.line ?? "")}">${modeIcon(d.mode)}<span>${esc(d.line ?? MODE_LABEL[d.mode])}</span></span>`;
  const ended = data.ended_lines?.length ? `<p class="small muted">No service right now: ${esc(data.ended_lines.join(", "))}</p>` : "";
  const source = sourceLine(data.meta);
  let rows;

  if (upcoming[0]?.operator === "stib") {
    // STIB: one row per line + direction with its next two (different) waiting times, like the screens at the stop.
    const groups = new Map();
    for (const d of upcoming) {
      const key = `${d.line}|${d.direction}`;
      if (!groups.has(key)) groups.set(key, { d, times: [] });
      const g = groups.get(key);
      const w = waitText(d);
      if (g.times.length < 2 && g.times.at(-1) !== w) g.times.push(w);
    }
    rows = [...groups.values()].slice(0, 10).map(({ d, times }) => ({
      short: `${d.line ?? ""} ${times[0]}`,
      html: `
      <li>
        ${chip(d)}
        <div class="board-dir"><strong>${esc(d.direction ?? "")}</strong></div>
        <div class="board-when"><strong>${times[0]}</strong>${times[1] ? `<div class="small muted">then ${times[1]}</div>` : ""}</div>
      </li>`,
    }));
  } else {
    rows = upcoming.slice(0, 10).map((d) => {
      const t = shownTime(d);
      const late = d.delay_min > 0 ? ` +${d.delay_min}` : "";
      return {
        short: `${d.line ?? ""} ${hhmm(t)}${d.cancelled ? " cancelled" : late}`,
        html: `
        <li class="dep">
          ${chip(d)}
          <div class="board-dir"><strong>${esc(d.direction ?? "")}</strong>${d.arrival_at_to ? `<div class="small muted">arr ${hhmm(shownTime(d.arrival_at_to))}</div>` : ""}</div>
          ${platformHtml(d.platform, data.stop, "md", d.mode) || "<span></span>"}
          <div class="board-when"><strong class="dep-time${d.delay_min > 0 && !d.cancelled ? " late" : ""}">${hhmm(t)}</strong>${
            d.cancelled || d.delay_min > 0 ? statusPill(d, d.cancelled) : `<span class="countdown">${waitText(d) === "now" ? "now" : `in ${waitText(d)}`}</span>`
          }</div>
        </li>`,
      };
    });
  }
  return { rows, ended, source };
}

$("#boards").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-board-toggle]");
  if (toggle) {
    const b = userData.boards.find((x) => x.id === toggle.dataset.boardToggle);
    const open = toggle.getAttribute("aria-expanded") === "true";
    setBoardState(b.id, open ? "collapsed" : undefined);
    toggle.setAttribute("aria-expanded", String(!open));
    renderBoardBody(b);
    const all = $("#boards-toggle-all");
    if (all) all.textContent = userData.boards.every((x) => boardState()[x.id] === "collapsed") ? "Expand All" : "Collapse All";
    return;
  }
  const more = e.target.closest("[data-board-more]");
  if (more) {
    const b = userData.boards.find((x) => x.id === more.dataset.boardMore);
    setBoardState(b.id, boardState()[b.id] === "all" ? undefined : "all");
    renderBoardBody(b);
    return;
  }
  if (e.target.closest("#boards-toggle-all")) {
    const collapse = e.target.closest("#boards-toggle-all").textContent.includes("Collapse");
    // Folding only changes what is shown; no new data is fetched.
    for (const b of userData.boards) {
      setBoardState(b.id, collapse ? "collapsed" : undefined);
      document.querySelector(`[data-board-toggle="${CSS.escape(b.id)}"]`)?.setAttribute("aria-expanded", String(!collapse));
      renderBoardBody(b);
    }
    e.target.closest("#boards-toggle-all").textContent = collapse ? "Expand All" : "Collapse All";
    return;
  }
  const id = e.target.closest("[data-delete-board]")?.dataset.deleteBoard;
  if (!id) return;
  userData.boards = userData.boards.filter((b) => b.id !== id);
  saveUserData();
  renderBoards();
});

$("#board-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#board-stop");
  if (!input.value.trim()) return;
  if (userData.boards.length >= 10) return alert("You can add up to 10 stops. Remove one first.");
  const operator = $("#board-operator").value || undefined;
  if (!(await resolveStop(input, operator))) return;
  const stop = input.value.trim();
  const stopId = input.dataset.stopName === stop ? input.dataset.stopId : undefined;
  userData.boards.push({ id: newId(), stop: stop.slice(0, 80), ...(stopId ? { stop_id: stopId } : {}), ...(operator ? { operator } : {}) });
  stopHint(input);
  saveUserData();
  e.target.reset();
  renderBoards();
});

// Stop field on the board form: suggestions + auto-select, filtered by the chosen operator.
attachStopField($("#board-stop"), $("#board-list"), () => $("#board-operator").value || undefined);

// "Try again" on any error notice re-runs what failed.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-retry]");
  if (!b) return;
  if (b.closest("#results")) searchTrip();
  else if (b.closest("#boards")) refreshBoards();
});

// ---------- Home: logo goes home, transit line divider ----------

$("#home-link").addEventListener("click", (e) => {
  e.preventDefault();
  showView("trip");
});

// The little railway under the header on every tab: side views of a train, tram, bus and metro.
// They drive like the real thing: each has its own top speed, acceleration and braking. Rail vehicles
// brake into the station and wait, then pull away; the bus does the same at its bus stop on the road
// lane in front. Rail vehicles keep their distance (a fast train slows behind a tram). Wheels turn
// with the actual speed. One requestAnimationFrame loop, only for the visible tab; with Reduce Motion
// they stand still. Bus: rubber tyres. Train, tram and metro: rail bogies with small steel wheels.
// Artwork: 120×40 side views. The body is the mode colour (currentColor); a shared shading overlay
// (light top, darker bottom), glass with a reflection, door seams, roof gear, lights and a soft ground
// shadow make them look rounded. Gradients live once in an always-rendered <svg> (see below), because a
// gradient inside a hidden tab stops working in Safari.
const tyre = (x) => `<g class="wh tyre"><circle cx="${x}" cy="33.6" r="4.6"/><circle class="hub" cx="${x}" cy="33.6" r="2.1"/><path d="M${x} 31.5v4.2M${x - 2.1} 33.6h4.2"/></g>`;
const steel = (x) => `<g class="wh rail"><circle cx="${x}" cy="34.4" r="2.9"/><path d="M${x} 31.5v5.8M${x - 2.9} 34.4h5.8"/></g>`;
const bogie = (x) => `<rect class="bogie" x="${x - 9}" y="30.5" width="18" height="3.4" rx="1.6"/>${steel(x - 4.6)}${steel(x + 4.6)}`;
const pane = (x, y, w, h, r = 1.6) => `<rect class="glass" x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;
const door = (x, y, h, w = 8) => `<rect class="door" x="${x}" y="${y}" width="${w}" height="${h}" rx="1.2"/><path class="seam" d="M${x + w / 2} ${y + 0.6}v${h - 1.2}"/>${pane(x + 1, y + 1.4, w / 2 - 1.5, h * 0.42, 0.8)}${pane(x + w / 2 + 0.5, y + 1.4, w / 2 - 1.5, h * 0.42, 0.8)}`;
const shadow = `<ellipse class="ground" cx="60" cy="38.6" rx="56" ry="1.5"/>`;

const SIDE_VIEWS = {
  // Train: modern electric unit with a sloped nose, pantograph, roof units and a yellow stripe.
  train: `${shadow}<g class="body">
    <path class="p" d="M40 7.5l5.5-5.5M51 7.5l-5.5-5.5M38.5 2h14"/>
    <rect class="roofgear" x="18" y="4.6" width="13" height="3" rx="1"/><rect class="roofgear" x="62" y="4.6" width="13" height="3" rx="1"/>
    <path class="b" d="M6 7.5h85c11 0 19 5.5 24.5 13.5l1.5 3v6.5a2.5 2.5 0 0 1-2.5 2.5H6a3 3 0 0 1-3-3V10.5a3 3 0 0 1 3-3z"/>
    <path class="shade" d="M6 7.5h85c11 0 19 5.5 24.5 13.5l1.5 3v6.5a2.5 2.5 0 0 1-2.5 2.5H6a3 3 0 0 1-3-3V10.5a3 3 0 0 1 3-3z"/>
    <rect class="frame" x="7" y="11" width="82" height="8" rx="2"/>
    ${pane(9, 12, 15, 6)}${pane(34, 12, 18, 6)}${pane(60, 12, 18, 6)}${pane(84, 12, 4, 6, 1)}
    <path class="glass" d="M93 11.5h3c6 0 11 3 14.5 8.5H93z"/>
    ${door(25.5, 11, 18)}${door(52.5, 11, 18, 7)}
    <rect class="stripe" x="3" y="21.5" width="112" height="1.6"/><rect class="accent" x="3" y="24" width="112" height="1.1"/>
    <rect class="skirt" x="3" y="28.6" width="114" height="2.4" rx="1"/>
    <circle class="lamp" cx="113.2" cy="25.6" r="1.4"/>
  </g>${bogie(20)}${bogie(97)}`,
  // Tram: long low-floor, three sections with joints, big windows, pantograph in the middle.
  tram: `${shadow}<g class="body">
    <path class="p" d="M54 7.5l5-5M64 7.5l-5-5M52.5 2.5h13"/>
    <rect class="roofgear" x="14" y="5" width="11" height="2.6" rx="1"/><rect class="roofgear" x="92" y="5" width="11" height="2.6" rx="1"/>
    <rect class="b" x="3" y="7.5" width="113" height="22" rx="8"/>
    <rect class="shade" x="3" y="7.5" width="113" height="22" rx="8"/>
    <rect class="frame" x="7" y="10.5" width="104" height="10" rx="2.5"/>
    ${pane(9, 11.5, 12, 8)}${pane(27, 11.5, 9, 8)}${pane(45, 11.5, 12, 8)}${pane(63, 11.5, 12, 8)}${pane(83, 11.5, 9, 8)}
    <path class="glass" d="M100 11.5h6a4 4 0 0 1 4 4v4h-10z"/>
    ${door(37.5, 10.5, 18)}${door(76, 10.5, 18)}${door(21.5, 10.5, 18, 5)}
    <rect class="joint" x="40" y="8" width="2" height="21"/><rect class="joint" x="79" y="8" width="2" height="21"/>
    <rect class="stripe" x="3" y="23" width="113" height="1.6"/>
    <rect class="skirt" x="5" y="27.4" width="109" height="2.6" rx="1.2"/>
    <circle class="lamp" cx="112.5" cy="24.6" r="1.4"/>
  </g>${bogie(18)}${bogie(60)}${bogie(101)}`,
  // Metro: boxy with rounded ends, wide doors and the white "M" badge.
  metro: `${shadow}<g class="body">
    <rect class="roofgear" x="20" y="5" width="16" height="2.8" rx="1"/><rect class="roofgear" x="80" y="5" width="16" height="2.8" rx="1"/>
    <rect class="b" x="3" y="7.5" width="114" height="22.5" rx="7"/>
    <rect class="shade" x="3" y="7.5" width="114" height="22.5" rx="7"/>
    <rect class="frame" x="8" y="11" width="104" height="8" rx="2"/>
    ${pane(10, 12, 13, 6)}${pane(36, 12, 15, 6)}${pane(69, 12, 15, 6)}${pane(97, 12, 13, 6)}
    ${door(24.5, 10.5, 18.5, 10)}${door(85.5, 10.5, 18.5, 10)}
    <circle class="badge" cx="60" cy="16" r="5.2"/><path class="m" d="M57.3 18.4v-4.8l2.7 3.1 2.7-3.1v4.8"/>
    <rect class="stripe" x="3" y="22" width="114" height="1.6"/>
    <rect class="skirt" x="5" y="27.6" width="110" height="2.6" rx="1.2"/>
    <circle class="lamp" cx="114.2" cy="25" r="1.3"/><circle class="tail" cx="5.8" cy="25" r="1.1"/>
  </g>${bogie(24)}${bogie(96)}`,
  // Bus: big windscreen, two doors, destination display, wheel arches and tyres with hubcaps.
  bus: `${shadow}<g class="body">
    <rect class="roofgear" x="34" y="3.4" width="26" height="3" rx="1.2"/>
    <path class="b" d="M7 6h100a6 6 0 0 1 6 6v18a2.5 2.5 0 0 1-2.5 2.5H6.5A3.5 3.5 0 0 1 3 29V10a4 4 0 0 1 4-4z"/>
    <path class="shade" d="M7 6h100a6 6 0 0 1 6 6v18a2.5 2.5 0 0 1-2.5 2.5H6.5A3.5 3.5 0 0 1 3 29V10a4 4 0 0 1 4-4z"/>
    <rect class="frame" x="6" y="9.5" width="92" height="10" rx="2"/>
    ${pane(8, 10.5, 13, 8)}${pane(23, 10.5, 13, 8)}${pane(51, 10.5, 13, 8)}${pane(66, 10.5, 13, 8)}${pane(81, 10.5, 9, 8)}
    <path class="glass" d="M102 9h5.5a3.5 3.5 0 0 1 3.5 3.5V22h-9z"/>
    <rect class="led" x="100" y="6.8" width="10" height="1.8" rx=".6"/>
    ${door(37.5, 9.5, 20, 11)}${door(91, 9.5, 20, 9)}
    <rect class="stripe" x="3" y="22" width="110" height="1.6"/>
    <path class="arch" d="M9 32.5a8 8 0 0 1 16 0zM90 32.5a8 8 0 0 1 16 0z"/>
    <circle class="lamp" cx="111.2" cy="26.4" r="1.4"/><rect class="tail" x="3" y="24.5" width="1.6" height="3" rx=".6"/>
  </g>${tyre(17)}${tyre(98)}`,
};

/** Shared gradients, defined once in an <svg> that is never hidden. */
document.body.insertAdjacentHTML(
  "afterbegin",
  `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
    <linearGradient id="ld-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset=".42" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".32"/></linearGradient>
    <linearGradient id="ld-glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef4fc"/><stop offset=".48" stop-color="#a9bfdc"/><stop offset=".5" stop-color="#8ea6c8"/><stop offset="1" stop-color="#6a84a9"/></linearGradient>
  </defs></svg>`,
);

/** px/s and seconds. Rail vehicles share the rail; the bus has the road lane in front. */
const DRIVE = {
  train: { vmax: 150, acc: 55, brake: 90, dwell: 1.6, rail: true },
  tram: { vmax: 68, acc: 42, brake: 70, dwell: 2.0, rail: true },
  bus: { vmax: 82, acc: 38, brake: 75, dwell: 2.2, rail: false },
  metro: { vmax: 108, acc: 70, brake: 95, dwell: 1.4, rail: true },
};
const VEH_W = 78;
const STATION_AT = 0.36;
const BUS_STOP_AT = 0.74;
/** Belgian skyline silhouette (600×60): stepped-gable houses, Gent's belfry and St Bavo, the Atomium,
 *  Brussels town hall, Antwerp cathedral, a Flemish windmill, Koekelberg basilica, trees. */
function skylineSvg(cls) {
  const gable = (x, w, h) => {
    // A row house with a stepped gable (3 steps each side).
    const s = w / 6;
    const top = 60 - h;
    return `<path d="M${x} 60V${top + 9}h${s}v-3h${s}v-3h${s}v-3h${s}v3h${s}v3h${s}v3V60z"/>`;
  };
  const tree = (x, r) => `<circle cx="${x}" cy="${60 - r - 3}" r="${r}"/><rect x="${x - 0.8}" y="${60 - 4}" width="1.6" height="4"/>`;
  const sphere = (x, y) => `<circle cx="${x}" cy="${y}" r="3.6"/>`;
  return `<svg class="${cls}" viewBox="0 0 600 60" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    ${gable(0, 16, 22)}${gable(16, 14, 26)}${gable(30, 16, 20)}
    <path d="M52 60V30h3v-6h2v-8l3-10 3 10v8h2v6h3v30z"/>
    ${gable(70, 14, 24)}
    <path d="M86 60V24h2v-5h2v5h4v-5h2v5h2v36z"/><path d="M87 19l1-4 1 4M95 19l1-4 1 4"/>
    ${tree(106, 6)}${tree(116, 5)}
    <g class="atomium">
      <path d="M150 60l-8-4M150 60h0M168 60l8-4" />
      <path d="M140 52l9-13 9 13M140 26l9 13 9-13M140 26v26M158 26v26M149 13v52" />
      ${sphere(149, 13)}${sphere(140, 26)}${sphere(158, 26)}${sphere(149, 39)}${sphere(140, 52)}${sphere(158, 52)}
      <path d="M137 60l3-8M161 60l-3-8M149 60v-8" />
    </g>
    ${tree(176, 5)}
    <path d="M190 60V36h30v24z"/><path d="M203 36V20h4v16z"/><path d="M204 20l1-16 1 16z"/>
    ${gable(222, 14, 25)}${gable(236, 16, 21)}
    <path d="M258 60V38h10v-8l4-2 4 2v8h10v22z"/><path d="M270 28V14h4v14z"/><path d="M270.5 14l1.5-14 1.5 14z"/>
    ${tree(296, 6)}${tree(307, 4)}
    <path d="M330 60V46h8V60zM334 46l-5-5 5-5 5 5z"/><path d="M334 41l-12-12M334 41l12-12M334 41l-12 12M334 41l12 12" class="sail"/>
    ${gable(352, 14, 22)}${gable(366, 16, 27)}${gable(382, 14, 21)}
    <path d="M404 60V40a16 14 0 0 1 32 0v20z"/><path d="M417 26a3 3 0 0 1 6 0v3h-6z"/><path d="M419.5 26V21h1v5z"/><path d="M398 60V44h6v16zM436 60V44h6v16z"/>
    ${tree(452, 6)}${tree(462, 5)}
    ${gable(474, 16, 24)}${gable(490, 14, 20)}
    <path d="M512 60V34h10V22h4v-4l2-6 2 6v4h4v12h10v26z"/>
    ${tree(556, 5)}${gable(566, 16, 23)}${gable(582, 18, 19)}
  </svg>`;
}

/** Station on the rail line: curved canopy, platform with a yellow edge, sign with clock, bench, lamp. */
const LD_STATION = `<svg class="ld-station" viewBox="0 0 72 36" aria-hidden="true">
  <rect class="st-platform" x="2" y="29" width="68" height="5" rx="1"/><rect class="st-edge" x="2" y="29" width="68" height="1.2"/>
  <rect class="st-post" x="10" y="9" width="2" height="20"/><rect class="st-post" x="35" y="9" width="2" height="20"/><rect class="st-post" x="60" y="9" width="2" height="20"/>
  <path class="st-roof" d="M1 10c12-6 58-6 70 0v2c-12-5-58-5-70 0z"/>
  <rect class="st-sign" x="25" y="13" width="22" height="6" rx="1.2"/><rect class="st-signtext" x="28" y="15.4" width="12" height="1.4" rx=".6"/><circle class="st-clock" cx="43.5" cy="16" r="1.8"/>
  <rect class="st-post" x="17" y="25.6" width="9" height="1.4" rx=".6"/><rect class="st-post" x="18" y="27" width="1" height="2"/><rect class="st-post" x="24" y="27" width="1" height="2"/>
  <rect class="st-post" x="66" y="15" width="1.2" height="14"/><circle class="st-lamp" cx="66.6" cy="14.6" r="1.6"/>
</svg>`;

/** Bus shelter: roof, glass back panel, bench, timetable and a round bus-stop sign on a pole. */
const LD_BUS_STOP = `<svg class="ld-busstop" viewBox="0 0 34 36" aria-hidden="true">
  <rect class="st-roof" x="1" y="9" width="24" height="2.4" rx="1"/>
  <rect class="st-glass" x="3" y="11.4" width="19" height="19" rx="1"/>
  <rect class="st-post" x="2.4" y="11.4" width="1.4" height="22"/><rect class="st-post" x="21.6" y="11.4" width="1.4" height="22"/>
  <rect class="st-post" x="6" y="25" width="10" height="1.4" rx=".6"/>
  <rect class="st-board" x="16.5" y="14" width="4" height="7" rx=".6"/>
  <rect class="st-post" x="28.6" y="9" width="1.4" height="25"/>
  <circle class="st-busdisc" cx="29.3" cy="7" r="4.8"/><rect class="st-busicon" x="26.8" y="4.8" width="5" height="3.8" rx="1"/><rect class="st-busdisc" x="27.6" y="5.6" width="3.4" height="1.4" rx=".4"/>
  <rect class="st-curb" x="0" y="33.4" width="34" height="2.6" rx="1"/>
</svg>`;

const LD_CLOUDS = `<svg class="ld-cloud c1" viewBox="0 0 40 14" aria-hidden="true"><path d="M8 13a6 6 0 0 1 1-11.8A8 8 0 0 1 24 3a6 6 0 0 1 9 5 5 5 0 0 1-1 5z"/></svg><svg class="ld-cloud c2" viewBox="0 0 40 14" aria-hidden="true"><path d="M8 13a6 6 0 0 1 1-11.8A8 8 0 0 1 24 3a6 6 0 0 1 9 5 5 5 0 0 1-1 5z"/></svg>`;

const dividerHtml =
  skylineSvg("ld-skyline") + LD_CLOUDS + LD_STATION + LD_BUS_STOP +
  ["train", "tram", "metro", "bus"].map((m) => `<svg class="ld-veh ${m}${DRIVE[m].rail ? "" : " road"}" viewBox="0 0 120 40" aria-hidden="true">${SIDE_VIEWS[m]}</svg>`).join("");

const dividers = [...document.querySelectorAll(".line-divider")].map((d) => {
  d.innerHTML = `<span class="ld-track"></span>${dividerHtml}`;
  d.querySelector(".ld-station").style.left = `calc(${STATION_AT * 100}% - 36px)`;
  d.querySelector(".ld-busstop").style.left = `calc(${BUS_STOP_AT * 100}% + ${VEH_W / 2 - 4}px)`;
  const vehicles = [...d.querySelectorAll(".ld-veh")].map((el) => {
    const kind = ["train", "tram", "bus", "metro"].find((k) => el.classList.contains(k));
    return { el, kind, ...DRIVE[kind], x: -VEH_W - 10, v: 0, phase: "wait", until: 0, served: false, angle: 0, wheels: [...el.querySelectorAll(".wh")] };
  });
  return { d, vehicles, started: false };
});

function placeVehicle(veh) {
  veh.el.style.transform = `translateX(${veh.x.toFixed(1)}px)`;
  veh.el.classList.toggle("stopped", veh.v < 1);
  for (const w of veh.wheels) w.style.transform = `rotate(${veh.angle.toFixed(1)}deg)`;
}

/** First frame on a divider: a train already rolling in and the bus on its way, the others follow. */
function startDividerScene({ d, vehicles }, now) {
  const W = d.clientWidth;
  for (const veh of vehicles) {
    if (veh.kind === "train") Object.assign(veh, { phase: "drive", x: W * 0.04, v: veh.vmax * 0.6 });
    else if (veh.kind === "bus") Object.assign(veh, { phase: "drive", x: W * 0.42, v: veh.vmax * 0.8 });
    else Object.assign(veh, { phase: "wait", until: now + (veh.kind === "metro" ? 2500 : 6500) });
    placeVehicle(veh);
  }
}

function stepDivider({ d, vehicles }, dt, now) {
  const W = d.clientWidth;
  for (const veh of vehicles) {
    if (veh.phase === "wait") {
      const entryClear = !veh.rail || !vehicles.some((o) => o !== veh && o.rail && o.phase !== "wait" && o.x < 40);
      if (now < veh.until || !entryClear) continue;
      Object.assign(veh, { phase: "drive", x: -VEH_W - 4, v: veh.vmax * 0.7, served: false });
    }
    if (veh.phase === "dwell") {
      if (now >= veh.until) Object.assign(veh, { phase: "drive", served: true });
      else continue;
    }
    // Where must it stop? Its station (once), or behind the rail vehicle ahead.
    const stopX = (veh.rail ? STATION_AT : BUS_STOP_AT) * W - VEH_W / 2;
    let target = veh.served ? Infinity : stopX;
    if (veh.rail) {
      for (const o of vehicles) if (o !== veh && o.rail && o.phase !== "wait" && o.x > veh.x) target = Math.min(target, o.x - VEH_W - 12);
    }
    const dist = target - veh.x;
    if (dist <= (veh.v * veh.v) / (2 * veh.brake) + 1) veh.v = Math.max(0, veh.v - veh.brake * dt);
    else veh.v = Math.min(veh.vmax, veh.v + veh.acc * dt);
    // Creep the last bit so it stops exactly at the platform.
    if (veh.v === 0 && dist > 0.5 && dist < 30 && target === stopX) veh.v = Math.min(12, dist * 2);
    veh.x = Math.min(veh.x + veh.v * dt, Math.max(veh.x, target));
    if (veh.x >= target - 0.01 && target !== Infinity) veh.v = Math.min(veh.v, 0);
    veh.angle = (veh.angle + ((veh.v * dt) / 3) * 57.3) % 360;
    if (!veh.served && veh.v === 0 && Math.abs(veh.x - stopX) < 1) Object.assign(veh, { phase: "dwell", until: now + veh.dwell * 1000 });
    if (veh.x > W + 10) Object.assign(veh, { phase: "wait", x: -VEH_W - 10, v: 0, until: now + 1200 + Math.random() * 3500 });
    placeVehicle(veh);
  }
}

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
let ldLast = 0;
function dividerFrame(now) {
  const dt = Math.min(0.05, (now - (ldLast || now)) / 1000);
  ldLast = now;
  for (const div of dividers) {
    if (!div.d.offsetParent) continue; // only the visible tab
    if (!div.started) {
      startDividerScene(div, now);
      div.started = true;
    } else stepDivider(div, dt, now);
  }
  if (!reduceMotion.matches) requestAnimationFrame(dividerFrame);
}
// With Reduce Motion they stand still, spread along the line (positions in styles.css).
if (!reduceMotion.matches) requestAnimationFrame(dividerFrame);

// ---------- Journey tracker ----------
// "Start Journey" saves the trip on this device. The current step is worked out from the clock and the
// live times every time the screen updates, so reopening the app mid-journey lands on the right step.
// GPS (only while the app is open, never sent to the server) shows where you are and notices when
// you're not on the planned trip.

const JOURNEY_KEY = "activeJourney";
const JOURNEY_TICK_MS = 5_000;
const JOURNEY_REFRESH_MS = 60_000;
let journey = store.get(JOURNEY_KEY);
let journeyTick;
let journeyRefresh;
let geoWatch = null;
let geoProblem = null;
let position = null;
let wakeLock = null;
let journeyMap = null;
let journeyDot = null;
let journeyMapFitted = false;

const EXTRA_ICONS = {
  walk: '<circle cx="13.5" cy="3.75" r="1.75" fill="currentColor" stroke="none"/><path d="M12.5 7.5l-1.5 6"/><path d="M11 13.5l-2.5 3.5-1 4"/><path d="M11 13.5l3 3 .5 4.5"/><path d="M8 10.5l4-3 2.5 3 2.5 1"/>',
  done: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
};
const stepIcon = (kind) =>
  MODE_ICON_PATHS[kind]
    ? modeIcon(kind)
    : `<svg class="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${EXTRA_ICONS[kind] ?? ""}</svg>`;

const msOf = (iso) => (iso ? Date.parse(iso) : NaN);
const brusselsDay = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(d);
const brusselsHm = (d) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Brussels" }).format(d);
const legLabel = (l) => `${MODE_LABEL[l.mode] ?? l.mode} ${l.vehicle_id ?? l.line ?? ""}`.trim();
// Compare moments, not text: the same time can be written in UTC ("…Z") or Belgian time ("…+02:00").
const journeySignature = (j) => j.legs.map((l) => `${l.line ?? l.vehicle_id}|${Date.parse(l.departure.scheduled)}`).join(">");

function distM(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** Points along a leg: its real shape, or a straight line split into many points. */
function legLine(leg) {
  if (leg.path?.length > 1) return leg.path;
  return Array.from({ length: 41 }, (_, k) => [leg.from.lat + ((leg.to.lat - leg.from.lat) * k) / 40, leg.from.lon + ((leg.to.lon - leg.from.lon) * k) / 40]);
}
const distToLine = (p, pts) => Math.min(...pts.map(([lat, lon]) => distM(p, { lat, lon })));

/** The trip as steps: walk/go to the first stop, ride, change, …, final walk, arrived. */
function journeySteps(j, dest) {
  const steps = [];
  const first = j.legs[0];
  steps.push({
    kind: "walk",
    title: j.walk_start_min ? `Walk to ${first.from.name}` : `Go to ${first.from.name}`,
    detail: `${j.walk_start_min ? `${j.walk_start_min} min walk · ` : ""}${legLabel(first)} leaves ${hhmm(shownTime(first.departure))}`,
    plat: { p: first.departure.platform, stop: first.from, mode: first.mode },
    until: shownTime(first.departure),
    verb: "leaves",
    leg: first,
  });
  j.legs.forEach((leg, i) => {
    if (i > 0) {
      const walk = leg.transfer_before?.walk_min;
      steps.push({
        kind: "walk",
        title: `Change at ${leg.from.name}`,
        detail: `${walk ? `${walk} min walk · ` : ""}${legLabel(leg)} → ${leg.direction ?? ""} leaves ${hhmm(shownTime(leg.departure))}`,
        plat: { p: leg.departure.platform, stop: leg.from, mode: leg.mode },
        until: shownTime(leg.departure),
        verb: "leaves",
        leg,
      });
    }
    steps.push({
      kind: leg.mode,
      title: `${legLabel(leg)} → ${leg.direction ?? leg.to.name}`,
      detail: `Get off at ${leg.to.name} · ${hhmm(shownTime(leg.arrival))}`,
      plat: { p: leg.arrival.platform, stop: leg.to, mode: leg.mode },
      until: shownTime(leg.arrival),
      verb: "arrives",
      leg,
      ride: true,
    });
  });
  if (j.walk_end_min) steps.push({ kind: "walk", title: `Walk to ${dest}`, detail: `${j.walk_end_min} min walk`, until: j.arrive_at, verb: "arrive" });
  steps.push({ kind: "done", title: `You've arrived at ${dest}`, detail: "Have a good day!", until: null });
  return steps;
}

/** The platform sign for a journey step (departure platform before a ride, arrival platform during it). */
const stepPlat = (st, size = "sm") => (st.plat ? platformHtml(st.plat.p, st.plat.stop, size, st.plat.mode) : "");

/** Current step from the clock: the first step that hasn't finished yet. */
function currentStepIndex(steps, now = Date.now()) {
  const i = steps.findIndex((s) => s.until && msOf(s.until) > now - 30_000);
  return i === -1 ? steps.length - 1 : i;
}

function countdown(iso, now = Date.now()) {
  const mins = Math.round((msOf(iso) - now) / 60_000);
  if (!Number.isFinite(mins)) return "";
  if (mins > 60) return `at ${hhmm(iso)}`;
  if (mins <= 0) return "now";
  return `in ${mins} min`;
}

/** GPS check: are you where this trip expects you to be? */
function offTripMessage(step) {
  if (!position || !step?.leg || position.accuracy > 300) return null;
  const leg = step.leg;
  const now = Date.now();
  // Only a fresh, precise fix can say you're not on board: underground (metro) the phone gets no new
  // fixes and the last one is still at the station you left from.
  const fresh = now - (position.at ?? 0) < 90_000 && position.accuracy <= 100;
  if (step.ride) {
    if (!fresh) return null;
    const nearStart = distM(position, leg.from) < 250;
    if (nearStart && now > msOf(shownTime(leg.departure)) + 3 * 60_000) return `It looks like you missed the ${legLabel(leg)}.`;
    if (distToLine(position, legLine(leg)) > Math.max(2000, position.accuracy * 2)) return `You don't seem to be on the ${legLabel(leg)}.`;
  } else if (now > msOf(step.until) - 60_000 && distM(position, leg.from) > 1500) {
    return `You're still far from ${leg.from.name} and the ${legLabel(leg)} leaves ${countdown(step.until)}.`;
  }
  return null;
}

async function startJourney(index) {
  const j = currentJourneys[index];
  if (!j || !lastRequest) return;
  const firstDep = new Date(msOf(j.legs[0].departure.scheduled ?? shownTime(j.legs[0].departure)) - 60_000);
  const last = j.legs.at(-1);
  journey = {
    trip: j,
    signature: journeySignature(j),
    dest: lastRequest.toName || last.to.name,
    destCoords: lastRequest.toCoords?.lat !== undefined ? lastRequest.toCoords : { lat: last.to.lat, lon: last.to.lon },
    // Same search, starting just before this trip, to fetch fresh live times for it.
    request: { path: lastRequest.path, params: { ...lastRequest.params, time: brusselsHm(firstDep), date: brusselsDay(firstDep), arrive_by: undefined, disruptions: "0" } },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.set(JOURNEY_KEY, journey);
  journeyMap?.remove();
  journeyMap = null;
  journeyDot = null;
  journeyMapFitted = false;
  $("#view-journey").innerHTML = "";
  await runJourneyLoader(prepareJourney, { mode: j.legs[0]?.mode ?? "train", dest: journey.dest });
  showView("journey");
}

// ---------- Journey loading animation ----------
// A horizontal road where a train, metro, tram and bus drive past while Sebway fetches live times
// and your first GPS fix. Driven by requestAnimationFrame; a plain progress bar with Reduce Motion.

const LOADER_MIN_MS = 2600;
const LOADER_MAX_MS = 4500;
/** The three things the loader waits for, ticked off as prepareJourney reports progress. */
const LOADER_STEPS = [
  { label: "Live times", until: 0.5 },
  { label: "Your location", until: 0.85 },
  { label: "Your steps", until: 1 },
];
const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

/**
 * Loading screen for Start Journey: your first vehicle rides through a little Belgian city
 * (skyline, houses and trees slide past at different speeds for depth; day or night sky from the
 * clock), with a checklist that ticks off and a glowing progress bar. Stands still with Reduce Motion.
 */
function runJourneyLoader(work, { mode = "train", dest = "" } = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Brussels" }).format(new Date()));
  const night = hour < 7 || hour >= 19;
  const kind = SIDE_VIEWS[mode] ? mode : "train";
  const road = kind === "bus";
  const overlay = document.createElement("div");
  overlay.className = `jl-overlay${reduce ? " still" : ""}`;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <div class="jl-card">
      <div class="jl-head">
        <div class="jl-title">Starting your journey</div>
        ${dest ? `<div class="jl-dest">to ${esc(dest)}</div>` : ""}
      </div>
      <div class="jl-scene ${night ? "night" : "day"}" aria-hidden="true">
        <div class="jl-sky">${night ? '<span class="jl-moon"></span><span class="jl-stars"></span>' : '<span class="jl-sun"></span>'}</div>
        <div class="jl-layer far"><div class="jl-strip">${skylineSvg("jl-city")}${skylineSvg("jl-city")}</div></div>
        <div class="jl-layer near"><div class="jl-strip">${skylineSvg("jl-city near")}${skylineSvg("jl-city near")}</div></div>
        <div class="jl-ground ${road ? "road" : "rail"}"></div>
        <div class="jl-speed"><i></i><i></i><i></i></div>
        <svg class="ld-veh jl-vehicle ${kind}" viewBox="0 0 120 40">${SIDE_VIEWS[kind]}</svg>
      </div>
      <ol class="jl-checks">${LOADER_STEPS.map((st) => `<li><span class="jl-dot">${CHECK_SVG}</span>${st.label}</li>`).join("")}</ol>
      <div class="jl-bar" aria-hidden="true"><div class="jl-fill"></div></div>
      <div class="jl-step">Checking live times…</div>
    </div>`;
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add("show"));

  const fill = overlay.querySelector(".jl-fill");
  const stepEl = overlay.querySelector(".jl-step");
  const checks = [...overlay.querySelectorAll(".jl-checks li")];
  let target = 0.08; // real progress (0..1)
  let shown = 0; // what the bar shows, easing towards target
  let ticked = 0; // checklist items shown as done; at most one more every TICK_MS, so you see each one
  let lastTick = performance.now();
  const TICK_MS = 520;
  let last = performance.now();
  let raf = 0;
  const paint = () =>
    checks.forEach((li, i) => {
      li.classList.toggle("done", i < ticked);
      li.classList.toggle("active", i === ticked);
    });
  // Ticking runs on a timer, not on animation frames: those pause when the app isn't on screen.
  const ticker = setInterval(() => {
    const now = performance.now();
    const due = LOADER_STEPS.filter((st) => target >= st.until).length;
    if (ticked < due && now - lastTick >= TICK_MS) {
      ticked++;
      lastTick = now;
      paint();
    }
  }, 80);
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // The bar follows the ticked steps, so bar and checklist agree.
    const goal = ticked >= LOADER_STEPS.length ? 1 : Math.max(0.08, ticked ? LOADER_STEPS[ticked - 1].until : Math.min(target, 0.4));
    shown += (goal - shown) * Math.min(1, dt * 5);
    fill.style.width = `${(shown * 100).toFixed(1)}%`;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  paint();

  const setStep = (text, progress) => {
    stepEl.textContent = text;
    target = Math.max(target, progress);
  };
  /** Resolves once every checklist item is ticked (right away with Reduce Motion, never later than 3 s). */
  const allTicked = () =>
    new Promise((r) => {
      const giveUp = performance.now() + 3000;
      const check = () => (reduce || ticked >= LOADER_STEPS.length || performance.now() > giveUp ? r() : setTimeout(check, 60));
      if (reduce) {
        ticked = LOADER_STEPS.length;
        paint();
      }
      check();
    });

  const started = performance.now();
  return (async () => {
    const timeout = new Promise((r) => setTimeout(r, LOADER_MAX_MS));
    await Promise.race([work(setStep), timeout]);
    setStep("Almost ready…", 1);
    await allTicked();
    stepEl.textContent = "Ready ✓";
    overlay.classList.add("ready");
    const wait = Math.max(LOADER_MIN_MS - (performance.now() - started), 600);
    await new Promise((r) => setTimeout(r, wait));
    overlay.classList.remove("show");
    await new Promise((r) => setTimeout(r, reduce ? 0 : 300));
    cancelAnimationFrame(raf);
    clearInterval(ticker);
    overlay.remove();
  })();
}

/**
 * Lock-screen updates: the server pushes each step (leave, board, get off, arrived) while the phone
 * is locked. Needs notifications on. Sent again when fresh times come in, stopped on End.
 */
/** The trip without map shapes, for the server (lock-screen updates and shared links). */
function slimJourney() {
  const { walk_paths, walk_paths_enc, analysis, ...trip } = journey.trip;
  trip.legs = trip.legs.map(({ path, path_enc, ...leg }) => leg);
  return { trip, dest: journey.dest };
}

async function syncLiveJourney() {
  if (!journey) return;
  // A shared link follows the fresh times too.
  if (journey.share) api("/api/share", { method: "PUT", body: slimJourney() }).catch(() => {});
  const sub = await currentSubscription().catch(() => null);
  if (!sub || Notification.permission !== "granted") {
    journey.lockScreen = "off";
  } else {
    try {
      await api("/api/live-journey", { method: "PUT", body: slimJourney() });
      journey.lockScreen = "on";
    } catch (err) {
      journey.lockScreen = err.code === "PUSH_OFF" ? "off" : "error";
    }
  }
  store.set(JOURNEY_KEY, journey);
}

// ---------- Share My Trip ----------
// A private link that shows where you are on your trip (worked out from the clock and live times,
// never your GPS) to whoever you send it to. It ends 1 hour after arrival or when you stop sharing.

const shareText = () => {
  const j = journey.trip;
  return `I'm on my way to ${journey.dest}, arriving around ${hhmm(j.arrive_at ?? shownTime(j.legs.at(-1).arrival))}. Follow my trip live on Sebway:`;
};

async function sendShareLink() {
  const url = journey.share;
  if (navigator.share) {
    try {
      await navigator.share({ title: "My trip", text: shareText(), url });
      return;
    } catch (err) {
      if (err.name === "AbortError") return; // closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(`${shareText()} ${url}`);
    journey.shareNote = "Link copied. Paste it in a message.";
  } catch {
    journey.shareNote = `Copy this link: ${url}`;
  }
  renderJourney();
}

async function startSharing() {
  const btn = $("#journey-share");
  if (btn) btn.disabled = true;
  try {
    const res = await api("/api/share", { method: "PUT", body: slimJourney() });
    journey.share = res.url;
    journey.shareNote = null;
    store.set(JOURNEY_KEY, journey);
    renderJourney();
    await sendShareLink();
  } catch (err) {
    journey.shareNote = err.message || "Couldn't create a link. Try again.";
    renderJourney();
  }
}

async function stopSharing() {
  if (!confirm("Stop sharing this trip? The link will stop working.")) return;
  api("/api/share", { method: "DELETE" }).catch(() => {});
  journey.share = null;
  journey.shareNote = "Sharing stopped.";
  store.set(JOURNEY_KEY, journey);
  renderJourney();
}

function shareRow() {
  const buttons = journey.share
    ? `<button type="button" class="btn small" id="journey-share-again">📤 Send Link</button><button type="button" class="btn small" id="journey-unshare">Stop Sharing</button>`
    : `<button type="button" class="btn small" id="journey-share">📤 Share My Trip</button>`;
  const note = journey.shareNote ? `<p class="lock-line">${esc(journey.shareNote)}</p>` : journey.share ? `<p class="lock-line">🔗 Shared: anyone with the link sees your progress until you arrive.</p>` : "";
  return `<div class="jt-actions">${buttons}<button type="button" class="btn small" data-recover="manual">I Missed It</button></div>${note}`;
}

/** Someone opened a shared link: their friend's trip, read-only, refreshed every minute. */
let sharedTimer;
function stopSharedView() {
  clearTimeout(sharedTimer);
}

const sharedStepTitle = (step) => {
  if (step.kind === "done") return step.title.replace(/^You've arrived/, "Arrived");
  if (step.ride) return `On the ${step.title}`;
  return step.title.replace(/^Walk to/, "Walking to").replace(/^Go to/, "Heading to").replace(/^Change at/, "Changing at");
};

async function showSharedTrip(token) {
  showView("shared");
  const box = $("#view-shared");
  const load = async () => {
    try {
      const data = await api(`/api/share/${encodeURIComponent(token)}`);
      const j = data.trip;
      const steps = journeySteps(j, data.dest);
      const cur = currentStepIndex(steps);
      const step = steps[cur];
      const arrive = j.arrive_at ?? shownTime(j.legs.at(-1).arrival);
      const delay = j.legs.reduce((m, l) => Math.max(m, l.arrival.delay_min ?? 0), 0);
      box.innerHTML = `
        <section class="card journey-top">
          <p class="small muted" style="margin:0">Shared trip</p>
          <div class="jt-title">To ${esc(data.dest)}</div>
          <div class="small muted">Expected ${hhmm(arrive)}${delay > 0 ? ` · running ${delay} min late` : ""}</div>
        </section>
        <section class="card step-now ${esc(step.kind)}" aria-live="polite">
          <div class="step-icon">${stepIcon(step.ride ? step.kind : step.kind === "done" ? "done" : "walk")}</div>
          <div class="step-body">
            <div class="step-title">${esc(sharedStepTitle(step))}</div>
            <div class="step-detail">${esc(step.detail.replace(/^Get off/, "Gets off"))}</div>
          </div>
        </section>
        <ol class="card jsteps">${steps
          .map((s, i) => {
            const icon = s.ride ? s.kind : s.kind === "done" ? "done" : "walk";
            return `<li class="${i < cur ? "done" : i === cur ? "current" : ""}">
              <span class="js-icon ${esc(icon)}">${i < cur ? "✓" : stepIcon(icon)}</span>
              <span class="js-text"><strong>${esc(s.title.replace(/^You've arrived/, "Arrived"))}</strong><span class="small muted">${esc(s.detail.replace(/^Have a good day!$/, ""))}</span></span>
              <span class="js-time">${s.until ? hhmm(s.until) : ""}${stepPlat(s)}</span>
            </li>`;
          })
          .join("")}</ol>
        <p class="source">Worked out from the timetable and live delays, not from their location. Updated ${hhmm(data.updated_at)}.</p>`;
      if (step.kind !== "done") sharedTimer = setTimeout(load, 60_000);
    } catch (err) {
      box.innerHTML = `<div class="notice">${esc(err.code === "SHARE_ENDED" ? "This trip has ended or is no longer shared." : err.message || "Couldn't load this trip.")}</div>`;
    }
  };
  box.innerHTML = `<div class="loading"><span class="spinner" aria-hidden="true"></span>Loading the shared trip…</div>`;
  await load();
}

// ---------- Missed-connection recovery ----------
// When a connection breaks (fresh live times, a cancelled vehicle, GPS showing you missed it, a push from
// the server, or you tap "I Missed It"), Sebway plans again from where you are and offers to switch.
// Where you are: your GPS if it's precise, else the stop of the next vehicle that hasn't left yet.

let recovery = null; // { state: "loading" | "ready" | "none" | "error", reason, plan?, request?, fromName? }

const RECOVERY_TITLE = {
  auto: "Your connection will be missed",
  cancelled: "Your next vehicle is cancelled",
  gps: "It looks like you missed it",
  push: "Your connection is at risk",
  manual: "New plan",
};

async function recoverJourney(reason) {
  if (!journey || recovery?.state === "loading") return;
  recovery = { state: "loading", reason };
  renderJourney();
  const now = Date.now();
  const j = journey.trip;
  const nextLeg = j.legs.find((l) => msOf(shownTime(l.departure)) > now - 60_000) ?? j.legs.at(-1);
  const gps = position && position.accuracy <= 300 ? position : null;
  const from = nextLeg.from;
  const req = journey.request;
  const reset = { date: undefined, time: undefined, arrive_by: undefined, disruptions: "0" };
  const request =
    req.path === "/api/trip"
      ? { path: "/api/trip", params: { ...req.params, ...reset, from: gps ? "My location" : from.name, from_name: gps ? "My location" : from.name, from_lat: gps ? gps.lat : from.lat, from_lon: gps ? gps.lon : from.lon } }
      : { path: "/api/journey", params: { ...req.params, ...reset, from: from.id ?? from.name } };
  try {
    const data = await api(`${request.path}?${qs(request.params)}`);
    // Only plans you can still make: leaving (walk included) from now on.
    const options = (data.journeys ?? []).filter((x) => msOf(x.leave_by ?? shownTime(x.departure)) >= now - 30_000 && journeySignature(x) !== journey.signature);
    const works = (x) => !x.cancelled && !x.strike && !["broken", "cancelled"].includes(x.analysis?.level);
    const plan = options.find(works) ?? options[0];
    recovery = plan ? { state: "ready", reason, plan, request, fromName: gps ? "your location" : from.name } : { state: "none", reason };
  } catch {
    recovery = { state: "error", reason };
  }
  renderJourney();
}

function switchToRecovery() {
  if (recovery?.state !== "ready" || !journey) return;
  const { plan, request } = recovery;
  const firstDep = new Date(msOf(shownTime(plan.legs[0].departure)) - 60_000);
  journey.trip = plan;
  journey.signature = journeySignature(plan);
  journey.request = { path: request.path, params: { ...request.params, time: brusselsHm(firstDep), date: brusselsDay(firstDep) } };
  journey.updatedAt = new Date().toISOString();
  journey.recovered = (journey.recovered ?? 0) + 1;
  delete journey.autoOffered;
  delete journey.recoverMuted;
  delete journey.missSeenAt;
  recovery = null;
  store.set(JOURNEY_KEY, journey);
  // Redraw the map for the new route.
  journeyMap?.remove();
  journeyMap = null;
  journeyDot = null;
  journeyMapFitted = false;
  renderJourney();
  setupJourneyMap();
  syncLiveJourney(); // lock-screen updates and a shared link follow the new plan
}

function recoveryHtml() {
  if (!recovery) return "";
  const title = RECOVERY_TITLE[recovery.reason] ?? RECOVERY_TITLE.manual;
  if (recovery.state === "loading") return `<section class="card recovery" aria-live="polite"><strong>${esc(title)}</strong><p><span class="spinner" aria-hidden="true"></span> Finding a new plan from where you are…</p></section>`;
  if (recovery.state === "none" || recovery.state === "error") {
    return `<section class="card recovery" aria-live="polite"><strong>${esc(title)}</strong><p>${recovery.state === "none" ? "No other connection found right now." : "Couldn't get a new plan right now."} Try again in a few minutes.</p><div class="choices"><button type="button" class="btn small" data-recover="manual">Try Again</button><button type="button" class="btn small" data-recover-dismiss>Close</button></div></section>`;
  }
  const p = recovery.plan;
  const oldArrive = msOf(journey.trip.arrive_at ?? shownTime(journey.trip.legs.at(-1).arrival));
  const newArrive = p.arrive_at ?? shownTime(p.legs.at(-1).arrival);
  const later = Math.round((msOf(newArrive) - oldArrive) / 60_000);
  const legsText = p.legs.map((l) => `${legLabel(l)} ${hhmm(shownTime(l.departure))}`).join(" → ");
  return `<section class="card recovery ready" aria-live="assertive">
    <strong>${esc(title)}</strong>
    <p class="recovery-plan">New plan from ${esc(recovery.fromName)}: leave <b>${hhmm(p.leave_by ?? shownTime(p.departure))}</b>, arrive <b>${hhmm(newArrive)}</b>${later > 0 ? ` <span class="pill late">+${later} min</span>` : ""}</p>
    <p class="small muted">${esc(legsText)}</p>
    <div class="choices"><button type="button" class="btn small btn-switch" data-recover-switch>Switch to New Plan</button><button type="button" class="btn small" data-recover-dismiss>Keep Current Plan</button></div>
  </section>`;
}

function lockScreenLine() {
  if (journey?.lockScreen === "on") return `<p class="lock-line">🔔 Updates on your lock screen at every step. You can lock your phone.</p>`;
  if (journey?.lockScreen === "off") return `<p class="lock-line">🔕 Turn on notifications in <button type="button" class="linkish" id="journey-notify">Settings</button> to follow this trip on your lock screen.</p>`;
  return "";
}

/** The real work behind the loader: fresh live times for this trip, then a first GPS fix. */
async function prepareJourney(setStep) {
  setStep("Checking live times…", 0.15);
  try {
    const data = await api(`${journey.request.path}?${qs(journey.request.params)}`);
    const fresh = data.journeys?.find((j) => journeySignature(j) === journey.signature);
    if (fresh) {
      journey.trip = fresh;
      journey.updatedAt = new Date().toISOString();
      store.set(JOURNEY_KEY, journey);
    }
  } catch {
    // The journey screen keeps trying every minute.
  }
  await syncLiveJourney();
  setStep("Finding your location…", 0.6);
  if ("geolocation" in navigator) {
    await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          position = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), at: p.timestamp || Date.now() };
          resolve();
        },
        () => resolve(),
        { enableHighAccuracy: true, maximumAge: 15_000, timeout: 3000 },
      );
    });
  }
  setStep("Almost there…", 0.9);
}

function endJourney() {
  leaveJourneyView();
  journeyMap?.remove();
  journeyMap = null;
  journeyDot = null;
  journeyMapFitted = false;
  $("#view-journey").innerHTML = "";
  if (journey?.lockScreen === "on") api("/api/live-journey", { method: "DELETE" }).catch(() => {});
  if (journey?.share) api("/api/share", { method: "DELETE" }).catch(() => {});
  recovery = null;
  journey = null;
  store.remove(JOURNEY_KEY);
  renderJourneyBanner();
}

/** Journeys stay resumable until 2 hours after arrival. */
function journeyExpired(jr = journey) {
  if (!jr) return true;
  const end = msOf(jr.trip.arrive_at ?? shownTime(jr.trip.legs.at(-1).arrival));
  return !Number.isFinite(end) || Date.now() > end + 2 * 3_600_000;
}

function enterJourneyView() {
  if (!journey || journeyExpired()) {
    endJourney();
    showView("trip");
    return;
  }
  // Notifications turned on after the journey started: start the lock-screen updates now.
  if (journey.lockScreen === "off") syncLiveJourney().then(renderJourney);
  const box = $("#view-journey");
  if (!box.querySelector("#journey-dyn")) {
    box.innerHTML = `
      <div id="journey-dyn"></div>
      <div class="card journey-map-card">
        <div class="map journey-map" id="journey-map"></div>
        <div class="map-row"><button type="button" class="btn small" id="journey-center">◎ Center on Me</button></div>
      </div>
      <p class="source" id="journey-status"></p>`;
  }
  renderJourney();
  setupJourneyMap();
  startGps();
  keepScreenOn();
  clearInterval(journeyTick);
  journeyTick = setInterval(renderJourney, JOURNEY_TICK_MS);
  clearTimeout(journeyRefresh);
  refreshJourney();
}

function leaveJourneyView() {
  clearInterval(journeyTick);
  clearTimeout(journeyRefresh);
  if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch);
  geoWatch = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

let journeyLoading = false;
const JOURNEY_FRESH_MS = 20_000;

/**
 * Fresh delay, platform and cancellation for each train on the trip, merged into the journey (the map,
 * walks and the rest stay). Same source as the lock-screen updates. True when the trip was updated.
 */
async function refreshLiveTrains() {
  const trip = journey?.trip;
  if (!trip?.legs.some((l) => l.mode === "train" && l.vehicle_id)) return false;
  const live = await api("/api/live-trains", { method: "POST", body: { trip: slimJourney().trip } });
  // The journey changed while we waited (new plan, ended): these times belong to the old one.
  if (journey?.trip !== trip || live.legs?.length !== trip.legs.length) return false;
  const leaveBefore = msOf(shownTime(trip.legs[0].departure));
  trip.legs = trip.legs.map((l, i) => {
    const { transfer_before, ...times } = live.legs[i];
    return { ...l, ...times, transfer_before: l.transfer_before && transfer_before ? { ...l.transfer_before, ...transfer_before } : l.transfer_before };
  });
  trip.departure = trip.legs[0].departure;
  trip.arrival = trip.legs.at(-1).arrival;
  trip.cancelled = live.cancelled;
  // Door to door: leave-by and arrival include the walks. Train trips: move leave-by with the first train.
  if (trip.walk_start_min !== undefined && live.leave_by) trip.leave_by = live.leave_by;
  if (trip.walk_end_min !== undefined && live.arrive_at) trip.arrive_at = live.arrive_at;
  const shift = msOf(shownTime(trip.legs[0].departure)) - leaveBefore;
  const analysis = { ...trip.analysis, ...live.analysis };
  if (analysis.leave_by && Number.isFinite(shift) && shift) analysis.leave_by = new Date(msOf(analysis.leave_by) + shift).toISOString();
  trip.analysis = analysis;
  return true;
}

async function refreshJourney() {
  clearTimeout(journeyRefresh);
  if (!journey) return;
  // Opening the screen, coming back to the app and the timer can all ask at once: one request is enough.
  const fresh = Date.now() - msOf(journey.updatedAt) < JOURNEY_FRESH_MS;
  if (journeyLoading || fresh) {
    journeyRefresh = setTimeout(refreshJourney, fresh ? JOURNEY_FRESH_MS : 5_000);
    return;
  }
  journeyLoading = true;
  let changed = false;
  try {
    const data = await api(`${journey.request.path}?${qs(journey.request.params)}`);
    const fresh = data.journeys?.find((j) => journeySignature(j) === journey.signature);
    if (fresh) {
      journey.trip = fresh;
      changed = true;
    }
  } catch {
    // Keep the last known times; the trains are still asked below.
  }
  // The route search doesn't always find the same trip again (or know the new platform): ask each train
  // directly, like the lock-screen updates do.
  try {
    if (await refreshLiveTrains()) changed = true;
  } catch {
    // Keep the last known times; try again later.
  }
  if (changed && journey) {
    const trip = journey.trip;
    journey.updatedAt = new Date().toISOString();
    store.set(JOURNEY_KEY, journey);
    renderJourney();
    syncLiveJourney();
    // Live times say a change can't be made, or a vehicle is cancelled: offer a new plan.
    // Only live data counts (a tight change you chose from the timetable is not "missed"), at most once
    // per journey, and never after "Keep Current Plan".
    const cancelled = trip.cancelled || trip.analysis?.level === "cancelled";
    const liveBroken = (trip.analysis?.transfers ?? []).some((t) => t.realtime && t.level === "broken");
    if ((cancelled || liveBroken) && !recovery && !journey.recoverMuted && !journey.autoOffered) {
      journey.autoOffered = true;
      store.set(JOURNEY_KEY, journey);
      recoverJourney(cancelled ? "cancelled" : "auto");
    }
  }
  journeyLoading = false;
  journeyRefresh = setTimeout(() => {
    if (document.visibilityState === "visible" && !$("#view-journey").hidden) refreshJourney();
  }, JOURNEY_REFRESH_MS);
}

function startGps() {
  if (!("geolocation" in navigator)) {
    geoProblem = "This device can't share its location.";
    return;
  }
  if (geoWatch !== null) return;
  geoWatch = navigator.geolocation.watchPosition(
    (p) => {
      position = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) };
      geoProblem = null;
      updateJourneyDot();
      renderJourney();
    },
    (err) => {
      geoProblem = err.code === 1 ? "Location is off for Sebway. Allow it in Settings to see yourself on the map." : "Looking for your location…";
      renderJourney();
    },
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
  );
}

async function keepScreenOn() {
  try {
    if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen");
    wakeLock?.addEventListener("release", () => (wakeLock = null));
  } catch {
    // Not allowed right now (e.g. low battery); the journey still works.
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && journey && !$("#view-journey").hidden) {
    keepScreenOn();
    renderJourney();
    refreshJourney();
  }
});

function renderJourney() {
  const dyn = document.getElementById("journey-dyn");
  if (!dyn || !journey) return;
  const j = journey.trip;
  const steps = journeySteps(j, journey.dest);
  const now = Date.now();
  const cur = currentStepIndex(steps, now);
  const step = steps[cur];
  const next = steps[cur + 1];

  // Progress along the whole trip, by time.
  const start = msOf(j.leave_by ?? shownTime(j.legs[0].departure));
  const end = msOf(j.arrive_at ?? shownTime(j.legs.at(-1).arrival));
  const frac = (t) => Math.min(1, Math.max(0, (t - start) / (end - start || 1)));
  const pct = (frac(now) * 100).toFixed(1);
  const stops = j.legs.flatMap((l, i) => [...(i === 0 ? [msOf(shownTime(l.departure))] : []), msOf(shownTime(l.arrival))]);
  const vehicleKind = step.kind === "done" ? "done" : step.ride ? step.kind : "walk";
  const arrive = j.arrive_at ?? shownTime(j.legs.at(-1).arrival);
  const off = offTripMessage(step);
  // GPS says you missed the vehicle: plan again right away (once per step).
  // GPS says you missed the vehicle for 2 minutes in a row: offer a new plan (at most once per journey,
  // never after "Keep Current Plan").
  if (off && /missed/i.test(off)) {
    journey.missSeenAt ??= now;
    if (now - journey.missSeenAt >= 120_000 && !recovery && !journey.recoverMuted && !journey.autoOffered) {
      journey.autoOffered = true;
      store.set(JOURNEY_KEY, journey);
      setTimeout(() => recoverJourney("gps"), 0);
    }
  } else delete journey.missSeenAt;

  const html = `
    <section class="card journey-top">
      <div class="jt-head">
        <div>
          <div class="jt-title">To ${esc(journey.dest)}</div>
          <div class="small muted">Arrive ${hhmm(arrive)} · ${j.transfers === 0 ? "direct" : `${j.transfers} change${j.transfers > 1 ? "s" : ""}`}</div>
        </div>
        <button type="button" class="btn small btn-end" id="journey-end">End</button>
      </div>
      <div class="jt-track" aria-hidden="true">
        <div class="jt-line"><div class="jt-fill" style="width:${pct}%"></div></div>
        ${stops.map((t) => `<span class="jt-stop${t <= now ? " done" : ""}" style="left:${(frac(t) * 100).toFixed(1)}%"></span>`).join("")}
        <span class="jt-vehicle ${esc(vehicleKind)}" style="left:${pct}%">${stepIcon(vehicleKind)}</span>
      </div>
      ${lockScreenLine()}
      ${shareRow()}
    </section>
    ${recoveryHtml()}

    <section class="card step-now ${esc(vehicleKind)}" aria-live="polite">
      <div class="step-icon">${stepIcon(vehicleKind)}</div>
      <div class="step-body">
        <div class="step-title">${esc(step.title)}</div>
        ${step.until ? `<div class="step-when">${esc(step.verb === "arrive" ? "You arrive" : step.ride ? `Arriving at ${step.leg.to.name}` : `${legLabel(step.leg)} leaves`)}</div><div class="step-countdown">${countdown(step.until, now).replace(/^in /, "")}</div>` : ""}
        <div class="step-detail">${esc(step.detail)}${step.leg ? ` ${statusPill(step.ride ? step.leg.arrival : step.leg.departure, step.leg.cancelled)}` : ""}</div>
        ${step.plat?.p ? `<div class="step-plat">${step.ride ? "Arrives at" : "Leaves from"}${stepPlat(step, "lg")}</div>` : ""}
      </div>
    </section>

    ${off ? `<div class="notice error off-trip"><strong>${esc(off)}</strong><div class="choices"><button type="button" class="btn small" id="journey-replan">Replan From Here</button></div></div>` : ""}
    ${alertHtml(j.analysis)}

    <h2 class="section-title">Your trip</h2>
    <ol class="card jsteps">
      ${steps
        .map((s, i) => `
        <li class="${i < cur ? "done" : i === cur ? "current" : ""}">
          <span class="js-icon ${esc(s.ride ? s.kind : s.kind === "done" ? "done" : "walk")}">${i < cur ? "✓" : stepIcon(s.ride ? s.kind : s.kind === "done" ? "done" : "walk")}</span>
          <span class="js-text"><strong>${esc(s.title)}</strong><span class="small muted">${esc(s.detail)}</span></span>
          <span class="js-time">${s.until ? hhmm(s.until) : ""}${stepPlat(s)}</span>
        </li>`)
        .join("")}
    </ol>`;

  // Only rebuild when something visible changed (a new minute, the next step, new live times…).
  // The progress bar and the vehicle just move. Rebuilding every few seconds made iPhone Safari jump
  // back to the top while you were scrolling; when we do rebuild, the scroll position is kept.
  const key = html.replace(/(width|left):[\d.]+%/g, "");
  if (key !== dyn._key) {
    const y = window.scrollY;
    dyn.innerHTML = html;
    dyn._key = key;
    if (window.scrollY !== y) window.scrollTo(0, y);
  } else {
    const fill = dyn.querySelector(".jt-fill");
    const veh = dyn.querySelector(".jt-vehicle");
    if (fill) fill.style.width = `${pct}%`;
    if (veh) veh.style.left = `${pct}%`;
  }

  const status = document.getElementById("journey-status");
  if (status) {
    const where = position ? `GPS ±${position.accuracy} m` : geoProblem ?? "Looking for your location…";
    status.textContent = `Live times updated ${hhmm(journey.updatedAt)} · ${where} · Your location stays on this phone.`;
  }
  renderJourneyBanner();
}

async function setupJourneyMap() {
  if (journeyMap || !journey) return;
  try {
    const L = await loadLeaflet();
    const el = document.getElementById("journey-map");
    if (!el || journeyMap) return;
    journeyMap = L.map(el, { scrollWheelZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(journeyMap);
    const css = getComputedStyle(document.documentElement);
    const all = [];
    for (const leg of journey.trip.legs) {
      const pts = legLine(leg);
      all.push(...pts);
      L.polyline(pts, { color: css.getPropertyValue(`--${leg.mode}`).trim() || "#19398d", weight: 5, opacity: 0.85 }).addTo(journeyMap);
      L.circleMarker([leg.from.lat, leg.from.lon], { radius: 5, color: "#fff", weight: 2, fillColor: css.getPropertyValue("--accent").trim(), fillOpacity: 1 }).bindTooltip(leg.from.name).addTo(journeyMap);
    }
    for (const w of journey.trip.walk_paths ?? []) if (w.length > 1) L.polyline(w, { color: css.getPropertyValue("--muted").trim(), weight: 3, dashArray: "4 6" }).addTo(journeyMap);
    const last = journey.trip.legs.at(-1);
    L.circleMarker([last.to.lat, last.to.lon], { radius: 7, color: "#fff", weight: 2, fillColor: css.getPropertyValue("--bad").trim(), fillOpacity: 1 }).bindTooltip(last.to.name).addTo(journeyMap);
    journeyMap.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
    updateJourneyDot();
  } catch {
    const el = document.getElementById("journey-map");
    if (el) el.innerHTML = `<div class="notice error">Map could not load.</div>`;
  }
}

function updateJourneyDot() {
  if (!journeyMap || !position || !window.L) return;
  const ll = [position.lat, position.lon];
  if (!journeyDot) {
    journeyDot = window.L.circleMarker(ll, { radius: 8, color: "#fff", weight: 3, fillColor: "#2f7cf6", fillOpacity: 1, className: "gps-dot" }).addTo(journeyMap);
  } else {
    journeyDot.setLatLng(ll);
  }
  if (!journeyMapFitted) {
    journeyMapFitted = true;
    journeyMap.setView(ll, Math.max(journeyMap.getZoom(), 14));
  }
}

function renderJourneyBanner() {
  const box = $("#journey-banner");
  if (!box) return;
  if (!journey || journeyExpired()) {
    box.innerHTML = "";
    return;
  }
  const steps = journeySteps(journey.trip, journey.dest);
  const step = steps[currentStepIndex(steps)];
  box.innerHTML = `<button type="button" class="journey-banner" id="journey-open"><span class="live-dot" aria-hidden="true"></span><span><strong>Journey to ${esc(journey.dest)}</strong><span class="small">${esc(step.title)}${step.until ? ` · ${countdown(step.until)}` : ""}</span></span><span aria-hidden="true">›</span></button>`;
}

document.addEventListener("click", (e) => {
  const start = e.target.closest("[data-start-journey]");
  if (start) return startJourney(Number(start.dataset.startJourney));
  if (e.target.closest("#journey-open")) return showView("journey");
  if (e.target.closest("#journey-notify")) return showView("settings");
  if (e.target.closest("[data-recover-switch]")) return switchToRecovery();
  if (e.target.closest("[data-recover-dismiss]")) {
    // "Keep Current Plan": no more automatic suggestions on this journey ("I Missed It" still works).
    if (journey && recovery?.reason !== "manual") {
      journey.recoverMuted = true;
      store.set(JOURNEY_KEY, journey);
    }
    recovery = null;
    return renderJourney();
  }
  const rec = e.target.closest("[data-recover]");
  if (rec) return recoverJourney(rec.dataset.recover);
  if (e.target.closest("#journey-share")) return startSharing();
  if (e.target.closest("#journey-share-again")) return sendShareLink();
  if (e.target.closest("#journey-unshare")) return stopSharing();
  if (e.target.closest("#journey-end")) {
    if (!confirm("End this journey?")) return;
    endJourney();
    return showView("trip");
  }
  if (e.target.closest("#journey-center") && position && journeyMap) return journeyMap.setView([position.lat, position.lon], 15);
  if (e.target.closest("#journey-replan") && position && journey) {
    const { dest, destCoords } = journey;
    endJourney();
    applyMode("commute");
    setStop($("#from"), "My location", undefined, position.lat, position.lon);
    setStop($("#to"), dest, undefined, destCoords?.lat, destCoords?.lon);
    $("#date").value = "";
    $("#time").value = "";
    refreshGhosts();
    showView("trip");
    searchTrip();
  }
});

// ---------- Online status + service worker ----------

const updateOnline = () => ($("#offline").hidden = navigator.onLine);
window.addEventListener("online", updateOnline);
window.addEventListener("offline", updateOnline);
updateOnline();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// ---------- App updates ----------
// The app checks sebway.app for a newer version (when opened, and from Settings). Updating loads the new
// files and restarts the app in a second; Repair App clears the saved app files and reloads them fresh.
// Neither touches saved data (places, routes, passes, Claude key, name, notifications), so nobody has to
// delete the Home Screen icon and set everything up again.

/** Must match CACHE ("sebway-vNN") in public/sw.js; a unit test checks they're the same. */
const APP_VERSION = 54;
let updateChecked = 0;

async function latestVersion() {
  const res = await fetch(`/sw.js?check=${Date.now()}`, { cache: "no-store" });
  const m = res.ok ? /sebway-v(\d+)/.exec(await res.text()) : null;
  return m ? Number(m[1]) : null;
}

async function applyUpdate() {
  toast("Updating Sebway…");
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update(); // the new helper installs and takes over right away
  } catch {}
  setTimeout(() => location.reload(), 1200);
}

function showUpdateBanner(latest) {
  if (document.querySelector(".update-banner") || store.get("updateDismissed") === latest) return;
  const bar = document.createElement("div");
  bar.className = "update-banner";
  bar.setAttribute("role", "status");
  bar.innerHTML = `<span>✨ A new version of Sebway is ready</span><button type="button" class="btn small" data-update-now>Update</button><button type="button" class="update-x" aria-label="Not now">×</button>`;
  bar.querySelector("[data-update-now]").addEventListener("click", applyUpdate);
  bar.querySelector(".update-x").addEventListener("click", () => {
    store.set("updateDismissed", latest);
    bar.remove();
  });
  document.body.append(bar);
}

/** quiet: on open (banner only when there's an update); otherwise from Settings (always says something). */
async function checkForUpdate({ quiet = true } = {}) {
  const status = $("#update-status");
  if (!quiet) status.textContent = "Checking…";
  updateChecked = Date.now();
  let latest = null;
  try {
    latest = await latestVersion();
  } catch {}
  if (latest === null) {
    if (!quiet) status.textContent = "Couldn't check right now. Try again when you're online.";
    return;
  }
  const newer = latest > APP_VERSION;
  $("#update-now").hidden = !newer;
  if (newer) {
    if (!quiet) status.textContent = `Version ${latest} is available (you have ${APP_VERSION}).`;
    else showUpdateBanner(latest);
  } else if (!quiet) status.textContent = `You're up to date (version ${APP_VERSION}).`;
}

$("#app-version").textContent = String(APP_VERSION);
$("#check-update").addEventListener("click", () => checkForUpdate({ quiet: false }));
$("#update-now").addEventListener("click", applyUpdate);
$("#repair-app").addEventListener("click", async () => {
  if (!confirm("Repair Sebway? The app files are downloaded again. Your places, routes, passes, Claude key and settings stay.")) return;
  $("#update-status").textContent = "Repairing…";
  try {
    for (const k of await caches.keys()) await caches.delete(k);
    for (const r of (await navigator.serviceWorker?.getRegistrations()) ?? []) await r.unregister();
  } catch {}
  location.reload();
});
// Check a few seconds after opening, and when you come back to the app (at most every 30 minutes).
setTimeout(() => checkForUpdate(), 4000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - updateChecked > 30 * 60_000) checkForUpdate();
});

// ---------- Start ----------

applyMode(form.mode);
loadUserDataFromServer();
// Notifications open the app at ?view=…
// ---------- First-time tutorial ----------
// Swipe through a few cards on first launch (or from Settings). Skip closes it at any time.

const TUTORIAL_KEY = "tutorialDone";

function tutorialSlides() {
  const modes = ["train", "metro", "tram", "bus"].map((m) => `<span class="tut-mode ${m}">${stepIcon(m)}</span>`).join("");
  const slides = [
    { art: `<div class="tut-modes">${modes}</div>`, title: "Welcome to Sebway", text: "SNCB, STIB, De Lijn and TEC in one app. Live delays, platforms and door-to-door trips anywhere in Belgium." },
    { art: "👋", title: "What's your name?", text: "Sebway greets you by name and keeps your next trip ready. Your name stays on this phone.", name: true },
    { art: "📍", title: "Plan any trip", text: "<b>Train</b> for station to station. <b>Door to Door</b> for any address, place or stop, even from your current location. Pick today or any later date." },
    { art: "🛟", title: "It watches your connections", text: "Too tight a change? Sebway warns you and suggests leaving a bit earlier. It also checks every station on your trip for strikes and disruptions." },
    { art: "🔔", title: "Start Journey", text: "Follow your trip step by step. Lock your phone: each step, delay and platform change appears on your lock screen. Send a link so others can follow along." },
    { art: "🎫", title: "Make it yours", text: "Save your routes and stations, add your passes for a countdown and a renew button, and get alerts for strikes on your routes." },
    { art: "💬", title: "Ask the assistant", text: "Optional: ask questions in plain words, like “When should I leave for Gent?”. It uses your own Claude key (Settings) and only real timetable data." },
  ];
  if (isIos() && !isStandalone()) {
    slides.push({ art: "⬆️", title: "Add to Home Screen", text: "In Safari, tap <b>Share</b> then <b>Add to Home Screen</b>. Sebway opens like an app, and iPhone only allows notifications that way." });
  } else if (pushSupported() && Notification.permission === "default") {
    slides.push({ art: "🔔", title: "Turn on notifications", text: "Get lock-screen updates during a journey, strike alerts for your saved routes and pass reminders. You can turn them on in Settings.", action: "Open Settings" });
  }
  return slides;
}

function showTutorial() {
  if (document.querySelector(".tut-overlay")) return;
  const slides = tutorialSlides();
  const overlay = document.createElement("div");
  overlay.className = "tut-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Welcome to Sebway");
  overlay.innerHTML = `
    <div class="tut-box">
      <div class="tut-top"><button type="button" class="linkish tut-skip">Skip</button></div>
      <div class="tut-track" tabindex="0" aria-roledescription="carousel">
        ${slides
          .map((sl, i) => `
          <section class="tut-slide" aria-roledescription="slide" aria-label="${i + 1} of ${slides.length}">
            <div class="tut-art" aria-hidden="true">${sl.art}</div>
            <h2>${sl.title}</h2>
            <p>${sl.text}</p>
            ${sl.name ? `<input type="text" class="tut-name" id="tut-name" maxlength="30" autocomplete="given-name" autocapitalize="words" enterkeyhint="next" placeholder="Your first name (optional)" aria-label="Your first name" value="${esc(store.get("userName") ?? "")}">` : ""}
            ${sl.action ? `<button type="button" class="btn tut-action">${sl.action}</button>` : ""}
          </section>`)
          .join("")}
      </div>
      <div class="tut-dots" aria-hidden="true">${slides.map(() => "<span></span>").join("")}</div>
      <button type="button" class="btn primary tut-next">Next</button>
    </div>`;
  document.body.append(overlay);
  document.body.classList.add("tut-open");
  const track = overlay.querySelector(".tut-track");
  const next = overlay.querySelector(".tut-next");
  const dots = [...overlay.querySelectorAll(".tut-dots span")];
  const index = () => Math.round(track.scrollLeft / track.clientWidth);
  const update = () => {
    const i = index();
    dots.forEach((d, k) => d.classList.toggle("on", k === i));
    next.textContent = i === slides.length - 1 ? "Get Started" : "Next";
  };
  const nameInput = overlay.querySelector("#tut-name");
  const saveName = () => {
    const name = nameInput?.value.trim().slice(0, 30);
    if (name) store.set("userName", name);
  };
  // Focusing the field can nudge the swipe track: snap back to this card.
  nameInput?.addEventListener("focus", () => setTimeout(() => track.scrollTo({ left: index() * track.clientWidth }), 60));
  nameInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur();
      go(index() + 1);
    }
  });
  const close = (then) => {
    saveName();
    store.set(TUTORIAL_KEY, true);
    if (!$("#view-trip").hidden) renderHome();
    overlay.remove();
    document.body.classList.remove("tut-open");
    document.removeEventListener("keydown", onKey);
    then?.();
  };
  const go = (i) => track.scrollTo({ left: i * track.clientWidth, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  const onKey = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") go(Math.min(slides.length - 1, index() + 1));
    if (e.key === "ArrowLeft") go(Math.max(0, index() - 1));
  };
  track.addEventListener("scroll", update, { passive: true });
  next.addEventListener("click", () => (index() >= slides.length - 1 ? close() : go(index() + 1)));
  overlay.querySelector(".tut-skip").addEventListener("click", () => close());
  overlay.querySelector(".tut-action")?.addEventListener("click", () => close(() => showView("settings")));
  document.addEventListener("keydown", onKey);
  update();
  next.focus();
}

$("#tutorial-again").addEventListener("click", showTutorial);

const startParams = new URLSearchParams(location.search);
const startView = startParams.get("view") ?? store.get("view");
const sharedToken = startParams.get("share");
if (location.search) history.replaceState(null, "", "/");
// A journey in progress opens straight on its current step (it works that out from the clock).
if (journey && journeyExpired()) endJourney();
if (sharedToken) showSharedTrip(sharedToken);
else showView(journey ? "journey" : views.includes(startView) && startView !== "shared" ? startView : "trip");
// Opened from a "connection at risk" push: go straight to a new plan.
if (journey && !sharedToken && startParams.get("recover") && !journey.recoverMuted) recoverJourney("push");
if (movedIn) setTimeout(() => toast("Welcome to sebway.app! Your places and routes came along. Paste your Claude key and turn alerts on again in Settings.", 7000), 800);
// First launch (not when opening someone's shared trip): the tutorial.
if (!sharedToken && !store.get(TUTORIAL_KEY)) showTutorial();
loadNews();
