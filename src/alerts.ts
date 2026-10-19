// Missed-connection alerts and "leave by": plain code, no AI.
// Used by /api/journey, /api/trip (door to door) and the chat.
import type { Journey, Leg, Mode, TimeInfo } from "./types";

export type TransferLevel = "ok" | "at_risk" | "broken";
export type JourneyLevel = TransferLevel | "cancelled";

export interface TransferCheck {
  /** Index of the leg the user changes INTO. */
  leg_index: number;
  at: string;
  available_min: number;
  needed_min: number;
  /** false when the change time is based on timetable times only. */
  realtime: boolean;
  level: TransferLevel;
}

export interface Alternative {
  journey_index: number;
  departure: string;
  arrival: string;
  later_min: number;
}

export interface JourneyAnalysis {
  level: JourneyLevel;
  /** One line for the user, null when everything is fine. */
  message: string | null;
  transfers: TransferCheck[];
  /** Best journey to take instead, when this one is broken or cancelled. */
  alternative: Alternative | null;
  /** When to leave home: from the source (door to door) or departure minus walk time. */
  leave_by: string | null;
  recommended: boolean;
}

export type AnalyzedJourney = Journey & { analysis: JourneyAnalysis };

/**
 * Minimum time needed to change between two legs.
 * Train ⇄ metro at a big station (e.g. Midi) needs 5 min; train ⇄ bus/tram 3 min; anything else 3 min.
 */
export function neededMinutes(from: Mode, to: Mode): number {
  const pair = new Set([from, to]);
  if (pair.has("train") && pair.has("metro")) return 5;
  return 3;
}

const shown = (t: TimeInfo): string | null => t.expected ?? t.scheduled;

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" });
export const hhmm = (iso: string | null | undefined): string => (iso ? timeFmt.format(new Date(iso)) : "–");

const legName = (leg: Leg): string => leg.vehicle_id ?? leg.line ?? leg.mode;

export function checkTransfers(legs: Leg[]): TransferCheck[] {
  const checks: TransferCheck[] = [];
  legs.forEach((leg, i) => {
    const t = leg.transfer_before;
    if (!t || i === 0) return;
    const prev = legs[i - 1];
    const realtime = t.expected_min !== null && t.expected_min !== undefined;
    const available = realtime ? (t.expected_min as number) : t.scheduled_min;
    // Door-to-door trips include the walk between stops: the change needs at least that long.
    const needed = Math.max(neededMinutes(prev.mode, leg.mode), t.walk_min ?? 0);
    const level: TransferLevel = available < 0 ? "broken" : available < needed ? "at_risk" : "ok";
    checks.push({ leg_index: i, at: t.at.name, available_min: available, needed_min: needed, realtime, level });
  });
  return checks;
}

function journeyLevel(j: Journey, transfers: TransferCheck[]): JourneyLevel {
  if (j.cancelled || j.legs.some((l) => l.cancelled)) return "cancelled";
  if (transfers.some((t) => t.level === "broken")) return "broken";
  if (transfers.some((t) => t.level === "at_risk")) return "at_risk";
  return "ok";
}

function message(j: Journey, level: JourneyLevel, transfers: TransferCheck[]): string | null {
  if (level === "cancelled") {
    const leg = j.legs.find((l) => l.cancelled);
    return leg ? `${legName(leg)} is cancelled.` : "This trip is cancelled.";
  }
  const worst = transfers.find((t) => t.level === "broken") ?? transfers.find((t) => t.level === "at_risk");
  if (!worst) return null;
  const prev = j.legs[worst.leg_index - 1];
  const next = j.legs[worst.leg_index];
  if (worst.level === "broken") {
    return `Connection missed at ${worst.at}: ${legName(prev)} arrives ${hhmm(shown(prev.arrival))}, ${legName(next)} leaves ${hhmm(shown(next.departure))}.`;
  }
  const mins = worst.available_min === 1 ? "1 min" : `${worst.available_min} min`;
  return `Tight change at ${worst.at}: only ${mins} to reach ${legName(next)} (you need about ${worst.needed_min}).`;
}

/** Departure minus the time to reach the first stop. Door-to-door trips bring their own leave_by. */
export function leaveBy(j: Journey, walkMin: number | null): string | null {
  const dep = shown(j.departure);
  if (j.leave_by) {
    // A leave-by after the trip's own departure can't be right (seen from commute_check): don't show it.
    if (dep && new Date(j.leave_by).getTime() > new Date(dep).getTime()) return null;
    return j.leave_by;
  }
  if (walkMin === null || !dep) return null;
  return new Date(new Date(dep).getTime() - walkMin * 60_000).toISOString();
}

const arrivalMs = (j: Journey): number => {
  const a = j.arrive_at ?? shown(j.arrival);
  return a ? new Date(a).getTime() : Number.POSITIVE_INFINITY;
};

/**
 * Analyse every journey and pick the best one: the earliest arrival among trips that still work
 * (fewest changes on a tie). Broken or cancelled trips point to that best trip as the alternative.
 */
export function analyzeJourneys(journeys: Journey[], walkMin: number | null = null): AnalyzedJourney[] {
  const base = journeys.map((j) => {
    const transfers = checkTransfers(j.legs);
    const level = journeyLevel(j, transfers);
    return { j, transfers, level };
  });

  let best: number | null = null;
  for (let i = 0; i < base.length; i++) {
    const { j, level } = base[i];
    if (level === "broken" || level === "cancelled") continue;
    if (best === null) {
      best = i;
      continue;
    }
    const cur = base[best].j;
    if (arrivalMs(j) < arrivalMs(cur) || (arrivalMs(j) === arrivalMs(cur) && j.transfers < cur.transfers)) best = i;
  }

  return base.map(({ j, transfers, level }, i) => {
    let alternative: Alternative | null = null;
    if ((level === "broken" || level === "cancelled") && best !== null) {
      const alt = base[best].j;
      const later = arrivalMs(alt) - arrivalMs(j);
      alternative = {
        journey_index: best,
        departure: shown(alt.departure) ?? "",
        arrival: alt.arrive_at ?? shown(alt.arrival) ?? "",
        later_min: Number.isFinite(later) ? Math.max(0, Math.round(later / 60_000)) : 0,
      };
    }
    return {
      ...j,
      analysis: {
        level,
        message: message(j, level, transfers),
        transfers,
        alternative,
        leave_by: leaveBy(j, walkMin),
        recommended: i === best,
      },
    };
  });
}
