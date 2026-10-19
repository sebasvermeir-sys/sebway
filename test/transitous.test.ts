import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeJourneys } from "../src/alerts.ts";
import { brusselsToIso, decodePolyline, operatorOf, toJourneys, toPlaces, type MotisPlan } from "../src/transitous.ts";

// A real Transitous answer for Trône (Brussels) → Gent Heuvelpoort, recorded 14 Oct 2026.
const plan = JSON.parse(readFileSync(new URL("./fixtures/transitous-plan.json", import.meta.url), "utf8")) as MotisPlan;

test("a door-to-door trip becomes metro → train → bus with walks folded into the changes", () => {
  const [j] = toJourneys(plan);
  assert.deepEqual(j.legs.map((l) => l.mode), ["metro", "train", "bus"]);
  assert.deepEqual(j.legs.map((l) => l.operator), ["stib", "sncb", "delijn"]);
  assert.equal(j.legs[0].line, "M6");
  assert.equal(j.legs[0].direction, "Roi Baudouin"); // tidied from "ROI BAUDOUIN"
  assert.equal(j.legs[1].line, "IC");
  assert.match(j.legs[1].vehicle_id ?? "", /^IC \d+$/);
  assert.match(j.legs[2].line ?? "", /^B\d+$/); // De Lijn bus, labelled like the rest of the app
  assert.equal(j.transfers, 2);
  // Walking: to the first stop, between Gare du Midi (metro) and Bruxelles-Midi (train), and at the end.
  assert.equal(j.walk_start_min, 6);
  assert.equal(j.legs[1].transfer_before?.walk_min, 5);
  assert.equal(j.legs[1].transfer_before?.at.name, "Bruxelles-Midi");
  assert.ok((j.walk_end_min ?? 0) > 0);
  // Leave by = when the walk starts; arrive = after the last walk.
  assert.equal(j.leave_by, plan.itineraries[0].startTime);
  assert.equal(j.arrive_at, plan.itineraries[0].endTime);
  // Live data flags come through: the train is live, the metro is timetable only.
  assert.equal(j.legs[1].departure.realtime, true);
  assert.equal(j.legs[0].departure.realtime, false);
  // Every leg has a map shape near Belgium (sent encoded, decoded on the phone).
  for (const l of j.legs) {
    assert.ok(l.path_enc);
    const pts = decodePolyline(l.path_enc.points, l.path_enc.precision);
    assert.ok(pts.length > 1);
    for (const [lat, lon] of pts) assert.ok(lat > 49.4 && lat < 51.6 && lon > 2.5 && lon < 6.5);
  }
});

test("the connection check counts the walk between stops", () => {
  const analyzed = analyzeJourneys(toJourneys(plan));
  const midi = analyzed[0].analysis.transfers.find((t) => t.at.startsWith("Bruxelles-Midi"));
  assert.ok(midi);
  assert.ok(midi.needed_min >= 5);
});

test("operators are recognised from Transitous agency names", () => {
  assert.equal(operatorOf("NMBS/SNCB"), "sncb");
  assert.equal(operatorOf("STIB"), "stib");
  assert.equal(operatorOf("De Lijn"), "delijn");
  assert.equal(operatorOf("TEC"), "tec");
  assert.equal(operatorOf("LETEC tec"), "tec");
  assert.equal(operatorOf("Flixbus"), "other");
});

test("Brussels local time becomes the right UTC time in summer and winter", () => {
  assert.equal(brusselsToIso("2026-10-14", "07:30"), "2026-10-14T05:30:00.000Z"); // CEST, UTC+2
  assert.equal(brusselsToIso("2026-11-14", "07:30"), "2026-11-14T06:30:00.000Z"); // CET, UTC+1
});

test("polylines decode (precision 5 reference example)", () => {
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5), [
    [38.5, -120.2],
    [40.7, -120.95],
    [43.252, -126.453],
  ]);
});

test("address search keeps Belgian results only, with short labels and no duplicates", () => {
  const places = toPlaces([
    { type: "ADDRESS", name: "Rue de Bruxelles 16", lat: 48.1, lon: -0.7, country: "FR", zip: "53000" },
    { type: "ADDRESS", name: "Rue de la Loi - Wetstraat 16", lat: 50.846, lon: 4.367, country: "BE", zip: "1000", areas: [{ name: "Brussels", default: true }] },
    { type: "ADDRESS", name: "Rue de la Loi - Wetstraat 16", lat: 50.846, lon: 4.367, country: "BE", zip: "1000", areas: [{ name: "Brussels", default: true }] },
    { type: "PLACE", name: "Atomium", lat: 50.89, lon: 4.34, country: "BE", zip: "1020", areas: [{ name: "Brussels", default: true }] },
    { type: "STOP", name: "Gent Gravensteen (Geldmunt)", lat: 51.057, lon: 3.721, country: "BE" },
  ]);
  assert.deepEqual(
    places.map((p) => [p.kind, p.label]),
    [
      ["address", "Rue de la Loi - Wetstraat 16, 1000 Brussels"],
      ["place", "Atomium, 1020 Brussels"],
      ["stop", "Gent Gravensteen (Geldmunt)"],
    ],
  );
});
