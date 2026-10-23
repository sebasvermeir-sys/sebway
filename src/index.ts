import Anthropic from "@anthropic-ai/sdk";
import { analyzeJourneys, neededMinutes } from "./alerts";
import { attachRouteDisruptions } from "./route-disruptions";
import { brusselsToIso, findPlaces, planTrip, TransitousError, type Place } from "./transitous";
import { hasLongWalk, improveTrips, preferRides, refreshTrainLegs, saferStarts, SHORT_WALK_MIN, type TrainStatus } from "./trip-fixes";

/** Live SNCB data for one train (iRail via the MCP). */
export const liveTrain = (env: Env) => (id: string, date: string) => callTool<TrainStatus>(env, "train_status", { train_id: id, date });
import type { Journey, Stop } from "./types";
import { liveTtl, pushKey, runLiveJourneys, runScheduledChecks, type PushRecord } from "./notify";
import { cleanTrip, LIVE_TAG, liveKey, startMessage, type LiveRecord } from "./live-journey";
import { isValidSubscription, sendPush } from "./push";
import { deviceKey, EMPTY, loadUserData, saveUserData, UserDataError } from "./userdata";
import { ChatInputError, checkClaudeKey, parseChatInput, readClaudeKey, runChat } from "./chat";
import { callTool, McpToolError } from "./mcp";

// GET endpoints that map 1:1 onto an MCP tool. Query params are validated and converted here,
// so the app only gets well-formed calls through.
type Kind = "str" | "int" | "bool";
interface Param {
  query: string;
  arg: string;
  kind?: Kind;
  required?: boolean;
  /** Nested under this argument object, e.g. filter.line */
  group?: string;
}
interface Route {
  tool: string;
  params: Param[];
  /** Add missed-connection analysis and leave-by to each journey. */
  analyze?: boolean;
}

const board: Param[] = [
  { query: "stop", arg: "stop", required: true },
  { query: "operator", arg: "operator" },
  { query: "to", arg: "to" },
  { query: "time", arg: "time" },
  { query: "date", arg: "date" },
  { query: "limit", arg: "limit", kind: "int" },
  { query: "line", arg: "line", group: "filter" },
  { query: "destination", arg: "destination", group: "filter" },
];

const ROUTES: Record<string, Route> = {
  "/api/stops": {
    tool: "find_stop",
    params: [
      { query: "q", arg: "query", required: true },
      { query: "operator", arg: "operator" },
    ],
  },
  "/api/departures": { tool: "departures", params: board },
  "/api/arrivals": { tool: "arrivals", params: board },
  "/api/journey": {
    tool: "plan_journey",
    analyze: true,
    params: [
      { query: "from", arg: "from", required: true },
      { query: "to", arg: "to", required: true },
      { query: "time", arg: "time" },
      { query: "date", arg: "date" },
      { query: "arrive_by", arg: "arrive_by", kind: "bool" },
      { query: "results", arg: "results", kind: "int" },
    ],
  },
  "/api/train": {
    tool: "train_status",
    params: [
      { query: "id", arg: "train_id", required: true },
      { query: "date", arg: "date" },
    ],
  },
  "/api/disruptions": {
    tool: "disruptions",
    params: [
      { query: "station", arg: "station" },
      { query: "operator", arg: "operator" },
      { query: "line", arg: "line" },
      { query: "type", arg: "type" },
      { query: "limit", arg: "limit", kind: "int" },
    ],
  },
};

// The Worker only handles /api/*. Everything else is served from /public (see wrangler.jsonc).
export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);

    try {
      if (url.pathname.startsWith("/media/")) return await serveMedia(req, env);
      if (url.pathname === "/api/health") return json({ ok: true });

      if (url.pathname === "/api/me") return await handleUserData(req, env);
      if (url.pathname === "/api/places") {
        const { success } = await env.API_LIMIT.limit({ key: clientKey(req) });
        if (!success) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute.", retryable: true } }, 429);
        const q = url.searchParams.get("q")?.trim() ?? "";
        if (q.length < 3 || q.length > 120) throw new BadInput("?q must be 3–120 characters");
        const [lat, lon] = (url.searchParams.get("near") ?? "").split(",").map(Number);
        const near = Number.isFinite(lat) && Number.isFinite(lon) && inBelgiumArea(lat, lon) ? { lat, lon } : undefined;
        return json({ places: await findPlaces(q, near) });
      }
      if (url.pathname === "/api/trip") {
        const { success } = await env.API_LIMIT.limit({ key: clientKey(req) });
        if (!success) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute.", retryable: true } }, 429);
        return json(await handleTrip(env, url.searchParams));
      }
      if (url.pathname === "/api/push/key") return json({ publicKey: env.VAPID_PUBLIC_KEY });
      if (url.pathname === "/api/push/subscription" || url.pathname === "/api/push/test") return await handlePush(req, env, url.pathname);
      if (url.pathname === "/api/live-journey") return await handleLiveJourney(req, env);
      if (url.pathname === "/api/live-trains") return await handleLiveTrains(req, env);
      if (url.pathname === "/api/share" || url.pathname.startsWith("/api/share/")) return await handleShare(req, env, url.pathname);

      if (url.pathname === "/api/chat" || url.pathname === "/api/claude-key/check") {
        if (req.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } }, 405);
        const apiKey = readClaudeKey(req);
        if (!apiKey) {
          return json({ error: { code: "CLAUDE_KEY_MISSING", message: "Add your Claude API key in Settings to use the chat.", retryable: false } }, 401);
        }
        if (url.pathname === "/api/claude-key/check") {
          await checkClaudeKey(apiKey);
          return json({ ok: true });
        }
        return await handleChat(req, env, apiKey);
      }

      const route = ROUTES[url.pathname];
      if (!route) return json({ error: { code: "NOT_FOUND", message: "Unknown endpoint" } }, 404);
      if (req.method !== "GET") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use GET" } }, 405);
      const { success } = await env.API_LIMIT.limit({ key: clientKey(req) });
      if (!success) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute.", retryable: true } }, 429);
      const data = await callTool<{ journeys?: Journey[] }>(env, route.tool, buildArgs(route, url.searchParams)).catch((err) => {
        // A stop search with no match is an empty answer, not an error (typing "Atomium" asks this too).
        if (route.tool === "find_stop" && err instanceof McpToolError && (err.code === "STOP_NOT_FOUND" || err.code === "NO_RESULTS")) return { stops: [] } as { journeys?: Journey[] };
        throw err;
      });
      if (route.analyze && data.journeys) {
        // ?walk= minutes from the user's door to the first stop (train trips; door-to-door has its own).
        const walk = url.searchParams.get("walk");
        const walkMin = walk === null ? null : clampInt(walk, 0, 90);
        const analyzed = analyzeJourneys(data.journeys, walkMin);
        // ?disruptions=0 skips the station-by-station disruption check (used by quick background refreshes).
        if (url.searchParams.get("disruptions") === "0") return json({ ...data, journeys: analyzed });
        const { journeys, route_disruptions } = await attachRouteDisruptions(env, analyzed);
        return json({ ...data, journeys, route_disruptions });
      }
      return json(data);
    } catch (err) {
      return errorResponse(err);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(controller.cron === "* * * * *" ? runLiveJourneys(env) : runScheduledChecks(env));
  },
} satisfies ExportedHandler<Env>;

/**
 * PUT /api/live-journey: start (or update) the lock-screen updates for this device's journey.
 * DELETE: stop them. Needs notifications turned on. The first PUT sends a "journey started" card.
 */
async function handleLiveJourney(req: Request, env: Env): Promise<Response> {
  const key = deviceKey(req);
  if (!key) throw new BadInput("Missing or invalid X-Device-Id");
  const deviceId = key.slice("device:".length);
  const { success } = await env.API_LIMIT.limit({ key: clientKey(req) });
  if (!success) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute.", retryable: true } }, 429);
  if (req.method === "DELETE") {
    await env.DATA.delete(liveKey(deviceId));
    return json({ ok: true });
  }
  if (req.method !== "PUT") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use PUT or DELETE" } }, 405);
  const push = await env.DATA.get<PushRecord>(pushKey(deviceId), "json");
  if (!push) return json({ error: { code: "PUSH_OFF", message: "Turn on notifications in Settings to get lock-screen updates.", retryable: false } }, 409);
  const raw = await req.text();
  if (raw.length > 30_000) throw new BadInput("Trip too large");
  let body: { trip?: unknown; dest?: unknown };
  let trip;
  try {
    body = JSON.parse(raw);
    trip = cleanTrip(body.trip);
  } catch (err) {
    throw new BadInput(`Not a valid trip (${err instanceof Error ? err.message : "bad JSON"})`);
  }
  const dest = typeof body.dest === "string" && body.dest.trim() ? body.dest.trim().slice(0, 80) : trip.legs[trip.legs.length - 1].to.name;
  const now = Date.now();
  const existing = await env.DATA.get<LiveRecord>(liveKey(deviceId), "json");
  // Same journey again (fresh times from the app): keep what was already sent.
  const same = existing && existing.dest === dest && existing.trip.legs[0]?.departure.scheduled === trip.legs[0].departure.scheduled;
  const rec: LiveRecord = { dest, trip, sent: same ? existing.sent : [], started_at: same ? existing.started_at : new Date(now).toISOString(), live_at: same ? existing.live_at : undefined, told: same ? existing.told : undefined };
  await env.DATA.put(liveKey(deviceId), JSON.stringify(rec), { expirationTtl: liveTtl(rec, now) });
  if (!same) {
    const msg = startMessage(trip, dest, now);
    const result = await sendPush(env, push.subscription, { ...msg, url: "/?view=journey", tag: LIVE_TAG }, 300);
    if (result.gone) await env.DATA.delete(pushKey(deviceId));
  }
  return json({ ok: true, started: !same });
}

/**
 * POST /api/live-trains: fresh delays, platforms and cancellations for the trains on a trip, so the
 * journey screen shows the same as the lock-screen updates. Answers only the live fields; the app keeps
 * the rest of its trip (map, walks).
 */
async function handleLiveTrains(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } }, 405);
  const { success } = await env.API_LIMIT.limit({ key: clientKey(req) });
  if (!success) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute.", retryable: true } }, 429);
  const raw = await req.text();
  if (raw.length > 30_000) throw new BadInput("Trip too large");
  let trip;
  try {
    trip = cleanTrip((JSON.parse(raw) as { trip?: unknown }).trip);
  } catch (err) {
    throw new BadInput(`Not a valid trip (${err instanceof Error ? err.message : "bad JSON"})`);
  }
  const fresh = analyzeJourneys([await refreshTrainLegs(trip, liveTrain(env), Date.now())])[0];
  return json({
    legs: fresh.legs.map((l) => ({ departure: l.departure, arrival: l.arrival, cancelled: l.cancelled, transfer_before: l.transfer_before })),
    cancelled: fresh.cancelled,
    leave_by: fresh.leave_by,
    arrive_at: fresh.arrive_at,
    analysis: { level: fresh.analysis.level, message: fresh.analysis.message, transfers: fresh.analysis.transfers },
    fetched_at: new Date().toISOString(),
  });
}

// ---------- Share My Trip ----------
// A private, unguessable link that shows where you are on your trip (by the clock and live data, not
// GPS) to whoever you send it to. It ends by itself 1 hour after arrival, or when you stop sharing.

interface ShareRecord {
  dest: string;
  trip: Journey;
  device: string;
  updated_at: string;
}
const shareKey = (token: string) => `share:${token}`;
const shareOfKey = (deviceId: string) => `shareof:${deviceId}`;
const TOKEN = /^[A-Za-z0-9_-]{16,32}$/;

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function handleShare(req: Request, env: Env, path: string): Promise<Response> {
  const { success } = await env.API_LIMIT.limit({ key: clientKey(req) });
  if (!success) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute.", retryable: true } }, 429);

  // GET /api/share/<token>: the shared trip, with the freshest times we have.
  if (path !== "/api/share") {
    const token = path.slice("/api/share/".length);
    if (req.method !== "GET" || !TOKEN.test(token)) throw new BadInput("Not a valid share link");
    const rec = await env.DATA.get<ShareRecord>(shareKey(token), "json");
    if (!rec) return json({ error: { code: "SHARE_ENDED", message: "This trip has ended or is no longer shared.", retryable: false } }, 404);
    // The lock-screen updates keep live train data fresher than the last copy from the phone.
    const live = await env.DATA.get<LiveRecord>(liveKey(rec.device), "json");
    const sameTrip = live && live.trip.legs[0]?.departure.scheduled === rec.trip.legs[0]?.departure.scheduled;
    const trip = sameTrip && live.live_at && live.live_at > rec.updated_at ? live.trip : rec.trip;
    return json({ dest: rec.dest, trip, updated_at: sameTrip && live.live_at && live.live_at > rec.updated_at ? live.live_at : rec.updated_at });
  }

  const key = deviceKey(req);
  if (!key) throw new BadInput("Missing or invalid X-Device-Id");
  const deviceId = key.slice("device:".length);
  const existing = await env.DATA.get(shareOfKey(deviceId));
  if (req.method === "DELETE") {
    await Promise.all([env.DATA.delete(shareOfKey(deviceId)), ...(existing ? [env.DATA.delete(shareKey(existing))] : [])]);
    return json({ ok: true });
  }
  if (req.method !== "PUT") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use PUT or DELETE" } }, 405);
  const raw = await req.text();
  if (raw.length > 30_000) throw new BadInput("Trip too large");
  let body: { trip?: unknown; dest?: unknown };
  let trip: Journey;
  try {
    body = JSON.parse(raw);
    trip = cleanTrip(body.trip);
  } catch (err) {
    throw new BadInput(`Not a valid trip (${err instanceof Error ? err.message : "bad JSON"})`);
  }
  const dest = typeof body.dest === "string" && body.dest.trim() ? body.dest.trim().slice(0, 80) : trip.legs[trip.legs.length - 1].to.name;
  // Same link while you keep sharing (fresh times update it); a new one after you stopped.
  const token = existing && (await env.DATA.get(shareKey(existing))) ? existing : newToken();
  const now = Date.now();
  const rec: ShareRecord = { dest, trip, device: deviceId, updated_at: new Date(now).toISOString() };
  const ttl = liveTtl({ dest, trip, sent: [], started_at: rec.updated_at }, now);
  await Promise.all([
    env.DATA.put(shareKey(token), JSON.stringify(rec), { expirationTtl: ttl }),
    env.DATA.put(shareOfKey(deviceId), token, { expirationTtl: ttl }),
  ]);
  return json({ ok: true, token, url: `${new URL(req.url).origin}/?share=${token}` });
}

async function handlePush(req: Request, env: Env, path: string): Promise<Response> {
  const key = deviceKey(req);
  if (!key) throw new BadInput("Missing or invalid X-Device-Id");
  const deviceId = key.slice("device:".length);
  const { success } = await env.CHAT_LIMIT.limit({ key: clientKey(req) });
  if (!success) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute.", retryable: true } }, 429);

  if (path === "/api/push/subscription") {
    if (req.method === "DELETE") {
      await env.DATA.delete(pushKey(deviceId));
      return json({ ok: true });
    }
    if (req.method !== "PUT") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use PUT or DELETE" } }, 405);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new BadInput("Body must be JSON");
    }
    const subscription = (body as { subscription?: unknown })?.subscription;
    if (!isValidSubscription(subscription)) throw new BadInput("Not a valid push subscription");
    const existing = await env.DATA.get<PushRecord>(pushKey(deviceId), "json");
    const record: PushRecord = {
      subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } },
      created_at: existing?.created_at ?? new Date().toISOString(),
      sent: existing?.sent ?? {},
    };
    await env.DATA.put(pushKey(deviceId), JSON.stringify(record));
    return json({ ok: true });
  }

  // POST /api/push/test: send a test notification to this device right now.
  if (req.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use POST" } }, 405);
  const record = await env.DATA.get<PushRecord>(pushKey(deviceId), "json");
  if (!record) return json({ error: { code: "PUSH_OFF", message: "Notifications are not turned on for this device.", retryable: false } }, 404);
  const result = await sendPush(env, record.subscription, {
    title: "Sebway test alert ✓",
    body: "Notifications work. You'll hear from Sebway when there's a strike or major disruption on your saved routes, or when a pass is about to run out.",
    url: "/?view=settings",
    tag: "test",
  });
  if (result.gone) await env.DATA.delete(pushKey(deviceId));
  if (!result.ok) {
    return json({ error: { code: "PUSH_FAILED", message: result.gone ? "This device unsubscribed. Turn notifications on again." : `The push service refused the message (${result.status}).`, retryable: !result.gone } }, 502);
  }
  return json({ ok: true });
}

async function handleChat(req: Request, env: Env, apiKey: string): Promise<Response> {
  const { success } = await env.CHAT_LIMIT.limit({ key: clientKey(req) });
  if (!success) {
    return json({ error: { code: "RATE_LIMITED", message: "Too many messages. Wait a minute and try again.", retryable: true } }, 429);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ChatInputError("Body must be JSON");
  }
  return json(await runChat(env, apiKey, parseChatInput(body)));
}

async function handleUserData(req: Request, env: Env): Promise<Response> {
  const key = deviceKey(req);
  if (!key) throw new BadInput("Missing or invalid X-Device-Id");
  const { success } = await env.API_LIMIT.limit({ key: clientKey(req) });
  if (!success) return json({ error: { code: "RATE_LIMITED", message: "Too many requests. Wait a minute.", retryable: true } }, 429);

  if (req.method === "GET") return json((await loadUserData(env.DATA, key)) ?? { ...EMPTY, updated_at: null });
  if (req.method === "DELETE") {
    // Delete My Data: everything stored for this device (saved data, notifications, live trip, shared trip).
    const deviceId = key.slice("device:".length);
    const token = await env.DATA.get(shareOfKey(deviceId));
    await Promise.all([
      env.DATA.delete(key),
      env.DATA.delete(pushKey(deviceId)),
      env.DATA.delete(liveKey(deviceId)),
      env.DATA.delete(shareOfKey(deviceId)),
      ...(token ? [env.DATA.delete(shareKey(token))] : []),
    ]);
    return json({ ok: true, deleted: true });
  }
  if (req.method === "PUT") {
    if (Number(req.headers.get("Content-Length") ?? 0) > 32_000) throw new BadInput("Too much data");
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new BadInput("Body must be JSON");
    }
    return json(await saveUserData(env.DATA, key, body));
  }
  return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use GET, PUT or DELETE" } }, 405);
}

/** One rate-limit bucket per device (sent by the app), falling back to the IP address. */
function clientKey(req: Request): string {
  return req.headers.get("X-Device-Id") || req.headers.get("CF-Connecting-IP") || "anon";
}

class BadInput extends Error {}

/** Videos with byte-range support: iPhone Safari only plays video that it can load in pieces (206). */
async function serveMedia(req: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(req.url).toString()));
  if (!res.ok) return res;
  const type = res.headers.get("Content-Type") ?? "video/mp4";
  const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=86400" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("Range") ?? "");
  const body = await res.arrayBuffer();
  const total = body.byteLength;
  if (!range) return new Response(body, { headers: { ...base, "Content-Length": String(total) } });
  let start = range[1] ? Number(range[1]) : total - Number(range[2]);
  let end = range[1] && range[2] ? Number(range[2]) : total - 1;
  start = Math.max(0, start);
  end = Math.min(end, total - 1);
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
  return new Response(body.slice(start, end + 1), {
    status: 206,
    headers: { ...base, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) },
  });
}

const inBelgiumArea = (lat: number, lon: number) => lat > 49 && lat < 52 && lon > 2 && lon < 7;

/** A place for the route planner: coordinates sent by the app, or looked up by stop name/id. */
async function resolvePlace(env: Env, q: URLSearchParams, side: "from" | "to"): Promise<Place> {
  const name = q.get(side)?.trim();
  if (!name) throw new BadInput(`Missing ?${side}=`);
  const lat = Number(q.get(`${side}_lat`));
  const lon = Number(q.get(`${side}_lon`));
  if (Number.isFinite(lat) && Number.isFinite(lon) && inBelgiumArea(lat, lon)) return { lat, lon, name: q.get(`${side}_name`) ?? name };
  const { stops } = await callTool<{ stops: Stop[] }>(env, "find_stop", { query: name }).catch((err) => {
    if (err instanceof McpToolError && (err.code === "STOP_NOT_FOUND" || err.code === "NO_RESULTS")) return { stops: [] as Stop[] };
    throw err;
  });
  if (!stops.length) {
    // Not a stop: try it as an address or place ("Wetstraat 16", "Atomium").
    const [place] = name.length >= 3 ? await findPlaces(name) : [];
    if (place) return { lat: place.lat, lon: place.lon, name: place.label };
    throw new McpToolError("STOP_NOT_FOUND", `No stop, address or place found for "${name}"`, false);
  }
  return { lat: stops[0].lat, lon: stops[0].lon, name: stops[0].name };
}

/** GET /api/trip: door to door anywhere in Belgium (Transitous), with Sebway's checks on top. */
async function handleTrip(env: Env, q: URLSearchParams) {
  const time = q.get("time")?.trim() || undefined;
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadInput("?time must be HH:mm");
  const date = q.get("date")?.trim() || undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadInput("?date must be YYYY-MM-DD");
  const [from, to] = await Promise.all([resolvePlace(env, q, "from"), resolvePlace(env, q, "to")]);
  const arriveBy = q.get("arrive_by") === "true";
  // ?avoid=rail on SNCB strike days: plan with metro, tram and bus only.
  const noRail = q.get("avoid") === "rail";
  const plan = await planTrip(from, to, { date, time, arriveBy, noRail });
  // Never leave before the asked time ("now", or the "leave at" time).
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date());
  const earliest = arriveBy ? undefined : time ? Date.parse(brusselsToIso(date ?? today, time)) : date && date !== today ? undefined : Date.now();
  // A long walk at the start or end? Ask again with short walks and prefer a bus when it's not much later.
  if (plan.journeys.some(hasLongWalk)) {
    const fewerWalks = await planTrip(from, to, { date, time, arriveBy, noRail, maxWalkMin: SHORT_WALK_MIN, results: 6 }).catch(() => null);
    if (fewerWalks) plan.journeys = preferRides(plan.journeys, fewerWalks.journeys, earliest);
  }
  const improved = await improveTrips(plan.journeys, liveTrain(env));
  // Tight change before the first train? Plan the start again to arrive with a comfortable margin.
  const safer = await saferStarts(improved, (dest, by) => planTrip(from, dest, { at: by, arriveBy: true, results: 2, light: true, noRail }).then((p) => p.journeys), {
    needed: neededMinutes,
    earliest,
  });
  // The extra planner requests (less walking, safer start) can return the same trip twice: keep one.
  const seen = new Set<string>();
  const unique = safer.filter((j) => {
    const sig = `${j.leave_by}|${j.arrive_at}|${j.legs.map((l) => `${l.line}@${l.departure.scheduled}`).join(">")}`;
    return !seen.has(sig) && seen.add(sig);
  });
  const analyzed = analyzeJourneys(unique, null);
  const avoid = noRail ? "rail" : null;
  if (q.get("disruptions") === "0") return { ...plan, avoid, journeys: analyzed };
  const { journeys, route_disruptions } = await attachRouteDisruptions(env, analyzed);
  return { ...plan, avoid, journeys, route_disruptions };
}

function clampInt(raw: string, min: number, max: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new BadInput("Expected a number");
  return Math.min(max, Math.max(min, n));
}

function buildArgs(route: Route, q: URLSearchParams): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const p of route.params) {
    const raw = q.get(p.query)?.trim();
    if (!raw) {
      if (p.required) throw new BadInput(`Missing ?${p.query}=`);
      continue;
    }
    let value: unknown = raw;
    if (p.kind === "int") {
      value = Number.parseInt(raw, 10);
      if (Number.isNaN(value)) throw new BadInput(`?${p.query} must be a number`);
    } else if (p.kind === "bool") {
      value = raw === "true" || raw === "1";
    }
    if (p.group) {
      args[p.group] = { ...(args[p.group] as object | undefined), [p.arg]: value };
    } else {
      args[p.arg] = value;
    }
  }
  return args;
}

/** Security basics on every API answer (the app's files get theirs from public/_headers). */
export const API_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: API_HEADERS });
}

function errorResponse(err: unknown): Response {
  if (err instanceof BadInput || err instanceof ChatInputError || err instanceof UserDataError) {
    return json({ error: { code: "BAD_INPUT", message: err.message, retryable: false } }, 400);
  }
  if (err instanceof McpToolError) {
    const status = err.code.startsWith("UPSTREAM") ? 502 : err.code === "STOP_NOT_FOUND" || err.code === "NO_RESULTS" ? 404 : 400;
    return json(
      { error: { code: err.code, message: err.message, retryable: err.retryable, candidates: err.candidates } },
      status,
    );
  }
  if (err instanceof TransitousError) {
    console.error(err.message);
    return json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "The door-to-door route planner is not available right now. Try again in a minute.", retryable: true } }, 502);
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return json({ error: { code: "CLAUDE_KEY_INVALID", message: "Your Claude API key was not accepted. Check it in Settings.", retryable: false } }, 401);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return json({ error: { code: "CHAT_BUSY", message: "Your Claude account is busy or at its limit. Try again in a minute.", retryable: true } }, 503);
  }
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
    return json({ error: { code: "CLAUDE_NO_CREDIT", message: "Your Claude account has no credit left. Top up at console.anthropic.com.", retryable: false } }, 402);
  }
  if (err instanceof Anthropic.APIError) {
    console.error(`Claude API error ${err.status}: ${err.message}`);
    return json({ error: { code: "CHAT_UNAVAILABLE", message: "Chat is not available right now. Try again.", retryable: true } }, 502);
  }
  console.error(err);
  return json({ error: { code: "INTERNAL", message: "Something went wrong", retryable: true } }, 500);
}
