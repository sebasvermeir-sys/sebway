import { test } from "node:test";
import assert from "node:assert/strict";
import { isNationalStrike, isPushWorthy, isQuietHours, passDaysLeft, passReminderDue, routeQueries } from "../src/notify-rules.ts";
import type { Disruption } from "../src/types.ts";
import type { Pass } from "../src/userdata.ts";

// 14 Oct 2026 is in summer time: Brussels = UTC+2.
const brussels = (hm: string, day = "2026-10-14") => new Date(`${day}T${hm}:00+02:00`);

test("quiet hours are 23:00–06:59 in Brussels", () => {
  assert.equal(isQuietHours(brussels("22:59")), false);
  assert.equal(isQuietHours(brussels("23:00")), true);
  assert.equal(isQuietHours(brussels("03:00")), true);
  assert.equal(isQuietHours(brussels("06:59")), true);
  assert.equal(isQuietHours(brussels("07:00")), false);
});

test("pass days left count Brussels dates, not UTC", () => {
  // 00:30 Brussels on the 15th is still the 14th in UTC.
  assert.equal(passDaysLeft("2026-10-20", brussels("00:30", "2026-10-15")), 5);
  assert.equal(passDaysLeft("2026-10-14", brussels("12:00")), 0);
  assert.equal(passDaysLeft("2026-10-13", brussels("12:00")), -1);
});

test("pass reminders fire on the chosen day, then 3, 1 and 0 days before", () => {
  const p: Pass = { id: "p", name: "Pass", operator: "sncb", valid_until: "2026-10-21", remind_days: 7 };
  assert.equal(passReminderDue(p, brussels("12:00")), 7); // 14 → 21 = 7 days
  assert.equal(passReminderDue(p, brussels("12:00", "2026-10-15")), null);
  assert.equal(passReminderDue(p, brussels("12:00", "2026-10-18")), 3);
  assert.equal(passReminderDue(p, brussels("12:00", "2026-10-20")), 1);
  assert.equal(passReminderDue(p, brussels("12:00", "2026-10-21")), 0);
  assert.equal(passReminderDue(p, brussels("12:00", "2026-10-22")), null);
});

test("door-to-door routes check SNCB at both ends plus the STIB and De Lijn stops", () => {
  const q = routeQueries({ id: "r", name: "Commute", mode: "commute", from: "Trône", to: "Heuvelpoort" });
  assert.deepEqual(q, [{ station: "Bruxelles-Midi" }, { station: "Gent-Sint-Pieters" }, { station: "Trône", operator: "stib" }, { station: "Heuvelpoort" }]);
});

test("only strikes and major disruptions are pushed", () => {
  const d = (type: Disruption["type"], severity: Disruption["severity"]) => ({ type, severity }) as Disruption;
  assert.equal(isPushWorthy(d("strike", "minor")), true);
  assert.equal(isPushWorthy(d("incident", "major")), true);
  assert.equal(isPushWorthy(d("incident", "minor")), false);
  assert.equal(isPushWorthy(d("works", "info")), false);
});

test("national strikes are recognised in FR, NL and EN; local ones are not", () => {
  const strike = (title: string, description = "") => ({ type: "strike", severity: "major", title, description }) as Disruption;
  assert.equal(isNationalStrike(strike("Grève nationale", "Préavis de grève nationale sur tout le réseau")), true);
  assert.equal(isNationalStrike(strike("Nationale staking", "Landelijke staking bij het spoor")), true);
  assert.equal(isNationalStrike(strike("National strike", "Nationwide rail strike")), true);
  assert.equal(isNationalStrike(strike("Visé / Wezet - Maastricht (NL): No trains", "Cause : strike on the Dutch rail network")), false);
  assert.equal(isNationalStrike({ ...strike("National"), type: "incident" } as Disruption), false);
});
