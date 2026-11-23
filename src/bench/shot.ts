import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { frameDifference, frameProblem } from "../session/png.js";
import { VERSION } from "../version.js";
import { android, ensureSimbenchAvd, findSdk, listAvds, packageOf, startEmulator, waitForBoot, type AndroidSdk, type RunningEmulator } from "./android.js";
import { benchHarness } from "./env.js";
import { frameChanged, isAppFrame } from "./frames.js";
import { bundleIdOf, ios, pickIosTarget } from "./ios.js";
import { pollFrame } from "./simbench.js";
import { errorText, FRAME_TIMEOUT_MS, now, since, sleep } from "./util.js";

// `odr shot`: boot a fresh device, install an app, and capture the first frame it draws, then one
// more frame (after a centre tap on Android, after the screen settles on iOS). On Android the launch
// waits for `am start -W`, so the first frame is the app's own window, not the system splash. On iOS
// the first frame can be the app's launch screen; the settled frame is the one after it. Writes PNGs and an
// `odr.shot/v1` JSON with timings. It reports what was on screen; it does not judge it.

export interface ShotOptions {
  platform: "ios" | "android";
  app: string;
  appId?: string;
  runtime?: string;
  deviceType?: string;
  avd?: string;
  headless?: boolean;
  tap?: boolean;
  outDir: string;
  log?: (line: string) => void;
}

export interface ShotResult {
  schema: "odr.shot/v1";
  platform: "ios" | "android";
  app_id: string;
  device: Record<string, string | null>;
  started_at: string;
  finished_at: string;
  ok: boolean;
  error?: string;
  timings_ms: {
    boot?: number;
    install?: number;
    launch?: number;
    /** Launch command to the first frame that differs from the pre-launch screen. */
    launch_to_first_frame?: number;
    /** Start (before device create or emulator start) to that frame. */
    run_to_first_frame?: number;
    /** Android only: `am start -W` TotalTime, as reported by the OS (activity drawn, after any splash). */
    android_total_time?: number | null;
    /** Tap command to a changed frame (Android). */
    tap_to_change?: number | null;
  };
  second_frame: { kind: "after_tap" | "settled"; changed: boolean | null } | null;
  files: { first?: string; second?: string };
  tool: { name: "opendevicerouter"; version: string };
  harness: { repository: string; commit: string; run_url: string | null };
}

/** Two frames in a row with under 2% difference, or the timeout. Returns the last frame. */
async function settle(capture: () => Promise<Buffer>, start: Buffer, timeoutMs = 8_000): Promise<Buffer> {
  const deadline = now() + timeoutMs;
  let prev = start;
  while (now() < deadline) {
    await sleep(700);
    const cur = await capture().catch(() => prev);
    try {
      if (frameDifference(prev, cur) < 0.02 && frameProblem(cur) === undefined) return cur;
    } catch {
      /* size change during rotation: keep polling */
    }
    prev = cur;
  }
  return prev;
}

export async function runShot(opts: ShotOptions): Promise<ShotResult> {
  const log = opts.log ?? (() => undefined);
  mkdirSync(opts.outDir, { recursive: true });
  const res: ShotResult = {
    schema: "odr.shot/v1",
    platform: opts.platform,
    app_id: opts.appId ?? "",
    device: {},
    started_at: new Date().toISOString(),
    finished_at: "",
    ok: false,
    timings_ms: {},
    second_frame: null,
    files: {},
    tool: { name: "opendevicerouter", version: VERSION },
    harness: benchHarness(),
  };
  const save = (name: string, png: Buffer) => {
    writeFileSync(join(opts.outDir, name), png);
    return name;
  };

  if (opts.platform === "ios") {
    if (process.platform !== "darwin") throw new Error("iOS screenshots need macOS with Xcode");
    const appId = opts.appId ?? (await bundleIdOf(opts.app));
    res.app_id = appId;
    const t = await pickIosTarget({ runtime: opts.runtime, deviceType: opts.deviceType });
    res.device = { model: t.type.name, os: `iOS ${t.runtime.version}`, runtime_build: t.runtime.buildversion ?? null };
    log(`device: ${t.type.name}, iOS ${t.runtime.version}`);
    let udid: string | undefined;
    const t0 = now();
    try {
      udid = await ios.create("odr-shot", t);
      await ios.bootWait(udid);
      const home = await pollFrame(() => ios.screenshot(udid!), (png) => frameProblem(png) === undefined);
      res.timings_ms.boot = since(t0);
      let s = now();
      await ios.install(udid, opts.app);
      res.timings_ms.install = since(s);
      s = now();
      await ios.launch(udid, appId);
      res.timings_ms.launch = since(s);
      const first = await pollFrame(() => ios.screenshot(udid!), (png) => isAppFrame(png, home), FRAME_TIMEOUT_MS);
      res.timings_ms.launch_to_first_frame = since(s);
      res.timings_ms.run_to_first_frame = since(t0);
      res.files.first = save("first-frame.png", first);
      const second = await settle(() => ios.screenshot(udid!), first);
      res.files.second = save("settled.png", second);
      res.second_frame = { kind: "settled", changed: frameChanged(first, second, 0.02) };
      res.timings_ms.tap_to_change = null;
      res.ok = true;
    } catch (e) {
      res.error = errorText(e);
    } finally {
      if (udid) await ios.teardown(udid);
    }
  } else {
    const sdk: AndroidSdk = findSdk();
    const appId = opts.appId ?? (await packageOf(sdk, opts.app));
    res.app_id = appId;
    let avd = opts.avd;
    let wipe = false;
    if (!avd) {
      const made = await ensureSimbenchAvd(sdk);
      avd = made.avd;
      wipe = true;
      res.device = { avd, system_image: made.image };
    } else {
      if (!(await listAvds(sdk)).includes(avd)) throw new Error(`AVD ${avd} not found`);
      res.device = { avd, system_image: null };
    }
    log(`device: AVD ${avd}`);
    const headless = opts.headless ?? (process.platform === "linux" && !process.env.DISPLAY);
    let emu: RunningEmulator | undefined;
    const t0 = now();
    try {
      emu = startEmulator(sdk, avd, { port: 5582, wipe, headless });
      await waitForBoot(sdk, emu);
      const home = await pollFrame(() => android.screenshot(sdk, emu!.serial), (png) => frameProblem(png) === undefined);
      res.timings_ms.boot = since(t0);
      let s = now();
      await android.install(sdk, emu.serial, opts.app);
      res.timings_ms.install = since(s);
      s = now();
      res.timings_ms.android_total_time = await android.launchWait(sdk, emu.serial, appId);
      res.timings_ms.launch = since(s);
      const first = await pollFrame(() => android.screenshot(sdk, emu!.serial), (png) => isAppFrame(png, home), FRAME_TIMEOUT_MS);
      res.timings_ms.launch_to_first_frame = since(s);
      res.timings_ms.run_to_first_frame = since(t0);
      res.files.first = save("first-frame.png", first);
      const settled = await settle(() => android.screenshot(sdk, emu!.serial), first);
      if (opts.tap === false) {
        res.files.second = save("settled.png", settled);
        res.second_frame = { kind: "settled", changed: frameChanged(first, settled, 0.02) };
        res.timings_ms.tap_to_change = null;
      } else {
        const w = settled.readUInt32BE(16), h = settled.readUInt32BE(20);
        s = now();
        await android.tap(sdk, emu.serial, w / 2, h / 2);
        let after: Buffer | undefined;
        try {
          after = await pollFrame(() => android.screenshot(sdk, emu!.serial), (png) => frameChanged(settled, png, 0.02), 5_000);
          res.timings_ms.tap_to_change = since(s);
        } catch {
          after = await android.screenshot(sdk, emu.serial);
          res.timings_ms.tap_to_change = null;
        }
        res.files.second = save("after-tap.png", after);
        res.second_frame = { kind: "after_tap", changed: res.timings_ms.tap_to_change !== null };
      }
      res.ok = true;
    } catch (e) {
      res.error = `${errorText(e)}${emu ? ` | emulator log tail: ${emu.log()}` : ""}`;
    } finally {
      if (emu) await android.stop(sdk, emu);
    }
  }
  res.finished_at = new Date().toISOString();
  writeFileSync(join(opts.outDir, "shot.json"), `${JSON.stringify(res, null, 2)}\n`);
  return res;
}

/** Markdown for a PR comment or job summary. `imageUrl` maps a file name to a URL, or undefined to omit images. */
export function shotMarkdown(r: ShotResult, imageUrl?: (file: string) => string | undefined): string {
  const s = (ms: number | null | undefined) => (ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
  const dev = Object.values(r.device).filter(Boolean).join(", ");
  const lines = [
    `<!-- odr-first-screenshot:${r.platform} -->`,
    `### First screenshot: ${r.platform === "ios" ? "iOS" : "Android"} (${dev})`,
    "",
  ];
  if (!r.ok) {
    lines.push(`No frame captured: ${r.error ?? "unknown error"}`, "");
  } else {
    const first = r.files.first && imageUrl?.(r.files.first);
    const second = r.files.second && imageUrl?.(r.files.second);
    const label = r.second_frame?.kind === "after_tap" ? (r.second_frame.changed ? "After a centre tap" : "After a centre tap (no visible change in 5 s)") : "Settled";
    if (first || second) {
      lines.push(`| First frame | ${label} |`, "| --- | --- |", `| ${first ? `<img src="${first}" width="280">` : "-"} | ${second ? `<img src="${second}" width="280">` : "-"} |`, "");
    }
    lines.push(
      `| Boot | Install | Launch to first frame | Run to first frame | Tap to change |`,
      `| --- | --- | --- | --- | --- |`,
      `| ${s(r.timings_ms.boot)} | ${s(r.timings_ms.install)} | ${s(r.timings_ms.launch_to_first_frame)} | ${s(r.timings_ms.run_to_first_frame)} | ${r.platform === "ios" ? "not measured on iOS" : s(r.timings_ms.tap_to_change)} |`,
      "",
    );
  }
  lines.push(`Captured by [OpenDeviceRouter](https://github.com/QA-army/open-device-router) \`odr shot\` ${r.tool.version}. No pass/fail verdict: this shows what the app drew${r.harness.run_url ? `. [Run](${r.harness.run_url})` : ""}.`);
  return lines.join("\n");
}
