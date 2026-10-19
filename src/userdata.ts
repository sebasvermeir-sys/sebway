// Personal data per device: saved places, routes, departure boards and passes.
// Stored in KV as one small JSON document under device:<uuid>. The device id is a random UUID the
// app creates; there are no accounts. The Claude key is never part of this document.

export interface SavedRoute {
  id: string;
  name: string;
  mode: "train" | "commute";
  from: string;
  to: string;
  /** Exact stop ids picked in the app (more reliable than names). */
  from_id?: string;
  to_id?: string;
  /** Coordinates of the stops, for door-to-door planning. */
  from_lat?: number;
  from_lon?: number;
  to_lat?: number;
  to_lon?: number;
  direction?: "auto" | "to_gent" | "to_brussels";
  /** Emoji shown on the favourite chip. */
  emoji?: string;
  /** Made by the app from two saved places (e.g. Home → School); kept in sync with them. */
  auto?: boolean;
  from_place?: string;
  to_place?: string;
}

/** A saved place: an address, a place or a stop, with a label like Home or School. */
export interface SavedPlace {
  id: string;
  label: string;
  emoji: string;
  /** What to plan to/from: the address, place or stop name. */
  name: string;
  stop_id?: string;
  lat?: number;
  lon?: number;
}

export interface SavedBoard {
  id: string;
  stop: string;
  stop_id?: string;
  operator?: "sncb" | "stib" | "delijn";
}

export interface Pass {
  id: string;
  name: string;
  operator: "sncb" | "stib" | "delijn" | "tec" | "other";
  /** Last valid day, YYYY-MM-DD. */
  valid_until: string;
  /** Remind this many days before it runs out. */
  remind_days: number;
}

export interface UserData {
  version: 1;
  places: SavedPlace[];
  routes: SavedRoute[];
  boards: SavedBoard[];
  passes: Pass[];
  walk_min: number;
  updated_at: string;
}

export const EMPTY: Omit<UserData, "updated_at"> = { version: 1, places: [], routes: [], boards: [], passes: [], walk_min: 10 };

const LIMITS = { places: 8, routes: 16, boards: 10, passes: 5, text: 80 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class UserDataError extends Error {}

export function deviceKey(req: Request): string | null {
  const id = req.headers.get("X-Device-Id") ?? "";
  return UUID.test(id) ? `device:${id.toLowerCase()}` : null;
}

const text = (v: unknown, field: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new UserDataError(`${field} is required`);
  return v.trim().slice(0, LIMITS.text);
};
const id = (v: unknown): string => (typeof v === "string" && /^[\w-]{1,40}$/.test(v) ? v : crypto.randomUUID());
/** Stop ids look like "BE.NMBS.008814001", "stib:GARE DU MIDI" or "delijn:2_200274_2_201274". */
const stopId = (v: unknown): string | undefined => (typeof v === "string" && /^[\w:. -]{1,300}$/.test(v) ? v : undefined);
/** Latitude/longitude pair inside the Belgium area, or nothing. */
const coords = (lat: unknown, lon: unknown, prefix: "from" | "to") => {
  const a = Number(lat);
  const b = Number(lon);
  return Number.isFinite(a) && Number.isFinite(b) && a > 49 && a < 52 && b > 2 && b < 7 ? { [`${prefix}_lat`]: a, [`${prefix}_lon`]: b } : {};
};
const withStopIds = (fields: Record<string, string | undefined>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v));

/** A short emoji (no letters, digits or markup), else nothing. */
const emoji = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= 12 && !/[\p{L}\p{N}<>&"'\s]/u.test(v) ? v : undefined;

const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T | undefined): T | undefined =>
  options.includes(v as T) ? (v as T) : fallback;

/** Validate and clean what the app sends. Unknown fields are dropped. */
export function sanitize(input: unknown): Omit<UserData, "updated_at"> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const list = (v: unknown, max: number, name: string): Record<string, unknown>[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new UserDataError(`${name} must be a list`);
    if (v.length > max) throw new UserDataError(`At most ${max} ${name}`);
    return v.map((x) => (x ?? {}) as Record<string, unknown>);
  };

  const routes = list(raw.routes, LIMITS.routes, "routes").map((r): SavedRoute => {
    const mode = oneOf(r.mode, ["train", "commute"] as const, "train")!;
    return {
      id: id(r.id),
      name: text(r.name, "Route name"),
      mode,
      from: text(r.from, "From"),
      to: text(r.to, "To"),
      ...withStopIds({ from_id: stopId(r.from_id), to_id: stopId(r.to_id) }),
      ...coords(r.from_lat, r.from_lon, "from"),
      ...coords(r.to_lat, r.to_lon, "to"),
      ...(mode === "commute" ? { direction: oneOf(r.direction, ["auto", "to_gent", "to_brussels"] as const, "auto") } : {}),
      ...(emoji(r.emoji) ? { emoji: emoji(r.emoji) } : {}),
      ...(r.auto === true ? { auto: true, ...withStopIds({ from_place: stopId(r.from_place), to_place: stopId(r.to_place) }) } : {}),
    };
  });

  const places = list(raw.places, LIMITS.places, "places").map((p): SavedPlace => {
    const c = coords(p.lat, p.lon, "from") as { from_lat?: number; from_lon?: number };
    return {
      id: id(p.id),
      label: text(p.label, "Place label"),
      emoji: emoji(p.emoji) ?? "📍",
      name: text(p.name, "Place"),
      ...withStopIds({ stop_id: stopId(p.stop_id) }),
      ...(c.from_lat !== undefined ? { lat: c.from_lat, lon: c.from_lon } : {}),
    };
  });

  const boards = list(raw.boards, LIMITS.boards, "boards").map((b): SavedBoard => {
    const operator = oneOf(b.operator, ["sncb", "stib", "delijn"] as const, undefined);
    return { id: id(b.id), stop: text(b.stop, "Stop"), ...withStopIds({ stop_id: stopId(b.stop_id) }), ...(operator ? { operator } : {}) };
  });

  const passes = list(raw.passes, LIMITS.passes, "passes").map((p): Pass => {
    const until = typeof p.valid_until === "string" && DATE.test(p.valid_until) ? p.valid_until : null;
    if (!until) throw new UserDataError("Pass end date must be YYYY-MM-DD");
    const remind = Number(p.remind_days);
    return {
      id: id(p.id),
      name: text(p.name, "Pass name"),
      operator: oneOf(p.operator, ["sncb", "stib", "delijn", "tec", "other"] as const, "other")!,
      valid_until: until,
      remind_days: Number.isFinite(remind) ? Math.min(60, Math.max(0, Math.round(remind))) : 7,
    };
  });

  const walk = Number(raw.walk_min);
  return { version: 1, places, routes, boards, passes, walk_min: Number.isFinite(walk) ? Math.min(90, Math.max(0, Math.round(walk))) : 10 };
}

export async function loadUserData(kv: KVNamespace, key: string): Promise<UserData | null> {
  return kv.get<UserData>(key, "json");
}

export async function saveUserData(kv: KVNamespace, key: string, input: unknown): Promise<UserData> {
  const data: UserData = { ...sanitize(input), updated_at: new Date().toISOString() };
  await kv.put(key, JSON.stringify(data));
  return data;
}
