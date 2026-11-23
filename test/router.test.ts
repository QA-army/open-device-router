import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { costInUnits, emptyState, loadState, remainingFor, saveState, type State } from "../src/core/ledger.js";
import { route } from "../src/core/router.js";
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
  assert.match(d.reason, /refuses rather than risk a bill/);
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

test("free-only refuses AWS Device Farm: the trial bills after it runs out and has no usage API", () => {
  const d = route({ surface: "android-real", minutes: 30 }, providers, stateWith("aws-device-farm", "revyl"), now);
  assert.equal(d.chosen, undefined);
  assert.equal(d.considered.find((c) => c.provider === "aws-device-farm")?.skip, "overage_bills_remaining_unverified");
});

test("a budget lets AWS Device Farm serve real devices, priced as if every minute bills", () => {
  const d = route({ surface: "android-real", minutes: 30, spend: { mode: "budget", max_usd: 10 } }, providers, stateWith("aws-device-farm"), now);
  assert.equal(d.chosen?.provider, "aws-device-farm");
  assert.equal(d.chosen?.usd, 5.1);
  const tight = route({ surface: "android-real", minutes: 30, spend: { mode: "budget", max_usd: 1 } }, providers, stateWith("aws-device-farm"), now);
  assert.equal(tight.chosen, undefined);
  assert.equal(tight.considered.find((c) => c.provider === "aws-device-farm")?.skip, "over_budget");
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

test("OS ranges and prefixes match profile versions", async () => {
  const { osMatches } = await import("../src/core/router.js");
  assert.ok(osMatches("18.2", "18"));
  assert.ok(osMatches("18.2", ">=17"));
  assert.ok(!osMatches("16.4", ">=17"));
  assert.ok(osMatches("18.2.1", "18.2"));
  assert.ok(!osMatches("18.20", "18.2"));
  assert.ok(osMatches("*", "18.2"));
});

test("driving a device requires a control path that covers every input", () => {
  const swipe = route({ platform: "ios", minutes: 5, needs: ["screenshot", "tap", "swipe", "type"] }, providers, stateWith("revyl", "limrun"), now);
  assert.equal(swipe.considered.find((c) => c.provider === "revyl")?.skip, "input_not_supported");
  assert.equal(swipe.chosen?.provider, "limrun");
});

test("a build format the provider cannot install is refused", () => {
  const d = route({ platform: "ios", minutes: 5, build_format: "ipa" }, providers, stateWith("local"), now);
  assert.equal(d.considered.find((c) => c.provider === "local")?.skip, "build_format_not_supported");
});

test("model and OS route to a matching device profile", () => {
  const s = stateWith("github-actions");
  const d = route({ platform: "ios", model: "iPhone 17", os: "26", minutes: 5, require_control: true }, providers, s, now);
  assert.equal(d.chosen?.provider, "github-actions");
  assert.ok(d.chosen?.profile);
  const none = route({ platform: "ios", model: "iPhone 17", os: "15", minutes: 5, require_control: true }, providers, s, now);
  assert.equal(none.considered.find((c) => c.provider === "github-actions")?.skip, "no_matching_profile");
});

test("open reservations count against remaining allowance and the parallel cap", () => {
  const s = stateWith("revyl");
  const base = { provider: "revyl", allowance: 0, surface: "ios-simulator" as const, usd: 0, created_at: "2026-11-20T00:00:00Z", heartbeat_at: "2026-11-20T00:00:00Z", expires_at: "2026-11-23T00:00:00Z", owner: { pid: 1, host: "h" } };
  s.reservations.push({ ...base, id: "r_0000000000000001", minutes: 1195, amount: 1195, status: "active" });
  const d = route({ surface: "ios-simulator", minutes: 10 }, providers, s, now);
  assert.equal(d.considered.find((c) => c.provider === "revyl")?.skip, "not_enough_remaining");
  s.reservations[0]!.status = "closed";
  assert.equal(route({ surface: "ios-simulator", minutes: 10 }, providers, s, now).chosen?.provider, "revyl");
});

test("Appetize free-only needs a plan-matched allowance, and starter bills only after a fresh reconcile", () => {
  const s = stateWith("appetize");
  s.connections.appetize!.plan = "starter";
  const req = { platform: "android" as const, minutes: 5, require_control: true };
  const stale = route(req, providers, s, now);
  assert.equal(stale.considered.find((c) => c.provider === "appetize" && c.plan === "starter")?.skip, "overage_bills_remaining_unverified");
  assert.equal(stale.considered.find((c) => c.provider === "appetize" && c.plan === undefined)?.skip, "other_plan");
  s.reconciliations.push({ provider: "appetize", at: "2026-11-22T11:00:00Z", period: "2026-11", provider_minutes: 100, local_minutes: 0 });
  const fresh = route(req, providers, s, now);
  assert.equal(fresh.chosen?.provider, "appetize");
  assert.equal(fresh.chosen?.basis, "provider_reconciled");
  assert.equal(fresh.chosen?.remaining, 400);
});

test("Appetize Free never exceeds its 3-minute session cap", () => {
  const d = route({ platform: "ios", minutes: 5, require_control: true }, providers, stateWith("appetize"), now);
  assert.equal(d.considered.find((c) => c.provider === "appetize" && c.plan === undefined)?.skip, "session_longer_than_cap");
});
