import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeJourneys } from "../src/alerts.ts";
import { toJourneys, type MotisPlan } from "../src/transitous.ts";
import { applyRideRules, improveTrips, type TrainStatus } from "../src/trip-fixes.ts";

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
