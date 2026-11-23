import os from "node:os";
import { trySh } from "./util.js";

// What the machine was, without identifying who owns it: no hostname, username, serial number or UDID.

export interface BenchEnvironment {
  os: string;
  os_version: string | null;
  os_build: string | null;
  arch: string;
  chip: string;
  machine_model: string | null;
  cpu_count: number;
  memory_gb: number;
  xcode: string | null;
  power: "ac" | "battery" | "unknown";
  booted_simulators_before: number | null;
  runner_label: string | null;
  image_os: string | null;
  image_version: string | null;
  node: string;
}

export async function benchEnvironment(opts: { bootedSimulators?: () => Promise<number> } = {}): Promise<BenchEnvironment> {
  const mac = process.platform === "darwin";
  const cpus = os.cpus();
  const [chip, model, swVersion, swBuild, xcode, power, booted] = await Promise.all([
    mac ? trySh("sysctl", ["-n", "machdep.cpu.brand_string"]) : Promise.resolve(undefined),
    mac ? trySh("sysctl", ["-n", "hw.model"]) : Promise.resolve(undefined),
    mac ? trySh("sw_vers", ["-productVersion"]) : Promise.resolve(undefined),
    mac ? trySh("sw_vers", ["-buildVersion"]) : Promise.resolve(undefined),
    mac ? trySh("xcodebuild", ["-version"]) : Promise.resolve(undefined),
    mac ? trySh("pmset", ["-g", "batt"]) : Promise.resolve(undefined),
    opts.bootedSimulators ? opts.bootedSimulators().catch(() => null) : Promise.resolve(null),
  ]);
  return {
    os: process.platform,
    os_version: swVersion ?? os.release(),
    os_build: swBuild ?? null,
    arch: process.arch,
    chip: chip || cpus[0]?.model || "unknown",
    machine_model: model ?? null,
    cpu_count: cpus.length,
    memory_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    xcode: xcode ? xcode.split("\n").map((l) => l.trim()).join(" ") : null,
    power: !power ? "unknown" : /AC Power/.test(power) ? "ac" : /Battery Power/.test(power) ? "battery" : "unknown",
    booted_simulators_before: booted ?? null,
    runner_label: process.env.ODR_BENCH_RUNNER_LABEL ?? null,
    image_os: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    node: process.version,
  };
}

export function benchHarness(): { repository: string; commit: string; run_url: string | null } {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return {
    repository: repo ?? "local",
    commit: process.env.GITHUB_SHA ?? process.env.ODR_HARNESS_COMMIT ?? "unknown",
    run_url: server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
  };
}
