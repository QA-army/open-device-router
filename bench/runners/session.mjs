// Session benchmark: what a user waits for, measured through the public SDK.
//
// Each sample runs the full lifecycle that QA.army and `odr run` use: route and reserve, allocate,
// install the fixture build, launch it, wait for the first usable frame, hold the session while
// taking a screenshot every few seconds, tap once and check the frame changed, then release and
// verify closure. Timings come from the session receipt, so the benchmark and production report the
// same numbers.
//
// Usage:
//   node bench/runners/session.mjs --provider github-actions --platform android \
//     --build bench/tmp/fixtures/odr-fixture.apk --samples 3 --hold 60 --out-dir bench/tmp/out
//
// Requires `npm run build` first (imports dist/sdk). Writes one odr.bench.session/v1 file.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environment, harness, sleep, tryRun } from "./lib.mjs";

const { allocate, frameDifference, RouteRefusedError, SessionError, VERSION } = await import("../../dist/sdk/index.js");

function args(argv) {
  const out = { samples: 3, hold: 60, every: 5, outDir: "bench/tmp/out", spend: "free-only" };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--provider") out.provider = v();
    else if (k === "--platform") out.platform = v();
    else if (k === "--model") out.model = v();
    else if (k === "--os") out.os = v();
    else if (k === "--build") out.build = v();
    else if (k === "--app-id") out.appId = v();
    else if (k === "--samples") out.samples = Number(v());
    else if (k === "--hold") out.hold = Number(v());
    else if (k === "--every") out.every = Number(v());
    else if (k === "--out-dir") out.outDir = v();
    else if (k === "--budget-usd") out.spend = Number(v());
    else throw new Error(`unknown flag ${k}`);
  }
  if (!out.provider || !["ios", "android"].includes(out.platform)) throw new Error("--provider and --platform ios|android are required");
  if (!Number.isInteger(out.samples) || out.samples < 1 || out.samples > 20) throw new Error("--samples must be 1-20");
  if (!(out.hold >= 0 && out.hold <= 1800)) throw new Error("--hold must be 0-1800 seconds");
  return out;
}

const opt = args(process.argv.slice(2));
const format = opt.build?.endsWith(".apk") ? "apk" : opt.build?.endsWith(".zip") ? "app-zip" : opt.build ? "app" : undefined;
const minutes = Math.max(1, Math.ceil((opt.hold + 300) / 60));
const request = {
  provider: opt.provider,
  platform: opt.platform,
  ...(opt.model ? { model: opt.model } : {}),
  ...(opt.os ? { os: opt.os } : {}),
  ...(format ? { build_format: format } : {}),
  needs: ["screenshot", "tap"],
  minutes,
  require_control: true,
  spend: opt.spend === "free-only" ? { mode: "free-only" } : { mode: "budget", max_usd: opt.spend },
};
const CHILD = process.env.ODR_BENCH_CHILD_SAMPLE;
const home = process.env.ODR_BENCH_HOME ?? join(tmpdir(), `odr-bench-${process.pid}`);
// A fresh ledger per run, connected to the one provider under test.
const connectArgs = ["dist/cli/index.js", "connect", opt.provider, "--done", ...(process.env.ODR_BENCH_PLAN ? ["--plan", process.env.ODR_BENCH_PLAN] : [])];
const connected = CHILD ? { status: 0 } : spawnSync(process.execPath, connectArgs, { env: { ...process.env, ODR_HOME: home }, encoding: "utf8" });
if (connected.status !== 0) throw new Error(`odr connect ${opt.provider} failed: ${connected.stderr || connected.stdout}`);
const startedAt = new Date().toISOString();
const samples = [];

// Each sample runs in its own process, as a QA.army worker would. agent-device keeps a host-wide
// device claim for a session it could not close until its process exits, so one stuck sample in a
// shared process would block every later one.
async function runSample(n) {
  const sample = { n, outcome: "failed", timings_ms: {}, hold: { seconds: opt.hold, screenshots_ok: 0, screenshots_failed: 0, max_gap_ms: 0 } };
  let session;
  try {
    session = await allocate(request, {
      home,
      handleSignals: true,
      runId: `bench-${process.env.GITHUB_RUN_ID ?? "local"}-${n}`,
      ...(opt.build ? { build: { format, path: opt.build, ...(opt.appId ? { app_id: opt.appId } : {}) } } : {}),
      ...(opt.appId && !opt.build ? { launch: opt.appId } : {}),
      log: (line) => console.error(`[sample ${n}] ${line}`),
    });
    // Hold: screenshot on a fixed cadence and record the longest gap between good frames.
    const holdStart = performance.now();
    let lastOk = holdStart;
    while (performance.now() - holdStart < opt.hold * 1000) {
      try {
        await session.screenshot();
        sample.hold.screenshots_ok += 1;
        const now = performance.now();
        sample.hold.max_gap_ms = Math.max(sample.hold.max_gap_ms, Math.round(now - lastOk));
        lastOk = now;
      } catch {
        sample.hold.screenshots_failed += 1;
      }
      await sleep(opt.every * 1000);
    }
    // Input check: one tap in the middle; the fixture changes colour on every tap.
    const size = await session.size();
    const before = await session.screenshot();
    const t0 = performance.now();
    await session.tap(Math.round(size.width / 2), Math.round(size.height / 2));
    sample.tap_ms = Math.round(performance.now() - t0);
    await sleep(1500);
    const after = await session.screenshot();
    sample.tap_frame_change = Math.round(frameDifference(before.png, after.png) * 1000) / 1000;
    const receipt = await session.release("ok");
    Object.assign(sample, summarize(receipt));
  } catch (e) {
    const receipt = e instanceof RouteRefusedError || e instanceof SessionError ? e.receipt : await session?.release("failed", e).catch(() => undefined);
    if (receipt) Object.assign(sample, summarize(receipt));
    sample.outcome = e instanceof RouteRefusedError ? "refused" : "failed";
    sample.error = { code: e?.code ?? "error", message: String(e?.message ?? e).slice(0, 500) };
  }
  // A sample that could not prove closure must not poison the next one. On a CI runner the bench
  // owns the machine, so it force-stops local devices and records that it had to.
  if (sample.closure && sample.closure !== "verified" && opt.provider === "github-actions") {
    const forced = opt.platform === "ios" ? await tryRun("xcrun", ["simctl", "shutdown", "all"]) : await tryRun("adb", ["emu", "kill"]);
    sample.sweep = [{ action: "force_stop_local_devices", ok: forced !== undefined }];
    await sleep(5000);
  }
  console.error(`[sample ${n}] ${sample.outcome} run_to_first_frame=${sample.timings_ms.run_to_first_frame ?? "-"}ms closure=${sample.closure ?? "-"}`);
  return sample;
}

if (CHILD) {
  const sample = await runSample(Number(CHILD));
  process.stdout.write(`${JSON.stringify(sample)}\n`);
  process.exit(0);
}
for (let n = 1; n <= opt.samples; n += 1) {
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    env: { ...process.env, ODR_BENCH_CHILD_SAMPLE: String(n), ODR_BENCH_HOME: home },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 45 * 60_000,
  });
  const line = child.stdout?.trim().split("\n").pop();
  let sample;
  try {
    sample = JSON.parse(line ?? "");
  } catch {
    sample = { n, outcome: "failed", timings_ms: {}, error: { code: "sample_process", message: `sample process exited ${child.status ?? child.signal} without a result` } };
  }
  samples.push(sample);
}

function summarize(r) {
  return {
    outcome: r.outcome,
    receipt_id: r.id,
    route: r.route ? { provider: r.route.provider, profile: r.route.profile ?? null, surface: r.route.surface } : null,
    device: r.device ?? null,
    timings_ms: r.timings_ms,
    health: r.health,
    closure: r.closure.status,
    closure_method: r.closure.method,
    ...(r.closure.detail ? { closure_detail: r.closure.detail } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

const finishedAt = new Date().toISOString();
const result = {
  schema: "odr.bench.session/v1",
  provider: opt.provider,
  platform: opt.platform,
  measurement: "session",
  odr_version: VERSION,
  started_at: startedAt,
  finished_at: finishedAt,
  harness: harness("bench/runners/session.mjs"),
  environment: environment({
    node: process.version,
    // 1 when the workflow built and started agent-device's iOS runner before timing; otherwise the
    // first sample's allocate includes that build.
    runner_prepared: process.env.ODR_BENCH_RUNNER_PREPARED === "1" ? "yes" : "no",
    "agent-device": (await tryRun("npx", ["--no-install", "agent-device", "--version"])) ?? "not installed",
    "@appetize/cli": (await tryRun("appetize", ["--version"])) ?? "not installed",
  }),
  request,
  build: opt.build ? { format, file: opt.build.split("/").pop() } : null,
  samples,
};
mkdirSync(opt.outDir, { recursive: true });
const dir = join(opt.outDir, opt.provider, "session", opt.platform);
mkdirSync(dir, { recursive: true });
const file = join(dir, `${finishedAt.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
console.log(file);
const ok = samples.filter((s) => s.outcome === "ok" && s.closure === "verified").length;
console.error(`${ok}/${samples.length} samples ok with verified closure`);
process.exit(ok === samples.length ? 0 : 1);
