import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOOT_TIMEOUT_MS, compareVersions, sh, trySh } from "./util.js";

// iOS Simulator operations through `xcrun simctl`. No other tools needed, so this runs on any Mac
// with Xcode. Input (taps) is not available through simctl; see SimBench notes.

export interface IosTarget {
  runtime: { identifier: string; version: string; buildversion?: string; name?: string };
  type: { identifier: string; name: string };
}

interface SimRuntime {
  identifier: string;
  version: string;
  buildversion?: string;
  name?: string;
  platform?: string;
  isAvailable: boolean;
  supportedDeviceTypes?: { identifier: string; name: string; productFamily?: string }[];
}

export async function iosRuntimes(): Promise<SimRuntime[]> {
  const { runtimes } = JSON.parse(await sh("xcrun", ["simctl", "list", "runtimes", "-j"])) as { runtimes: SimRuntime[] };
  return runtimes
    .filter((r) => r.isAvailable && (r.platform === "iOS" || /iOS/.test(r.identifier)))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Newest runtime (or the one asked for) and the newest plain "iPhone <n>" it supports. */
export async function pickIosTarget(want: { runtime?: string; deviceType?: string } = {}): Promise<IosTarget> {
  const ios = await iosRuntimes();
  const runtime = want.runtime
    ? ios.find((r) => r.identifier === want.runtime || r.version === want.runtime || r.version.startsWith(`${want.runtime}.`))
    : ios[0];
  if (!runtime) throw new Error(want.runtime ? `iOS runtime ${want.runtime} is not installed` : "no available iOS Simulator runtime. Install one in Xcode > Settings > Components");
  const phones = (runtime.supportedDeviceTypes ?? []).filter((d) => d.productFamily === "iPhone");
  const plain = phones.filter((d) => /^iPhone \d+$/.test(d.name)).sort((a, b) => Number(b.name.split(" ")[1]) - Number(a.name.split(" ")[1]));
  const type = want.deviceType ? phones.find((d) => d.identifier === want.deviceType || d.name === want.deviceType) : (plain[0] ?? phones[0]);
  if (!type) throw new Error(`no iPhone device type for runtime ${runtime.identifier}`);
  return { runtime: { identifier: runtime.identifier, version: runtime.version, buildversion: runtime.buildversion, name: runtime.name }, type: { identifier: type.identifier, name: type.name } };
}

export const ios = {
  create: (name: string, t: IosTarget) => sh("xcrun", ["simctl", "create", name, t.type.identifier, t.runtime.identifier]),
  /** Boots if needed and returns once the system reports boot complete. */
  bootWait: (udid: string) => sh("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: BOOT_TIMEOUT_MS }),
  install: (udid: string, app: string) => sh("xcrun", ["simctl", "install", udid, app]),
  launch: (udid: string, bundleId: string) => sh("xcrun", ["simctl", "launch", udid, bundleId]),
  terminate: (udid: string, bundleId: string) => trySh("xcrun", ["simctl", "terminate", udid, bundleId]),
  uninstall: (udid: string, bundleId: string) => trySh("xcrun", ["simctl", "uninstall", udid, bundleId]),
  async screenshot(udid: string): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), "odr-shot-"));
    const file = join(dir, "s.png");
    try {
      await sh("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", file], { timeout: 60_000 });
      return readFileSync(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  async teardown(udid: string): Promise<void> {
    await trySh("xcrun", ["simctl", "shutdown", udid], { timeout: 120_000 });
    await trySh("xcrun", ["simctl", "delete", udid], { timeout: 120_000 });
  },
  async bootedCount(): Promise<number> {
    const out = await trySh("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    if (!out) return 0;
    const devices = Object.values((JSON.parse(out) as { devices: Record<string, unknown[]> }).devices).flat();
    return devices.length;
  },
};

/** Reads the bundle id from an .app's Info.plist (binary or XML) with plutil. */
export async function bundleIdOf(app: string): Promise<string> {
  const id = await sh("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(app, "Info.plist")]);
  if (!id) throw new Error(`no CFBundleIdentifier in ${app}/Info.plist`);
  return id;
}
