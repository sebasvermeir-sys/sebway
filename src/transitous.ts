// Door-to-door trips anywhere in Belgium via Transitous (https://transitous.org), the free, open,
// community-run route planner (MOTIS 2 API) built on the official open timetables of SNCB, STIB,
// De Lijn and TEC. Its trips are converted to Sebway's journey format so the same alerts, leave-by,
// disruption checks and map apply.
//
// Usage rules we follow (transitous.org/api): non-commercial, light use (results cached 30 s, never
// called from the background checks), a User-Agent that names the app and how to reach it, and a
// visible link to https://transitous.org/sources/ in the app.
import type { Journey, Leg, Meta, Mode, Operator, Stop, TimeWithPlatform } from "./types";

const API = "https://api.transitous.org/api/v1/plan";
export const USER_AGENT = "Sebway/1.0 (+https://sebway.app; +https://github.com/sebasvermeir-sys/sebway; non-commercial school project)";
const CACHE_SECONDS = 30;

export interface Place {
  lat: number;
  lon: number;
  name: string;
}

/** The parts of the MOTIS response we use. */
interface MotisPlace {
  name: string;
  stopId?: string;
  lat: number;
  lon: number;
  departure?: string;
  scheduledDeparture?: string;
  arrival?: string;
  scheduledArrival?: string;
  track?: string;
  scheduledTrack?: string;
  cancelled?: boolean;
}
interface MotisLeg {
  mode: string;
  from: MotisPlace;
  to: MotisPlace;
  duration: number;
  startTime: string;
  endTime: string;
  scheduledStartTime?: string;
  scheduledEndTime?: string;
  realTime?: boolean;
  headsign?: string;
  agencyName?: string;
  agencyId?: string;
  routeShortName?: string;
  displayName?: string;
  cancelled?: boolean;
  legGeometry?: { points: string; precision?: number };
}
interface MotisItinerary {
  duration: number;
  startTime: string;
  endTime: string;
  transfers: number;
  legs: MotisLeg[];
}
export interface MotisPlan {
  itineraries: MotisItinerary[];
}

export class TransitousError extends Error {}

/** Brussels local date + HH:mm → UTC ISO string (handles summer/winter time). */
export function brusselsToIso(date: string, hm: string): string {
  const guess = new Date(`${date}T${hm}:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Brussels",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(guess)
      .map((p) => [p.type, p.value]),
  );
  const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess.getTime() - (localAsUtc - guess.getTime())).toISOString();
}

export async function planTrip(
  from: Place,
  to: Place,
  opts: { date?: string; time?: string; arriveBy?: boolean; at?: string; results?: number; light?: boolean; maxWalkMin?: number; noRail?: boolean } = {},
): Promise<{ meta: Meta; query: { from: Place; to: Place; time: string | null; arrive_by: boolean }; journeys: Journey[] }> {
  const params = new URLSearchParams({
    fromPlace: `${from.lat.toFixed(6)},${from.lon.toFixed(6)}`,
    toPlace: `${to.lat.toFixed(6)},${to.lon.toFixed(6)}`,
    // Bilingual names, the same style as SNCB uses elsewhere in the app ("Louvain / Leuven").
    language: "en",
    // No turn-by-turn walking directions (half the answer, never shown) and 4 trips: the answer
    // shrinks from ~320 KB to ~170 KB, which keeps parsing under the free plan's 10 ms CPU limit.
    detailedTransfers: "false",
    numItineraries: String(opts.results ?? 4),
  });
  // Light: only the last options in a 10-minute window and no route shapes (~27 KB instead of ~130 KB),
  // for the extra "safer start" requests.
  if (opts.light) {
    params.set("detailedLegs", "false");
    params.set("searchWindow", "600");
  }
  // Strike day: no trains (metro, tram, bus and coach only).
  if (opts.noRail) params.set("transitModes", "SUBWAY,TRAM,BUS,COACH,FERRY");
  // Cap the walk to the first stop and from the last stop (seconds).
  if (opts.maxWalkMin) {
    params.set("maxPreTransitTime", String(opts.maxWalkMin * 60));
    params.set("maxPostTransitTime", String(opts.maxWalkMin * 60));
  }
  let time: string | null = opts.at ?? null;
  if (!time && (opts.time || opts.date)) {
    const date = opts.date ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date());
    // A date without a time means "at this time of day, on that date".
    const hm = opts.time ?? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    time = brusselsToIso(date, hm);
  }
  if (time) params.set("time", time);
  if (opts.arriveBy) params.set("arriveBy", "true");
  const url = `${API}?${params}`;

  // Short shared cache: the same question within 30 s is answered once (light on Transitous).
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const cacheKey = new Request(url);
  let res = cache ? await cache.match(cacheKey) : undefined;
  if (!res) {
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    } catch (err) {
      throw new TransitousError(`Route planner unreachable (${String(err)})`);
    }
    if (!res.ok) throw new TransitousError(`Route planner HTTP ${res.status}`);
    if (cache) {
      const copy = new Response(res.clone().body, res);
      copy.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
      await cache.put(cacheKey, copy);
    }
  }
  const plan = (await res.json()) as MotisPlan;
  return {
    meta: { schema_version: "1", source: "transitous", fetched_at: new Date().toISOString(), stale: false },
    query: { from, to, time, arrive_by: Boolean(opts.arriveBy) },
    journeys: toJourneys(plan),
  };
}

// ---------- Conversion to Sebway's journey format (pure, unit-tested) ----------

const MODE: Record<string, Mode> = {
  SUBWAY: "metro",
  METRO: "metro",
  TRAM: "tram",
  BUS: "bus",
  COACH: "bus",
  FERRY: "bus",
  RAIL: "train",
  REGIONAL_RAIL: "train",
  REGIONAL_FAST_RAIL: "train",
  SUBURBAN: "train",
  HIGHSPEED_RAIL: "train",
  LONG_DISTANCE: "train",
  NIGHT_RAIL: "train",
};

export function operatorOf(agency: string | undefined): Operator {
  const a = agency ?? "";
  if (/sncb|nmbs/i.test(a)) return "sncb";
  if (/stib|mivb/i.test(a)) return "stib";
  if (/de ?lijn/i.test(a)) return "delijn";
  if (/\btec\b|letec/i.test(a)) return "tec";
  return "other";
}

const PREFIX: Record<Mode, string> = { metro: "M", tram: "T", bus: "B", train: "" };

/** Line label like the rest of the app: STIB "M6", De Lijn "B55", trains "IC". */
function lineLabel(leg: MotisLeg, mode: Mode): string | null {
  const short = leg.routeShortName ?? leg.displayName ?? null;
  if (!short) return null;
  if (mode === "train") return short.split(" ")[0];
  return /^[A-Za-z]/.test(short) ? short : `${PREFIX[mode]}${short}`;
}

/** "ROI BAUDOUIN" → "Roi Baudouin"; mixed-case names stay as they are. */
function tidyName(s: string | undefined): string | null {
  if (!s) return null;
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-/'(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

const minutes = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

function time(actual: string | undefined, scheduled: string | undefined, realtime: boolean, track?: string, schedTrack?: string): TimeWithPlatform {
  const sched = scheduled ?? actual ?? null;
  const exp = realtime ? (actual ?? sched) : null;
  return {
    scheduled: sched,
    expected: exp,
    delay_min: realtime && sched && exp ? minutes(sched, exp) : null,
    realtime,
    platform: track || schedTrack ? { scheduled: schedTrack ?? null, actual: track ?? schedTrack ?? null, changed: Boolean(track && schedTrack && track !== schedTrack) } : null,
  };
}

function stop(p: MotisPlace, operator: Operator): Stop {
  return { id: p.stopId ?? `${p.lat},${p.lon}`, name: p.name, operator, lat: p.lat, lon: p.lon };
}

/** Decode a Google-style encoded polyline (MOTIS uses precision 7), keeping at most `max` points. */
export function decodePolyline(str: string, precision = 7, max = 200): [number, number][] {
  const factor = 10 ** precision;
  const pts: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b: number;
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

/** Route shapes are passed on still encoded: decoding them is the costliest step, so the phone does it. */
const shape = (leg: MotisLeg) => (leg.legGeometry?.points ? { points: leg.legGeometry.points, precision: leg.legGeometry.precision ?? 7 } : undefined);

export function toJourneys(plan: MotisPlan): Journey[] {
  const out: Journey[] = [];
  for (const it of plan.itineraries ?? []) {
    const transit = it.legs.filter((l) => l.mode !== "WALK" && MODE[l.mode]);
    if (!transit.length) continue; // walking-only answers are not a transit trip

    const legs: Leg[] = [];
    const walkPaths: { points: string; precision: number }[] = [];
    let walkSince = 0;
    let prev: MotisLeg | null = null;
    for (const l of it.legs) {
      if (l.mode === "WALK" || !MODE[l.mode]) {
        walkSince += Math.round(l.duration / 60);
        const p = shape(l);
        if (p) walkPaths.push(p);
        continue;
      }
      const mode = MODE[l.mode];
      const operator = operatorOf(`${l.agencyName ?? ""} ${l.agencyId ?? ""}`);
      const rt = Boolean(l.realTime);
      const departure = time(l.from.departure ?? l.startTime, l.from.scheduledDeparture ?? l.scheduledStartTime, rt, l.from.track, l.from.scheduledTrack);
      const arrival = time(l.to.arrival ?? l.endTime, l.to.scheduledArrival ?? l.scheduledEndTime, rt, l.to.track, l.to.scheduledTrack);
      legs.push({
        mode,
        operator,
        line: lineLabel(l, mode),
        vehicle_id: mode === "train" ? (l.displayName ?? l.routeShortName ?? null) : null,
        direction: tidyName(l.headsign),
        from: stop(l.from, operator),
        to: stop(l.to, operator),
        departure,
        arrival,
        cancelled: Boolean(l.cancelled || l.from.cancelled),
        transfer_before: prev
          ? {
              at: stop(l.from, operator),
              walk_min: walkSince,
              scheduled_min: minutes(prev.scheduledEndTime ?? prev.endTime, l.scheduledStartTime ?? l.startTime),
              expected_min: prev.realTime || l.realTime ? minutes(prev.endTime, l.startTime) : null,
            }
          : null,
        path_enc: shape(l),
        walks_before: walkPaths.length,
      });
      prev = l;
      walkSince = 0;
    }

    const firstWalk = it.legs[0].mode === "WALK" ? Math.round(it.legs[0].duration / 60) : 0;
    const last = it.legs[it.legs.length - 1];
    out.push({
      departure: legs[0].departure,
      arrival: legs[legs.length - 1].arrival,
      duration_min: Math.round(it.duration / 60),
      transfers: legs.length - 1,
      cancelled: legs.some((l) => l.cancelled),
      legs,
      alerts: [],
      leave_by: it.startTime,
      arrive_at: it.endTime,
      walk_start_min: firstWalk,
      walk_end_min: last.mode === "WALK" ? Math.round(last.duration / 60) : 0,
      walk_paths_enc: walkPaths,
    });
  }
  return out;
}

// ---------- Addresses and places (geocoding) ----------

export interface PlaceResult {
  kind: "address" | "place" | "stop";
  /** Label shown in the app, e.g. "Wetstraat 16, 1000 Brussels". */
  label: string;
  lat: number;
  lon: number;
}

interface MotisMatch {
  type: string;
  name: string;
  lat: number;
  lon: number;
  country?: string;
  zip?: string;
  areas?: { name: string; default?: boolean }[];
}

const GEOCODE_API = "https://api.transitous.org/api/v1/geocode";

/** Turn geocoder matches into short labels, Belgian results only, without duplicates. */
export function toPlaces(matches: MotisMatch[], limit = 6): PlaceResult[] {
  const out: PlaceResult[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    if (m.country !== "BE") continue;
    const area = m.areas?.find((a) => a.default)?.name;
    const where = [m.zip, area].filter(Boolean).join(" ");
    const kind = m.type === "ADDRESS" ? "address" : m.type === "STOP" ? "stop" : "place";
    const label = where && !m.name.includes(where) ? `${m.name}, ${where}` : m.name;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ kind, label, lat: m.lat, lon: m.lon });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Find addresses, places and stops in Belgium. Results are biased towards `near` (the user's
 * position, else Brussels) and cached for a day. "Street 16, 1000 City" is retried as "Street 16".
 */
export async function findPlaces(text: string, near?: { lat: number; lon: number }): Promise<PlaceResult[]> {
  const bias = near ?? { lat: 50.85, lon: 4.35 };
  const ask = async (q: string): Promise<PlaceResult[]> => {
    const params = new URLSearchParams({ text: q, language: "en", place: `${bias.lat.toFixed(2)},${bias.lon.toFixed(2)}`, placeBias: "5" });
    const url = `${GEOCODE_API}?${params}`;
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    const key = new Request(url);
    let res = cache ? await cache.match(key) : undefined;
    if (!res) {
      try {
        res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      } catch (err) {
        throw new TransitousError(`Address search unreachable (${String(err)})`);
      }
      if (!res.ok) throw new TransitousError(`Address search HTTP ${res.status}`);
      if (cache) {
        const copy = new Response(res.clone().body, res);
        copy.headers.set("Cache-Control", "public, max-age=86400");
        await cache.put(key, copy);
      }
    }
    return toPlaces((await res.json()) as MotisMatch[]);
  };
  const first = await ask(text);
  if (first.length || !text.includes(",")) return first;
  return ask(text.split(",")[0]);
}
