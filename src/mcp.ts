// Minimal client for the Belgian Transit MCP: one stateless `tools/call` per request.
import type { McpErrorCode, Stop } from "./types";

export class McpToolError extends Error {
  code: McpErrorCode;
  retryable: boolean;
  candidates: Stop[];

  constructor(code: McpErrorCode, message: string, retryable: boolean, candidates: Stop[] = []) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.candidates = candidates;
  }
}

export interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
}

interface RpcMessage {
  result?: ToolResult;
  error?: { code: number; message: string };
}

const TIMEOUT_MS = 10_000;

/** Structured JSON for app code. Tool errors are thrown as McpToolError. */
export async function callTool<T>(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  if (name === "find_stop") return cachedForADay<T>(`find_stop:${JSON.stringify(args)}`, () => callToolResolved<T>(env, name, args));
  return callToolResolved<T>(env, name, args);
}

const STOP_CACHE_SECONDS = 86_400;

/** Cloudflare's edge cache for slow-changing answers (stop names). Falls back to a live call. */
async function cachedForADay<T>(key: string, load: () => Promise<T>): Promise<T> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  const req = new Request(`https://cache.sebway.internal/${encodeURIComponent(key)}`);
  const hit = cache ? await cache.match(req) : undefined;
  if (hit) return (await hit.json()) as T;
  const value = await load();
  await cache?.put(req, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${STOP_CACHE_SECONDS}` } }));
  return value;
}

async function callToolResolved<T>(env: Env, name: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await callToolOnce<T>(env, name, args);
  } catch (err) {
    // The MCP sometimes calls an exact stop name "ambiguous" with that same stop as the only candidate
    // (seen with "Trone / Troon" in commute_check). Retry once with the candidate's id.
    const fixed = err instanceof McpToolError && err.code === "STOP_AMBIGUOUS" ? resolveExactCandidate(args, err.candidates) : null;
    if (!fixed) throw err;
    return callToolOnce<T>(env, name, fixed);
  }
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Replace an argument whose value exactly matches one candidate's name with that candidate's id. */
export function resolveExactCandidate(args: Record<string, unknown>, candidates: Stop[]): Record<string, unknown> | null {
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const matches = candidates.filter((c) => norm(c.name) === norm(value));
    if (matches.length === 1 && matches[0].id !== value) return { ...args, [key]: matches[0].id };
  }
  return null;
}

async function callToolOnce<T>(env: Env, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await callToolRaw(env, name, args);
  if (result.isError) {
    const e = (result.structuredContent as { error?: Partial<McpToolError> } | undefined)?.error;
    throw new McpToolError(
      (e?.code as McpErrorCode) ?? "UPSTREAM_UNAVAILABLE",
      e?.message ?? textOf(result) ?? "Unknown transit error",
      e?.retryable ?? true,
      e?.candidates ?? [],
    );
  }
  if (result.structuredContent === undefined) {
    // Happens when the chat token (text only) is used instead of SEBWAY_TOKEN.
    throw new McpToolError("UPSTREAM_UNAVAILABLE", "No structuredContent in MCP result: check SEBWAY_TOKEN", false);
  }
  return result.structuredContent as T;
}

/** The full MCP result (text + structured), tool errors included. Transport failures throw.
 *  Temporary failures (the MCP overloaded or briefly down) are retried once. */
export async function callToolRaw(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    return await callToolRawOnce(env, name, args);
  } catch (err) {
    if (!(err instanceof McpToolError) || !err.retryable) throw err;
    await new Promise((r) => setTimeout(r, 250));
    return callToolRawOnce(env, name, args);
  }
}

async function callToolRawOnce(env: Env, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  let res: Response;
  try {
    res = await env.TRANSIT.fetch("https://transit/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SEBWAY_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && err.name === "TimeoutError";
    throw new McpToolError(
      timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_UNAVAILABLE",
      `Transit service unreachable (${String(err)})`,
      true,
    );
  }

  if (!res.ok) {
    throw new McpToolError("UPSTREAM_UNAVAILABLE", `Transit service HTTP ${res.status}`, res.status >= 500);
  }

  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    throw new McpToolError("UPSTREAM_UNAVAILABLE", `Transit service failed while answering (${String(err)})`, true);
  }
  const msg = parseRpc(body);
  if (msg.error) {
    throw new McpToolError("BAD_INPUT", `MCP error ${msg.error.code}: ${msg.error.message}`, false);
  }
  return msg.result ?? {};
}

export function textOf(result: ToolResult): string | undefined {
  const parts = result.content?.filter((c) => c.type === "text" && c.text).map((c) => c.text);
  return parts?.length ? parts.join("\n") : undefined;
}

/** The response is either plain JSON or SSE with a `data:` line. */
function parseRpc(body: string): RpcMessage {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  for (const line of dataLines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.result || parsed.error) return parsed;
    } catch {
      // not JSON, keep looking
    }
  }
  throw new McpToolError("UPSTREAM_UNAVAILABLE", "Unreadable MCP response", true);
}
