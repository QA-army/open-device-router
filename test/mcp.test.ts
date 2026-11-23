import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyState, type State } from "../src/core/ledger.js";
import { createServer, TOOLS } from "../src/mcp/server.js";
import { loadRegistry } from "../src/registry/load.js";

const { providers } = loadRegistry();
const now = new Date("2026-11-22T12:00:00Z");

function serverWith(...ids: string[]) {
  const s: State = emptyState();
  for (const id of ids) s.connections[id] = { connected_at: "2026-11-01T00:00:00.000Z" };
  return createServer({ providers: () => providers, state: () => s, now: () => now });
}

const rpc = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0" as const, id, method, ...(params ? { params } : {}) });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const result = (r: unknown) => (r as { result: any }).result;

test("initialize echoes a supported protocol version and offers tools only", () => {
  const s = serverWith();
  const r = result(s.handle(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } })));
  assert.equal(r.protocolVersion, "2025-03-26");
  assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
  assert.equal(r.serverInfo.name, "opendevicerouter");
  const unknown = result(s.handle(rpc(2, "initialize", { protocolVersion: "1999-01-01" })));
  assert.equal(unknown.protocolVersion, "2025-06-18");
});

test("notifications get no response; ping and unknown methods do", () => {
  const s = serverWith();
  assert.equal(s.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.equal(s.initialized, true);
  assert.deepEqual(s.handle(rpc(3, "ping")), { jsonrpc: "2.0", id: 3, result: {} });
  assert.equal((s.handle(rpc(4, "resources/list")) as { error: { code: number } }).error.code, -32601);
  assert.equal((s.handle({ id: 5 }) as { error: { code: number } }).error.code, -32600);
});

test("tools/list exposes three read-only tools with object schemas", () => {
  const tools = result(serverWith().handle(rpc(1, "tools/list"))).tools as typeof TOOLS;
  assert.deepEqual(tools.map((t) => t.name), ["plan_route", "read_ledger", "list_providers"]);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.annotations.readOnlyHint, true);
  }
});

test("plan_route picks local before any cloud allowance and reserves nothing", () => {
  const s = serverWith("local", "revyl", "limrun");
  const r = result(s.handle(rpc(1, "tools/call", { name: "plan_route", arguments: { platform: "ios", kind: "simulator", minutes: 10 } })));
  assert.equal(r.isError, false);
  assert.equal(r.structuredContent.chosen.provider, "local");
  assert.equal(r.structuredContent.dry_run, true);
});

test("plan_route with nothing connected refuses instead of picking paid capacity", () => {
  const r = result(serverWith().handle(rpc(1, "tools/call", { name: "plan_route", arguments: { surface: "ios-simulator", minutes: 10 } })));
  assert.equal(r.structuredContent.chosen, null);
  assert.match(r.structuredContent.reason, /refuses rather than risk a bill/);
});

test("bad tool input is a tool error, not a protocol error", () => {
  const s = serverWith("local");
  for (const args of [{ platform: "ios" }, { platform: "ios", minutes: -1 }, { platform: "symbian", minutes: 5 }, { platform: "ios", minutes: 5, api_key: "x" }, { minutes: 5 }]) {
    const r = result(s.handle(rpc(1, "tools/call", { name: "plan_route", arguments: args })));
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal((s.handle(rpc(2, "tools/call", { name: "allocate", arguments: {} })) as { error: { code: number } }).error.code, -32602);
});

test("read_ledger reports connected allowances without the owner host", () => {
  const s = emptyState();
  s.connections.revyl = { connected_at: "2026-11-01T00:00:00.000Z" };
  s.usage.push({ provider: "revyl", allowance: 0, amount: 100, minutes: 100, surface: "ios-simulator", at: "2026-11-10T00:00:00Z" });
  const server = createServer({ providers: () => providers, state: () => s, now: () => now });
  const r = result(server.handle(rpc(1, "tools/call", { name: "read_ledger", arguments: {} })));
  const row = r.structuredContent.allowances.find((a: { provider: string }) => a.provider === "revyl");
  assert.equal(row.used, 100);
  assert.ok(!JSON.stringify(r).includes("host"));
});

test("list_providers marks restricted third-party access as own-key only", () => {
  const r = result(serverWith().handle(rpc(1, "tools/call", { name: "list_providers", arguments: { surface: "ios-simulator" } })));
  const list = r.structuredContent.providers as { id: string; third_party_access: string; key_policy: string }[];
  assert.ok(list.length > 0);
  for (const p of list.filter((x) => x.third_party_access === "restricted")) assert.match(p.key_policy, /own account and key only/);
});

test("odr mcp speaks newline-delimited JSON-RPC over stdio", async () => {
  const home = mkdtempSync(join(tmpdir(), "odr-mcp-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", "mcp"], { env: { ...process.env, ODR_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += String(c);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send(rpc(2, "tools/list"));
  send(rpc(3, "tools/call", { name: "plan_route", arguments: { platform: "android", minutes: 5 } }));
  const deadline = Date.now() + 20_000;
  while (lines.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
  assert.equal(lines.length, 3, "one response per request, none for the notification");
  const [init, list, call] = lines.map((l) => JSON.parse(l));
  assert.equal(init.id, 1);
  assert.equal(list.result.tools.length, 3);
  assert.equal(call.result.structuredContent.chosen, null, "fresh ODR_HOME has nothing connected");
});
