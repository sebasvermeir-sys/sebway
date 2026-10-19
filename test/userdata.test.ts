import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitize } from "../src/userdata.ts";

test("places are kept with a label, emoji and coordinates; junk is dropped", () => {
  const out = sanitize({
    places: [
      { id: "home", label: "Home", emoji: "🏠", name: "Rue de la Loi 16, 1000 Brussels", lat: 50.846, lon: 4.366, evil: "<script>" },
      { label: "School", emoji: "<b>x</b>", name: "Gent-Sint-Pieters", lat: 999, lon: 4 },
    ],
  });
  assert.equal(out.places.length, 2);
  assert.deepEqual(out.places[0], { id: "home", label: "Home", emoji: "🏠", name: "Rue de la Loi 16, 1000 Brussels", lat: 50.846, lon: 4.366 });
  assert.equal(out.places[1].emoji, "📍"); // markup is not an emoji
  assert.equal(out.places[1].lat, undefined); // outside Belgium
  assert.throws(() => sanitize({ places: [{ label: "", name: "x" }] }));
  assert.throws(() => sanitize({ places: Array.from({ length: 9 }, () => ({ label: "a", name: "b" })) }));
});

test("routes keep their emoji and the auto flag with the places they come from", () => {
  const [r] = sanitize({ routes: [{ name: "Home → School", mode: "commute", from: "A", to: "B", emoji: "🎓", auto: true, from_place: "home", to_place: "school" }] }).routes;
  assert.equal(r.emoji, "🎓");
  assert.equal(r.auto, true);
  assert.equal(r.from_place, "home");
  const [plain] = sanitize({ routes: [{ name: "x", mode: "train", from: "A", to: "B", auto: "yes", emoji: "hello" }] }).routes;
  assert.equal(plain.auto, undefined);
  assert.equal(plain.emoji, undefined);
});
