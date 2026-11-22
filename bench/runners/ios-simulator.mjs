#!/usr/bin/env node
// Cold boot of a freshly created iOS Simulator. Needs macOS with Xcode.
// Usage: node bench/runners/ios-simulator.mjs [--samples 5] [--out-dir bench/tmp/out]
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { environment, errorText, finish, harness, parseArgs, run, timed, tryRun, BOOT_TIMEOUT_MS } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
const provider = process.env.ODR_BENCH_PROVIDER ?? "local";
if (process.platform !== "darwin") throw new Error("the iOS Simulator runner needs macOS");

function versionKey(v) {
  return v.split(".").map((n) => Number(n) || 0);
}
function compareVersions(a, b) {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

async function pickTarget() {
  const { runtimes } = JSON.parse(await run("xcrun", ["simctl", "list", "runtimes", "-j"]));
  const ios = runtimes
    .filter((r) => r.isAvailable && (r.platform === "iOS" || /iOS/.test(r.identifier)))
    .sort((a, b) => compareVersions(b.version, a.version));
  const wantedRuntime = process.env.ODR_BENCH_IOS_RUNTIME;
  const runtime = wantedRuntime ? ios.find((r) => r.identifier === wantedRuntime) : ios[0];
  if (!runtime) throw new Error("no available iOS Simulator runtime");
  const phones = (runtime.supportedDeviceTypes ?? []).filter((d) => d.productFamily === "iPhone");
  const wantedType = process.env.ODR_BENCH_IOS_DEVICE_TYPE;
  // Prefer the newest plain "iPhone <number>" so the choice is stable and easy to reproduce.
  const plain = phones
    .filter((d) => /^iPhone \d+$/.test(d.name))
    .sort((a, b) => Number(b.name.split(" ")[1]) - Number(a.name.split(" ")[1]));
  const type = wantedType ? phones.find((d) => d.identifier === wantedType) : (plain[0] ?? phones[0]);
  if (!type) throw new Error(`no iPhone device type for runtime ${runtime.identifier}`);
  return { runtime, type };
}

async function sample(index, target, shots) {
  const out = { index, ok: false };
  let udid;
  try {
    const created = await timed(() =>
      run("xcrun", ["simctl", "create", `odr-bench-${index}`, target.type.identifier, target.runtime.identifier]),
    );
    udid = created.value;
    out.create_ms = created.ms;

    const bootStart = performance.now();
    // `bootstatus -b` boots the device if needed and returns once the system reports boot complete.
    await run("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: BOOT_TIMEOUT_MS });
    out.boot_ms = Math.round(performance.now() - bootStart);

    const shot = join(shots, `${index}.png`);
    await run("xcrun", ["simctl", "io", udid, "screenshot", shot]);
    if (statSync(shot).size === 0) throw new Error("screenshot was empty");
    out.first_frame_ms = Math.round(performance.now() - bootStart);
    out.ok = true;
  } catch (e) {
    out.error = errorText(e);
  } finally {
    if (udid) {
      const down = await timed(async () => {
        await tryRun("xcrun", ["simctl", "shutdown", udid]);
        await tryRun("xcrun", ["simctl", "delete", udid]);
      });
      out.teardown_ms = down.ms;
    }
  }
  return out;
}

const started = new Date();
const setup = await timed(pickTarget);
const target = setup.value;
const xcode = (await tryRun("xcodebuild", ["-version"]))?.replace(/\n/g, ", ") ?? "unknown";
const shots = mkdtempSync(join(tmpdir(), "odr-ios-"));
const samples = [];
for (let i = 0; i < args.samples; i += 1) {
  const s = await sample(i, target, shots);
  console.log(JSON.stringify(s));
  samples.push(s);
}

finish(args.outDir, {
  schema: "odr.bench.result/v1",
  provider,
  target: "ios-simulator",
  measurement: "cold-boot",
  started_at: started.toISOString(),
  finished_at: new Date().toISOString(),
  harness: harness("bench/runners/ios-simulator.mjs"),
  environment: environment({ xcode, node: process.version }),
  device: {
    name: target.type.name,
    os_version: `iOS ${target.runtime.version}`,
    details: { device_type: target.type.identifier, runtime: target.runtime.identifier, build: target.runtime.buildversion ?? null },
  },
  setup_ms: setup.ms,
  samples,
});
