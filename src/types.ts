// Shapes of the Belgian Transit MCP `structuredContent` (schema_version "1").
// Source of truth: docs/sebway-api.md and docs/sebway-examples.json.

/** "tec" and "other" only appear in door-to-door trips planned by Transitous. */
export type Operator = "sncb" | "stib" | "delijn" | "tec" | "other";
export type Mode = "train" | "metro" | "tram" | "bus";

export interface Meta {
  schema_version: "1";
  source: string;
  fetched_at: string;
  stale: boolean;
}

export interface Stop {
  id: string;
  name: string;
  operator: Operator;
  lat: number;
  lon: number;
}

export interface Platform {
  scheduled: string | null;
  actual: string | null;
  changed: boolean;
}

/** realtime=false → timetable only: expected and delay_min are null. STIB: scheduled is null. */
export interface TimeInfo {
  scheduled: string | null;
  expected: string | null;
  delay_min: number | null;
  realtime: boolean;
}

export interface TimeWithPlatform extends TimeInfo {
  platform: Platform | null;
}

export interface Departure extends TimeInfo {
  operator: Operator;
  mode: Mode;
  line: string | null;
  direction: string | null;
  platform: Platform | null;
  cancelled: boolean;
  vehicle_id: string | null;
  arrival_at_to: TimeInfo | null;
}

export interface DeparturesResult {
  meta: Meta;
  stop: Stop;
  to: Stop | null;
  departures: Departure[];
  ended_lines: string[];
}

export interface Transfer {
  /** Walking time included in this change (door-to-door trips). */
  walk_min?: number;
  at: Stop;
  scheduled_min: number;
  /** Negative → connection broken. */
  expected_min: number | null;
}

export interface Leg {
  mode: Mode;
  operator: Operator;
  line: string | null;
  vehicle_id: string | null;
  direction: string | null;
  from: Stop;
  to: Stop;
  departure: TimeWithPlatform;
  arrival: TimeWithPlatform;
  cancelled: boolean;
  transfer_before: Transfer | null;
  /** Door-to-door trips: the route drawn on the map, as [lat, lon] points. */
  path?: [number, number][];
  /** A Sebway correction shown on the trip card (e.g. a realistic ride time). */
  note?: string;
  /** Encoded polyline (decoded on the phone into `path`, to keep server CPU low). */
  path_enc?: { points: string; precision: number };
  /** Door-to-door: how many walking paths (walk_paths_enc) come before this leg. */
  walks_before?: number;
}

export interface Journey {
  departure: TimeInfo;
  arrival: TimeInfo;
  duration_min: number;
  transfers: number;
  cancelled: boolean;
  legs: Leg[];
  alerts: unknown[];
  /** commute_check only */
  leave_by?: string;
  arrive_at?: string;
  /** Door-to-door trips: walking at the start and end, and walking segments for the map. */
  walk_start_min?: number;
  walk_end_min?: number;
  walk_paths?: [number, number][][];
  walk_paths_enc?: { points: string; precision: number }[];
  /** Door-to-door: the start was moved earlier for a comfortable change before the first train. */
  safer_start?: { at: string; original_change_min: number; change_min: number; earlier_min: number };
  /** Door-to-door: a bus replaced a long walk at the start or end. */
  less_walking?: { saved_min: number; later_min: number };
}

export interface PlanJourneyResult {
  meta: Meta;
  query: { from: Stop; to: Stop; time: string; arrive_by: boolean };
  journeys: Journey[];
}

export interface Disruption {
  id: string;
  operator: Operator;
  type: "strike" | "works" | "incident" | "info";
  severity: "major" | "minor" | "info";
  title: string;
  description: string;
  lines: string[];
  stops: Stop[];
  valid_from: string | null;
  valid_until: string | null;
  url: string;
}

export interface DisruptionsResult {
  meta: Meta;
  total: number;
  disruptions: Disruption[];
}

export type McpErrorCode =
  | "STOP_AMBIGUOUS"
  | "STOP_NOT_FOUND"
  | "NO_RESULTS"
  | "BAD_INPUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_TIMEOUT";
