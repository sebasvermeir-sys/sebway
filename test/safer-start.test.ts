import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { neededMinutes } from "../src/alerts.ts";
import { toJourneys, type MotisPlan } from "../src/transitous.ts";
import { improveTrips, saferStarts } from "../src/trip-fixes.ts";
import type { Journey, Leg } from "../src/types.ts";

// Real Transitous answer: Trône → Gent Heuvelpoort (metro M6 to Gare du Midi, IC train, De Lijn bus).
const plan = JSON.parse(readFileSync(new URL("./fixtures/transitous-plan.json", import.meta.url), "utf8")) as MotisPlan;
const minutes = (a: string | null | undefined, b: string | null | undefined) => Math.round((Date.parse(b!) - Date.parse(a!)) / 60_000);
const plus = (iso: string | null | undefined, m: number) => (iso ? new Date(Date.parse(iso) + m * 60_000).toISOString() : null);
const shiftLeg = (l: Leg, m: number): Leg => ({
  ...l,
  departure: { ...l.departure, scheduled: plus(l.departure.scheduled, m), expected: plus(l.departure.expected, m) },
  arrival: { ...l.arrival, scheduled: plus(l.arrival.scheduled, m), expected: plus(l.arrival.expected, m) },
});

/** The fixture's first trip, with the metro moved so the change at Midi is `change` minutes. */
async function tripWithChange(change: number): Promise<Journey> {
  const [raw] = await improveTrips(toJourneys(plan).slice(0, 1), async () => null);
  const now = raw.legs[1].transfer_before!.scheduled_min!;
  const metro = shiftLeg(raw.legs[0], now - change);
  const [j] = await improveTrips([{ ...raw, legs: [metro, ...raw.legs.slice(1)], leave_by: plus(raw.leave_by, now - change)! }], async () => null);
  return j;
}

/** A fake planner: the same metro ride, `earlier` minutes before the tight one. */
const plannerFrom = (tight: Journey, earlier: number[]) => {
  const calls: string[] = [];
  const fn = async (_to: { name: string }, by: string) => {
    calls.push(by);
    return earlier.map((m) => ({ ...tight, legs: [shiftLeg(tight.legs[0], -m)], leave_by: plus(tight.leave_by, -m)!, walk_end_min: 0 }));
  };
  return { fn, calls };
};

test("a 1-minute metro → train change gets an earlier metro with a comfortable change", async () => {
  const tight = await tripWithChange(1);
  const { fn, calls } = plannerFrom(tight, [4, 8, 12]);
  const [safer] = await saferStarts([tight], fn, { needed: neededMinutes });
  assert.equal(calls.length, 1);
  // Comfort = 5 min (train ⇄ metro) + 3 = 8: the latest metro that gives ≥ 8 min is 8 min earlier.
  assert.equal(safer.safer_start?.change_min, 9);
  assert.equal(safer.safer_start?.original_change_min, 1);
  assert.equal(safer.safer_start?.earlier_min, 8);
  assert.equal(minutes(safer.leave_by, tight.leave_by), 8);
  // The train and everything after it are unchanged.
  assert.deepEqual(safer.legs.slice(1).map((l) => l.departure.scheduled), tight.legs.slice(1).map((l) => l.departure.scheduled));
  assert.equal(safer.arrive_at, tight.arrive_at);
});

test("a comfortable change is left alone, and no extra request is made", async () => {
  const fine = await tripWithChange(10);
  const { fn, calls } = plannerFrom(fine, [5]);
  const [same] = await saferStarts([fine], fn, { needed: neededMinutes });
  assert.equal(calls.length, 0);
  assert.equal(same, fine);
});

test("no safer start before the earliest allowed time (e.g. now), and never more than 20 min earlier", async () => {
  const tight = await tripWithChange(1);
  const tooSoon = await saferStarts([tight], plannerFrom(tight, [8]).fn, { needed: neededMinutes, earliest: Date.parse(tight.leave_by!) });
  assert.equal(tooSoon[0].safer_start, undefined);
  const tooEarly = await saferStarts([tight], plannerFrom(tight, [25]).fn, { needed: neededMinutes });
  assert.equal(tooEarly[0].safer_start, undefined);
});

test("a failing planner keeps the original trip", async () => {
  const tight = await tripWithChange(1);
  const [same] = await saferStarts([tight], async () => { throw new Error("down"); }, { needed: neededMinutes });
  assert.equal(same, tight);
});

// ---------- Less walking ----------
import { preferRides } from "../src/trip-fixes.ts";

test("a long final walk is swapped for a bus on the same train when it's not much later", async () => {
  const [base] = toJourneys(plan);
  const walking: Journey = { ...base, walk_end_min: 14 };
  const bus: Journey = { ...base, walk_end_min: 5, arrive_at: plus(base.arrive_at, 2)! };
  const [chosen] = preferRides([walking], [bus]);
  assert.equal(chosen.walk_end_min, 5);
  assert.deepEqual(chosen.less_walking, { saved_min: 9, later_min: 2 });
  // The bus is taken unless walking is 10+ min faster.
  assert.equal(preferRides([walking], [{ ...bus, arrive_at: plus(base.arrive_at, 9)! }])[0].walk_end_min, 5);
  assert.equal(preferRides([walking], [{ ...bus, arrive_at: plus(base.arrive_at, 10)! }])[0], walking);
  // A different train: keep walking.
  const otherTrain = { ...bus, legs: bus.legs.map((l) => (l.mode === "train" ? { ...l, vehicle_id: "IC 9999" } : l)) };
  assert.equal(preferRides([walking], [otherTrain])[0], walking);
  // Short walks are left alone.
  assert.equal(preferRides([bus], [walking])[0], bus);
});

test("tram and bus options are added next to train trips, in order of leaving, never before now", async () => {
  const { addNoRailOptions } = await import("../src/trip-fixes.ts");
  const [train] = toJourneys(plan);
  const local = (startMin: number): Journey => {
    const legs = [shiftLeg(train.legs[0], startMin)];
    return { ...train, legs, departure: legs[0].departure, arrival: legs[0].arrival, leave_by: plus(train.leave_by, startMin)! };
  };
  const now = Date.parse(train.leave_by!);
  const out = addNoRailOptions([train], [local(-5), local(3), local(6), local(9)], now);
  assert.equal(out.length, 3); // the trip that left 5 min ago is dropped, at most 2 are added
  assert.deepEqual(out.map((j) => Boolean(j.no_rail)), [false, true, true]);
  // Trips without trains already: nothing to add.
  assert.equal(addNoRailOptions([local(0)], [local(3)], now).length, 1);
});
