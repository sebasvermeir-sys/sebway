import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toJourneys, type MotisPlan } from "../src/transitous.ts";
import { cleanTrip, dueStep, liveSteps, startMessage, STALE_MS, trainChangeMessage, trainState } from "../src/live-journey.ts";
import type { Leg } from "../src/types.ts";

// Real Transitous answer: Trône → Gent Heuvelpoort (metro M6 to Gare du Midi, IC train, De Lijn bus).
const plan = JSON.parse(readFileSync(new URL("./fixtures/transitous-plan.json", import.meta.url), "utf8")) as MotisPlan;
const [trip] = toJourneys(plan);
const steps = liveSteps(trip, "Home");
const at = (key: string) => steps.find((s) => s.key === key)!;

test("a trip becomes lock-screen steps in time order: leave, board, get off, arrived", () => {
  const keys = steps.map((s) => s.key);
  assert.equal(keys[0], trip.walk_start_min ? "leave" : "board-0");
  assert.equal(keys.at(-1), "arrived");
  for (let i = 0; i < trip.legs.length; i++) assert.ok(keys.includes(`board-${i}`));
  assert.deepEqual([...steps].sort((a, b) => a.at - b.at), steps);
  // Boarding 3 min before departure; the train card names the train and its destination.
  const train = trip.legs.findIndex((l) => l.mode === "train");
  assert.equal(at(`board-${train}`).at, Date.parse(trip.legs[train].departure.scheduled!) - 3 * 60_000);
  assert.match(at(`board-${train}`).title, /^Train /);
  // Getting off before a change tells you the next vehicle.
  assert.match(at(`off-${train}`).body, /^Then Bus /);
});

test("only the current step is pushed; missed older ones are skipped, stale ones dropped", () => {
  const board1 = at("board-1");
  const r = dueStep(steps, [], board1.at + 30_000);
  assert.equal(r.step?.key, "board-1");
  assert.ok(r.skipped.includes("board-0"));
  assert.equal(dueStep(steps, ["board-0", "board-1", ...r.skipped], board1.at + 60_000).step, null);
  const late = dueStep(steps, [], board1.at + STALE_MS + 60_000);
  assert.notEqual(late.step?.key, "board-1");
  assert.equal(dueStep(steps, [], steps[0].at - 60_000).step, null);
});

test("the start card gives the arrival and the next step", () => {
  const msg = startMessage(trip, "Home", steps[0].at - 10 * 60_000);
  assert.match(msg.title, /^To Home · arrive \d\d:\d\d$/);
  assert.match(msg.body, /^Next: /);
});

test("a trip from the app is reduced to known fields and rejected when unusable", () => {
  const clean = cleanTrip(JSON.parse(JSON.stringify({ ...trip, extra: "x".repeat(100), legs: trip.legs.map((l) => ({ ...l, mode: l.mode, evil: "<script>" })) })));
  assert.equal(clean.legs.length, trip.legs.length);
  assert.equal((clean as unknown as Record<string, unknown>).extra, undefined);
  assert.equal((clean.legs[0] as unknown as Record<string, unknown>).evil, undefined);
  assert.deepEqual(liveSteps(clean, "Home").map((s) => s.key), steps.map((s) => s.key));
  assert.throws(() => cleanTrip({ legs: [] }));
  assert.throws(() => cleanTrip({ legs: [{ mode: "bus" }] }));
});

/** The fixture's train with a live delay (and optionally a platform), as the cron would see it. */
function delayed(delay: number, platform = "8", cancelled = false): Leg {
  const leg = trip.legs.find((l) => l.mode === "train")!;
  const plus = (iso: string | null) => (iso ? new Date(Date.parse(iso) + delay * 60_000).toISOString() : null);
  const p = { scheduled: "8", actual: platform, changed: platform !== "8" };
  return {
    ...leg,
    cancelled,
    departure: { ...leg.departure, expected: plus(leg.departure.scheduled), delay_min: delay, realtime: true, platform: p },
    arrival: { ...leg.arrival, expected: plus(leg.arrival.scheduled), delay_min: delay, realtime: true },
  };
}

test("a train delay of 2+ min, a platform change or a cancellation gives a card; small changes don't", () => {
  const start = trainState(delayed(0));
  assert.equal(trainChangeMessage(start, delayed(1), undefined), null);
  const late = trainChangeMessage(start, delayed(6), undefined)!;
  assert.match(late.title, /now \+6 min$/);
  assert.match(late.body, /instead of/);
  assert.match(trainChangeMessage(trainState(delayed(6)), delayed(0), undefined)!.title, /back on time/);
  const moved = trainChangeMessage(start, delayed(0, "11"), undefined)!;
  assert.match(moved.title, /platform 11/);
  assert.match(moved.body, /now 11 \(was 8\)/);
  assert.match(trainChangeMessage(start, delayed(0, "8", true), undefined)!.title, /cancelled/);
});

test("a delay that eats the next change says the connection may be missed", () => {
  const train = trip.legs.findIndex((l) => l.mode === "train");
  const next = { ...trip.legs[train + 1], transfer_before: { ...trip.legs[train + 1].transfer_before!, expected_min: 1 } };
  assert.match(trainChangeMessage(trainState(delayed(0)), delayed(5), next)!.body, /may be missed/);
});

// ---------- missed connections ----------
import { brokenConnection } from "../src/live-journey.ts";
import { neededMinutes } from "../src/alerts.ts";
import { recomputeTimes } from "../src/trip-fixes.ts";

test("a late train that breaks the next change gives one 'new plan' push; on time gives none", () => {
  const t = trip.legs.findIndex((l) => l.mode === "train");
  const before = Date.parse(trip.legs[0].departure.scheduled!) - 60_000;
  assert.equal(brokenConnection(recomputeTimes({ ...trip, legs: trip.legs.map((l, i) => (i === t ? delayed(0) : l)) }), neededMinutes, before), null);
  const late = recomputeTimes({ ...trip, legs: trip.legs.map((l, i) => (i === t ? delayed(30) : l)) });
  const miss = brokenConnection(late, neededMinutes, before)!;
  assert.match(miss.title, /^⚠️ Connection at .+ at risk$/);
  assert.match(miss.body, /\(\+30 min\).*Tap for a new plan\.$/);
  assert.match(miss.key, /^miss-\d+-/);
});
