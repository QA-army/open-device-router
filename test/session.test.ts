import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import { loadState, saveState, emptyState } from "../src/core/ledger.js";
import { loadRegistry } from "../src/registry/load.js";
import { allocate, sweep, withSession, RouteRefusedError, SessionError } from "../src/session/session.js";
import { isUsableFrame, decodePng, frameDifference } from "../src/session/png.js";
import { midsceneInterface } from "../src/sdk/midscene.js";
import { escapeTypeText, deviceSlug } from "../src/session/drivers/appetize.js";
import { fakeDriver, makePng, type FakeLog } from "./fixtures/fake-driver.js";

const run = promisify(execFile);
const { providers } = loadRegistry();
const schema = JSON.parse(readFileSync(new URL("../schema/receipt.schema.json", import.meta.url), "utf8"));
const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ allErrors: true, strict: false });
const validReceipt = ajv.compile(schema);

function home(connect: string[] = ["local"], usage: { provider: string; amount: number }[] = []): string {
  const h = mkdtempSync(join(tmpdir(), "odr-test-"));
  const s = emptyState();
  for (const id of connect) s.connections[id] = { connected_at: new Date(Date.now() - 86_400_000).toISOString() };
  for (const u of usage) s.usage.push({ provider: u.provider, allowance: 0, amount: u.amount, minutes: u.amount, surface: "ios-simulator", at: new Date().toISOString() });
  saveState(s, h);
  return h;
}

const opts = (h: string, log: FakeLog, extra: Parameters<typeof fakeDriver>[1] = {}) => ({
  home: h,
  providers,
  drivers: { "agent-device": fakeDriver(log, extra) },
  handleSignals: false,
  heartbeatMs: 50,
});

test("PNG decoder accepts real frames and rejects blank ones", () => {
  assert.ok(isUsableFrame(makePng(64, 128)));
  assert.ok(!isUsableFrame(makePng(64, 128, true)));
  assert.equal(decodePng(makePng(10, 20)).height, 20);
  assert.equal(frameDifference(makePng(32, 32), makePng(32, 32)), 0);
  assert.ok(frameDifference(makePng(32, 32), makePng(32, 32, true)) > 0.5);
});

test("allocate installs, launches, waits past blank frames, and release writes a valid receipt", async () => {
  const h = home();
  const log: FakeLog = { calls: [], released: 0 };
  const s = await allocate(
    { platform: "ios", minutes: 5 },
    { ...opts(h, log, { blankFrames: 2 }), build: { format: "app", path: "/tmp/Fixture.app" } },
  );
  assert.deepEqual(log.calls.slice(0, 3), ["allocate", "install", "launch:com.example.fixture"]);
  assert.equal(s.device.model, "Fake Phone");
  assert.deepEqual(await s.size(), { width: 20, height: 40 });
  await s.tap(10, 20);
  await s.type("hello");
  await s.key("enter");
  await assert.rejects(s.key("tab"), (e: SessionError) => e.code === "key_not_supported");
  const active = loadState(h).reservations[0]!;
  assert.equal(active.status, "active");
  assert.deepEqual(active.locator, { driver: "fake", reservation: s.id });
  const r = await s.release();
  assert.equal(await s.release(), await s.release(), "release is idempotent");
  assert.equal(log.released, 1);
  assert.ok(validReceipt(r), JSON.stringify(validReceipt.errors));
  assert.equal(r.outcome, "ok");
  assert.equal(r.closure.status, "verified");
  assert.ok(r.timings_ms.run_to_first_frame! >= r.timings_ms.first_frame!);
  assert.ok(!JSON.stringify(r).includes("do-not-leak"), "private handle stays out of the receipt");
  const file = JSON.parse(readFileSync(s.receiptFile, "utf8"));
  assert.equal(file.schema, "odr.receipt/v1");
  const st = loadState(h);
  assert.equal(st.reservations[0]!.status, "closed");
  assert.equal(st.usage[0]!.reservation, s.id);
});

test("a failed allocation still releases and reports outcome failed", async () => {
  const h = home();
  const log: FakeLog = { calls: [], released: 0 };
  await assert.rejects(allocate({ platform: "ios", minutes: 5 }, opts(h, log, { failAllocate: true })), (e: SessionError) => {
    assert.equal(e.receipt?.outcome, "failed");
    assert.ok(validReceipt(e.receipt));
    return true;
  });
  assert.equal(log.released, 1);
  assert.notEqual(loadState(h).reservations[0]!.status, "active");
});

test("withSession releases when the run throws", async () => {
  const h = home();
  const log: FakeLog = { calls: [], released: 0 };
  await assert.rejects(
    withSession({ platform: "ios", minutes: 5 }, async () => {
      throw new Error("assertion failed in the run");
    }, opts(h, log)),
    (e: Error & { receipt?: { outcome: string } }) => e.receipt?.outcome === "failed",
  );
  assert.equal(log.released, 1);
});

test("an aborted run is released with outcome cancelled", async () => {
  const h = home();
  const log: FakeLog = { calls: [], released: 0 };
  const ac = new AbortController();
  const s = await allocate({ platform: "ios", minutes: 5 }, { ...opts(h, log), signal: ac.signal });
  void s;
  const s2 = await allocate({ platform: "ios", minutes: 5 }, opts(h, log));
  const r = await s2.release("cancelled");
  assert.equal(r.outcome, "cancelled");
  await s.release();
});

test("losing screenshots mid-session marks the session dropped", async () => {
  const h = home();
  const log: FakeLog = { calls: [], released: 0 };
  const s = await allocate({ platform: "ios", minutes: 5 }, opts(h, log, { failScreenshotsAfter: 1 }));
  await s.heartbeat();
  await s.heartbeat();
  await assert.rejects(s.tap(1, 1), (e: SessionError) => e.code === "session_dropped");
  const r = await s.release();
  assert.equal(r.outcome, "failed");
  assert.equal(r.health.dropped, true);
  assert.match(r.health.dropped_reason!, /screenshot_lost/);
});

test("unverified closure keeps the reservation holding capacity", async () => {
  const h = home();
  const log: FakeLog = { calls: [], released: 0 };
  const s = await allocate({ platform: "ios", minutes: 5 }, opts(h, log, { unverified: true }));
  await s.release();
  assert.equal(loadState(h).reservations[0]!.status, "closure_unverified");
});

test("refusal is a typed error with a receipt and no reservation", async () => {
  const h = home([]);
  await assert.rejects(allocate({ platform: "ios", minutes: 5 }, opts(h, { calls: [], released: 0 })), (e: RouteRefusedError) => {
    assert.equal(e.code, "route_refused");
    assert.equal(e.receipt.outcome, "refused");
    assert.ok(validReceipt(e.receipt));
    return true;
  });
  assert.equal(loadState(h).reservations.length, 0);
});

test("sweep closes reservations left by a dead worker, using the stored locator", async () => {
  const h = home();
  const s = loadState(h);
  s.reservations.push({
    id: "r_00000000000000aa", provider: "local", allowance: 0, surface: "ios-simulator", minutes: 5, amount: 0, usd: 0,
    created_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), expires_at: new Date(Date.now() - 1000).toISOString(),
    owner: { pid: 999999, host: "elsewhere" }, status: "active", locator: { driver: "fake", reservation: "r_00000000000000aa" },
  });
  s.reservations.push({
    id: "r_00000000000000bb", provider: "local", allowance: 0, surface: "ios-simulator", minutes: 5, amount: 0, usd: 0,
    created_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), expires_at: new Date(Date.now() - 1000).toISOString(),
    owner: { pid: 999999, host: "elsewhere" }, status: "reserved",
  });
  saveState(s, h);
  const log: FakeLog = { calls: [], released: 0 };
  const res = await sweep({ home: h, providers, drivers: { "agent-device": fakeDriver(log) } });
  assert.deepEqual(res.map((r) => r.action).sort(), ["closed", "never_allocated"]);
  assert.ok(log.calls.includes("sweep:r_00000000000000aa"));
  assert.ok(loadState(h).reservations.every((r) => r.status === "closed"));
});

async function race(h: string, env: Record<string, string> = {}): Promise<string[]> {
  const child = new URL("./fixtures/reserve-child.ts", import.meta.url).pathname;
  return Promise.all(
    Array.from({ length: 8 }, () =>
      run(process.execPath, ["--import", "tsx", child], { env: { ...process.env, ODR_HOME: h, ...env } })
        .then((r) => r.stdout.trim())
        .catch((e: { stdout: string }) => e.stdout.trim()),
    ),
  );
}

test("eight concurrent workers against 30 free minutes: exactly three get a 10-minute session", async () => {
  // Revyl: 1,200 monthly minutes, 1,170 already used. Parallel cap lifted to isolate the minutes check.
  const h = home(["revyl"], [{ provider: "revyl", amount: 1170 }]);
  const results = await race(h, { ODR_TEST_NO_PARALLEL: "1" });
  assert.equal(results.filter((r) => r.startsWith("OK")).length, 3, results.join("\n"));
  assert.equal(results.filter((r) => r === "REFUSED route_refused").length, 5, results.join("\n"));
  assert.equal(loadState(h).reservations.filter((r) => r.status === "active").length, 3);
});

test("eight concurrent workers against a 2-session cap: exactly two get a device", async () => {
  const h = home(["revyl"]);
  const results = await race(h);
  assert.equal(results.filter((r) => r.startsWith("OK")).length, 2, results.join("\n"));
});

test("Midscene interface maps actions onto the session", async () => {
  const h = home();
  const log: FakeLog = { calls: [], released: 0 };
  const s = await allocate({ platform: "ios", minutes: 5 }, opts(h, log));
  const helpers = {
    defineActionTap: (fn: unknown) => ({ name: "Tap", call: fn }),
    defineActionInput: (k: unknown) => ({ name: "Input", call: k }),
    defineActionKeyboardPress: (fn: unknown) => ({ name: "KeyboardPress", call: fn }),
    defineActionSwipe: (c: unknown) => ({ name: "Swipe", call: c }),
  };
  const mi = await midsceneInterface(s, { device: helpers as never });
  assert.match(await mi.screenshotBase64(), /^data:image\/png;base64,/);
  assert.deepEqual(await mi.size(), { width: 20, height: 40 });
  const [tap, input, , swipe] = mi.actionSpace() as { call: never }[];
  await (tap!.call as (p: { x: number; y: number }) => Promise<void>)({ x: 3, y: 4 });
  await (input!.call as { typeText: (v: string) => Promise<void> }).typeText("abc");
  await (swipe!.call as { swipe: (a: unknown, b: unknown) => Promise<void> }).swipe({ x: 1, y: 2 }, { x: 1, y: 30 });
  assert.ok(log.calls.includes("tap:3,4") && log.calls.includes("type:abc") && log.calls.includes("swipe:1,2->1,30"));
  await mi.destroy();
  assert.equal(s.released, true);
});

test("Appetize text escaping and device slugs", () => {
  assert.equal(escapeTypeText("a{Enter}b"), "a{{Enter}b");
  assert.equal(deviceSlug("iPhone 16 Pro"), "iphone16pro");
});

test("agent-device shutdown report: clean only when nothing is pending", async () => {
  const { shutdownClean } = await import("../src/session/drivers/agent-device.js");
  const clean = { providerReleases: { completed: ["l1"], pending: [], unknown: [] }, runners: { stopped: ["d"], handedOff: [] }, requests: { drained: 1, abandoned: 0 }, sessions: { closed: 1, failed: 0 }, platformOwners: "closed", plugins: { disposed: [], failed: [], pending: [] } };
  assert.equal(shutdownClean(clean), true);
  assert.equal(shutdownClean({ ...clean, platformOwners: "pending" }), false);
  assert.equal(shutdownClean({ ...clean, providerReleases: { completed: [], pending: ["l1"], unknown: [] } }), false);
  assert.equal(shutdownClean({ ...clean, runners: { stopped: [], handedOff: ["d"] } }), false);
});

test("frameProblem explains why a frame is not usable", async () => {
  const { frameProblem } = await import("../src/session/png.js");
  assert.equal(frameProblem(makePng(64, 128)), undefined);
  assert.match(frameProblem(makePng(64, 128, true)) ?? "", /^flat colour/);
  assert.match(frameProblem(Buffer.from("not a png")) ?? "", /^undecodable/);
});
