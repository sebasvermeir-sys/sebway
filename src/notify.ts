// Background alerts (cron, every 5 min): disruptions on saved routes and pass reminders → Web Push.
// Plain code, no AI. Only devices that turned on notifications are checked.
import { callTool } from "./mcp";
import { sendPush, type PushMessage, type PushSubscriptionData } from "./push";
import { isNationalStrike, isPushWorthy, isQuietHours, passReminderDue, routeQueries } from "./notify-rules";
import type { Disruption, DisruptionsResult } from "./types";
import { loadUserData, type SavedRoute } from "./userdata";
import { brokenConnection, dueStep, LIVE_TAG, liveKey, liveSteps, trainChangeMessage, trainState, type LiveRecord } from "./live-journey";
import { neededMinutes } from "./alerts";
import { liveTrainLeg, recomputeTimes, type TrainStatus } from "./trip-fixes";
import { routeOperators, strikeTomorrow } from "./strikes";

export interface PushRecord {
  subscription: PushSubscriptionData;
  created_at: string;
  /** What was already sent (key → ISO time), so nothing is pushed twice. Pruned after 7 days. */
  sent: Record<string, string>;
}

export const pushKey = (deviceId: string) => `push:${deviceId}`;
const SENT_KEEP_MS = 7 * 86_400_000;
const PASS_OP_NAME: Record<string, string> = { sncb: "SNCB", stib: "STIB", delijn: "De Lijn", tec: "TEC" };

const headline = (d: Disruption) => (d.operator === "stib" ? d.description : d.title);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function runScheduledChecks(env: Env, now = new Date()): Promise<{ devices: number; sent: number }> {
  if (isQuietHours(now)) return { devices: 0, sent: 0 };
  const cache = new Map<string, Promise<Disruption[]>>();
  let devices = 0;
  let sent = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DATA.list({ prefix: "push:", cursor });
    for (const { name } of page.keys) {
      devices++;
      try {
        sent += await checkDevice(env, name.slice("push:".length), cache, now);
      } catch (err) {
        console.error(`check failed for a device: ${String(err)}`);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  console.log(JSON.stringify({ cron: "checks", devices, sent }));
  return { devices, sent };
}

async function checkDevice(env: Env, deviceId: string, cache: Map<string, Promise<Disruption[]>>, now: Date): Promise<number> {
  const record = await env.DATA.get<PushRecord>(pushKey(deviceId), "json");
  const data = await loadUserData(env.DATA, `device:${deviceId}`);
  if (!record || !data) return 0;

  const messages: { key: string; message: PushMessage }[] = [];

  // 1. Disruptions on saved routes (one lookup per station per run, shared across devices).
  const newOnes = new Map<string, { d: Disruption; route: SavedRoute }>();
  for (const route of data.routes) {
    for (const q of routeQueries(route)) {
      const cacheKey = JSON.stringify(q);
      if (!cache.has(cacheKey)) {
        cache.set(
          cacheKey,
          callTool<DisruptionsResult>(env, "disruptions", { ...q, limit: 10 })
            .then((r) => r.disruptions)
            .catch(() => []),
        );
      }
      for (const d of await cache.get(cacheKey)!) {
        const key = `d:${d.id}`;
        if (isPushWorthy(d) && !record.sent[key] && !newOnes.has(key)) newOnes.set(key, { d, route });
      }
    }
  }
  // National strikes concern every saved route, even when they name no station on it.
  if (data.routes.length) {
    if (!cache.has("national")) {
      cache.set(
        "national",
        callTool<DisruptionsResult>(env, "disruptions", { type: "incident", limit: 30 })
          .then((r) => r.disruptions.filter(isNationalStrike))
          .catch(() => []),
      );
    }
    for (const d of await cache.get("national")!) {
      const key = `d:${d.id}`;
      if (!record.sent[key] && !newOnes.has(key)) newOnes.set(key, { d, route: { ...data.routes[0], name: "all your routes" } });
    }
  }

  const found = [...newOnes.entries()];
  if (found.length > 2) {
    // Several at once: one summary instead of a burst of notifications.
    const strikes = found.filter(([, x]) => x.d.type === "strike").length;
    messages.push({
      key: found.map(([k]) => k).join("|"),
      message: {
        title: strikes ? `${strikes} strike${strikes > 1 ? "s" : ""} + other disruptions on your routes` : `${found.length} disruptions on your routes`,
        body: clip(found.map(([, x]) => headline(x.d)).join(" · "), 180),
        url: "/?view=trip",
        tag: "disruptions",
      },
    });
  } else {
    for (const [key, { d, route }] of found) {
      messages.push({
        key,
        message: {
          title: `${d.type === "strike" ? "Strike" : "Disruption"} on ${route.name} (${d.operator.toUpperCase()})`,
          body: clip(headline(d), 180),
          url: "/?view=trip",
          tag: key,
        },
      });
    }
  }

  // 2. Strike tomorrow: the evening before, one heads-up per strike for operators on the saved routes.
  //    Sources: national SNCB strikes, STIB's network-wide notices, and strikes found at route stations.
  if (data.routes.length) {
    const strikes: Disruption[] = [...((await cache.get("national")) ?? [])];
    if (routeOperators(data.routes).has("stib")) {
      if (!cache.has("stib-strikes")) {
        cache.set(
          "stib-strikes",
          callTool<DisruptionsResult>(env, "disruptions", { operator: "stib", limit: 30 })
            .then((r) => r.disruptions.filter((d) => d.type === "strike"))
            .catch(() => []),
        );
      }
      strikes.push(...(await cache.get("stib-strikes")!));
    }
    for (const route of data.routes) for (const q of routeQueries(route)) strikes.push(...((await cache.get(JSON.stringify(q))) ?? []));
    for (const eve of strikeTomorrow(data.routes, strikes, now.getTime())) {
      if (record.sent[eve.key]) continue;
      messages.push({ key: eve.key, message: { title: eve.title, body: eve.body, url: "/?view=trip", tag: eve.key } });
    }
  }

  // 3. Pass reminders, once per reminder day, during the day only.
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Brussels" }).format(now));
  if (hour >= 8 && hour < 21) {
    for (const p of data.passes) {
      const due = passReminderDue(p, now);
      if (due === null) continue;
      const key = `p:${p.id}:${p.valid_until}:${due}`;
      if (record.sent[key]) continue;
      messages.push({
        key,
        message: {
          title: due === 0 ? `${p.name}: last day today` : `${p.name}: ${due} day${due > 1 ? "s" : ""} left`,
          body: `Valid until ${p.valid_until}. Tap to open Sebway, then Renew to go straight to the ${PASS_OP_NAME[p.operator] ?? "operator's"} site.`,
          url: "/?view=settings",
          tag: `pass:${p.id}`,
        },
      });
    }
  }

  if (!messages.length) return 0;

  let sentCount = 0;
  for (const { key, message } of messages) {
    const result = await sendPush(env, record.subscription, message);
    if (result.gone) {
      // The phone unsubscribed or the app was removed: stop checking this device.
      await env.DATA.delete(pushKey(deviceId));
      return sentCount;
    }
    if (result.ok) {
      sentCount++;
      for (const k of key.split("|")) record.sent[k] = now.toISOString();
    }
  }
  const cutoff = now.getTime() - SENT_KEEP_MS;
  record.sent = Object.fromEntries(Object.entries(record.sent).filter(([, t]) => Date.parse(t) > cutoff));
  await env.DATA.put(pushKey(deviceId), JSON.stringify(record));
  return sentCount;
}

// ---------- Live journey on the lock screen (cron, every minute) ----------

/** Live train data is fetched at most this often per journey, and only for a train leaving soon. */
const LIVE_REFRESH_MS = 2 * 60_000;
const LIVE_SOON_MS = 30 * 60_000;

/** Seconds a journey record is kept: until 1 hour after arrival (at least a minute). */
export function liveTtl(rec: LiveRecord, now: number): number {
  const end = Date.parse(rec.trip.arrive_at ?? rec.trip.arrival.expected ?? rec.trip.arrival.scheduled ?? "");
  const secs = Number.isFinite(end) ? Math.round((end + 3_600_000 - now) / 1000) : 3 * 3600;
  return Math.min(12 * 3600, Math.max(60, secs));
}

/**
 * Fresh delay and platform for the next train on the trip that hasn't arrived yet (also while you're
 * on it). Returns a card when it changed since you were last told.
 */
async function refreshTrains(env: Env, rec: LiveRecord, now: number): Promise<{ changed: boolean; message: { title: string; body: string; recover?: boolean } | null }> {
  if (rec.live_at && now - Date.parse(rec.live_at) < LIVE_REFRESH_MS) return { changed: false, message: null };
  const i = rec.trip.legs.findIndex((l) => {
    const dep = Date.parse(l.departure.expected ?? l.departure.scheduled ?? "");
    const arr = Date.parse(l.arrival.expected ?? l.arrival.scheduled ?? "");
    return l.mode === "train" && l.vehicle_id && arr > now && dep - now < LIVE_SOON_MS;
  });
  if (i < 0) return { changed: false, message: null };
  const leg = rec.trip.legs[i];
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date(leg.departure.scheduled ?? now));
  rec.live_at = new Date(now).toISOString();
  rec.told ??= {};
  // What you knew at the start (the trip the app sent) unless a change was pushed since.
  const told = rec.told[i] ?? trainState(leg);
  rec.told[i] = told;
  try {
    const status = await callTool<TrainStatus>(env, "train_status", { train_id: leg.vehicle_id, date });
    const legs = [...rec.trip.legs];
    legs[i] = liveTrainLeg(leg, status);
    rec.trip = recomputeTimes({ ...rec.trip, legs });
  } catch {
    return { changed: true, message: null }; // keep the planned times
  }
  const updated = rec.trip.legs[i];
  const message = trainChangeMessage(told, updated, rec.trip.legs[i + 1]);
  if (message) rec.told[i] = trainState(updated);
  return { changed: true, message };
}

async function runLiveJourney(env: Env, deviceId: string, now: number): Promise<boolean> {
  const rec = await env.DATA.get<LiveRecord>(liveKey(deviceId), "json");
  if (!rec) return false;
  const live = await refreshTrains(env, rec, now);
  let changed = live.changed;
  // A change that can't be made any more (after fresh train data): one push that opens the new-plan screen.
  const broken = live.changed ? brokenConnection(rec.trip, neededMinutes, now) : null;
  const miss = broken && !rec.sent.includes(broken.key) ? { ...broken, recover: true } : null;
  if (miss) rec.sent.push(miss.key);
  // A train change is pushed right away; the next step follows on the next minute.
  const urgent = miss ?? live.message;
  const { step, skipped } = urgent ? { step: null, skipped: [] } : dueStep(liveSteps(rec.trip, rec.dest), rec.sent, now);
  if (skipped.length) {
    rec.sent.push(...skipped);
    changed = true;
  }
  const message = urgent ?? step;
  let pushed = false;
  if (message) {
    const push = await env.DATA.get<PushRecord>(pushKey(deviceId), "json");
    if (!push) {
      await env.DATA.delete(liveKey(deviceId));
      return false;
    }
    const recover = "recover" in message && message.recover;
    const result = await sendPush(env, push.subscription, { title: message.title, body: message.body, url: recover ? "/?view=journey&recover=1" : "/?view=journey", tag: LIVE_TAG, renotify: true }, 300);
    if (result.gone) {
      await env.DATA.delete(liveKey(deviceId));
      return false;
    }
    pushed = changed = true;
    if (step) {
      rec.sent.push(step.key);
      if (step.key === "arrived") {
        await env.DATA.delete(liveKey(deviceId));
        return true;
      }
    }
  }
  if (changed) await env.DATA.put(liveKey(deviceId), JSON.stringify(rec), { expirationTtl: liveTtl(rec, now) });
  return pushed;
}

/** Every minute: push the current step of each live journey. No quiet hours: you asked for it. */
export async function runLiveJourneys(env: Env, now = Date.now()): Promise<{ journeys: number; sent: number }> {
  let journeys = 0;
  let sent = 0;
  let cursor: string | undefined;
  do {
    const page = await env.DATA.list({ prefix: "live:", cursor });
    await Promise.all(
      page.keys.map(async ({ name }) => {
        journeys++;
        try {
          if (await runLiveJourney(env, name.slice("live:".length), now)) sent++;
        } catch (err) {
          console.error(`live journey failed: ${String(err)}`, (err as Error)?.stack);
        }
      }),
    );
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  if (journeys) console.log(JSON.stringify({ cron: "live", journeys, sent }));
  return { journeys, sent };
}
