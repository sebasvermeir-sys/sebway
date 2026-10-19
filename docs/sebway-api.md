# Belgian Transit MCP: Sebway integration (schema_version "1")

## Connection
- **URL:** `https://<your-mcp-worker>.workers.dev/mcp`
- **Transport:** MCP Streamable HTTP, stateless. A single `tools/call` POST works with no `initialize` and no session.
- **Auth:** `Authorization: Bearer <SEBWAY_TOKEN>`. This token gets **text + `structuredContent`**, and every tool declares an `outputSchema`. The chat token (`MCP_TOKEN`) gets text only, with no `outputSchema`.
- **Service Binding (same Cloudflare account):** in Sebway's `wrangler.jsonc`, add
  `"services": [{ "binding": "TRANSIT", "service": "belgian-transit-mcp" }]`
  and call `env.TRANSIT.fetch("https://transit/mcp", { method: "POST", headers: {...same headers...}, body })`. Still send the bearer token. This path is faster and never goes over the public internet.
- **Headers:** `Content-Type: application/json`, `Accept: application/json, text/event-stream`. The response is either JSON or one SSE `data:` line, so parse both.
- **Upstream timeout:** 8 s. **Caching:** 20–60 s per identical query, plus a 10 min stale copy served if a source fails (`meta.stale: true`). Polling every 5 min per saved route is fine.

```bash
curl -s https://<your-mcp-worker>.workers.dev/mcp \
  -H "Authorization: Bearer $SEBWAY_TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"plan_journey","arguments":{"from":"Bruxelles-Midi","to":"Gent-Sint-Pieters"}}}'
```

## Conventions
- **Times:** ISO 8601 with the Brussels offset (`2026-10-09T13:51:00+02:00`). A time object is `{ scheduled, expected, delay_min, realtime }`.
  - `realtime: false` means timetable only: `expected` and `delay_min` are `null`.
  - STIB gives only waiting times, so `scheduled` is `null` and `expected` is absolute.
- **Stop:** `{ id, name, operator, lat, lon }`.
  - Ids: SNCB `BE.NMBS.008814001`; STIB `stib:GARE DU MIDI` (all platforms of that name); De Lijn `delijn:2_201274_2_200274…` (all haltes of a place).
  - For grouped stops, `lat`/`lon` is the average of their platforms.
- **Platform:** `{ scheduled, actual, changed }`, or `null` when the operator has none (STIB, De Lijn). When a platform changed, iRail doesn't say what the original was, so `scheduled` is `null` and `changed` is `true`.
- **`meta`:** `{ schema_version: "1", source: "irail" | "stib" | "delijn" | "irail,stib,delijn", fetched_at, stale }`.
- **Unknown or extra fields:** ignore them. New fields may be added within schema_version 1; breaking changes will bump the version.

## Tools
| Tool | Structured shape | Notes |
|---|---|---|
| `find_stop` | `{ meta, stops[{ id, name, operator, lat, lon, names{fr,nl,en}, lines[] }] }` | `names.en` only for SNCB; `lines` only for STIB. Searches all 3 operators unless `operator` is given. |
| `departures` / `arrivals` | `{ meta, stop, to, departures[…], ended_lines[] }` | Flat list sorted by `expected` (`scheduled` if null). Each item: `operator, mode, line, direction, scheduled, expected, delay_min, realtime, platform, cancelled, vehicle_id, arrival_at_to`. SNCB `line` = type (`IC`), `vehicle_id` = `IC 1528`. De Lijn with `to` fills `arrival_at_to` and `to`. For `arrivals`, `direction` = origin. `ended_lines` = STIB lines serving the stop with no live departures now (night / service ended). |
| `plan_journey` (trains) | `{ meta, query{from,to,time,arrive_by}, journeys[] }` | Journey: `departure, arrival, duration_min, transfers, cancelled, legs[], alerts[]`. Leg: `mode, operator, line, vehicle_id, direction, from, to, departure{…platform}, arrival{…platform}, cancelled, transfer_before`. |
| `commute_check` | `{ meta, query{home,destination,direction,time}, journeys[], warnings[] }` | Same journey shape, legs `metro → train → bus` (`to_gent`) or `bus → train → metro` (`to_brussels`), plus `leave_by` (start walking) and `arrive_at` (walk included). Metro legs are live (`realtime: true`, `expected`) when checked within the hour; otherwise an estimate (`realtime: false`, `scheduled` = boarding time). |
| `train_status` | `{ meta, vehicle_id, origin, destination, cancelled, stops[{ stop, arrival, departure, cancelled, passed }] }` | `arrival` is null at the first stop, `departure` null at the last. |
| `disruptions` | `{ meta, total, disruptions[{ id, operator, type, severity, title, description, lines[], stops[], valid_from, valid_until, url }] }` | `type`: strike / works / incident / info; strike is detected from grève / staking / strike / préavis. `severity`: major (strike, or an interruption or cancellation in an incident) / minor / info. **`id` is stable** across calls. SNCB `valid_from` = publication time, `valid_until` null; STIB has no dates; De Lijn has both. |
| `composition` | `{ meta, vehicle_id, segments[{ origin, destination, cars, length_m, material_types, first_class_cars, bike_cars, seats_first, seats_second, toilet_cars }] }` | Low priority. |

### `transfer_before` (instead of a separate transfer object between legs)
Every leg after the first has `transfer_before: { at: stop, scheduled_min, expected_min }`, the time available to change before that leg. The first leg has `null`. A **negative `expected_min` means the connection is broken**: use it for missed-connection alerts.

## Errors
`isError: true`, the text error for the chat, and:
```json
{ "error": { "code": "STOP_AMBIGUOUS", "message": "…", "retryable": false, "candidates": [ {stop}, … ] } }
```
Codes: `STOP_AMBIGUOUS` (with `candidates`), `STOP_NOT_FOUND`, `NO_RESULTS`, `BAD_INPUT`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_TIMEOUT`. `retryable` is true for `UPSTREAM_*`, except when an API key is missing or rejected.

## Examples
`docs/sebway-examples.json` has one real response per tool, generated from recorded upstream data with `npm run examples`. Arrays are trimmed to 2 items.

## Guarantees (tests)
- `test/structured.test.ts`: every tool's `structuredContent` validates against its schema; all times are ISO with an offset; every stop has coordinates; the text is identical for both tokens; the chat token never gets `outputSchema`.
- `test/snapshot.test.ts`: the chat text output is locked by snapshot.
