# Sebway

Belgian commuter PWA (SNCB · STIB · De Lijn), installable on phone and PC. School capstone: Evidence Audit Thu 22 or Fri 23 Oct 2026 (group slot), capstone bundle deadline Fri 30 Oct 2026, 23:59.

## Architecture
- One Cloudflare Worker (`sebway`, at **https://sebway.app**, custom domain) serves the app from `public/` and the API on `/api/*` (`src/index.ts`). The old workers.dev address is a separate tiny Worker (`moved/`, deploy with `npx wrangler deploy -c moved/wrangler.jsonc`): a "Sebway has moved" page whose button passes the device id (+ name, theme) in the URL #fragment; the app adopts it on load (`movedIn`). No crons there.
- Door to door anywhere in Belgium: `/api/trip` plans with Transitous (`src/transitous.ts`, MOTIS 2 API) and converts trips to the same journey format, so alerts, leave-by, disruption checks and the map apply. Transitous rules: non-commercial, light use (30 s cache, never from the cron), identifying User-Agent, visible link to transitous.org/sources, and the code must be published open source.
- Transit data comes from the Belgian Transit MCP via the `TRANSIT` service binding, called with `SEBWAY_TOKEN` to get `structuredContent` JSON. Contract: `docs/sebway-api.md`, examples: `docs/sebway-examples.json`, types: `src/types.ts`. Personal notes (launch guide, demo script, trip log) live in `notes/`, which is git-ignored and never published.
- Claude API is for chat only, billed to the user's own key. `src/model-router.ts` sends short first-turn lookups to Haiku 5.5 (effort low) and everything else to Sonnet 5.5 (effort medium); Haiku failures retry on Sonnet.
- Trips are checked for disruptions at every station (start, transfers, end) plus national strikes (`src/route-disruptions.ts`); cards say a disruption *involves a station on the trip*, never that the train is certainly affected.

## Rules
- Times, delays and platforms shown to the user come from MCP data, never from the model.
- Missed-connection alerts and "leave by" are plain code, not AI. Broken connection = `transfer_before.expected_min` below the margin (train→metro at Midi 5 min, train→bus 3 min).
- Always show the data source and `fetched_at`; flag `meta.stale`.
- Bring your own Claude key: there is no server-side Claude key. Each user enters their key in Settings; it lives only on their device and is sent as `X-Claude-Key` on chat requests. The Worker uses it for that request only: never store, log or echo it.
- Saved routes, boards, passes and walk time live per device in KV (`DATA`, key `device:<uuid>`, `src/userdata.ts`), validated on PUT /api/me. The device id is a random UUID from the app; no accounts.
- Push: Web Push via VAPID + aes128gcm in `src/push.ts` (RFC 8291 known-answer test). Subscriptions in KV `push:<uuid>`. Cron every 5 min (`src/notify.ts`, rules in `src/notify-rules.ts`) pushes only strikes/major disruptions on saved routes and pass reminders; quiet 23:00–07:00; dedupe via `sent`.
- Live journey on the lock screen: Start Journey PUTs the trip to `/api/live-journey` (KV `live:<uuid>`, TTL until 1 h after arrival); a second cron every minute (`runLiveJourneys` in `src/notify.ts`, steps in `src/live-journey.ts`) pushes one card per step with tag `journey` (leave, board, get off, arrived), refreshing train delay/platform via `train_status`. No quiet hours (user-started).
- Door to door "safer start": a change before the first train below min + 3 min gets the part before the train replanned (light Transitous request, `saferStarts` in `src/trip-fixes.ts`). The account is on Workers Paid, so ~20 ms CPU per trip search is fine.
- Door to door "less walking": a start/end walk ≥ 10 min triggers a second Transitous request with walks capped at 8 min; the bus version on the same main ride replaces it unless walking arrives ≥ 10 min earlier (`preferRides`).
- Door to door results keep only trips close to the fastest one (≤ fastest + max(20 min, 25%); `fastTripsOnly` in `src/trip-fixes.ts`), sorted by leaving time then arrival: the planner also returns much slower trips with fewer changes, which the user doesn't want. Otherwise they are the planner's own list, nothing added or mixed in (the user rejected both "Other ways" and a "Show Trips Without Trains" section). Transitous v1 calls S-trains `METRO`: mapped to train; anything SNCB runs is a train.
- Strikes (`src/strikes.ts`): the strike's dates/times are read from the notice text (FR/NL/EN, ranges like "du mardi 20 octobre à 22h au mercredi 21"), else De Lijn's valid_from/until; no date found → no guess. Trips using a striking operator during the strike get `strike` ("may not run") and go last (`tagStrikes` in `attachRouteDisruptions`). The 5-min cron sends "Strike tomorrow" between 17:00 and 22:00 for operators on saved routes (`strikeTomorrow`, dedupe `eve:<id>:<date>`). `/api/trip?avoid=rail` plans without trains.
- Identity: platforms are station signs (`platformHtml`: navy square, word by language area from the stop's position: Spoor/Voie/Gleis, Perron/Quai for bus bays, alternating in Brussels). Home is a personal dashboard: greeting with the name from the tutorial (local only, `userName`) and **My places** tiles (`userData.places`: emoji, name, address/stop; stock labels Home/Studies/Work/Gym or custom). The ＋ tile opens a sheet with stop/address search; tapping a tile opens a trip sheet (from: where I am via GPS, another tile, or typed; when: now, +15/+30/+60 min, or a picked time leave/arrive) that fills the planner and searches. Edit mode: drag, change, delete. Pinned routes (☆ Save Route, with the way back) show as chips under the tiles. The app still keeps hidden auto routes Home ⇄ each place (`syncAutoRoutes`, `auto: true`) for disruption/strike alerts. Strikes use the red triangle (`RED_TRIANGLE`).
- Missed-connection recovery: journey screen replans from GPS or the next vehicle's stop (`recoverJourney`) on "I Missed It", on fresh times showing a broken change/cancellation, on GPS "missed", or when opened from the server's "connection at risk" push (`brokenConnection` in `src/live-journey.ts`, url `?recover=1`). Only plans you can still make; Switch keeps lock-screen updates and shared links. Automatic suggestions are rare on purpose: live data only (a timetable-tight change doesn't count), GPS only with a fresh (<90 s), precise (≤100 m) fix held for 2 min (underground the last fix is stale), at most once per journey (`autoOffered`), and "Keep Current Plan" mutes them for that journey (`recoverMuted`, persisted). "I Missed It" always works.
- Transit endpoints are open but rate-limited per device (`API_LIMIT`), chat by `CHAT_LIMIT`.
- Secrets live in `.dev.vars` (local) and `wrangler secret put` (prod), never in code or chat. Prod has only `SEBWAY_TOKEN`; `ANTHROPIC_API_KEY` in `.dev.vars` is for local tests only.

## Design (Apple HIG)
- Text sizes only via the `--t-*` tokens in `public/styles.css` (HIG iOS text styles, rem of Body 17 pt); the root follows Dynamic Type (`font: -apple-system-body`).
- Tap targets ≥ 44×44 pt (`--hit`), ~12 pt between buttons (`--gap`), contrast ≥ 4.5:1 (3:1 for bold/18 pt+) in light and dark.
- Layouts must survive 200% text: no fixed px columns, let text wrap, rows stack via the container query at the end of the stylesheet.
- Buttons: title case, a pressed state, and destructive actions confirm first.

## Service worker (public/sw.js)
- Must never leave the Home Screen app blank (iOS shows a blank screen when a page load fails): pass navigation requests unchanged (`fetch(event.request)`, so Wi-Fi login/filter redirects work), save only `200`/basic/non-redirected answers, save the shell file by file, fall back to the saved app after 3 s or on failure (page and app files alike; a Wi-Fi login/filter answer instead of a file also uses the saved copy), else the built-in "can't connect" page. Nothing third-party may block the first paint: the Inter font is added from `app.js`, not the page head. Bump `CACHE` on every app change, together with `APP_VERSION` in `public/app.js` (a unit test checks they match): that number drives the in-app update check (Settings → App: Check for Updates / Update Now / Repair App, plus a banner when a newer version is live).

## Git and publishing
- Public repo: https://github.com/sebasvermeir-sys/sebway (MIT). Push **only `main`** (`git push origin main`). Never `git push --all` or `--tags`: the local branch `private-history` (full old history with personal details) and local tags must never be uploaded.
- Commits are signed `sebasvermeir-sys <283285302+sebasvermeir-sys@users.noreply.github.com>` (repo git config). Before pushing, keep out: secrets, the MCP's address, personal notes (`notes/` is git-ignored), the user's school or personal addresses.

## Commands
- `npm run dev`: local dev at http://localhost:8787 (uses the deployed MCP via a remote binding)
- `npm run check`: typecheck
- `npm run smoke`: health check of the live app (all endpoints, real data)
- `npm test`: unit tests (Node runs the TypeScript directly)
- Trigger the cron locally: run dev with `--test-scheduled`, then GET `/__scheduled?cron=*/5+*+*+*+*`
- `npm run types`: regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc`
- `npm run deploy`: deploy
