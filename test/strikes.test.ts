import { test } from "node:test";
import assert from "node:assert/strict";
import { brusselsMs, describeWindow, strikeActiveAt, strikeWindows, tagStrikes, windowsOnDay } from "../src/strikes.ts";
import type { Disruption, Journey } from "../src/types.ts";

const NOW = brusselsMs(2026, 10, 19, 15, 0); // Mon 19 Oct 2026, 15:00 Brussels (20 Oct is a Tuesday)
const strike = (title: string, description = "", operator: Disruption["operator"] = "sncb", extra: Partial<Disruption> = {}): Disruption =>
  ({ id: title, operator, type: "strike", severity: "major", title, description, lines: [], stops: [], valid_from: null, valid_until: null, url: null, ...extra }) as Disruption;
const at = (d: number, h = 12, m = 0) => brusselsMs(2026, 10, d, h, m);

test("French range with times: SNCB strikes run 22:00 → 22:00", () => {
  const d = strike("Grève nationale", "Préavis de grève du mardi 20 octobre à 22h au mercredi 21 octobre à 22h. Un service alternatif sera organisé.");
  const [w] = strikeWindows(d, NOW);
  assert.equal(w.start, at(20, 22));
  assert.equal(w.end, at(21, 22));
  assert.ok(strikeActiveAt(d, at(21, 8), NOW));
  assert.ok(!strikeActiveAt(d, at(20, 8), NOW)); // Tuesday morning trains still run
  assert.equal(describeWindow(w), "Tue 20 Oct 22:00 – Wed 21 Oct 22:00");
});

test("Dutch single day, and 'X en Y oktober' as two days", () => {
  const one = strike("Nationale staking op dinsdag 21 oktober");
  assert.deepEqual(windowsOnDay(one, "2026-10-21", NOW).length, 1);
  assert.equal(windowsOnDay(one, "2026-10-22", NOW).length, 0);
  const two = strike("Staking", "Het spoorpersoneel staakt op 22 en 23 oktober.");
  assert.equal(strikeWindows(two, NOW).length, 2);
  assert.ok(strikeActiveAt(two, at(23, 9), NOW));
});

test("English dates, French day range without month on the first day, and dd/mm", () => {
  assert.ok(strikeActiveAt(strike("Strike on October 21"), at(21), NOW));
  assert.ok(strikeActiveAt(strike("Strike on 21 October 2026"), at(21), NOW));
  const range = strike("Grève", "Perturbations du 26 au 28 octobre", "stib");
  assert.ok(strikeActiveAt(range, at(27), NOW));
  assert.ok(!strikeActiveAt(range, at(29), NOW));
  assert.ok(strikeActiveAt(strike("Grève le 21/10"), at(21), NOW));
});

test("no date in the text: use De Lijn's validity, else no guess", () => {
  const dl = strike("Staking", "Er wordt gestaakt.", "delijn", { valid_from: new Date(at(21, 4)).toISOString(), valid_until: new Date(at(21, 23)).toISOString() });
  assert.ok(strikeActiveAt(dl, at(21, 9), NOW));
  assert.equal(strikeWindows(strike("Grève annoncée", "Plus d'infos suivront."), NOW).length, 0);
  // Times like "9.05" are not dates.
  assert.equal(strikeWindows(strike("Retards", "Train de 9.05 supprimé"), NOW).length, 0);
});

test("a date in early January read in October is next year", () => {
  const [w] = strikeWindows(strike("Grève le 6 janvier"), NOW);
  assert.equal(new Date(w.start).getUTCFullYear(), 2027);
});

// ---------- trips ----------
function trip(depDay: number, depHour: number, ops: string[], level = "ok"): Journey & { analysis: { level: string; recommended: boolean } } {
  const iso = (d: number, h: number) => new Date(at(d, h)).toISOString();
  const t = (h: number) => ({ scheduled: iso(depDay, h), expected: null, delay_min: null, realtime: false, platform: null });
  return {
    departure: t(depHour), arrival: t(depHour + 1), duration_min: 60, transfers: ops.length - 1, cancelled: false, alerts: [],
    legs: ops.map((op) => ({ mode: op === "sncb" ? "train" : "bus", operator: op, line: null, vehicle_id: null, direction: null, from: { id: "a", name: "A", operator: op, lat: 0, lon: 0 }, to: { id: "b", name: "B", operator: op, lat: 0, lon: 0 }, departure: t(depHour), arrival: t(depHour + 1), cancelled: false, transfer_before: null })),
    leave_by: iso(depDay, depHour), arrive_at: iso(depDay, depHour + 1),
    analysis: { level, recommended: false },
  } as unknown as Journey & { analysis: { level: string; recommended: boolean } };
}

test("trips using the striking operator during the strike are tagged and go last; others become recommended", () => {
  const s = strike("Grève nationale", "du mardi 20 octobre à 22h au mercredi 21 octobre à 22h");
  const byTrain = trip(21, 8, ["stib", "sncb"]);
  const byBus = trip(21, 8, ["stib", "delijn"]);
  const out = tagStrikes([byTrain, byBus], () => [s], NOW);
  assert.equal(out[0].legs[1].operator, "delijn");
  assert.equal(out[0].analysis.recommended, true);
  assert.deepEqual(out[1].strike?.operators, ["sncb"]);
  assert.equal(out[1].analysis.recommended, false);
  // Before the strike starts (Tuesday morning): nothing tagged, order unchanged.
  const monday = tagStrikes([trip(20, 8, ["sncb"]), trip(20, 9, ["delijn"])], () => [s], NOW);
  assert.ok(monday.every((j) => !("strike" in j)));
});

// ---------- the evening before ----------
import { strikeTomorrow } from "../src/strikes.ts";

test("strike tomorrow: one heads-up in the early evening for routes using that operator", () => {
  const s = strike("Grève nationale", "du mardi 20 octobre à 22h au mercredi 21 octobre à 22h");
  const trainRoute = [{ mode: "train" }];
  // Tue 20 Oct 18:00: the strike starts tonight 22:00 and covers tomorrow.
  const [msg] = strikeTomorrow(trainRoute, [s, s], at(20, 18));
  assert.equal(msg.title, "Strike tomorrow: SNCB");
  assert.match(msg.body, /^Tue 20 Oct 22:00 – Wed 21 Oct 22:00\. Your saved trips use SNCB/);
  assert.equal(msg.key, `eve:${s.id}:2026-10-21`);
  assert.equal(strikeTomorrow(trainRoute, [s, s], at(20, 18)).length, 1); // the same strike twice → once
  // Not at lunchtime, not after it started, not without saved routes, not for an operator they don't use.
  assert.equal(strikeTomorrow(trainRoute, [s], at(20, 12)).length, 0);
  assert.equal(strikeTomorrow(trainRoute, [s], at(21, 18)).length, 0);
  assert.equal(strikeTomorrow([], [s], at(20, 18)).length, 0);
  const stib = strike("Grève STIB le 21 octobre", "", "stib");
  assert.equal(strikeTomorrow(trainRoute, [stib], at(20, 18)).length, 0);
  assert.equal(strikeTomorrow([{ mode: "commute" }], [stib], at(20, 18)).length, 1);
});
