// Disruptions that touch a trip: every station on it (start, end and transfers) plus national strikes.
// Plain code, no AI. Used by the journey/commute endpoints, the chat and the background checks.
import { callTool } from "./mcp";
import { isNationalStrike } from "./notify-rules";
import { tagStrikes, type TripStrike } from "./strikes";
import type { Disruption, DisruptionsResult, Journey, Meta, Stop } from "./types";

export interface RouteDisruptions {
  /** Everything found, strikes first, then by severity. */
  items: Disruption[];
  /** Station names that were checked. */
  checked: string[];
  meta: Meta | null;
}

const MAX_STATIONS = 8;
const SEVERITY_RANK = { major: 0, minor: 1, info: 2 } as const;

/** Shown on a trip card: strikes and incidents. Planned works and info stay in the panel. */
export const affectsTrip = (d: Disruption) => d.type === "strike" || d.type === "incident" || d.severity === "major";

function stationQuery(stop: Stop): Record<string, string> {
  // STIB and De Lijn stops need their operator; SNCB is the default.
  return stop.operator === "sncb" ? { station: stop.name } : { station: stop.name, operator: stop.operator };
}

const queryKey = (q: Record<string, string>) => `${q.operator ?? "sncb"}|${q.station ?? "*"}`;

/** Station lookups for one journey, in travel order, without duplicates. */
export function journeyStations(j: Journey): Record<string, string>[] {
  const seen = new Map<string, Record<string, string>>();
  for (const leg of j.legs) {
    if (leg.operator !== "sncb" && leg.operator !== "stib" && leg.operator !== "delijn") continue; // TEC etc.: no disruption source
    for (const stop of [leg.from, leg.to]) {
      const q = stationQuery(stop);
      if (!seen.has(queryKey(q))) seen.set(queryKey(q), q);
    }
  }
  return [...seen.values()];
}

/**
 * Look up disruptions for all stations used by these journeys (capped) plus national SNCB strikes,
 * and tag each journey with the ids that concern it (`analysis.disruption_ids`).
 */
export async function attachRouteDisruptions<T extends Journey & { analysis?: object }>(
  env: Env,
  journeys: T[],
): Promise<{ journeys: (T & { disruption_ids: string[]; strike?: TripStrike })[]; route_disruptions: RouteDisruptions }> {
  const perJourney = journeys.map(journeyStations);
  const unique = new Map<string, Record<string, string>>();
  for (const qs of perJourney) for (const q of qs) if (unique.size < MAX_STATIONS && !unique.has(queryKey(q))) unique.set(queryKey(q), q);

  const hasTrain = journeys.some((j) => j.legs.some((l) => l.mode === "train"));
  const lookups = [...unique.entries()].map(async ([key, q]) => {
    try {
      const r = await callTool<DisruptionsResult>(env, "disruptions", { ...q, limit: 10 });
      return { key, list: r.disruptions, meta: r.meta };
    } catch {
      return { key, list: [] as Disruption[], meta: null };
    }
  });
  const national = hasTrain
    ? callTool<DisruptionsResult>(env, "disruptions", { type: "incident", limit: 30 })
        .then((r) => r.disruptions.filter(isNationalStrike))
        .catch(() => [] as Disruption[])
    : Promise.resolve([] as Disruption[]);

  // STIB posts network-wide notices (strikes) without a station: check them when a trip uses STIB.
  const hasStib = journeys.some((j) => j.legs.some((l) => l.operator === "stib"));
  const stibStrikes = hasStib
    ? callTool<DisruptionsResult>(env, "disruptions", { operator: "stib", limit: 30 })
        .then((r) => r.disruptions.filter((d) => d.type === "strike"))
        .catch(() => [] as Disruption[])
    : Promise.resolve([] as Disruption[]);

  const results = await Promise.all(lookups);
  const nationalStrikes = await national;
  const stibNetwork = await stibStrikes;

  const byKey = new Map(results.map((r) => [r.key, r.list]));
  const all = new Map<string, Disruption>();
  for (const r of results) for (const d of r.list) all.set(d.id, d);
  for (const d of nationalStrikes) all.set(d.id, d);
  for (const d of stibNetwork) all.set(d.id, d);

  const items = [...all.values()].sort(
    (a, b) => Number(b.type === "strike") - Number(a.type === "strike") || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  /** Strike notices that concern one trip: at its stations, national SNCB strikes, STIB network notices. */
  const strikesFor = (i: number): Disruption[] => {
    const list: Disruption[] = [];
    for (const q of perJourney[i]) for (const d of byKey.get(queryKey(q)) ?? []) if (d.type === "strike") list.push(d);
    return [...list, ...nationalStrikes, ...stibNetwork];
  };
  const tagged = journeys.map((j, i) => {
    const ids = new Set<string>();
    for (const q of perJourney[i]) for (const d of byKey.get(queryKey(q)) ?? []) if (affectsTrip(d)) ids.add(d.id);
    if (j.legs.some((l) => l.mode === "train")) for (const d of nationalStrikes) ids.add(d.id);
    if (j.legs.some((l) => l.operator === "stib")) for (const d of stibNetwork) ids.add(d.id);
    return { ...j, disruption_ids: [...ids], _i: i };
  });
  // On strike days: trips using a striking operator during the strike get "may not run" and go last.
  const reordered = tagStrikes(tagged, (j) => strikesFor(j._i));
  // Trips may have moved: keep "take this one instead" pointing at the right trip.
  const newIndex = new Map(reordered.map((j, k) => [j._i, k]));
  const withStrikes = reordered.map(({ _i, ...j }) => {
    const a = (j as { analysis?: { alternative?: { journey_index: number } | null } }).analysis;
    if (a?.alternative) a.alternative = { ...a.alternative, journey_index: newIndex.get(a.alternative.journey_index) ?? a.alternative.journey_index };
    return j as T & { disruption_ids: string[]; strike?: TripStrike };
  });

  return {
    journeys: withStrikes,
    route_disruptions: {
      items,
      checked: [...unique.values()].map((q) => q.station),
      meta: results.find((r) => r.meta)?.meta ?? null,
    },
  };
}
