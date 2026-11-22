#!/usr/bin/env node
// Cold boot of an Android emulator with wiped data. Needs the Android SDK and hardware acceleration (KVM on Linux).
// Usage: node bench/runners/android-emulator.mjs [--samples 5] [--out-dir bench/tmp/out]
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { environment, errorText, finish, harness, parseArgs, run, sleep, timed, tryRun, BOOT_TIMEOUT_MS, STEP_TIMEOUT_MS } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const provider = process.env.ODR_BENCH_PROVIDER ?? "local";
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) throw new Error("ANDROID_HOME is not set");

const API = process.env.ODR_BENCH_ANDROID_API ?? "34";
const TAG = process.env.ODR_BENCH_ANDROID_TAG ?? "google_apis";
const ABI = process.env.ODR_BENCH_ANDROID_ABI ?? (process.arch === "arm64" ? "arm64-v8a" : "x86_64");
const DEVICE = process.env.ODR_BENCH_ANDROID_DEVICE ?? "pixel_6";
const IMAGE = `system-images;android-${API};${TAG};${ABI}`;
const AVD = "odr-bench";
const PORT = 5554;
const SERIAL = `emulator-${PORT}`;

const tools = join(sdk, "cmdline-tools", "latest", "bin");
const sdkmanager = join(tools, "sdkmanager");
const avdmanager = join(tools, "avdmanager");
const adb = join(sdk, "platform-tools", "adb");
const emulator = join(sdk, "emulator", "emulator");
if (!existsSync(sdkmanager)) throw new Error(`sdkmanager not found at ${sdkmanager}`);

// avdmanager and the emulator do not always agree on where AVDs live (for example when XDG_CONFIG_HOME is set),
// so both are pointed at the same directory.
const AVD_HOME = process.env.ANDROID_AVD_HOME ?? join(homedir(), ".android", "avd");
process.env.ANDROID_AVD_HOME = AVD_HOME;

async function setup() {
  mkdirSync(AVD_HOME, { recursive: true });
  const opts = { stdio: ["pipe", "inherit", "inherit"], timeout: STEP_TIMEOUT_MS * 2, shell: "/bin/bash" };
  execSync(`yes | "${sdkmanager}" --licenses > /dev/null || true`, opts);
  execSync(`"${sdkmanager}" "platform-tools" "emulator" "${IMAGE}" > /dev/null`, opts);
  execSync(`echo no | "${avdmanager}" create avd --force -n ${AVD} -k "${IMAGE}" -d ${DEVICE}`, opts);
  const listed = (await run(emulator, ["-list-avds"])).split("\n").map((l) => l.trim());
  if (!listed.includes(AVD)) throw new Error(`setup fault: the emulator does not list AVD ${AVD} in ${AVD_HOME}`);
}

async function waitForBoot(child, deadline) {
  while (performance.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`emulator exited with code ${child.exitCode} before boot completed`);
    const done = await tryRun(adb, ["-s", SERIAL, "shell", "getprop", "sys.boot_completed"], { timeout: 10_000 });
    if (done === "1") return;
    await sleep(500);
  }
  throw new Error("boot did not complete within the timeout");
}

async function sample(index) {
  const out = { index, ok: false };
  let log = "";
  const bootStart = performance.now();
  const child = spawn(
    emulator,
    ["-avd", AVD, "-port", String(PORT), "-no-window", "-no-audio", "-no-boot-anim", "-no-snapshot", "-wipe-data", "-gpu", "swiftshader_indirect"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const keep = (chunk) => {
    log = (log + chunk.toString()).slice(-2000);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await waitForBoot(child, bootStart + BOOT_TIMEOUT_MS);
    out.boot_ms = Math.round(performance.now() - bootStart);
    const png = await run(adb, ["-s", SERIAL, "exec-out", "screencap", "-p"], { encoding: "buffer", timeout: 60_000 });
    if (!png || png.length === 0) throw new Error("screenshot was empty");
    out.first_frame_ms = Math.round(performance.now() - bootStart);
    out.ok = true;
  } catch (e) {
    out.error = `${errorText(e)} | emulator log tail: ${log.split("\n").slice(-4).join(" ").slice(0, 300)}`;
  } finally {
    const down = await timed(async () => {
      await tryRun(adb, ["-s", SERIAL, "emu", "kill"], { timeout: 30_000 });
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      await exited;
      clearTimeout(timer);
    });
    out.teardown_ms = down.ms;
  }
  return out;
}

const started = new Date();
const setupTime = await timed(setup);
const emulatorVersion =
  (await tryRun(emulator, ["-version"]))?.split("\n").find((l) => /version/i.test(l))?.trim().slice(0, 120) ?? "unknown";
const kvm = existsSync("/dev/kvm") ? "present" : "absent";
const samples = [];
for (let i = 0; i < args.samples; i += 1) {
  const s = await sample(i);
  console.log(JSON.stringify(s));
  samples.push(s);
}
await tryRun(adb, ["kill-server"], { timeout: 30_000 });

finish(args.outDir, {
  schema: "odr.bench.result/v1",
  provider,
  target: "android-emulator",
  measurement: "cold-boot",
  started_at: started.toISOString(),
  finished_at: new Date().toISOString(),
  harness: harness("bench/runners/android-emulator.mjs"),
  environment: environment({ emulator: emulatorVersion, kvm, node: process.version }),
  device: {
    name: DEVICE,
    os_version: `Android API ${API}`,
    details: { system_image: IMAGE, flags: "-no-window -no-audio -no-boot-anim -no-snapshot -wipe-data -gpu swiftshader_indirect" },
  },
  setup_ms: setupTime.ms,
  samples,
});
