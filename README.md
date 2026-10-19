# Sebway

**Belgian public transport in one app: SNCB, STIB, De Lijn and TEC.** Live delays and platforms,
door-to-door trips anywhere in Belgium, missed-connection warnings and strike alerts.
A free, installable web app (PWA) for phone and computer. Live at **[sebway.app](https://sebway.app)**.

> A student project, not affiliated with SNCB/NMBS, STIB-MIVB, De Lijn or TEC.

## What it does
- **Plan trips** station to station (SNCB) or door to door: any address, place or stop in Belgium.
- **Live data**: delays, platforms (shown like real station signs), cancellations.
- **Connections that work**: warns when a change is too tight, suggests leaving a bit earlier,
  prefers a bus over a long walk.
- **Strike days**: reads the dates out of strike notices, marks trips that may not run, offers
  trips without trains, and pushes "Strike tomorrow" the evening before.
- **Start Journey**: step-by-step tracking, lock-screen notifications for each step, delay and
  platform change, and a new plan when a connection is missed. Share a live link with someone.
- **My places**: tiles for Home, Studies, Gym… Tap one to plan a trip there from where you are.
- **Departure boards**, **passes** with renewal reminders, and an optional **chat assistant**
  (bring your own Claude API key; it only uses real timetable data).

## How it works
One [Cloudflare Worker](https://developers.cloudflare.com/workers/) serves the app (`public/`) and a
small API (`src/`). Transit data comes from a separate MCP server (Belgian Transit MCP, private) that
wraps the official sources. Door-to-door routes come from [Transitous](https://transitous.org).
Plain code makes every decision about times, delays and connections; the AI is only used for the chat.

```
public/            the app (HTML, CSS, JavaScript; no build step)
src/               Worker: API, trip fixes, strikes, push notifications, live journeys
test/              unit tests (Node runs the TypeScript directly)
docs/              API contract with the transit server + example responses
moved/             tiny Worker for the old address ("Sebway has moved")
```

## Data sources and credits
- **SNCB/NMBS** live data via [iRail](https://api.irail.be)
- **STIB-MIVB** and **De Lijn** open data
- **Door-to-door routes** by [Transitous](https://transitous.org/sources/), built on the open
  timetables of SNCB, STIB, De Lijn and TEC
- **Maps** © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, drawn with [Leaflet](https://leafletjs.com)
- **Operator logos** are trademarks of their owners, shown only to identify a pass. Files from
  Wikimedia Commons (TEC logo: [CC BY-SA 4.0](https://commons.wikimedia.org/wiki/File:LETEC.svg)).

## Privacy
No accounts. Each phone gets a random ID. The server keeps only what you choose to save (places,
routes, boards, passes, your notification subscription, and a running journey until an hour after
arrival). Your location and chat stay on your phone; your Claude key is passed to Claude for each
message and never stored. **Delete My Data** in Settings removes everything.

## Run it yourself
You need a Cloudflare account and a transit MCP server that speaks the contract in
[`docs/sebway-api.md`](docs/sebway-api.md) (the original one is private).

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in your own values (never commit this file)
npm run dev                      # http://localhost:8787
npm test                         # unit tests
npm run check                    # typecheck
```
Update `wrangler.jsonc` (service binding, KV namespace, VAPID public key, custom domain) for your
own account before `npm run deploy`. Secrets go in with `npx wrangler secret put`.

## License
[MIT](LICENSE), except the operator logos (see above).
