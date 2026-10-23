// Corrections applied to door-to-door trips before the checks run:
//  1. Realistic ride-time rules where the official timetable is too optimistic.
//  2. Live SNCB data (delay, platform) for every train leg, from the MCP's train_status (iRail),
//     because the route planner has no platforms and its live data can lag behind.
// Afterwards the change times between legs, "leave by" and "arrive" are recomputed.
import type { Journey, Leg, Platform, Stop, TimeInfo } from "./types";

// ---------- 1. Ride-time rules ----------

interface RideRule {
  operator: string;
  mode: string;
  a: RegExp;
  b: RegExp;
  min: number;
  why: string;
}

/** Real-world minimum ride times (both directions). Add more stretches here when they come up. */
export const RIDE_RULES: RideRule[] = [
  { operator: "stib", mode: "metro", a: /tr[oô]ne|troon/i, b: /gare du midi|zuidstation/i, min: 10, why: "Trône ⇄ Gare du Midi takes about 10 min in practice" },
];

const add = (iso: string | null, minutes: number) => (iso ? new Date(Date.parse(iso) + minutes * 60_000).toISOString() : iso);
const mins = (a: string | null | undefined, b: string | null | undefined) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 60_000) : null);

export function applyRideRules(j: Journey): Journey {
  const legs = j.legs.map((leg) => {
    const rule = RIDE_RULES.find(
      (r) => r.operator === leg.operator && r.mode === leg.mode && ((r.a.test(leg.from.name) && r.b.test(leg.to.name)) || (r.b.test(leg.from.name) && r.a.test(leg.to.name))),
    );
    const ride = mins(leg.departure.scheduled, leg.arrival.scheduled);
    if (!rule || ride === null || ride >= rule.min) return leg;
    const extra = rule.min - ride;
    return {
      ...leg,
      arrival: { ...leg.arrival, scheduled: add(leg.arrival.scheduled, extra), expected: add(leg.arrival.expected, extra) },
      note: `Ride time set to ${rule.min} min: ${rule.why}.`,
    };
  });
  return { ...j, legs };
}

// ---------- 2. Live SNCB data for train legs ----------

interface TrainStop {
  stop: Stop;
  arrival: (TimeInfo & { platform: Platform | null }) | null;
  departure: (TimeInfo & { platform: Platform | null }) | null;
  cancelled: boolean;
}
export interface TrainStatus {
  vehicle_id: string;
  cancelled: boolean;
  stops: TrainStop[];
}

function distM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/** The stop of this train nearest to a place (names differ between sources, positions don't). */
function nearestStop(stops: TrainStop[], place: Stop, from = 0): number {
  let best = -1;
  let bestD = 800; // metres
  for (let i = from; i < stops.length; i++) {
    const d = distM(stops[i].stop, place);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Use the live train data for one leg. Returns the leg unchanged when the stations can't be matched. */
export function liveTrainLeg(leg: Leg, status: TrainStatus): Leg {
  const i = nearestStop(status.stops, leg.from);
  if (i < 0) return leg;
  const k = nearestStop(status.stops, leg.to, i + 1);
  if (k < 0) return leg;
  const dep = status.stops[i].departure;
  const arr = status.stops[k].arrival;
  if (!dep || !arr) return leg;
  return {
    ...leg,
    departure: { ...dep, scheduled: dep.scheduled ?? leg.departure.scheduled },
    arrival: { ...arr, scheduled: arr.scheduled ?? leg.arrival.scheduled },
    cancelled: leg.cancelled || status.cancelled || status.stops[i].cancelled || status.stops[k].cancelled,
  };
}

const shown = (t: TimeInfo) => t.expected ?? t.scheduled;

/** Recompute change times, leave-by and arrival after legs changed. Walking times stay as planned. */
export function recomputeTimes(j: Journey): Journey {
  const legs = j.legs.map((leg, i) => {
    if (i === 0 || !leg.transfer_before) return leg;
    const prev = j.legs[i - 1];
    const live = prev.arrival.realtime || leg.departure.realtime;
    return {
      ...leg,
      transfer_before: {
        ...leg.transfer_before,
        scheduled_min: mins(prev.arrival.scheduled, leg.departure.scheduled) ?? leg.transfer_before.scheduled_min,
        expected_min: live ? mins(shown(prev.arrival), shown(leg.departure)) : leg.transfer_before.expected_min,
      },
    };
  });
  const first = legs[0];
  const last = legs[legs.length - 1];
  const leave = shown(first.departure);
  const arrive = shown(last.arrival);
  return {
    ...j,
    legs,
    departure: first.departure,
    arrival: last.arrival,
    cancelled: legs.some((l) => l.cancelled),
    leave_by: leave && j.walk_start_min !== undefined ? add(leave, -j.walk_start_min) ?? j.leave_by : j.leave_by,
    arrive_at: arrive && j.walk_end_min !== undefined ? add(arrive, j.walk_end_min) ?? j.arrive_at : j.arrive_at,
  };
}

/** Brussels date of an ISO time, for train_status. */
const brusselsDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date(iso));

/**
 * All corrections for door-to-door trips. `trainStatus` fetches live data for one train
 * (injected so this stays testable); failures leave the leg as planned.
 */
export async function improveTrips(journeys: Journey[], trainStatus: (id: string, date: string) => Promise<TrainStatus | null>): Promise<Journey[]> {
  const wanted = new Map<string, string>();
  for (const j of journeys) {
    for (const l of j.legs) {
      if (l.mode === "train" && l.operator === "sncb" && l.vehicle_id && l.departure.scheduled) wanted.set(l.vehicle_id, brusselsDate(l.departure.scheduled));
    }
  }
  const statuses = new Map<string, TrainStatus>();
  await Promise.all(
    [...wanted].map(async ([id, date]) => {
      const s = await trainStatus(id, date).catch(() => null);
      if (s) statuses.set(id, s);
    }),
  );
  return journeys.map((j) => {
    const fixed = applyRideRules(j);
    const legs = fixed.legs.map((l) => (l.mode === "train" && l.vehicle_id && statuses.has(l.vehicle_id) ? liveTrainLeg(l, statuses.get(l.vehicle_id)!) : l));
    return recomputeTimes({ ...fixed, legs });
  });
}

/**
 * The journey screen's live times: fresh delay, platform and cancellation for each SNCB train on the trip
 * that hasn't arrived yet (at most `max`), then change times recomputed. Failures keep the leg as it was.
 */
export async function refreshTrainLegs(j: Journey, trainStatus: (id: string, date: string) => Promise<TrainStatus | null>, now: number, max = 4): Promise<Journey> {
  const due = j.legs
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.mode === "train" && l.operator === "sncb" && l.vehicle_id && l.departure.scheduled && Date.parse(shown(l.arrival) ?? "") > now)
    .slice(0, max);
  const statuses = await Promise.all(due.map(({ l }) => trainStatus(l.vehicle_id!, brusselsDate(l.departure.scheduled!)).catch(() => null)));
  const legs = [...j.legs];
  due.forEach(({ i }, k) => {
    const status = statuses[k];
    if (status) legs[i] = liveTrainLeg(legs[i], status);
  });
  return recomputeTimes({ ...j, legs });
}

// ---------- 3. Safer start: a comfortable change before the first train ----------
// The route planner picks the latest metro or bus that still technically catches your train, which
// can leave a 1-minute change at Midi. Everything before the first train is in your hands, so the
// part up to that train is planned again to arrive with a comfortable margin. Changes after the
// train (e.g. train → bus at the end) are left alone: there an earlier start wouldn't help.

/** Minutes on top of the minimum change time (5 min train ⇄ metro, 3 min otherwise). */
export const COMFORT_EXTRA_MIN = 3;
/** Never ask to leave more than this much earlier than the planner's trip. */
const MAX_EARLIER_MIN = 20;
/** Extra route-planner requests per search (light use of Transitous). */
const MAX_REPLANS = 3;

export interface SaferStart {
  /** Where the change to the train happens. */
  at: string;
  /** Change time in the planner's trip, and in the safer one. */
  original_change_min: number;
  change_min: number;
  /** How much earlier you leave. */
  earlier_min: number;
}

/** Plan from the trip's start to a place, arriving by an ISO time. */
export type PlanSegment = (to: { lat: number; lon: number; name: string }, arriveBy: string) => Promise<Journey[]>;

interface SaferOptions {
  /** Minimum change time between two modes (alerts.neededMinutes). */
  needed: (from: Leg["mode"], to: Leg["mode"]) => number;
  /** Earliest allowed leave time (ms), e.g. now for a "leave now" search. */
  earliest?: number;
}

const firstTrain = (j: Journey) => {
  const t = j.legs.findIndex((l) => l.mode === "train");
  return t > 0 ? t : -1; // a feeder (metro, bus, tram) must come before it
};
const changeMin = (leg: Leg) => leg.transfer_before?.expected_min ?? leg.transfer_before?.scheduled_min ?? null;

function comfortFor(j: Journey, t: number, needed: SaferOptions["needed"]): number {
  const train = j.legs[t];
  return Math.max(needed(j.legs[t - 1].mode, train.mode), train.transfer_before?.walk_min ?? 0) + COMFORT_EXTRA_MIN;
}

/** The trip with everything before leg `t` replaced by `seg`. */
export function spliceStart(j: Journey, t: number, seg: Journey): Journey {
  const train = j.legs[t];
  const tail = j.legs.slice(t).map((l, i) => (i === 0 ? { ...l, transfer_before: { at: l.from, walk_min: seg.walk_end_min ?? 0, scheduled_min: 0, expected_min: null } } : l));
  // The light replan has no route shapes. Usually it's the same metro or bus, just earlier, so the
  // planner's shapes (and walking paths) still fit; otherwise the map draws straight lines.
  const before = j.legs.slice(0, t);
  const same = (a: Leg, b: Leg) => a.line === b.line && a.from.name === b.from.name && a.to.name === b.to.name;
  const start = seg.legs.map((l) => (l.path_enc ? l : { ...l, path_enc: before.find((o) => same(o, l))?.path_enc }));
  const sameRoute = seg.legs.length === before.length && seg.legs.every((l, i) => same(l, before[i]));
  const startWalks = sameRoute ? (j.walk_paths_enc ?? []).slice(0, train.walks_before ?? 0) : (seg.walk_paths_enc ?? []);
  const legs = [...start, ...tail];
  return recomputeTimes({
    ...j,
    legs,
    transfers: legs.length - 1,
    walk_start_min: seg.walk_start_min,
    walk_paths_enc: [...startWalks, ...(j.walk_paths_enc ?? []).slice(train.walks_before ?? 0)],
  });
}

/** Replace trips with a tight change before their first train by a safer start, when one exists. */
export async function saferStarts(journeys: Journey[], planSegment: PlanSegment, opts: SaferOptions): Promise<Journey[]> {
  // Which trips need it, and one request per train (several trips often share the same train).
  const requests = new Map<string, Promise<Journey[]>>();
  const tight: { i: number; t: number; comfort: number; key: string }[] = [];
  journeys.forEach((j, i) => {
    const t = firstTrain(j);
    if (t < 0 || j.cancelled) return;
    const train = j.legs[t];
    const dep = shown(train.departure);
    const now = changeMin(train);
    const comfort = comfortFor(j, t, opts.needed);
    if (!dep || now === null || now >= comfort) return;
    // Leaving earlier must still be allowed (not before "now" or the asked time), else don't ask.
    if (opts.earliest !== undefined && j.leave_by && Date.parse(j.leave_by) - (comfort - now) * 60_000 < opts.earliest - 60_000) return;
    const key = `${train.vehicle_id ?? train.line}|${dep}`;
    if (!requests.has(key)) {
      if (requests.size >= MAX_REPLANS) return;
      const by = add(dep, -comfort + (train.transfer_before?.walk_min ?? 0))!;
      requests.set(key, planSegment({ lat: train.from.lat, lon: train.from.lon, name: train.from.name }, by).catch(() => []));
    }
    tight.push({ i, t, comfort, key });
  });
  if (!tight.length) return journeys;

  const out = [...journeys];
  for (const { i, t, comfort, key } of tight) {
    const j = journeys[i];
    const train = j.legs[t];
    const segs = (await requests.get(key)!).map((s) => recomputeTimes(applyRideRules(s)));
    let best: Journey | null = null;
    for (const seg of segs) {
      const change = mins(shown(seg.legs[seg.legs.length - 1].arrival), shown(train.departure));
      if (change === null || change < comfort || seg.cancelled || !seg.leave_by || !j.leave_by) continue;
      if (seg.legs.some((l) => l.mode === "train" && l.vehicle_id && l.vehicle_id === train.vehicle_id)) continue;
      const earlier = mins(seg.leave_by, j.leave_by)!;
      if (earlier > MAX_EARLIER_MIN) continue;
      if (opts.earliest !== undefined && Date.parse(seg.leave_by) < opts.earliest - 60_000) continue;
      if (!best || Date.parse(seg.leave_by) > Date.parse(best.leave_by!)) best = seg; // latest safe start
    }
    if (!best) continue;
    const safer = spliceStart(j, t, best);
    const change = changeMin(safer.legs[best.legs.length]);
    if (change === null || change < comfort) continue;
    out[i] = {
      ...safer,
      duration_min: mins(safer.leave_by, safer.arrive_at) ?? safer.duration_min,
      safer_start: { at: train.from.name, original_change_min: changeMin(train)!, change_min: change, earlier_min: Math.max(0, mins(safer.leave_by, j.leave_by) ?? 0) },
    };
  }
  return out;
}

// ---------- 4. Less walking: a bus instead of a long walk at the start or end ----------
// The route planner happily ends a trip with a 14-minute walk when it arrives a few minutes earlier
// than waiting for a bus. Most people would rather take the bus, so when a trip starts or ends with
// a long walk, Sebway asks again with walks capped and swaps in the version with the same main ride
// (usually the train) and a bus for the walk, unless walking arrives WALK_WINS_MIN or more earlier.

/** A walk at the start or end this long (minutes) is worth looking for a bus. */
export const LONG_WALK_MIN = 10;
/** Walk limit (minutes) for the second request. */
export const SHORT_WALK_MIN = 8;
/** Walking wins only when it arrives at least this much earlier; otherwise take the bus. */
export const WALK_WINS_MIN = 10;

export interface LessWalking {
  /** Walking minutes saved, and how much later you arrive (can be 0 or negative). */
  saved_min: number;
  later_min: number;
}

export const hasLongWalk = (j: Journey) => (j.walk_start_min ?? 0) >= LONG_WALK_MIN || (j.walk_end_min ?? 0) >= LONG_WALK_MIN;
const totalWalk = (j: Journey) => (j.walk_start_min ?? 0) + (j.walk_end_min ?? 0) + j.legs.reduce((s, l) => s + (l.transfer_before?.walk_min ?? 0), 0);

/** The trip's main ride (the longest), which a less-walking version must keep. */
function mainRide(j: Journey): string {
  let best = j.legs[0];
  for (const l of j.legs) if ((mins(l.departure.scheduled, l.arrival.scheduled) ?? 0) > (mins(best.departure.scheduled, best.arrival.scheduled) ?? 0)) best = l;
  return `${best.line}|${best.vehicle_id}|${best.departure.scheduled}`;
}

/**
 * Swap trips with a long walk for a version from `alternatives` (planned with short walks) that keeps
 * the same main ride and walks clearly less, unless walking arrives WALK_WINS_MIN or more earlier. `earliest` (ms):
 * never leave before this (e.g. now).
 */
export function preferRides(journeys: Journey[], alternatives: Journey[], earliest?: number): Journey[] {
  const used = new Set<Journey>();
  return journeys.map((j) => {
    if (!hasLongWalk(j) || !j.arrive_at) return j;
    const ride = mainRide(j);
    let best: Journey | null = null;
    for (const alt of alternatives) {
      if (used.has(alt) || mainRide(alt) !== ride || !alt.arrive_at || !alt.leave_by || alt.cancelled) continue;
      if (totalWalk(j) - totalWalk(alt) < 4) continue;
      if (mins(j.arrive_at, alt.arrive_at)! >= WALK_WINS_MIN) continue;
      if (earliest !== undefined && Date.parse(alt.leave_by) < earliest - 60_000) continue;
      if (!best || Date.parse(alt.arrive_at) < Date.parse(best.arrive_at!)) best = alt;
    }
    if (!best) return j;
    used.add(best);
    return { ...best, less_walking: { saved_min: totalWalk(j) - totalWalk(best), later_min: mins(j.arrive_at, best.arrive_at)! } };
  });
}

// ---------- 5. Other ways: options without trains ----------
// The planner picks the fastest trips, often all by train (in Gent: an S-train for a ride a tram also
// does). One extra request without trains adds the best tram/bus/metro options, so you can choose.

/** At most this many trips without trains are added. */
export const NO_RAIL_OPTIONS = 2;

export const usesRail = (j: Journey) => j.legs.some((l) => l.mode === "train");
const leaveMs = (j: Journey) => Date.parse(j.leave_by ?? shown(j.departure) ?? "");

/**
 * The planner's trips plus up to NO_RAIL_OPTIONS trips without trains (only when the planner's trips use
 * a train, and never leaving before `earliest`), in order of leaving.
 */
export function addNoRailOptions(journeys: Journey[], noRail: Journey[], earliest?: number): Journey[] {
  if (!journeys.some(usesRail)) return journeys;
  const extra = noRail
    .filter((j) => j.legs.length && !usesRail(j) && (earliest === undefined || leaveMs(j) >= earliest - 60_000))
    .slice(0, NO_RAIL_OPTIONS)
    .map((j) => ({ ...j, no_rail: true }));
  return [...journeys, ...extra].sort((a, b) => leaveMs(a) - leaveMs(b));
}
