// Run: npm test  (Node runs TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeJourneys, checkTransfers, leaveBy, neededMinutes } from "../src/alerts.ts";
import type { Journey, Leg, Mode, Stop } from "../src/types.ts";

const stop = (name: string): Stop => ({ id: name, name, operator: "sncb", lat: 50.8, lon: 4.3 });
const at = (hm: string) => `2026-10-14T${hm}:00+02:00`;

function leg(mode: Mode, name: string, from: string, dep: string, to: string, arr: string, opts: { depDelay?: number; arrDelay?: number; transfer?: [number, number | null]; cancelled?: boolean } = {}): Leg {
  const time = (hm: string, delay = 0) => ({
    scheduled: at(hm),
    expected: new Date(new Date(at(hm)).getTime() + delay * 60_000).toISOString(),
    delay_min: delay,
    realtime: true,
    platform: null,
  });
  return {
    mode,
    operator: mode === "train" ? "sncb" : mode === "metro" ? "stib" : "delijn",
    line: null,
    vehicle_id: name,
    direction: null,
    from: stop(from),
    to: stop(to),
    departure: time(dep, opts.depDelay),
    arrival: time(arr, opts.arrDelay),
    cancelled: opts.cancelled ?? false,
    transfer_before: opts.transfer ? { at: stop(from), scheduled_min: opts.transfer[0], expected_min: opts.transfer[1] } : null,
  };
}

function journey(legs: Leg[], extra: Partial<Journey> = {}): Journey {
  const first = legs[0];
  const last = legs[legs.length - 1];
  return {
    departure: first.departure,
    arrival: last.arrival,
    duration_min: 0,
    transfers: legs.length - 1,
    cancelled: false,
    legs,
    alerts: [],
    ...extra,
  };
}

test("change times: train⇄metro 5 min, train⇄bus 3 min", () => {
  assert.equal(neededMinutes("train", "metro"), 5);
  assert.equal(neededMinutes("metro", "train"), 5);
  assert.equal(neededMinutes("train", "bus"), 3);
  assert.equal(neededMinutes("bus", "train"), 3);
});

test("comfortable change is ok", () => {
  const [j] = analyzeJourneys([
    journey([
      leg("train", "IC 516", "Gent-Sint-Pieters", "17:24", "Midi", "17:52"),
      leg("metro", "M2", "Midi", "18:00", "Trône", "18:09", { transfer: [8, 8] }),
    ]),
  ]);
  assert.equal(j.analysis.level, "ok");
  assert.equal(j.analysis.message, null);
  assert.equal(j.analysis.recommended, true);
});

test("delay leaving 3 min for train→metro is at risk", () => {
  const [j] = analyzeJourneys([
    journey([
      leg("train", "IC 516", "Gent-Sint-Pieters", "17:24", "Midi", "17:52", { arrDelay: 5 }),
      leg("metro", "M2", "Midi", "18:00", "Trône", "18:09", { transfer: [8, 3] }),
    ]),
  ]);
  assert.equal(j.analysis.level, "at_risk");
  assert.match(j.analysis.message ?? "", /Tight change at Midi: only 3 min to reach M2 \(you need about 5\)/);
});

test("3 min is enough for train→bus", () => {
  const [j] = analyzeJourneys([
    journey([
      leg("train", "IC 1528", "Midi", "07:29", "Gent-Sint-Pieters", "07:57"),
      leg("bus", "B55", "Gent-Sint-Pieters", "08:00", "Heuvelpoort", "08:08", { transfer: [3, 3] }),
    ]),
  ]);
  assert.equal(j.analysis.level, "ok");
});

test("negative change time is a missed connection with an alternative", () => {
  const journeys = analyzeJourneys([
    journey([
      leg("train", "IC 1528", "Midi", "07:29", "Gent-Sint-Pieters", "07:57", { arrDelay: 6 }),
      leg("bus", "B55", "Gent-Sint-Pieters", "08:00", "Heuvelpoort", "08:08", { transfer: [3, -3] }),
    ]),
    journey([
      leg("train", "IC 528", "Midi", "07:42", "Gent-Sint-Pieters", "08:10"),
      leg("bus", "B70", "Gent-Sint-Pieters", "08:15", "Heuvelpoort", "08:23", { transfer: [5, 5] }),
    ]),
  ]);
  const broken = journeys[0].analysis;
  assert.equal(broken.level, "broken");
  assert.match(broken.message ?? "", /Connection missed at Gent-Sint-Pieters: IC 1528 arrives 08:03, B55 leaves 08:00/);
  assert.equal(broken.alternative?.journey_index, 1);
  assert.equal(broken.alternative?.later_min, 15);
  assert.equal(broken.recommended, false);
  assert.equal(journeys[1].analysis.recommended, true);
});

test("cancelled leg makes the trip cancelled", () => {
  const [j] = analyzeJourneys([journey([leg("train", "IC 437", "Midi", "16:37", "Gent-Sint-Pieters", "17:06", { cancelled: true })])]);
  assert.equal(j.analysis.level, "cancelled");
  assert.equal(j.analysis.message, "IC 437 is cancelled.");
});

test("timetable-only change uses the scheduled time", () => {
  const checks = checkTransfers([
    leg("train", "IC 1", "A", "10:00", "Midi", "10:30"),
    leg("metro", "M2", "Midi", "10:32", "Trône", "10:40", { transfer: [2, null] }),
  ]);
  assert.equal(checks[0].available_min, 2);
  assert.equal(checks[0].realtime, false);
  assert.equal(checks[0].level, "at_risk");
});

test("leave by: departure (with delay) minus walk time; door-to-door uses the source", () => {
  const j = journey([leg("train", "IC 1", "Midi", "17:00", "Gent-Sint-Pieters", "17:28", { depDelay: 4 })]);
  assert.equal(leaveBy(j, 10), new Date(at("16:54")).toISOString());
  assert.equal(leaveBy(j, null), null);
  assert.equal(leaveBy({ ...j, leave_by: at("16:40") }, 10), at("16:40"));
});

test("leave by after the trip's own departure is dropped", () => {
  const j = journey([leg("metro", "M6", "Trône", "17:19", "Midi", "17:27")], { leave_by: at("17:24") });
  assert.equal(leaveBy(j, null), null);
});

test("best option is the earliest arrival among working trips", () => {
  const journeys = analyzeJourneys([
    journey([leg("train", "A", "X", "10:00", "Y", "10:50")]),
    journey([leg("train", "B", "X", "10:05", "Y", "10:40")]),
  ]);
  assert.equal(journeys[0].analysis.recommended, false);
  assert.equal(journeys[1].analysis.recommended, true);
});
