import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The update check compares the app's version with the service worker's cache name on the server.
test("APP_VERSION in app.js matches CACHE in sw.js", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
  const appVersion = Number(/const APP_VERSION = (\d+);/.exec(app)?.[1]);
  const swVersion = Number(/const CACHE = "sebway-v(\d+)";/.exec(sw)?.[1]);
  assert.ok(appVersion > 0);
  assert.equal(appVersion, swVersion, "bump both together");
});
