import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { costInUnits, emptyState, loadState, remainingFor, saveState, type State } from "../src/core/ledger.js";
import { route } from "../src/core/router.js";
import { planHands, platformFor } from "../src/hands/agent-device.js";
import { findProvider, loadRegistry } from "../src/registry/load.js";

const { providers } = loadRegistry();
const now = new Date("2026-11-22T12:00:00Z");
const connected = "2026-11-01T00:00:00.000Z";

function stateWith(...ids: string[]): State {
  const s = emptyState();
  for (const id of ids) s.connections[id] = { connected_at: connected };
  return s;
}

test("nothing connected means no route and no paid fallback", () => {
  const d = route({ surface: "ios-simulator", minutes: 10 }, providers, emptyState(), now);
  assert.equal(d.chosen, undefined);
  assert.match(d.reason, /no paid path/);
});

test("local hardware is used before any cloud allowance", () => {
  const d = route({ surface: "ios-simulator", minutes: 10 }, providers, stateWith("local", "revyl", "limrun"), now);
  assert.equal(d.chosen?.provider, "local");
});

test("a monthly allowance is spent before a one-time trial", () => {
  const d = route({ surface: "ios-simulator", minutes: 10 }, providers, stateWith("revyl", "limrun"), now);
  assert.equal(d.chosen?.provider, "revyl");
});

test("when the monthly allowance is used up, the one-time trial is next", () => {
  const s = stateWith("revyl", "limrun");
  s.usage.push({ provider: "revyl", allowance: 0, amount: 1195, minutes: 1195, surface: "ios-simulator", at: "2026-11-10T00:00:00Z" });
  const d = route({ surface: "ios-simulator", minutes: 10 }, providers, s, now);
  assert.equal(d.chosen?.provider, "limrun");
  assert.equal(d.chosen?.cost, 20, "Limrun iOS costs 2 credits per minute");
  const revyl = d.considered.find((c) => c.provider === "revyl");
  assert.equal(revyl?.skip, "not_enough_remaining");
});

test("last month's usage does not count against this month", () => {
  const s = stateWith("revyl");
  s.usage.push({ provider: "revyl", allowance: 0, amount: 1200, minutes: 1200, surface: "ios-simulator", at: "2026-10-20T00:00:00Z" });
  const d = route({ surface: "ios-simulator", minutes: 10 }, providers, s, now);
  assert.equal(d.chosen?.provider, "revyl");
});

test("when every allowance is exhausted the router stops", () => {
  const s = stateWith("limrun");
  s.usage.push({ provider: "limrun", allowance: 0, amount: 120, minutes: 60, surface: "ios-simulator", at: "2026-11-10T00:00:00Z" });
  const d = route({ surface: "android-emulator", minutes: 1 }, providers, s, now);
  assert.equal(d.chosen, undefined);
});

test("a session longer than the provider cap is not routed there", () => {
  const d = route({ surface: "ios-real", minutes: 200 }, providers, stateWith("aws-device-farm"), now);
  assert.equal(d.chosen, undefined);
  assert.equal(d.considered.find((c) => c.provider === "aws-device-farm")?.skip, "session_longer_than_cap");
});

test("real devices route to AWS Device Farm when it is the only connected real-device provider", () => {
  const d = route({ surface: "android-real", minutes: 30 }, providers, stateWith("aws-device-farm", "revyl"), now);
  assert.equal(d.chosen?.provider, "aws-device-farm");
});

test("providers without a verified control path are never chosen", () => {
  const d = route({ surface: "desktop-browser", minutes: 5 }, providers, stateWith("kernel", "steel", "hyperbrowser"), now);
  assert.equal(d.chosen, undefined);
  for (const c of d.considered.filter((c) => ["kernel", "steel", "hyperbrowser"].includes(c.provider))) {
    assert.equal(c.skip, "no_verified_control_path");
  }
});

test("open-source programs need explicit confirmation", () => {
  const s = stateWith("browserstack");
  s.usage.push({ provider: "browserstack", allowance: 1, amount: 100, minutes: 100, surface: "android-real", at: "2026-11-10T00:00:00Z" });
  assert.equal(route({ surface: "android-real", minutes: 5 }, providers, s, now).chosen, undefined);
  s.connections.browserstack!.oss_program = true;
  assert.equal(route({ surface: "android-real", minutes: 5 }, providers, s, now).chosen?.type, "oss_program");
});

test("a narrowed connection limits surfaces", () => {
  const s = stateWith("local");
  s.connections.local!.surfaces = ["android-emulator"];
  assert.equal(route({ surface: "ios-simulator", minutes: 5 }, providers, s, now).chosen, undefined);
  assert.equal(route({ surface: "android-emulator", minutes: 5 }, providers, s, now).chosen?.provider, "local");
});

test("a daily allowance resets at the UTC day boundary", () => {
  const cf = findProvider(providers, "cloudflare-browser-rendering")!;
  const s = stateWith(cf.id);
  s.usage.push({ provider: cf.id, allowance: 0, amount: 10, minutes: 10, surface: "desktop-browser", at: "2026-11-21T23:00:00Z" });
  const left = remainingFor(s, cf.id, 0, cf.allowances[0]!, s.connections[cf.id]!, now);
  assert.equal(left.remaining, 10);
});

test("a trial past its expiry has nothing left", () => {
  const tb = findProvider(providers, "testingbot")!;
  const s = stateWith(tb.id);
  s.connections[tb.id]!.connected_at = "2026-09-01T00:00:00Z";
  const left = remainingFor(s, tb.id, 0, tb.allowances[0]!, s.connections[tb.id]!, now);
  assert.equal(left.expired, true);
  assert.equal(left.remaining, 0);
});

test("units without a rate cannot be metered", () => {
  const kernel = findProvider(providers, "kernel")!;
  assert.equal(costInUnits(kernel.allowances[0]!, "desktop-browser", 5), undefined);
});

test("invalid requests are rejected", () => {
  assert.throws(() => route({ surface: "ios-simulator", minutes: 0 }, providers, emptyState(), now));
  assert.throws(() => route({ surface: "ios-simulator", minutes: 1, parallel: 0 }, providers, emptyState(), now));
});

test("state round-trips through disk and stores no secrets", () => {
  const home = mkdtempSync(join(tmpdir(), "odr-"));
  const s = stateWith("revyl");
  saveState(s, home);
  assert.deepEqual(loadState(home), s);
  assert.deepEqual(Object.keys(loadState(home).connections.revyl!), ["connected_at"]);
});

test("hands plan for a cloud provider is an agent-device invocation", () => {
  const plan = planHands(findProvider(providers, "revyl")!, { surface: "ios-simulator", session: "s1", app: "com.example.app", env: {} });
  assert.deepEqual(plan.commands, [
    "agent-device plugins add @agent-device/revyl",
    "export AGENT_DEVICE_SESSION=s1",
    "agent-device connect revyl --platform ios",
    "agent-device open com.example.app",
    "agent-device snapshot -i",
    "agent-device close",
    "agent-device disconnect",
  ]);
  assert.deepEqual(plan.envMissing, ["REVYL_API_KEY"]);
});

test("hands plan for local devices has no connect step", () => {
  const plan = planHands(findProvider(providers, "local")!, { surface: "android-emulator", session: "s1", env: {} });
  assert.ok(!plan.commands.some((c) => c.includes("connect")));
  assert.ok(plan.commands.includes("agent-device open <bundle-id-or-package> --platform android"));
});

test("pass-through providers get no agent-device commands", () => {
  const plan = planHands(findProvider(providers, "browserbase")!, { surface: "desktop-browser", session: "s1", env: {} });
  assert.deepEqual(plan.commands, []);
  assert.match(plan.notes.join(" "), /not implemented/);
});

test("surface maps to an agent-device platform", () => {
  assert.equal(platformFor("ios-real"), "ios");
  assert.equal(platformFor("android-emulator"), "android");
  assert.equal(platformFor("desktop-browser"), "web");
});
