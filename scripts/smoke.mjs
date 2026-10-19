// Health check of the live app: every endpoint with real data. Run: npm run smoke
// Uses a throwaway device id; never sends a Claude key.
const BASE = process.env.SEBWAY_URL ?? "https://sebway.app";
const device = crypto.randomUUID();

const checks = [
  ["App page", "/", (r) => r.status === 200],
  ["Health", "/api/health", (r, j) => j?.ok === true],
  ["Stop search", "/api/stops?q=midi", (r, j) => j?.stops?.length > 0],
  ["SNCB departures (Midi)", "/api/departures?stop=Bruxelles-Midi&operator=sncb&limit=3", (r, j) => Array.isArray(j?.departures)],
  ["STIB departures (Trône)", "/api/departures?stop=Tr%C3%B4ne&operator=stib&limit=3", (r, j) => Array.isArray(j?.departures)],
  ["De Lijn departures (Gent)", "/api/departures?stop=Gent%20Sint-Pietersstation&operator=delijn&limit=3", (r, j) => Array.isArray(j?.departures)],
  ["Train journey + checks", "/api/journey?from=Bruxelles-Midi&to=Gent-Sint-Pieters&results=2", (r, j) => j?.journeys?.[0]?.analysis && j?.route_disruptions],
  ["Door to door (Trône → Gent Heuvelpoort)", "/api/trip?from=Trone%20%2F%20Troon&to=Gent%20Heuvelpoort&disruptions=0", (r, j) => j?.journeys?.length > 0],
  ["Door to door (Louvain-la-Neuve → Liège)", "/api/trip?from=Louvain-la-Neuve&to=Li%C3%A8ge-Guillemins&disruptions=0", (r, j) => j?.journeys?.length > 0],
  ["Disruptions", "/api/disruptions?limit=3", (r, j) => Array.isArray(j?.disruptions)],
  ["Saved data (empty device)", "/api/me", (r, j) => Array.isArray(j?.routes)],
  ["Push key", "/api/push/key", (r, j) => typeof j?.publicKey === "string"],
  ["Chat without key is refused", "/api/chat", (r, j) => j?.error?.code === "CLAUDE_KEY_MISSING", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }],
];

let failed = 0;
for (const [name, path, ok, init = {}] of checks) {
  const started = Date.now();
  let line;
  try {
    const r = await fetch(BASE + path, { ...init, headers: { "X-Device-Id": device, "Content-Type": "application/json" } });
    const j = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
    const pass = ok(r, j);
    if (!pass) failed++;
    const note = j?.error ? ` (${j.error.code})` : j?.meta?.stale ? " (stale data)" : "";
    line = `${pass ? "✓" : "✗"} ${name}${note}`;
  } catch (err) {
    failed++;
    line = `✗ ${name} (${err.message})`;
  }
  console.log(`${line.padEnd(48)} ${Date.now() - started} ms`);
}
console.log(failed ? `\n${failed} check(s) failed.` : "\nAll good. Sebway is ready.");
process.exit(failed ? 1 : 0);
