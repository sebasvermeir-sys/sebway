import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExactCandidate } from "../src/mcp.ts";
import type { Stop } from "../src/types.ts";

const trone: Stop = { id: "stib:TRONE", name: "Trone / Troon", operator: "stib", lat: 50.84, lon: 4.36 };

test("an 'ambiguous' stop whose only candidate is itself is retried with the id", () => {
  assert.deepEqual(resolveExactCandidate({ home: "Trone / Troon", destination: "Gent Heuvelpoort" }, [trone]), {
    home: "stib:TRONE",
    destination: "Gent Heuvelpoort",
  });
  // Accents and case don't matter.
  assert.deepEqual(resolveExactCandidate({ stop: "trône / troon" }, [trone]), { stop: "stib:TRONE" });
});

test("a truly ambiguous name is left for the user to choose", () => {
  const berchem: Stop = { id: "BE.NMBS.008821121", name: "Antwerpen-Berchem", operator: "sncb", lat: 51.2, lon: 4.43 };
  const centraal: Stop = { id: "BE.NMBS.008821006", name: "Antwerpen-Centraal", operator: "sncb", lat: 51.22, lon: 4.42 };
  assert.equal(resolveExactCandidate({ stop: "Antwerpen" }, [berchem, centraal]), null);
});
