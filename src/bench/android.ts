import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BOOT_TIMEOUT_MS, compareVersions, sh, shBuffer, sleep, trySh } from "./util.js";

// Android Emulator operations through the SDK's emulator, adb and avdmanager. SimBench never
// downloads system images and never wipes an AVD it did not create.

export const SIMBENCH_AVD = "odr-simbench";

export interface AndroidSdk {
  root: string;
  adb: string;
  emulator: string;
  avdmanager?: string;
}

export function findSdk(env: NodeJS.ProcessEnv = process.env): AndroidSdk {
  const candidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk"), join(homedir(), "Android", "Sdk")].filter(Boolean) as string[];
  const root = candidates.find((c) => existsSync(join(c, "platform-tools")));
  if (!root) throw new Error("Android SDK not found. Set ANDROID_HOME, or install Android Studio");
  const avdmanager = [join(root, "cmdline-tools", "latest", "bin", "avdmanager")].find((p) => existsSync(p));
  return { root, adb: join(root, "platform-tools", "adb"), emulator: join(root, "emulator", "emulator"), ...(avdmanager ? { avdmanager } : {}) };
}

/** Newest installed system image, as an sdkmanager package path. */
export function newestSystemImage(sdk: AndroidSdk): string | undefined {
  const base = join(sdk.root, "system-images");
  if (!existsSync(base)) return undefined;
  const wantAbi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  const found: { api: string; tag: string; abi: string }[] = [];
  for (const api of readdirSync(base)) {
    for (const tag of safeList(join(base, api))) {
      for (const abi of safeList(join(base, api, tag))) found.push({ api, tag, abi });
    }
  }
  const usable = found.filter((f) => f.abi === wantAbi && /^android-\d+$/.test(f.api));
  usable.sort((a, b) => compareVersions(b.api.slice(8), a.api.slice(8)) || tagRank(a.tag) - tagRank(b.tag));
  const pick = usable[0];
  return pick ? `system-images;${pick.api};${pick.tag};${pick.abi}` : undefined;
}

function tagRank(tag: string): number {
  return ["google_apis", "default", "aosp_atd", "google_atd", "google_apis_playstore"].indexOf(tag) === -1 ? 9 : ["google_apis", "default", "aosp_atd", "google_atd", "google_apis_playstore"].indexOf(tag);
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export async function listAvds(sdk: AndroidSdk): Promise<string[]> {
  return (await sh(sdk.emulator, ["-list-avds"])).split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Creates the SimBench AVD from the newest installed image. Overwrites only `odr-simbench`. */
export async function ensureSimbenchAvd(sdk: AndroidSdk): Promise<{ avd: string; image: string }> {
  // ODR_SIMBENCH_IMAGE pins the image (CI uses it so runs stay comparable); it must already be installed.
  const pinned = process.env.ODR_SIMBENCH_IMAGE;
  if (pinned && !existsSync(join(sdk.root, ...pinned.split(";")))) throw new Error(`ODR_SIMBENCH_IMAGE ${pinned} is not installed`);
  const image = pinned ?? newestSystemImage(sdk);
  if (!image) throw new Error("no Android system image installed. Install one in Android Studio > Device Manager, or pass --avd <name>");
  if (!sdk.avdmanager) throw new Error("avdmanager not found (install Android SDK Command-line Tools), or pass --avd <name>");
  // avdmanager and the emulator do not always agree on where AVDs live (XDG_CONFIG_HOME, for
  // example), so both are pointed at the same directory for the rest of this process.
  const avdHome = process.env.ANDROID_AVD_HOME ?? join(homedir(), ".android", "avd");
  process.env.ANDROID_AVD_HOME = avdHome;
  mkdirSync(avdHome, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(sdk.avdmanager!, ["create", "avd", "--force", "-n", SIMBENCH_AVD, "-k", image, "-d", "pixel_6"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err = (err + String(c)).slice(-1000)));
    child.stdin.end("no\n");
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`avdmanager create failed (${code}): ${err}`))));
  });
  if (!(await listAvds(sdk)).includes(SIMBENCH_AVD)) throw new Error(`setup fault: the emulator does not list ${SIMBENCH_AVD} in ${avdHome}`);
  return { avd: SIMBENCH_AVD, image };
}

export interface RunningEmulator {
  serial: string;
  child: ChildProcess;
  log: () => string;
}

export function startEmulator(sdk: AndroidSdk, avd: string, opts: { port: number; wipe: boolean; headless: boolean }): RunningEmulator {
  const args = ["-avd", avd, "-port", String(opts.port), "-no-audio", "-no-boot-anim", "-no-snapshot-load", "-no-snapshot-save"];
  if (opts.wipe) args.push("-wipe-data");
  if (opts.headless) args.push("-no-window");
  if (opts.headless && process.platform === "linux") args.push("-gpu", "swiftshader_indirect");
  const child = spawn(sdk.emulator, args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const keep = (c: Buffer) => (log = (log + c.toString()).slice(-2000));
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return { serial: `emulator-${opts.port}`, child, log: () => log.split("\n").slice(-4).join(" ").slice(0, 300) };
}

export async function waitForBoot(sdk: AndroidSdk, emu: RunningEmulator): Promise<void> {
  const deadline = performance.now() + BOOT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (emu.child.exitCode !== null) throw new Error(`emulator exited with code ${emu.child.exitCode} before boot completed`);
    const done = await trySh(sdk.adb, ["-s", emu.serial, "shell", "getprop", "sys.boot_completed"], { timeout: 10_000 });
    if (done === "1") return;
    await sleep(500);
  }
  throw new Error("boot did not complete within the timeout");
}

export const android = {
  screenshot: (sdk: AndroidSdk, serial: string) => shBuffer(sdk.adb, ["-s", serial, "exec-out", "screencap", "-p"], 60_000),
  install: (sdk: AndroidSdk, serial: string, apk: string) => sh(sdk.adb, ["-s", serial, "install", "-r", "-t", apk]),
  uninstall: (sdk: AndroidSdk, serial: string, pkg: string) => trySh(sdk.adb, ["-s", serial, "uninstall", pkg]),
  launch: (sdk: AndroidSdk, serial: string, pkg: string) => sh(sdk.adb, ["-s", serial, "shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]),
  tap: (sdk: AndroidSdk, serial: string, x: number, y: number) => sh(sdk.adb, ["-s", serial, "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]),
  async stop(sdk: AndroidSdk, emu: RunningEmulator): Promise<void> {
    await trySh(sdk.adb, ["-s", emu.serial, "emu", "kill"], { timeout: 30_000 });
    const exited = new Promise((resolve) => emu.child.once("exit", resolve));
    if (emu.child.exitCode === null) await Promise.race([exited, sleep(30_000)]);
    if (emu.child.exitCode === null) emu.child.kill("SIGKILL");
  },
};

/** Package name of an APK, via aapt2/aapt from the newest build-tools, if present. */
export async function packageOf(sdk: AndroidSdk, apk: string): Promise<string> {
  const bt = join(sdk.root, "build-tools");
  const versions = safeList(bt).sort((a, b) => compareVersions(b, a));
  for (const v of versions) {
    for (const tool of ["aapt2", "aapt"]) {
      const p = join(bt, v, tool);
      if (!existsSync(p)) continue;
      const out = await trySh(p, ["dump", "badging", apk]);
      const m = out?.match(/package: name='([^']+)'/);
      if (m) return m[1]!;
    }
  }
  throw new Error("could not read the APK package name (no aapt in build-tools). Pass --package <name>");
}
