import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeJourneys } from "../src/alerts.ts";
import { toJourneys, type MotisPlan } from "../src/transitous.ts";
import { applyRideRules, fastTripsOnly, improveTrips, refreshTrainLegs, type TrainStatus } from "../src/trip-fixes.ts";
import { cleanTrip } from "../src/live-journey.ts";

// Real Transitous answer: Trône → Gent Heuvelpoort (metro M6 to Gare du Midi, IC train, De Lijn bus).
const plan = JSON.parse(readFileSync(new URL("./fixtures/transitous-plan.json", import.meta.url), "utf8")) as MotisPlan;
const [trip] = toJourneys(plan);
const minutes = (a: string | null, b: string | null) => Math.round((Date.parse(b!) - Date.parse(a!)) / 60_000);
const plus = (iso: string | null, m: number) => new Date(Date.parse(iso!) + m * 60_000).toISOString();

test("metro Trône → Gare du Midi is at least 10 minutes, with a note", () => {
  const metro = trip.legs[0];
  assert.ok(minutes(metro.departure.scheduled, metro.arrival.scheduled) < 10); // the timetable says 6
  const fixed = applyRideRules(trip).legs[0];
  assert.equal(minutes(fixed.departure.scheduled, fixed.arrival.scheduled), 10);
  assert.match(fixed.note ?? "", /10 min/);
});

/** A live iRail answer for the train in the fixture, with a delay and platforms. */
function liveStatus(delay: number): TrainStatus {
  const t = trip.legs[1];
  const at = (iso: string | null, platform: string) => ({ scheduled: iso, expected: plus(iso, delay), delay_min: delay, realtime: true, platform: { scheduled: platform, actual: platform, changed: false } });
  return {
    vehicle_id: t.vehicle_id!,
    cancelled: false,
    stops: [
      // Names differ from Transitous ("Brussel-Zuid/Bruxelles-Midi"); positions are a few metres apart.
      { stop: { ...t.from, name: "Brussel-Zuid/Bruxelles-Midi", lat: t.from.lat + 0.0003 }, arrival: null, departure: at(t.departure.scheduled, "13"), cancelled: false },
      { stop: { ...t.to, name: "Gent-Sint-Pieters", lon: t.to.lon - 0.0003 }, arrival: at(t.arrival.scheduled, "12"), departure: null, cancelled: false },
    ],
  };
}

test("train legs get live delay and platforms from iRail, matched by position", async () => {
  const [j] = await improveTrips([trip], async () => liveStatus(6));
  const train = j.legs[1];
  assert.equal(train.departure.delay_min, 6);
  assert.equal(train.departure.platform?.actual, "13");
  assert.equal(train.arrival.platform?.actual, "12");
  assert.equal(train.departure.realtime, true);
  // The change after the train shrinks by the delay; arrival moves with it.
  const before = trip.legs[2].transfer_before!.scheduled_min;
  assert.equal(j.legs[2].transfer_before!.expected_min, before - 6);
  // "Arrive" = arrival of the last leg + the final walk.
  const last = j.legs[j.legs.length - 1];
  assert.equal(j.arrive_at, plus(last.arrival.expected ?? last.arrival.scheduled, j.walk_end_min ?? 0));
  assert.equal(minutes(train.arrival.expected, j.legs[2].departure.scheduled), j.legs[2].transfer_before!.expected_min);
});

test("a big train delay breaks the bus connection and the alert fires", async () => {
  const [j] = analyzeJourneys(await improveTrips([trip], async () => liveStatus(30)));
  assert.equal(j.analysis.level, "broken");
  assert.match(j.analysis.message ?? "", /Connection missed/);
});

test("if live train data is unavailable the trip stays as planned", async () => {
  const [j] = await improveTrips([trip], async () => {
    throw new Error("MCP down");
  });
  assert.equal(j.legs[1].departure.scheduled, trip.legs[1].departure.scheduled);
  assert.equal(j.legs[1].vehicle_id, trip.legs[1].vehicle_id);
});

test("journey screen: a trip sent by the app gets the train's new delay and platform", async () => {
  // What the lock screen said on 22 Oct: +3 min and platform 11 instead of 8.
  const moved = (): TrainStatus => {
    const s = liveStatus(3);
    s.stops[0].departure!.platform = { scheduled: "8", actual: "11", changed: true };
    return s;
  };
  const sent = cleanTrip(JSON.parse(JSON.stringify(trip)));
  const before = Date.parse(trip.legs[1].departure.scheduled!) - 10 * 60_000;
  const j = await refreshTrainLegs(sent, async () => moved(), before);
  const train = j.legs[1];
  assert.equal(train.departure.delay_min, 3);
  assert.equal(train.departure.expected, plus(trip.legs[1].departure.scheduled, 3));
  assert.deepEqual(train.departure.platform, { scheduled: "8", actual: "11", changed: true });
  assert.equal(j.legs[2].transfer_before!.expected_min, trip.legs[2].transfer_before!.scheduled_min - 3);
});

test("journey screen: trains already arrived aren't asked again, and failures keep the trip", async () => {
  const sent = cleanTrip(JSON.parse(JSON.stringify(trip)));
  let asked = 0;
  const after = Date.parse(trip.legs[1].arrival.scheduled!) + 60_000;
  await refreshTrainLegs(sent, async () => (asked++, liveStatus(3)), after);
  assert.equal(asked, 0);
  const j = await refreshTrainLegs(sent, async () => { throw new Error("MCP down"); }, 0);
  assert.equal(j.legs[1].departure.expected, sent.legs[1].departure.expected);
});

test("only trips close to the fastest one are kept, in order of leaving", () => {
  // 22 Oct-style case: Brussels-Luxembourg → Ghent, 74–86 min by train, plus 132 min by S-train + bus.
  const at = (leave: string, minutes: number) => ({ ...trip, leave_by: leave, arrive_at: plus(leave, minutes) });
  const fast = at("2026-10-28T09:09:00Z", 74);
  const later = at("2026-10-28T09:23:00Z", 84);
  const slow = at("2026-10-28T09:12:00Z", 132);
  const kept = fastTripsOnly([later, slow, fast]);
  assert.deepEqual(kept, [fast, later]);
  // Long trips get a bit more room (a quarter of the fastest time).
  assert.equal(fastTripsOnly([at("2026-10-28T08:00:00Z", 200), at("2026-10-28T08:10:00Z", 245)]).length, 2);
});
