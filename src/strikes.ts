// When is a strike? Reads the dates and times out of a strike announcement (French, Dutch or English),
// because SNCB and STIB publish them as text: "Grève nationale du lundi 6 octobre à 22h au mercredi
// 8 octobre à 22h", "Staking op dinsdag 14 oktober", "6 en 7 oktober", "le 21/10". Plain code, no AI.
// Used for the "strike tomorrow" push and the "may not run" label on trips.
import type { Disruption, Journey } from "./types";

export interface StrikeWindow {
  /** ms, inclusive start / exclusive end. */
  start: number;
  end: number;
  /** Times were given in the text (e.g. 22:00), not just days. */
  timed: boolean;
}

const MONTHS: Record<string, number> = {};
const monthNames: [number, string[]][] = [
  [1, ["janvier", "janv", "januari", "jan", "january"]],
  [2, ["fevrier", "fevr", "februari", "feb", "february"]],
  [3, ["mars", "maart", "mrt", "march", "mar"]],
  [4, ["avril", "avr", "april", "apr"]],
  [5, ["mai", "mei", "may"]],
  [6, ["juin", "juni", "june", "jun"]],
  [7, ["juillet", "juil", "juli", "july", "jul"]],
  [8, ["aout", "augustus", "aug", "august"]],
  [9, ["septembre", "sept", "september", "sep"]],
  [10, ["octobre", "oktober", "october", "okt", "oct"]],
  [11, ["novembre", "november", "nov"]],
  [12, ["decembre", "december", "dec"]],
];
for (const [n, names] of monthNames) for (const name of names) MONTHS[name] = n;
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const WEEKDAY_RE = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const TIME_RE = "(\\d{1,2})\\s*(?:h|u|uur|:)\\s*(\\d{2})?";
const RANGE_RE = new RegExp(
  `^[\\s,]*(?:(?:a|om|at|vanaf|from|des|vers)?\\s*${TIME_RE})?[\\s,]*(?:au|tot(?: en met)?|t\\/m|to|until|till|jusqu.?(?:au)?|-|–|—)\\s*(?:le|op|on|de|van|het|the)?\\s*(?:(?:${WEEKDAY_RE})\\s*)?$`,
);

/** Brussels local date + time → ms (handles summer/winter time). */
export function brusselsMs(y: number, m: number, d: number, hh = 0, mm = 0): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return guess - (asUtc - guess);
}

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

interface DateToken {
  at: number;
  end: number;
  y: number | null;
  m: number;
  d: number;
  hh: number | null;
  mm: number;
}

/** All dates in the text, in order, each with a time if one follows it closely ("à 22h", "om 22u"). */
/** "6 au 8 octobre" / "6 en 7 oktober" → put the month on the first day too. */
const spellOutDays = (text: string) =>
  text.replace(new RegExp(`\\b(\\d{1,2})(?:er|e|st|nd|rd|th)?\\s*(au|tot|to|-|–|en|et|and|&)\\s*(\\d{1,2})(?:er|e|st|nd|rd|th)?\\s+(${MONTH_RE})\\b`, "g"), "$1 $4 $2 $3 $4");

/** Positions refer to the text as given (already passed through spellOutDays). */
function dateTokens(t: string): DateToken[] {
  const tokens: DateToken[] = [];
  const add = (at: number, len: number, y: string | undefined, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const after = t.slice(at + len, at + len + 18);
    const time = new RegExp(`^[\\s,]*(?:a|om|at|vanaf|from|des|vers|a partir de)?\\s*${TIME_RE}`).exec(after);
    tokens.push({ at, end: at + len + (time ? time[0].length : 0), y: y ? Number(y.length === 2 ? `20${y}` : y) : null, m, d, hh: time ? Number(time[1]) : null, mm: time?.[2] ? Number(time[2]) : 0 });
  };
  for (const r of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:er|e|st|nd|rd|th)?\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?\\b`, "g"))) add(r.index!, r[0].length, r[3], MONTHS[r[2]], Number(r[1]));
  for (const r of t.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "g"))) add(r.index!, r[0].length, r[3], MONTHS[r[1]], Number(r[2]));
  // dd/mm(/yyyy) with slashes only: "9.05" is usually a time.
  for (const r of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) add(r.index!, r[0].length, r[3], Number(r[2]), Number(r[1]));
  // Keep one token per position (the English "October 21" and "21 October" patterns can overlap).
  return tokens.sort((a, b) => a.at - b.at).filter((tk, i, all) => i === 0 || tk.at >= all[i - 1].end);
}

/** The year for a date without one: this year, or next year if that date is long gone. */
function withYear(tk: DateToken, now: number): number {
  if (tk.y) return tk.y;
  const y = new Date(now).getUTCFullYear();
  return brusselsMs(y, tk.m, tk.d) < now - 60 * 86_400_000 ? y + 1 : y;
}

const DAY = 86_400_000;

/**
 * When this strike happens, from its text (dates, ranges, times), else from valid_from/valid_until
 * when both exist (De Lijn). Empty when nothing can be read: then we don't guess.
 */
export function strikeWindows(d: Disruption, now = Date.now()): StrikeWindow[] {
  const text = spellOutDays(plain(`${d.title} ${d.description}`));
  const tokens = dateTokens(text);
  const windows: StrikeWindow[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const ya = withYear(a, now);
    const dayStart = (tk: DateToken, y: number) => brusselsMs(y, tk.m, tk.d);
    if (b && RANGE_RE.test(text.slice(a.end, b.at))) {
      const yb = withYear(b, now);
      const start = a.hh !== null ? brusselsMs(ya, a.m, a.d, a.hh, a.mm) : dayStart(a, ya);
      const end = b.hh !== null ? brusselsMs(yb, b.m, b.d, b.hh, b.mm) : dayStart(b, yb) + DAY;
      if (end > start && end - start <= 31 * DAY) windows.push({ start, end, timed: a.hh !== null || b.hh !== null });
      i++;
      continue;
    }
    const start = a.hh !== null ? brusselsMs(ya, a.m, a.d, a.hh, a.mm) : dayStart(a, ya);
    // "from 22:00" on a day usually means through the next day (SNCB strikes run 22:00 → 22:00).
    const end = a.hh !== null && a.hh >= 18 ? dayStart(a, ya) + 2 * DAY : dayStart(a, ya) + DAY;
    windows.push({ start, end, timed: a.hh !== null });
  }
  if (!windows.length && d.valid_from && d.valid_until) {
    const start = Date.parse(d.valid_from);
    const end = Date.parse(d.valid_until);
    if (Number.isFinite(start) && end > start) windows.push({ start, end, timed: true });
  }
  // Only what's not over yet.
  return windows.filter((w) => w.end > now - DAY).sort((x, y) => x.start - y.start);
}

export const strikeActiveAt = (d: Disruption, at: number, now = Date.now()) => strikeWindows(d, now).some((w) => w.start <= at && at < w.end);

/** Brussels day (YYYY-MM-DD) → [start, end) in ms. */
export function dayRange(ymd: string): [number, number] {
  const [y, m, dd] = ymd.split("-").map(Number);
  return [brusselsMs(y, m, dd), brusselsMs(y, m, dd + 1)];
}

/** Strike windows that touch a given Brussels day. */
export const windowsOnDay = (d: Disruption, ymd: string, now = Date.now()) => {
  const [s, e] = dayRange(ymd);
  return strikeWindows(d, now).filter((w) => w.start < e && w.end > s);
};

const fmt = (ms: number, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", ...opts }).format(new Date(ms));

/** "Tue 21 Oct" or "Mon 20 Oct 22:00 – Tue 21 Oct 22:00". */
export function describeWindow(w: StrikeWindow): string {
  const day = (ms: number) => fmt(ms, { weekday: "short", day: "numeric", month: "short" });
  const hm = (ms: number) => fmt(ms, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const lastDay = w.end - 1;
  if (!w.timed) return day(w.start) === day(lastDay) ? day(w.start) : `${day(w.start)} – ${day(lastDay)}`;
  return `${day(w.start)} ${hm(w.start)} – ${day(w.end)} ${hm(w.end)}`;
}

// ---------- Trips on strike days ----------

export interface TripStrike {
  operators: string[];
  title: string;
  when: string;
}

const OP_NAME: Record<string, string> = { sncb: "SNCB", stib: "STIB", delijn: "De Lijn", tec: "TEC" };
export const operatorName = (op: string) => OP_NAME[op] ?? op.toUpperCase();

/**
 * Tag trips that use an operator on strike at the time of the trip ("may not run"), and put the trips
 * that avoid the strike first. `strikesFor(journey)` returns the strike notices relevant to that trip
 * (network-wide ones for its operators, plus any found at its stations).
 */
export function tagStrikes<T extends Journey & { analysis?: { recommended?: boolean; level?: string } }>(
  journeys: T[],
  strikesFor: (j: T) => Disruption[],
  now = Date.now(),
): (T & { strike?: TripStrike })[] {
  const tagged = journeys.map((j) => {
    const at = Date.parse(j.leave_by ?? j.departure.expected ?? j.departure.scheduled ?? "");
    const end = Date.parse(j.arrive_at ?? j.arrival.expected ?? j.arrival.scheduled ?? "") || at;
    if (!Number.isFinite(at)) return j;
    const ops = new Set(j.legs.map((l) => l.operator));
    const hits = strikesFor(j).filter((d) => d.type === "strike" && ops.has(d.operator) && strikeWindows(d, now).some((w) => w.start < end && at < w.end));
    if (!hits.length) return j;
    const w = strikeWindows(hits[0], now).find((x) => x.start < end && at < x.end)!;
    return { ...j, strike: { operators: [...new Set(hits.map((d) => d.operator))], title: hits[0].title, when: describeWindow(w) } };
  });
  const clear = tagged.filter((j) => !("strike" in j && j.strike));
  if (!clear.length || clear.length === tagged.length) return tagged;
  // Trips that avoid the strike first; the best of those becomes the recommended one.
  const firstClear = clear.find((j) => j.analysis?.level === "ok") ?? clear[0];
  return [...clear, ...tagged.filter((j) => "strike" in j && j.strike)].map((j) =>
    j.analysis ? { ...j, analysis: { ...j.analysis, recommended: j === firstClear } } : j,
  );
}

// ---------- The evening before ----------

/** Operators a saved route can use: train routes SNCB only, door-to-door routes any of the three. */
export const routeOperators = (routes: { mode: string }[]) =>
  new Set(routes.flatMap((r) => (r.mode === "train" ? ["sncb"] : ["sncb", "stib", "delijn"])));

/** Hours (Brussels) for the "strike tomorrow" heads-up: early evening, before people plan tomorrow. */
export const EVE_HOURS = [17, 22] as const;

/**
 * Strikes that start after now and touch tomorrow, for operators on these routes: one heads-up each.
 * Returns the push key (dedupe per strike and day) and the text.
 */
export function strikeTomorrow(
  routes: { mode: string }[],
  strikes: Disruption[],
  now: number,
): { key: string; title: string; body: string }[] {
  const hour = Number(fmt(now, { hour: "2-digit", hourCycle: "h23" }));
  if (!routes.length || hour < EVE_HOURS[0] || hour >= EVE_HOURS[1]) return [];
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels" }).format(new Date(now + 12 * 3_600_000 + 12 * 3_600_000));
  const ops = routeOperators(routes);
  const seen = new Set<string>();
  const out: { key: string; title: string; body: string }[] = [];
  for (const d of strikes) {
    if (d.type !== "strike" || !ops.has(d.operator) || seen.has(d.id)) continue;
    seen.add(d.id);
    const w = windowsOnDay(d, tomorrow, now).find((x) => x.start > now);
    if (!w) continue;
    const name = operatorName(d.operator);
    out.push({
      key: `eve:${d.id}:${tomorrow}`,
      title: `Strike tomorrow: ${name}`,
      body: `${describeWindow(w)}. Your saved trips use ${name}: open Sebway to see which trips may not run and plan around it.`,
    });
  }
  return out;
}
