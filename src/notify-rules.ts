// Pure rules for background alerts (no I/O), so they can be unit-tested.
import type { Disruption } from "./types";
import type { Pass, SavedRoute } from "./userdata";

/** No pushes at night (Brussels 23:00–06:59). Anything still active is sent in the morning. */
export function isQuietHours(now = new Date()): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Europe/Brussels" }).format(now));
  return hour >= 23 || hour < 7;
}

export function brusselsDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(now);
}

/** Days left on a pass, counting in Brussels dates. 0 = last valid day is today. */
export function passDaysLeft(validUntil: string, now = new Date()): number {
  return Math.round((Date.parse(validUntil) - Date.parse(brusselsDate(now))) / 86_400_000);
}

/** Remind on the chosen day, then 3 days, 1 day and 0 days before. */
export function passReminderDue(p: Pass, now = new Date()): number | null {
  const d = passDaysLeft(p.valid_until, now);
  return d >= 0 && new Set([p.remind_days, 3, 1, 0]).has(d) ? d : null;
}

/** The disruption lookups that cover a saved route. */
export function routeQueries(r: SavedRoute): Record<string, string>[] {
  if (r.mode === "train") return [{ station: r.from }, { station: r.to }];
  return [{ station: "Bruxelles-Midi" }, { station: "Gent-Sint-Pieters" }, { station: r.from, operator: "stib" }, { station: r.to }];
}

/** Worth a push: strikes and major disruptions. Minor and info items stay in the app only. */
export const isPushWorthy = (d: Disruption) => d.type === "strike" || d.severity === "major";

/** A strike that affects the whole network, not one line: worth showing on every train trip. */
export function isNationalStrike(d: Disruption): boolean {
  if (d.type !== "strike") return false;
  const text = `${d.title} ${d.description}`;
  return /national|nationwide|landelijk|nationale|heel het land|tout le pays|whole country|toute la belgique|heel belgi[eë]|all (?:lines|trains)|alle (?:lijnen|treinen)|toutes les lignes|tous les trains/i.test(text);
}
