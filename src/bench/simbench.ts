import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameProblem } from "../session/png.js";
import { VERSION } from "../version.js";
import { android, ensureSimbenchAvd, findSdk, listAvds, startEmulator, waitForBoot, type AndroidSdk, type RunningEmulator } from "./android.js";
import { benchEnvironment, benchHarness, type BenchEnvironment } from "./env.js";
import { isFixtureFirstFrame, isFixtureTapped } from "./frames.js";
import { ios, pickIosTarget, type IosTarget } from "./ios.js";
import { errorText, FRAME_TIMEOUT_MS, median, now, packageRoot, since, sleep } from "./util.js";

export const SIMBENCH_SCHEMA = "simbench/v1";
export const FIXTURE_ID = "dev.odr.fixture";

export type Tier = "ci-verified" | "vendor-submitted" | "self-reported";

export interface Sample {
  kind: "cold" | "warm";
  index: number;
  ok: boolean;
  /** Time from the start of the sample to each milestone, unless named *_step_ms. */
  create_step_ms?: number;
  boot_ms?: number;
  first_screenshot_ms?: number;
  install_step_ms?: number;
  launch_step_ms?: number;
  /** From launch command to the fixture's first frame. */
  launch_to_first_frame_ms?: number;
  /** From the start of the sample (cold: before create/boot; warm: before install) to the fixture's first frame. */
  run_to_first_frame_ms?: number;
  /** From the tap command to a captured frame showing the tap's effect. null when input was not measured. */
  tap_to_change_ms?: number | null;
  teardown_step_ms?: number;
  error?: string;
}

export interface ParallelLevel {
  n: number;
  ok: number;
  failed: number;
  /** Median over devices of run_to_first_frame_ms. */
  median_run_to_first_frame_ms: number | null;
  /** Slowest device: the time until all N have shown the fixture. */
  max_run_to_first_frame_ms: number | null;
  devices: Sample[];
}

export interface SimbenchResult {
  schema: typeof SIMBENCH_SCHEMA;
  tier: Tier;
  platform: "ios" | "android";
  started_at: string;
  finished_at: string;
  tool: { name: "opendevicerouter"; version: string };
  harness: { repository: string; commit: string; run_url: string | null };
  environment: BenchEnvironment;
  target: Record<string, string | null>;
  method: {
    cold: string;
    warm: string;
    first_frame: string;
    input: string;
    fixture_build_excluded_ms: number | null;
  };
  samples: Sample[];
  parallel?: { levels: ParallelLevel[]; max_ok_n: number | null; stop_reason: string; rule: string };
  summary: {
    cold: { n: number; ok: number; median_run_to_first_frame_ms: number | null; median_boot_ms: number | null };
    warm: { n: number; ok: number; median_run_to_first_frame_ms: number | null };
    tap: { n: number; median_ms: number | null };
  };
  /** Added by the intake workflow for results submitted through a GitHub issue. */
  submission?: { issue: string; received_at: string };
  cost?: { model: string; sku: string; rate_usd_per_min: number; source: string; estimated_usd_per_cold_session: number | null; note: string };
}

export interface SimbenchOptions {
  platform: "ios" | "android";
  cold: number;
  warm: number;
  parallel?: number[];
  runtime?: string;
  deviceType?: string;
  avd?: string;
  headless?: boolean;
  cost?: { rate: number; sku: string; source: string };
  log?: (line: string) => void;
}

const POLL_MS = 250;

export async function pollFrame(capture: () => Promise<Buffer>, accept: (png: Buffer) => boolean, timeoutMs = FRAME_TIMEOUT_MS): Promise<Buffer> {
  const deadline = now() + timeoutMs;
  let last: unknown;
  while (now() < deadline) {
    try {
      const png = await capture();
      if (accept(png)) return png;
    } catch (e) {
      last = e;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`frame did not appear within ${Math.round(timeoutMs / 1000)} s${last ? ` (last error: ${errorText(last)})` : ""}`);
}


/** Builds the fixture app from bench/fixtures into a temp dir; returns its path and build time. */
export function buildFixture(platform: "ios" | "android", sdk?: AndroidSdk): { path: string; ms: number } {
  const root = packageRoot();
  const out = mkdtempSync(join(tmpdir(), "odr-fixture-"));
  const script = join(root, "bench", "fixtures", platform, "build.sh");
  const t0 = now();
  const env = { ...process.env, ...(sdk ? { ANDROID_HOME: sdk.root } : {}) };
  const stdout = execFileSync("bash", [script, out], { env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 10 * 60_000 });
  const path = stdout.trim().split("\n").pop()!.trim();
  if (!existsSync(path)) throw new Error(`fixture build did not produce ${path}`);
  return { path, ms: since(t0) };
}

// ---------------------------------------------------------------- iOS

async function iosColdSample(target: IosTarget, app: string, index: number, label: string): Promise<Sample> {
  const s: Sample = { kind: "cold", index, ok: false, tap_to_change_ms: null };
  let udid: string | undefined;
  const t0 = now();
  try {
    udid = await ios.create(`odr-simbench-${label}-${index}`, target);
    s.create_step_ms = since(t0);
    await ios.bootWait(udid);
    s.boot_ms = since(t0);
    await pollFrame(() => ios.screenshot(udid!), (png) => frameProblem(png) === undefined);
    s.first_screenshot_ms = since(t0);
    let t = now();
    await ios.install(udid, app);
    s.install_step_ms = since(t);
    t = now();
    await ios.launch(udid, FIXTURE_ID);
    s.launch_step_ms = since(t);
    await pollFrame(() => ios.screenshot(udid!), isFixtureFirstFrame);
    s.launch_to_first_frame_ms = since(t);
    s.run_to_first_frame_ms = since(t0);
    s.ok = true;
  } catch (e) {
    s.error = errorText(e);
  } finally {
    if (udid) {
      const t = now();
      await ios.teardown(udid);
      s.teardown_step_ms = since(t);
    }
  }
  return s;
}

async function iosWarmSamples(target: IosTarget, app: string, count: number, log: (l: string) => void): Promise<Sample[]> {
  if (count === 0) return [];
  const udid = await ios.create("odr-simbench-warm", target);
  const out: Sample[] = [];
  try {
    await ios.bootWait(udid);
    await pollFrame(() => ios.screenshot(udid), (png) => frameProblem(png) === undefined);
    for (let i = 0; i < count; i += 1) {
      const s: Sample = { kind: "warm", index: i, ok: false, tap_to_change_ms: null };
      await ios.terminate(udid, FIXTURE_ID);
      await ios.uninstall(udid, FIXTURE_ID);
      await sleep(1000);
      const t0 = now();
      try {
        await ios.install(udid, app);
        s.install_step_ms = since(t0);
        const t = now();
        await ios.launch(udid, FIXTURE_ID);
        s.launch_step_ms = since(t);
        await pollFrame(() => ios.screenshot(udid), isFixtureFirstFrame);
        s.launch_to_first_frame_ms = since(t);
        s.run_to_first_frame_ms = since(t0);
        s.ok = true;
      } catch (e) {
        s.error = errorText(e);
      }
      log(`  warm ${i + 1}/${count}: ${s.ok ? `${fmt(s.run_to_first_frame_ms)} to first frame` : `failed: ${s.error}`}`);
      out.push(s);
    }
  } finally {
    await ios.teardown(udid);
  }
  return out;
}

export const PARALLEL_RULE =
  "Levels run in ascending order. The run stops at the first level where any device fails, or where the median time to first frame exceeds 2x the N=1 median. max_ok_n is the highest level that passed both checks.";

async function iosParallel(target: IosTarget, app: string, levels: number[], log: (l: string) => void): Promise<NonNullable<SimbenchResult["parallel"]>> {
  const done: ParallelLevel[] = [];
  let base: number | null = null;
  let maxOk: number | null = null;
  let stop = "all levels passed";
  for (const n of [...levels].sort((a, b) => a - b)) {
    log(`parallel N=${n}: booting ${n} simulator${n > 1 ? "s" : ""} at once`);
    const devices = await Promise.all(Array.from({ length: n }, (_, i) => iosColdSample(target, app, i, `p${n}`)));
    const okTimes = devices.filter((d) => d.ok).map((d) => d.run_to_first_frame_ms!);
    const level: ParallelLevel = {
      n,
      ok: okTimes.length,
      failed: n - okTimes.length,
      median_run_to_first_frame_ms: median(okTimes),
      max_run_to_first_frame_ms: okTimes.length ? Math.max(...okTimes) : null,
      devices: devices.map((d) => ({ ...d, kind: "cold" })),
    };
    done.push(level);
    log(`  ${level.ok}/${n} ok, median ${fmt(level.median_run_to_first_frame_ms)}, slowest ${fmt(level.max_run_to_first_frame_ms)}`);
    if (level.failed > 0) {
      stop = `N=${n}: ${level.failed} of ${n} devices failed`;
      break;
    }
    if (base === null) base = level.median_run_to_first_frame_ms;
    else if (base !== null && level.median_run_to_first_frame_ms !== null && level.median_run_to_first_frame_ms > 2 * base) {
      stop = `N=${n}: median ${fmt(level.median_run_to_first_frame_ms)} exceeds 2x the N=1 median ${fmt(base)}`;
      break;
    }
    maxOk = n;
  }
  return { levels: done, max_ok_n: maxOk, stop_reason: stop, rule: PARALLEL_RULE };
}

// ---------------------------------------------------------------- Android

const ANDROID_PORT = 5580;

async function androidTap(sdk: AndroidSdk, serial: string, png: Buffer): Promise<number> {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const t = now();
  await android.tap(sdk, serial, w / 2, h / 2);
  await pollFrame(() => android.screenshot(sdk, serial), isFixtureTapped, 30_000);
  return since(t);
}

async function androidColdSample(sdk: AndroidSdk, avd: string, wipe: boolean, apk: string, index: number, headless: boolean): Promise<Sample> {
  const s: Sample = { kind: "cold", index, ok: false, tap_to_change_ms: null };
  const t0 = now();
  let emu: RunningEmulator | undefined;
  try {
    emu = startEmulator(sdk, avd, { port: ANDROID_PORT, wipe, headless });
    await waitForBoot(sdk, emu);
    s.boot_ms = since(t0);
    await pollFrame(() => android.screenshot(sdk, emu!.serial), (png) => frameProblem(png) === undefined);
    s.first_screenshot_ms = since(t0);
    let t = now();
    await android.install(sdk, emu.serial, apk);
    s.install_step_ms = since(t);
    t = now();
    await android.launch(sdk, emu.serial, FIXTURE_ID);
    s.launch_step_ms = since(t);
    const frame = await pollFrame(() => android.screenshot(sdk, emu!.serial), isFixtureFirstFrame);
    s.launch_to_first_frame_ms = since(t);
    s.run_to_first_frame_ms = since(t0);
    s.ok = true;
    s.tap_to_change_ms = await androidTap(sdk, emu.serial, frame).catch(() => null);
  } catch (e) {
    s.error = `${errorText(e)}${emu ? ` | emulator log tail: ${emu.log()}` : ""}`;
  } finally {
    if (emu) {
      const t = now();
      await android.stop(sdk, emu);
      s.teardown_step_ms = since(t);
    }
  }
  return s;
}

async function androidWarmSamples(sdk: AndroidSdk, avd: string, apk: string, count: number, headless: boolean, log: (l: string) => void): Promise<Sample[]> {
  if (count === 0) return [];
  const emu = startEmulator(sdk, avd, { port: ANDROID_PORT, wipe: false, headless });
  const out: Sample[] = [];
  try {
    await waitForBoot(sdk, emu);
    await pollFrame(() => android.screenshot(sdk, emu.serial), (png) => frameProblem(png) === undefined);
    for (let i = 0; i < count; i += 1) {
      const s: Sample = { kind: "warm", index: i, ok: false, tap_to_change_ms: null };
      await android.uninstall(sdk, emu.serial, FIXTURE_ID);
      await sleep(1000);
      const t0 = now();
      try {
        await android.install(sdk, emu.serial, apk);
        s.install_step_ms = since(t0);
        const t = now();
        await android.launch(sdk, emu.serial, FIXTURE_ID);
        s.launch_step_ms = since(t);
        const frame = await pollFrame(() => android.screenshot(sdk, emu.serial), isFixtureFirstFrame);
        s.launch_to_first_frame_ms = since(t);
        s.run_to_first_frame_ms = since(t0);
        s.ok = true;
        s.tap_to_change_ms = await androidTap(sdk, emu.serial, frame).catch(() => null);
      } catch (e) {
        s.error = errorText(e);
      }
      log(`  warm ${i + 1}/${count}: ${s.ok ? `${fmt(s.run_to_first_frame_ms)} to first frame, tap ${fmt(s.tap_to_change_ms ?? null)}` : `failed: ${s.error}`}`);
      out.push(s);
    }
  } finally {
    await android.stop(sdk, emu);
  }
  return out;
}

// ---------------------------------------------------------------- run

export function fmt(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`;
}

export function summarise(samples: Sample[]): SimbenchResult["summary"] {
  const cold = samples.filter((s) => s.kind === "cold");
  const warm = samples.filter((s) => s.kind === "warm");
  const okCold = cold.filter((s) => s.ok);
  const okWarm = warm.filter((s) => s.ok);
  const taps = samples.map((s) => s.tap_to_change_ms).filter((v): v is number => typeof v === "number");
  return {
    cold: { n: cold.length, ok: okCold.length, median_run_to_first_frame_ms: median(okCold.map((s) => s.run_to_first_frame_ms!)), median_boot_ms: median(okCold.map((s) => s.boot_ms!)) },
    warm: { n: warm.length, ok: okWarm.length, median_run_to_first_frame_ms: median(okWarm.map((s) => s.run_to_first_frame_ms!)) },
    tap: { n: taps.length, median_ms: median(taps) },
  };
}

export function tierFor(harness: { run_url: string | null }): Tier {
  return harness.run_url && process.env.GITHUB_ACTIONS === "true" ? "ci-verified" : "self-reported";
}

export async function runSimbench(opts: SimbenchOptions): Promise<SimbenchResult> {
  const log = opts.log ?? (() => undefined);
  const started = new Date().toISOString();
  const harness = benchHarness();
  // Captured before any device is created, so booted_simulators_before reflects the machine's own load.
  const environment = await benchEnvironment({ bootedSimulators: opts.platform === "ios" && process.platform === "darwin" ? ios.bootedCount : undefined });
  const samples: Sample[] = [];
  let parallel: SimbenchResult["parallel"];
  let target: SimbenchResult["target"];
  let method: SimbenchResult["method"];

  if (opts.platform === "ios") {
    if (process.platform !== "darwin") throw new Error("the iOS benchmark needs macOS with Xcode");
    const t = await pickIosTarget({ runtime: opts.runtime, deviceType: opts.deviceType });
    target = { runtime: t.runtime.identifier, runtime_version: t.runtime.version, runtime_build: t.runtime.buildversion ?? null, device_type: t.type.name };
    log(`target: ${t.type.name}, iOS ${t.runtime.version}`);
    log("building the fixture app (not timed)");
    const fixture = buildFixture("ios");
    method = {
      cold: "simctl create, then bootstatus -b, first non-flat screenshot, install, launch, fixture frame; device deleted after each sample",
      warm: "one booted device; fixture uninstalled (not timed), then install, launch, fixture frame",
      first_frame: "simctl io screenshot polled every 250 ms until at least half of a 32x32 grid is the fixture's starting red",
      input: "not measured on iOS in simbench/v1: simctl has no input command",
      fixture_build_excluded_ms: fixture.ms,
    };
    for (let i = 0; i < opts.cold; i += 1) {
      const s = await iosColdSample(t, fixture.path, i, "cold");
      log(`  cold ${i + 1}/${opts.cold}: ${s.ok ? `boot ${fmt(s.boot_ms)}, first frame ${fmt(s.run_to_first_frame_ms)}` : `failed: ${s.error}`}`);
      samples.push(s);
    }
    samples.push(...(await iosWarmSamples(t, fixture.path, opts.warm, log)));
    if (opts.parallel?.length) parallel = await iosParallel(t, fixture.path, opts.parallel, log);
  } else {
    const sdk = findSdk();
    let avd = opts.avd;
    let wipe = false;
    let image: string | null = null;
    if (!avd) {
      const made = await ensureSimbenchAvd(sdk);
      avd = made.avd;
      image = made.image;
      wipe = true;
    } else if (!(await listAvds(sdk)).includes(avd)) {
      throw new Error(`AVD ${avd} not found. List them with: emulator -list-avds`);
    }
    if (opts.parallel?.length) log("note: --parallel is iOS only in simbench/v1; ignored for Android");
    target = { avd, system_image: image };
    log(`target: AVD ${avd}${image ? ` (${image})` : ""}`);
    log("building the fixture app (not timed)");
    const fixture = buildFixture("android", sdk);
    const headless = opts.headless ?? (process.platform === "linux" && !process.env.DISPLAY);
    method = {
      cold: wipe
        ? "emulator started with -wipe-data -no-snapshot-load on the odr-simbench AVD, then boot_completed, first non-flat screenshot, install, launch, fixture frame"
        : "emulator started with -no-snapshot-load -no-snapshot-save on your AVD (data kept), then boot_completed, first non-flat screenshot, install, launch, fixture frame",
      warm: "one booted emulator; fixture uninstalled (not timed), then install, launch, fixture frame",
      first_frame: "adb exec-out screencap polled every 250 ms until at least half of a 32x32 grid is the fixture's starting red",
      input: "adb shell input tap at screen centre, polled until the red share drops below 20%",
      fixture_build_excluded_ms: fixture.ms,
    };
    for (let i = 0; i < opts.cold; i += 1) {
      const s = await androidColdSample(sdk, avd, wipe, fixture.path, i, headless);
      log(`  cold ${i + 1}/${opts.cold}: ${s.ok ? `boot ${fmt(s.boot_ms)}, first frame ${fmt(s.run_to_first_frame_ms)}, tap ${fmt(s.tap_to_change_ms ?? null)}` : `failed: ${s.error}`}`);
      samples.push(s);
    }
    samples.push(...(await androidWarmSamples(sdk, avd, fixture.path, opts.warm, headless, log)));
  }

  const summary = summarise(samples);
  const result: SimbenchResult = {
    schema: SIMBENCH_SCHEMA,
    tier: tierFor(harness),
    platform: opts.platform,
    started_at: started,
    finished_at: new Date().toISOString(),
    tool: { name: "opendevicerouter", version: VERSION },
    harness,
    environment,
    target,
    method,
    samples,
    ...(parallel ? { parallel } : {}),
    summary,
  };
  if (opts.cost) {
    const ms = summary.cold.median_run_to_first_frame_ms;
    result.cost = {
      model: "per-minute runner rate x median cold run to first frame",
      sku: opts.cost.sku,
      rate_usd_per_min: opts.cost.rate,
      source: opts.cost.source,
      estimated_usd_per_cold_session: ms === null ? null : Math.round((ms / 60_000) * opts.cost.rate * 10_000) / 10_000,
      note: "Estimate only. GitHub bills whole minutes per job, and public repositories run standard runners at no charge.",
    };
  }
  return result;
}
