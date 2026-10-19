// Transit tools offered to Claude in chat. MCP tools are copied from its tools/list (keep in sync);
// plan_door_to_door runs in Sebway itself (Transitous).
// Order and content must stay stable: they are part of the cached prompt prefix.
import type Anthropic from "@anthropic-ai/sdk";

const operator = { type: "string", enum: ["sncb", "stib", "delijn"] } as const;
const time = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Local Brussels time HH:mm (default now)" } as const;
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD (default today)" } as const;
const trainId = { type: "string", minLength: 2, description: 'Train id, e.g. "IC 1517", "IC1517", "S1 1978"' } as const;
const boardProps = {
  stop: { type: "string", minLength: 1, description: "Station/stop name, nickname or id" },
  operator: { ...operator, description: 'Force trains ("sncb"), Brussels metro/tram/bus ("stib") or Flemish bus/tram ("delijn")' },
  to: { type: "string", description: 'De Lijn only: keep buses/trams that later stop here and show arrival time, e.g. stop "Gent Sint-Pietersstation", to "Heuvelpoort"' },
  time,
  date,
  limit: { type: "integer", minimum: 1, maximum: 30, default: 10 },
  filter: {
    type: "object",
    properties: {
      destination: { type: "string", description: "Final destination (departures) / origin (arrivals) contains this" },
      line: { type: "string", description: 'Train type or id ("IC", "S1", "IC 1517"), STIB line ("95", "M2", "T81") or De Lijn line ("T1", "555", "9b")' },
    },
  },
} as const;

export const TRANSIT_TOOLS: Anthropic.Tool[] = [
  {
    name: "find_stop",
    description: "Find stations/stops by name (FR/NL/EN, nicknames, typos ok). Returns ids usable in other tools.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: 'e.g. "midi", "Brussel-Zuid", "Gent St Pieters"' },
        operator: { ...operator, description: "Restrict to one operator" },
      },
      required: ["query"],
    },
  },
  {
    name: "departures",
    description:
      "Departures at a train station (SNCB: delays, platforms, cancellations), a STIB stop (live waiting times, now only) or a De Lijn stop (live delays; timetable when time/date given). For a specific A→B train use plan_journey.",
    input_schema: { type: "object", properties: boardProps, required: ["stop"] },
  },
  {
    name: "arrivals",
    description: "Live arrival board for a train station (SNCB only: delays, platforms, cancellations).",
    input_schema: { type: "object", properties: boardProps, required: ["stop"] },
  },
  {
    name: "plan_journey",
    description:
      "Train connections A→B (SNCB) with delays, platforms, transfers and alerts. Best tool for 'is my 07:29 from A to B on time / which platform'.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", minLength: 1 },
        to: { type: "string", minLength: 1 },
        time,
        date,
        arrive_by: { type: "boolean", default: false, description: "Treat time as arrival deadline" },
        results: { type: "integer", minimum: 1, maximum: 6, default: 4 },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "train_status",
    description: "Live status of one train: every stop with time, delay, platform; ✓ = already passed.",
    input_schema: { type: "object", properties: { train_id: trainId, date }, required: ["train_id"] },
  },
  {
    name: "disruptions",
    description:
      'Incidents, detours and planned works. SNCB by default; STIB when operator is "stib", a STIB line is given, or the station is a STIB stop; De Lijn when the station is a De Lijn stop. Incidents listed first.',
    input_schema: {
      type: "object",
      properties: {
        station: { type: "string", description: "Only disruptions mentioning/affecting this station or stop" },
        operator,
        line: { type: "string", description: 'STIB line ("95", "M2", "T51"), or De Lijn line together with a De Lijn station' },
        type: { type: "string", enum: ["incident", "planned", "all"], default: "all" },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 8 },
      },
    },
  },
  {
    name: "composition",
    description: "Carriages of a train: length, 1st-class position, seats, toilets, bike spaces.",
    input_schema: { type: "object", properties: { train_id: trainId }, required: ["train_id"] },
  },
  {
    name: "plan_door_to_door",
    description:
      "Door-to-door trip between any two stops or stations in Belgium, combining walking, STIB, De Lijn, TEC buses/trams/metro and SNCB trains (open timetables via Transitous, live data where available). Use for any trip that is not train-only, e.g. 'from Trône to Gent Heuvelpoort' or 'Louvain-la-Neuve to Liège'.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string", minLength: 1, description: "Start stop or station name, e.g. \"Trône\"" },
        to: { type: "string", minLength: 1, description: "Destination stop or station name, e.g. \"Gent Heuvelpoort\"" },
        time: { ...time, description: "Local Brussels time HH:mm to leave (or arrive with arrive_by). Default now" },
        date,
        arrive_by: { type: "boolean", default: false, description: "Treat time as arrival deadline" },
      },
      required: ["from", "to"],
    },
  },
];

export const TRANSIT_TOOL_NAMES = new Set(TRANSIT_TOOLS.map((t) => t.name));
/** Tools handled inside Sebway instead of the MCP. */
export const LOCAL_TOOLS = new Set(["plan_door_to_door"]);
