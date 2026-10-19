// Live journey on the lock screen: after "Start Journey", the phone sends its trip here and a
// check every minute pushes one notification per step (leave, board, get off, arrived). Each one
// replaces the previous (same tag), so the lock screen shows a single card with the current step.
// Plain code, no AI. Times come from the trip (live where known), never from a model.
import type { Journey, Leg } from "./types";

export const liveKey = (deviceId: string) => `live:${deviceId}`;
export const LIVE_TAG = "journey";

export interface LiveRecord {
  dest: string;
  trip: Journey;
  /** Step keys already pushed. */
  sent: string[];
  started_at: string;
  /** Last time live train data was fetched (ISO). */
  live_at?: string;
  /** Per train leg (index): the delay, platform and cancellation you were last told about. */
  told?: Record<string, TrainState>;
}

export interface TrainState {
  delay: number;
  platform: string | null;
  cancelled: boolean;
}

/** A delay change smaller than this isn't worth a buzz (it adds up until it is). */
export const DELAY_STEP_MIN = 2;

export const trainState = (leg: Leg): TrainState => ({
  delay: leg.departure.delay_min ?? 0,
  platform: leg.departure.platform?.actual ?? leg.departure.platform?.scheduled ?? null,
  cancelled: leg.cancelled,
});

/**
 * A card when a train on the trip changed since you were last told: cancelled, platform changed,
 * or the delay moved by DELAY_STEP_MIN or more. `next` is the leg after it (to check the change).
 */
export function trainChangeMessage(told: TrainState, leg: Leg, next: Leg | undefined): { title: string; body: string; recover?: boolean } | null {
  const now = trainState(leg);
  const name = vehicle(leg);
  if (now.cancelled && !told.cancelled) {
    return { title: `❌ ${name} is cancelled`, body: `From ${leg.from.name} at ${hm(leg.departure.scheduled)}. Tap for a new plan.`, recover: true };
  }
  const platformChanged = Boolean(now.platform && told.platform && now.platform !== told.platform);
  const delayMoved = Math.abs(now.delay - told.delay) >= DELAY_STEP_MIN;
  if (!platformChanged && !delayMoved) return null;
  const change = next?.transfer_before?.expected_min ?? next?.transfer_before?.scheduled_min;
  const risk =
    next && change !== null && change !== undefined && change < 3
      ? ` ⚠️ Your change to ${vehicle(next)} is now ${Math.max(0, change)} min: it may be missed.`
      : "";
  const title = delayMoved
    ? now.delay > 0
      ? `⏱ ${name} now +${now.delay} min`
      : `✓ ${name} back on time`
    : `🔁 ${name}: platform ${now.platform}`;
  const platformText = platformChanged ? ` Platform changed: now ${now.platform} (was ${told.platform}).` : now.platform ? ` Platform ${now.platform}.` : "";
  return {
    title,
    body: `Leaves ${leg.from.name} at ${hm(shown(leg.departure))}${now.delay > 0 ? ` instead of ${hm(leg.departure.scheduled)}` : ""}, arrives ${leg.to.name} ${hm(shown(leg.arrival))}.${platformText}${risk}`,
  };
}

export interface LiveStep {
  key: string;
  /** When to push it (ms). */
  at: number;
  title: string;
  body: string;
}

/** Steps further in the past than this are skipped (e.g. the phone was off), not pushed late. */
export const STALE_MS = 10 * 60_000;

const MODE_NAME: Record<string, string> = { train: "Train", metro: "Metro", tram: "Tram", bus: "Bus" };
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" });
const hm = (iso: string | null | undefined) => (iso ? timeFmt.format(new Date(iso)) : "?");
const shown = (t: Leg["departure"]) => t.expected ?? t.scheduled;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

function vehicle(leg: Leg): string {
  const name = leg.mode === "train" ? (leg.vehicle_id ?? leg.line ?? "") : (leg.line ?? "");
  return `${MODE_NAME[leg.mode] ?? leg.mode} ${name}`.trim();
}
function platform(t: Leg["departure"]): string {
  const p = t.platform?.actual ?? t.platform?.scheduled;
  return p ? ` · platform ${p}${t.platform?.changed ? " (changed!)" : ""}` : "";
}
const delay = (t: Leg["departure"]) => (t.delay_min && t.delay_min > 0 ? ` (+${t.delay_min} min)` : "");
const towards = (leg: Leg) => (leg.direction ? ` → ${leg.direction}` : "");

/** Every lock-screen step of a trip, in time order. */
export function liveSteps(trip: Journey, dest: string): LiveStep[] {
  const steps: LiveStep[] = [];
  const first = trip.legs[0];
  if (!first) return steps;

  if (trip.walk_start_min && trip.leave_by) {
    steps.push({
      key: "leave",
      at: ms(trip.leave_by) - 2 * 60_000,
      title: `Leave in 2 min · ${trip.walk_start_min} min walk`,
      body: `Walk to ${first.from.name}. ${vehicle(first)}${towards(first)} leaves at ${hm(shown(first.departure))}${delay(first.departure)}.`,
    });
  }

  trip.legs.forEach((leg, i) => {
    const dep = ms(shown(leg.departure));
    const arr = ms(shown(leg.arrival));
    const change = leg.transfer_before?.expected_min ?? leg.transfer_before?.scheduled_min;
    steps.push({
      key: `board-${i}`,
      at: dep - 3 * 60_000,
      title: `${vehicle(leg)} at ${hm(shown(leg.departure))}${delay(leg.departure)}`,
      body: `From ${leg.from.name}${platform(leg.departure)}${towards(leg)}. Get off at ${leg.to.name} (${hm(shown(leg.arrival))}).${
        i > 0 && change !== null && change !== undefined && change < 3 ? " Tight change: hurry." : ""
      }`,
    });
    // "Get off soon" only for rides long enough to be told twice.
    if (arr - dep >= 5 * 60_000) {
      const next = trip.legs[i + 1];
      const nextChange = next?.transfer_before?.expected_min ?? next?.transfer_before?.scheduled_min;
      steps.push({
        key: `off-${i}`,
        at: arr - 2 * 60_000,
        title: `Get off at ${leg.to.name} in 2 min`,
        body: next
          ? `Then ${vehicle(next)} at ${hm(shown(next.departure))}${delay(next.departure)}${platform(next.departure)}${
              nextChange !== null && nextChange !== undefined ? `: ${nextChange} min to change` : ""
            }.`
          : `Then ${trip.walk_end_min ? `walk ${trip.walk_end_min} min to ${dest}` : `you're at ${dest}`}. Arrive ${hm(trip.arrive_at ?? shown(leg.arrival))}.`,
      });
    }
  });

  const end = trip.arrive_at ?? shown(trip.legs[trip.legs.length - 1].arrival);
  steps.push({ key: "arrived", at: ms(end), title: `Arrived at ${dest}`, body: "Journey finished. Have a good day!" });
  return steps.filter((s) => Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
}

/**
 * The step to push now: the latest one that is due and not sent yet. Older due steps are skipped
 * (marked as sent), since only the current one matters on the lock screen.
 */
export function dueStep(steps: LiveStep[], sent: string[], now: number): { step: LiveStep | null; skipped: string[] } {
  const due = steps.filter((s) => s.at <= now && !sent.includes(s.key));
  if (!due.length) return { step: null, skipped: [] };
  const latest = due[due.length - 1];
  const skipped = due.slice(0, -1).map((s) => s.key);
  if (now - latest.at > STALE_MS) return { step: null, skipped: [...skipped, latest.key] };
  return { step: latest, skipped };
}

/** The first card, sent when the journey starts: the whole trip in one line plus what's next. */
export function startMessage(trip: Journey, dest: string, now: number): { title: string; body: string } {
  const next = liveSteps(trip, dest).find((s) => s.at > now);
  return {
    title: `To ${dest} · arrive ${hm(trip.arrive_at ?? shown(trip.legs[trip.legs.length - 1].arrival))}`,
    body: next && next.key !== "arrived" ? `Next: ${next.title}. Updates appear here at each step.` : "Updates appear here at each step.",
  };
}

// ---------- Input check: keep only what the steps need, with sane sizes ----------

const str = (x: unknown, max = 80) => (typeof x === "string" ? x.slice(0, max) : null);
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
const iso = (x: unknown) => (typeof x === "string" && x.length <= 40 && Number.isFinite(Date.parse(x)) ? x : null);

function cleanTime(t: unknown): Leg["departure"] {
  const o = (t ?? {}) as Record<string, unknown>;
  const p = (o.platform ?? null) as Record<string, unknown> | null;
  return {
    scheduled: iso(o.scheduled),
    expected: iso(o.expected),
    delay_min: num(o.delay_min),
    realtime: o.realtime === true,
    platform: p ? { scheduled: str(p.scheduled, 8), actual: str(p.actual, 8), changed: p.changed === true } : null,
  };
}
function cleanStop(s: unknown): Leg["from"] {
  const o = (s ?? {}) as Record<string, unknown>;
  return { id: str(o.id, 60) ?? "", name: str(o.name) ?? "?", operator: "other", lat: num(o.lat) ?? 0, lon: num(o.lon) ?? 0 };
}

/** A trip from the app, reduced to the fields used here. Throws on anything unusable. */
export function cleanTrip(input: unknown): Journey {
  const t = (input ?? {}) as Record<string, unknown>;
  const legsIn = Array.isArray(t.legs) ? t.legs.slice(0, 10) : [];
  if (!legsIn.length) throw new Error("The trip has no legs");
  const legs: Leg[] = legsIn.map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const mode = ["train", "metro", "tram", "bus"].includes(o.mode as string) ? (o.mode as Leg["mode"]) : "bus";
    const tb = (o.transfer_before ?? null) as Record<string, unknown> | null;
    return {
      mode,
      operator: (["sncb", "stib", "delijn", "tec"].includes(o.operator as string) ? o.operator : "other") as Leg["operator"],
      line: str(o.line, 20),
      vehicle_id: str(o.vehicle_id, 20),
      direction: str(o.direction),
      from: cleanStop(o.from),
      to: cleanStop(o.to),
      departure: cleanTime(o.departure),
      arrival: cleanTime(o.arrival),
      cancelled: o.cancelled === true,
      transfer_before: tb ? { at: cleanStop(tb.at ?? o.from), walk_min: num(tb.walk_min) ?? undefined, scheduled_min: num(tb.scheduled_min) ?? 0, expected_min: num(tb.expected_min) } : null,
    } as Leg;
  });
  if (!legs.every((l) => shown(l.departure) && shown(l.arrival))) throw new Error("Every leg needs times");
  return {
    departure: legs[0].departure,
    arrival: legs[legs.length - 1].arrival,
    duration_min: num(t.duration_min) ?? 0,
    transfers: legs.length - 1,
    cancelled: legs.some((l) => l.cancelled),
    legs,
    alerts: [],
    leave_by: iso(t.leave_by) ?? undefined,
    arrive_at: iso(t.arrive_at) ?? undefined,
    walk_start_min: num(t.walk_start_min) ?? 0,
    walk_end_min: num(t.walk_end_min) ?? 0,
  };
}

// ---------- Missed connections ----------

/**
 * The first change on the trip that can no longer be made with the latest times: less time than needed
 * (5 min train ⇄ metro, 3 min otherwise) for a leg that hasn't left yet. Plain code: `needed` comes from
 * alerts.neededMinutes.
 */
export function brokenConnection(
  trip: Journey,
  needed: (from: Leg["mode"], to: Leg["mode"]) => number,
  now: number,
): { key: string; title: string; body: string } | null {
  for (let i = 1; i < trip.legs.length; i++) {
    const leg = trip.legs[i];
    const prev = trip.legs[i - 1];
    const change = leg.transfer_before?.expected_min;
    if (change === null || change === undefined) continue; // no live data for this change
    if (ms(shown(leg.departure)) < now) continue; // already left
    const need = Math.max(needed(prev.mode, leg.mode), leg.transfer_before?.walk_min ?? 0);
    if (change >= need) continue;
    return {
      key: `miss-${i}-${leg.departure.scheduled}`,
      title: `⚠️ Connection at ${leg.from.name} at risk`,
      body: `${vehicle(prev)} arrives ${hm(shown(prev.arrival))}${delay(prev.arrival)}: ${Math.max(0, change)} min to catch ${vehicle(leg)} at ${hm(shown(leg.departure))} (you need about ${need}). Tap for a new plan.`,
    };
  }
  return null;
}
