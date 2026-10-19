// Chat: Claude answers commuter questions by calling the transit tools.
// Every time, delay and platform in a reply must come from a tool result (see SYSTEM_PROMPT).
import Anthropic from "@anthropic-ai/sdk";
import { callTool, callToolRaw, McpToolError, textOf, type ToolResult } from "./mcp";
import { analyzeJourneys, neededMinutes } from "./alerts";
import { HAIKU, pickModel, SONNET } from "./model-router";
import { attachRouteDisruptions } from "./route-disruptions";
import type { Disruption, Journey, Meta, Stop } from "./types";
import { LOCAL_TOOLS, TRANSIT_TOOL_NAMES, TRANSIT_TOOLS } from "./tools";
import { planTrip, TransitousError, type Place } from "./transitous";
import { hasLongWalk, improveTrips, preferRides, saferStarts, SHORT_WALK_MIN, type TrainStatus } from "./trip-fixes";

const MAX_TOOL_ROUNDS = 6;
const MAX_HISTORY = 20;
const MAX_CHARS = 2000;

const SYSTEM_PROMPT = `You are Sebway, a commuter assistant for public transport in Belgium: SNCB/NMBS trains, STIB/MIVB in Brussels (metro, tram, bus) and De Lijn in Flanders (bus, tram). Users mostly read your replies on a phone while travelling.

Facts come only from tools:
- Every time, delay, platform, cancellation and disruption you mention must come from a tool result in this conversation. If no tool returned it, you don't know it: call a tool, or say you don't have that information. Never estimate or fill in times from general knowledge.
- If a tool fails or returns no data, say so plainly, e.g. "SNCB data is not available right now, try again in a minute." Don't guess an answer instead.
- If a stop name is ambiguous, ask which one the user means, offering the candidates the tool returned.
- Don't assume the user's home or destination stop. Ask if they haven't said.

Choosing tools:
- A specific train between two stations: plan_journey (trains only).
- Live board at one stop: departures; arrivals for SNCB arrivals.
- One train's stops and delays: train_status.
- Door to door between any two stops in Belgium (metro, tram, bus and train combined, with walking): plan_door_to_door.
- Incidents, works, strikes: disruptions.
- Call several tools in parallel when they're independent.

Replying:
- Answer in the user's language (French, Dutch or English).
- Lead with the answer: the train or line, time, delay, platform. Keep it short; use a compact list for several options.
- "(+3)" means 3 minutes late. Times are Europe/Brussels, 24h.
- Journey results end with a "Sebway connection check". Use it: when it says a connection is tight or missed, say so first and recommend the alternative it names. Don't contradict it.
- If the check lists a strike or disruption involving a station on an option, mention it for that option. Say it involves a station on the trip; don't claim the user's specific train is affected unless the text says so.
- End with the data source and fetch time when you gave live information, e.g. "Source: iRail, 16:25".`;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSource {
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  meta?: Meta;
  data?: unknown;
}

export interface ChatReply {
  reply: string;
  sources: ChatSource[];
  model: string;
  stop_reason: string | null;
}

export class ChatInputError extends Error {}

export function parseChatInput(body: unknown): ChatTurn[] {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages) || messages.length === 0) throw new ChatInputError("messages must be a non-empty array");
  const turns = messages.slice(-MAX_HISTORY).map((m): ChatTurn => {
    const { role, content } = (m ?? {}) as Partial<ChatTurn>;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) {
      throw new ChatInputError("each message needs role user|assistant and non-empty string content");
    }
    if (content.length > MAX_CHARS) throw new ChatInputError(`messages are limited to ${MAX_CHARS} characters`);
    return { role, content };
  });
  // The API needs the first message to be from the user.
  while (turns.length && turns[0].role !== "user") turns.shift();
  if (turns.at(-1)?.role !== "user") throw new ChatInputError("the last message must be from the user");
  return turns;
}

/** The user's own Claude key, sent by the app per request. Never stored or logged. */
export function readClaudeKey(req: Request): string | null {
  const key = req.headers.get("X-Claude-Key")?.trim();
  return key && key.startsWith("sk-ant-") && key.length <= 256 ? key : null;
}

/** Cheap validity check for the Settings screen: listing models costs nothing. */
export async function checkClaudeKey(apiKey: string): Promise<void> {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  await client.models.list({ limit: 1 });
}

export async function runChat(env: Env, apiKey: string, turns: ChatTurn[]): Promise<ChatReply> {
  const client = new Anthropic({ apiKey, maxRetries: 1 });

  // Volatile context (current time) goes in the latest user turn, not the system prompt, so the
  // tools + system prefix stays byte-identical and cacheable.
  const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t, i) =>
    i === turns.length - 1
      ? {
          role: "user",
          content: [
            { type: "text", text: `[Current time in Brussels: ${brusselsNow()}]` },
            { type: "text", text: t.content },
          ],
        }
      : { role: t.role, content: t.content },
  );

  const model = pickModel(turns);
  if (model === HAIKU) {
    try {
      const reply = await runLoop(env, client, HAIKU, structuredClone(messages));
      if (reply.stop_reason !== "refusal" && reply.reply) return reply;
    } catch (err) {
      // A bad key is a bad key on every model; anything else gets a second try on Sonnet.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw err;
      console.error(`Haiku failed, retrying on Sonnet: ${String(err)}`);
    }
  }
  return runLoop(env, client, SONNET, messages);
}

async function runLoop(
  env: Env,
  client: Anthropic,
  model: string,
  messages: Anthropic.Beta.BetaMessageParam[],
): Promise<ChatReply> {
  const sources: ChatSource[] = [];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 4096,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TRANSIT_TOOLS,
      // Last round: no more tools, so Claude must answer with what it has.
      tool_choice: round === MAX_TOOL_ROUNDS ? { type: "none" } : { type: "auto" },
      messages,
      // Haiku: quick lookups at low effort. Sonnet: medium, with Anthropic's fallback on a refusal.
      ...(model === HAIKU
        ? { output_config: { effort: "low" as const } }
        : { output_config: { effort: "medium" as const }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    });
    console.log(JSON.stringify({ chat_round: round, model, stop_reason: response.stop_reason, usage: response.usage }));

    if (response.stop_reason === "refusal") {
      return { reply: "Sorry, I can't help with that. I can answer questions about trains, metro, trams and buses in Belgium.", sources, model: response.model, stop_reason: "refusal" };
    }

    // Append the full content (thinking blocks included) unchanged: the history must stay append-only.
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const reply = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { reply: reply || "Sorry, I couldn't put an answer together. Please try again.", sources, model: response.model, stop_reason: response.stop_reason };
    }

    const results = await Promise.all(toolUses.map((tu) => runTool(env, tu, sources)));
    messages.push({ role: "user", content: results });
  }

  // Unreachable: the last round runs with tool_choice "none".
  return { reply: "Sorry, that took too many steps. Please ask again more specifically.", sources, model, stop_reason: null };
}

async function runTool(
  env: Env,
  tu: Anthropic.Beta.BetaToolUseBlock,
  sources: ChatSource[],
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const input = (tu.input ?? {}) as Record<string, unknown>;
  if (!TRANSIT_TOOL_NAMES.has(tu.name)) {
    return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Unknown tool ${tu.name}` };
  }
  try {
    const result = LOCAL_TOOLS.has(tu.name) ? await doorToDoorTool(env, input) : await callToolRaw(env, tu.name, input);
    let structured = result.structuredContent as { meta?: Meta; journeys?: Journey[] } | undefined;
    // Claude reads the MCP's compact text view; the app gets the structured data via `sources`.
    let text = textOf(result) ?? JSON.stringify(result.structuredContent ?? {});

    // Same plain-code connection check as the app, so chat and trip cards never disagree.
    if (!result.isError && structured?.journeys?.length) {
      const analyzed = analyzeJourneys(structured.journeys);
      const { journeys, route_disruptions } = await attachRouteDisruptions(env, analyzed);
      structured = { ...structured, journeys };
      const byId = new Map(route_disruptions.items.map((d) => [d.id, d]));
      const lines = journeys.map((j, i) => {
        const a = j.analysis;
        const alt = a.alternative ? ` Best alternative: option ${a.alternative.journey_index + 1}.` : "";
        const dis = j.disruption_ids.map((id) => byId.get(id)).filter((d): d is Disruption => Boolean(d));
        const disText = dis.length ? ` Disruptions involving its stations: ${dis.map((d) => `[${d.type === "strike" ? "STRIKE" : d.severity}] ${d.title}`).join("; ")}.` : "";
        return `Option ${i + 1}: ${a.level === "ok" ? "connections OK" : a.message}${alt}${a.recommended ? " (best option)" : ""}${disText}`;
      });
      text += `\n\nSebway connection check (minimum change: train⇄metro 5 min, train⇄bus/tram 3 min; stations checked for disruptions: ${route_disruptions.checked.join(", ")} + national strikes):\n${lines.join("\n")}`;
    }
    sources.push({ tool: tu.name, input, ok: !result.isError, meta: structured?.meta, data: result.isError ? undefined : structured });

    // The text view doesn't label strikes; add the MCP's own classification so Claude can't miss one.
    const strikes = ((structured as { disruptions?: Disruption[] } | undefined)?.disruptions ?? []).filter((d) => d.type === "strike");
    if (strikes.length) text += `\n\nClassified as STRIKE by the data source: ${strikes.map((d) => d.title).join("; ")}`;
    return { type: "tool_result", tool_use_id: tu.id, is_error: result.isError ?? false, content: text };
  } catch (err) {
    sources.push({ tool: tu.name, input, ok: false });
    const message = err instanceof McpToolError ? err.message : "Transit service error";
    return { type: "tool_result", tool_use_id: tu.id, is_error: true, content: `Data not available: ${message}` };
  }
}

/** plan_door_to_door: resolve both names with the MCP, plan with Transitous, describe it for Claude. */
async function doorToDoorTool(env: Env, input: Record<string, unknown>): Promise<ToolResult> {
  const place = async (name: unknown): Promise<Place> => {
    const { stops } = await callTool<{ stops: Stop[] }>(env, "find_stop", { query: String(name ?? "") });
    if (!stops.length) throw new McpToolError("STOP_NOT_FOUND", `No stop found for "${String(name)}"`, false);
    return { lat: stops[0].lat, lon: stops[0].lon, name: stops[0].name };
  };
  try {
    const [from, to] = await Promise.all([place(input.from), place(input.to)]);
    const planned = await planTrip(from, to, {
      time: typeof input.time === "string" ? input.time : undefined,
      date: typeof input.date === "string" ? input.date : undefined,
      arriveBy: input.arrive_by === true,
    });
    if (planned.journeys.some(hasLongWalk)) {
      const fewerWalks = await planTrip(from, to, { time: typeof input.time === "string" ? input.time : undefined, date: typeof input.date === "string" ? input.date : undefined, arriveBy: input.arrive_by === true, maxWalkMin: SHORT_WALK_MIN }).catch(() => null);
      if (fewerWalks) planned.journeys = preferRides(planned.journeys, fewerWalks.journeys);
    }
    const improved = await improveTrips(planned.journeys, (id, date) => callTool<TrainStatus>(env, "train_status", { train_id: id, date }));
    // Same as the app: a tight change before the first train gets an earlier start when possible.
    const leaveNow = input.time === undefined && input.date === undefined && input.arrive_by !== true;
    const journeys = await saferStarts(improved, (dest, by) => planTrip(from, dest, { at: by, arriveBy: true, results: 2, light: true }).then((p) => p.journeys), {
      needed: neededMinutes,
      earliest: leaveNow ? Date.now() : undefined,
    });
    const plan = { ...planned, journeys };
    const hm = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Brussels" }).format(new Date(iso)) : "?");
    const lines = plan.journeys.slice(0, 4).map((j, i) => {
      const legs = j.legs
        .map((l) => {
          const delay = l.departure.delay_min ? ` (+${l.departure.delay_min})` : "";
          const live = l.departure.realtime ? "live" : "timetable";
          const walk = l.transfer_before?.walk_min ? `walk ${l.transfer_before.walk_min} min, ` : "";
          const pl = l.departure.platform ? ` platform ${l.departure.platform.actual ?? l.departure.platform.scheduled}${l.departure.platform.changed ? " (changed)" : ""}` : "";
          const note = l.note ? ` (${l.note})` : "";
          return `${walk}${l.mode} ${l.vehicle_id ?? l.line ?? ""} → ${l.direction ?? ""}: ${hm(l.departure.scheduled)}${delay} ${l.from.name}${pl} → ${hm(l.arrival.expected ?? l.arrival.scheduled)} ${l.to.name} [${live}]${note}`;
        })
        .join("; ");
      const lastWalk = j.walk_end_min ? `; then walk ${j.walk_end_min} min to ${to.name}` : "";
      const safer = j.safer_start ? ` Sebway moved the start ${j.safer_start.earlier_min} min earlier for a ${j.safer_start.change_min}-min change at ${j.safer_start.at} (the fastest plan left only ${j.safer_start.original_change_min} min).` : "";
      return `Option ${i + 1}:${safer} leave ${hm(j.leave_by)} (walk ${j.walk_start_min ?? 0} min to the first stop), arrive at ${to.name} ${hm(j.arrive_at)}, ${j.transfers} change(s). ${legs}${lastWalk}`;
    });
    const text = lines.length
      ? `Door-to-door options from ${from.name} to ${to.name} (Transitous, open timetables + live data where marked):\n${lines.join("\n")}`
      : `No door-to-door connection found from ${from.name} to ${to.name} for that time.`;
    return { content: [{ type: "text", text }], structuredContent: { meta: plan.meta, journeys: plan.journeys } };
  } catch (err) {
    const message = err instanceof McpToolError || err instanceof TransitousError ? err.message : "Route planner error";
    return { isError: true, content: [{ type: "text", text: `Data not available: ${message}` }] };
  }
}

function brusselsNow(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Brussels",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}
