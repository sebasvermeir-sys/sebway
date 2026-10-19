import { test } from "node:test";
import assert from "node:assert/strict";
import { HAIKU, pickModel, SONNET } from "../src/model-router.ts";

const ask = (q: string) => pickModel([{ role: "user", content: q }]);

test("short single lookups go to Haiku, in FR / NL / EN", () => {
  assert.equal(ask("Next metro at Trône?"), HAIKU);
  assert.equal(ask("Prochain train à Bruxelles-Midi ?"), HAIKU);
  assert.equal(ask("Volgende bus aan Heuvelpoort"), HAIKU);
  assert.equal(ask("Which platform for the 17:29 to Gent?"), HAIKU);
});

test("anything that needs reasoning goes to Sonnet", () => {
  assert.equal(ask("Any strikes this week?"), SONNET);
  assert.equal(ask("What's the best way from Trône to Heuvelpoort?"), SONNET);
  assert.equal(ask("Why is my train late?"), SONNET);
  assert.equal(ask("Hello"), SONNET);
  assert.equal(ask("Next train from Midi to Gent, and if it's late, which bus can I still catch at Sint-Pieters?"), SONNET);
});

test("follow-up questions always go to Sonnet", () => {
  assert.equal(
    pickModel([
      { role: "user", content: "Next metro at Trône?" },
      { role: "assistant", content: "M6 in 3 min." },
      { role: "user", content: "And the next train?" },
    ]),
    SONNET,
  );
});
