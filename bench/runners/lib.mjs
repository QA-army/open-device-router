// Shared helpers for benchmark runners. No dependencies, so a runner can start on a bare machine.
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const STEP_TIMEOUT_MS = 10 * 60 * 1000;

/** Run a command and return trimmed stdout. Rejects on non-zero exit or timeout. */
export async function run(cmd, args, opts = {}) {
  const { stdout } = await execFileP(cmd, args, {
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return typeof stdout === "string" ? stdout.trim() : stdout;
}

export async function tryRun(cmd, args, opts = {}) {
  try {
    return await run(cmd, args, opts);
  } catch {
    return undefined;
  }
}

/** Milliseconds elapsed while `fn` runs, as a whole number. */
export async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { ms: Math.round(performance.now() - t0), value };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseArgs(argv) {
  const out = { samples: 5, outDir: "bench/tmp/out" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--samples") out.samples = Number(argv[++i]);
    else if (argv[i] === "--out-dir") out.outDir = argv[++i];
  }
  if (!Number.isInteger(out.samples) || out.samples < 1 || out.samples > 50) {
    throw new Error("--samples must be a whole number from 1 to 50");
  }
  return out;
}

export function environment(tools) {
  const cpus = os.cpus();
  return {
    runner_label: process.env.ODR_BENCH_RUNNER_LABEL ?? "unlabelled",
    image_os: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    os: os.platform(),
    os_release: os.release(),
    arch: os.arch(),
    cpu_model: cpus[0]?.model ?? "unknown",
    cpu_count: cpus.length,
    memory_gb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    tools,
  };
}

export function harness(script) {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return {
    repository: repo ?? "local",
    commit: process.env.GITHUB_SHA ?? "uncommitted",
    script,
    run_url: server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : null,
  };
}

/** Writes one result file and returns its path. The file name sorts by start time. */
export function writeResult(outDir, result) {
  const stamp = result.started_at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = process.env.GITHUB_RUN_ID ?? "local";
  const file = join(outDir, result.provider, result.target, `${stamp}-${suffix}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return file;
}

export function errorText(e) {
  const text = e instanceof Error ? e.message : String(e);
  return text.split("\n").slice(0, 3).join(" ").slice(0, 400);
}
