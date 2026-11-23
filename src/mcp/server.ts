import { createInterface } from "node:readline";
import { holdsCapacity, loadState, remainingFor, type State } from "../core/ledger.js";
import { route, TYPE_ORDER, type RouteRequest } from "../core/router.js";
import { BUILD_FORMATS, INPUTS, isSurface, KEYS, SURFACES, type Provider } from "../core/types.js";
import { loadRegistry } from "../registry/load.js";
import { VERSION } from "../version.js";

// `odr mcp`: a Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
// v1 is read-only: it answers which provider a run would use, what free capacity is left, and what
// providers exist. It never allocates a device, stores a credential, or calls a provider API.

export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
interface Response {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ServerDeps {
  providers: () => Provider[];
  state: () => State;
  now: () => Date;
}

const defaultDeps: ServerDeps = {
  providers: () => {
    const { providers, issues } = loadRegistry();
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length) throw new Error(`registry has ${errors.length} error(s); run \`odr validate\``);
    return providers;
  },
  state: () => loadState(),
  now: () => new Date(),
};

class ToolInputError extends Error {}

const requestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["minutes"],
  properties: {
    platform: { type: "string", enum: ["ios", "android", "web"], description: "Device platform." },
    kind: { type: "string", enum: ["simulator", "emulator", "real", "browser"] },
    surface: { type: "string", enum: [...SURFACES], description: "Alternative to platform + kind." },
    model: { type: "string", description: "Case-insensitive substring of a device model, e.g. \"iPhone 16\" or \"pixel\"." },
    os: { type: "string", description: "\"18.2\", \"18\" (any 18.x), \">=17\", \"<=15\" or \"*\"." },
    build_format: { type: "string", enum: [...BUILD_FORMATS] },
    needs: { type: "array", items: { type: "string", enum: [...INPUTS] } },
    keys: { type: "array", items: { type: "string", enum: [...KEYS] } },
    minutes: { type: "number", exclusiveMinimum: 0, description: "Planned session length." },
    parallel: { type: "integer", minimum: 1 },
    provider: { type: "string", description: "Only consider this provider id." },
    budget_usd: { type: "number", minimum: 0, description: "Allow paid capacity up to this amount. Omit for free-only (default)." },
  },
} as const;

export const TOOLS = [
  {
    name: "plan_route",
    title: "Plan a device session (dry run)",
    description:
      "Which connected provider and device profile odr would use for a session, and why each other provider was skipped. Free capacity first; refuses rather than pick capacity that could bill unless budget_usd is set. Nothing is reserved.",
    inputSchema: requestSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "read_ledger",
    title: "Free capacity left",
    description:
      "Connected providers with used and remaining allowance per window, from odr's local ledger (an estimate unless reconciled), plus open reservations.",
    inputSchema: { type: "object", additionalProperties: false, properties: { provider: { type: "string" } } },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "list_providers",
    title: "Providers in the registry",
    description:
      "Device providers odr knows about: surfaces, free allowance, overage behaviour, whether the user's own key is required, and the registry check date. Filter by surface or status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        surface: { type: "string", enum: [...SURFACES] },
        status: { type: "string", enum: ["launch", "baseline", "researched", "candidate"] },
        connected_only: { type: "boolean" },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

function str(v: unknown, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new ToolInputError(`${name} must be a non-empty string`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T | undefined {
  const s = str(v, name);
  if (s !== undefined && !(allowed as readonly string[]).includes(s)) throw new ToolInputError(`${name} must be one of ${allowed.join(", ")}`);
  return s as T | undefined;
}

function listOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) throw new ToolInputError(`${name} must be an array`);
  return v.map((x, i) => oneOf(x, allowed, `${name}[${i}]`)!);
}

const KNOWN_REQUEST_FIELDS = new Set(Object.keys(requestSchema.properties));

export function requestFromArgs(a: Record<string, unknown>): RouteRequest {
  for (const k of Object.keys(a)) if (!KNOWN_REQUEST_FIELDS.has(k)) throw new ToolInputError(`unknown field ${k}`);
  const minutes = a.minutes;
  if (typeof minutes !== "number" || !(minutes > 0) || minutes > 24 * 60) throw new ToolInputError("minutes must be a number from 0 to 1440");
  const req: RouteRequest = { minutes, spend: { mode: "free-only" } };
  const platform = oneOf(a.platform, ["ios", "android", "web"] as const, "platform");
  if (platform) req.platform = platform;
  const kind = oneOf(a.kind, ["simulator", "emulator", "real", "browser"] as const, "kind");
  if (kind) req.kind = kind;
  const surface = oneOf(a.surface, SURFACES, "surface");
  if (surface) req.surface = surface;
  const model = str(a.model, "model");
  if (model) req.model = model;
  const os = str(a.os, "os");
  if (os) req.os = os;
  const bf = oneOf(a.build_format, BUILD_FORMATS, "build_format");
  if (bf) req.build_format = bf;
  const needs = listOf(a.needs, INPUTS, "needs");
  if (needs) req.needs = needs;
  const keys = listOf(a.keys, KEYS, "keys");
  if (keys) req.keys = keys;
  if (a.parallel !== undefined) {
    if (!Number.isInteger(a.parallel) || (a.parallel as number) < 1) throw new ToolInputError("parallel must be a whole number of at least 1");
    req.parallel = a.parallel as number;
  }
  const provider = str(a.provider, "provider");
  if (provider) req.provider = provider;
  if (a.budget_usd !== undefined) {
    if (typeof a.budget_usd !== "number" || !(a.budget_usd >= 0)) throw new ToolInputError("budget_usd must be 0 or more");
    req.spend = { mode: "budget", max_usd: a.budget_usd };
  }
  if (!req.surface && !req.platform) throw new ToolInputError("give platform (and optionally kind) or surface");
  return req;
}

function planRoute(args: Record<string, unknown>, deps: ServerDeps): { text: string; data: Record<string, Json> } {
  const req = requestFromArgs(args);
  const decision = route(req, deps.providers(), deps.state(), deps.now());
  const considered = decision.considered
    .filter((c) => c.skip !== "not_connected" && c.skip !== "surface_not_offered" && c.skip !== "not_selected")
    .map((c) => ({
      provider: c.provider,
      allowance: `${c.plan ? `${c.plan} ` : ""}${c.type} ${c.unit}`,
      profile: c.profile ?? null,
      cost: c.cost,
      remaining: Number.isFinite(c.remaining) ? c.remaining : "unlimited",
      remaining_basis: c.basis ?? null,
      usd: c.usd,
      eligible: c.eligible,
      skip: c.skip ?? null,
      detail: c.detail ?? null,
    }));
  const data = {
    dry_run: true,
    order: ["free first", ...TYPE_ORDER],
    chosen: decision.chosen ? { provider: decision.chosen.provider, profile: decision.chosen.profile ?? null, usd: decision.chosen.usd } : null,
    reason: decision.reason,
    considered,
    next: decision.chosen ? "Run `odr run` with the same request to allocate it. This tool reserved nothing." : "Connect a provider with `odr connect <id>`, or relax the request.",
  } as unknown as Record<string, Json>;
  return { text: decision.reason, data };
}

function readLedger(args: Record<string, unknown>, deps: ServerDeps): { text: string; data: Record<string, Json> } {
  for (const k of Object.keys(args)) if (k !== "provider") throw new ToolInputError(`unknown field ${k}`);
  const only = str(args.provider, "provider");
  const providers = deps.providers();
  const state = deps.state();
  const now = deps.now();
  const rows: Json[] = [];
  for (const [id, connection] of Object.entries(state.connections)) {
    if (only && id !== only) continue;
    const p = providers.find((x) => x.id === id);
    if (!p) continue;
    p.allowances.forEach((a, i) => {
      const left = remainingFor(state, id, i, a, connection, now);
      rows.push({
        provider: id,
        allowance: `${a.plan ? `${a.plan} ` : ""}${a.type} ${a.unit}`,
        used: left.used,
        reserved: left.reserved,
        remaining: Number.isFinite(left.remaining) ? left.remaining : "unlimited",
        expired: left.expired,
        resets_or_expires: left.window.end?.toISOString() ?? null,
        overage: a.overage,
      });
    });
  }
  const open = state.reservations
    .filter((r) => (!only || r.provider === only) && holdsCapacity(r))
    .map((r) => ({ id: r.id, provider: r.provider, status: r.status, created_at: r.created_at }));
  const text = rows.length ? `${rows.length} allowance window(s) across ${Object.keys(state.connections).length} connected provider(s); ${open.length} open reservation(s).` : "Nothing connected. The user can run `odr connect local`.";
  return { text, data: { basis: "odr local ledger; an estimate unless reconciled with the provider", allowances: rows, open_reservations: open as unknown as Json } };
}

function listProviders(args: Record<string, unknown>, deps: ServerDeps): { text: string; data: Record<string, Json> } {
  for (const k of Object.keys(args)) if (!["surface", "status", "connected_only"].includes(k)) throw new ToolInputError(`unknown field ${k}`);
  const surface = args.surface === undefined ? undefined : isSurface(String(args.surface)) ? String(args.surface) : (() => { throw new ToolInputError(`surface must be one of ${SURFACES.join(", ")}`); })();
  const status = oneOf(args.status, ["launch", "baseline", "researched", "candidate"] as const, "status");
  if (args.connected_only !== undefined && typeof args.connected_only !== "boolean") throw new ToolInputError("connected_only must be a boolean");
  const state = deps.state();
  const list = deps
    .providers()
    .filter((p) => (!surface || p.surfaces.includes(surface as Provider["surfaces"][number])) && (!status || p.status === status) && (!args.connected_only || state.connections[p.id]))
    .map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      surfaces: p.surfaces,
      connected: Boolean(state.connections[p.id]),
      free: p.allowances.filter((a) => !a.plan).map((a) => `${a.type}: ${a.unit === "unlimited" ? "unlimited" : `${a.amount} ${a.unit}`}, overage ${a.overage}`),
      drivable_by_odr: Boolean(p.control),
      third_party_access: p.policy.third_party_access ?? "unknown",
      key_policy: p.policy.third_party_access === "restricted" ? "the user's own account and key only; odr never shares or proxies credentials" : "the user's own account and key",
      checked_at: p.checked_at,
      homepage: p.homepage,
    }));
  return { text: `${list.length} provider(s).`, data: { providers: list as unknown as Json } };
}

export function createServer(deps: ServerDeps = defaultDeps) {
  let initialized = false;
  const ok = (id: Response["id"], result: unknown): Response => ({ jsonrpc: "2.0", id, result });
  const err = (id: Response["id"], code: number, message: string): Response => ({ jsonrpc: "2.0", id, error: { code, message } });

  function call(name: string, args: Record<string, unknown>) {
    const impl = name === "plan_route" ? planRoute : name === "read_ledger" ? readLedger : name === "list_providers" ? listProviders : undefined;
    if (!impl) return undefined;
    try {
      const { text, data } = impl(args, deps);
      return { content: [{ type: "text", text: `${text}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data, isError: false };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  /** Handles one parsed message. Returns undefined for notifications. */
  function handle(msg: unknown): Response | undefined {
    if (!msg || typeof msg !== "object" || (msg as Request).jsonrpc !== "2.0" || typeof (msg as Request).method !== "string") {
      return err((msg as Request | null)?.id ?? null, -32600, "invalid request");
    }
    const { id, method, params = {} } = msg as Request;
    const isNotification = id === undefined;
    if (isNotification) {
      if (method === "notifications/initialized") initialized = true;
      return undefined;
    }
    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : SUPPORTED_PROTOCOLS[0]!;
        return ok(id!, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "opendevicerouter", title: "OpenDeviceRouter", version: VERSION },
          instructions:
            "Read-only. Use plan_route before asking the user to run `odr run`; it says which free device capacity a session would use and refuses capacity that could bill. read_ledger shows what is left. Never ask the user to share a provider key with you; keys stay in their environment.",
        });
      }
      case "ping":
        return ok(id!, {});
      case "tools/list":
        return ok(id!, { tools: TOOLS });
      case "tools/call": {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== "string") return err(id!, -32602, "params.name is required");
        if (!args || typeof args !== "object" || Array.isArray(args)) return err(id!, -32602, "params.arguments must be an object");
        const result = call(name, args as Record<string, unknown>);
        return result ? ok(id!, result) : err(id!, -32602, `unknown tool ${name}`);
      }
      default:
        return err(id!, -32601, `method not found: ${method}`);
    }
  }

  return { handle, get initialized() { return initialized; } };
}

/** Reads newline-delimited JSON-RPC from stdin and writes responses to stdout. Logs go to stderr only. */
export async function serveStdio(deps: ServerDeps = defaultDeps): Promise<void> {
  const server = createServer(deps);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (r: Response) => process.stdout.write(`${JSON.stringify(r)}\n`);
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (Array.isArray(msg)) {
      const out = msg.map((m) => server.handle(m)).filter((r): r is Response => r !== undefined);
      if (out.length) process.stdout.write(`${JSON.stringify(out)}\n`);
      continue;
    }
    const r = server.handle(msg);
    if (r) write(r);
  }
}
