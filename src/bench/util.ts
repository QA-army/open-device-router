import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const STEP_TIMEOUT_MS = 10 * 60_000;
/** A boot that has not completed by this point counts as a failed sample. */
export const BOOT_TIMEOUT_MS = 5 * 60_000;
/** How long to wait for the app's first frame after launch, or for a tap to change the frame. */
export const FRAME_TIMEOUT_MS = 60_000;
/**
 * First usable screenshot after boot. On GitHub macOS runners `simctl io screenshot` keeps failing for
 * a while after `bootstatus` returns (about 40 s at the median in the cold-boot runs), so this matches
 * the session SDK's default first-frame timeout.
 */
export const BOOT_FRAME_TIMEOUT_MS = 180_000;

export async function sh(cmd: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const timeout = opts.timeout ?? STEP_TIMEOUT_MS;
  try {
    const { stdout } = await execFileP(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, env: opts.env ?? process.env });
    return String(stdout).trim();
  } catch (e) {
    throw withTimeoutNote(e, timeout);
  }
}

export async function shBuffer(cmd: string, args: string[], timeout = 60_000): Promise<Buffer> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" });
    return stdout as Buffer;
  } catch (e) {
    throw withTimeoutNote(e, timeout);
  }
}

/** execFile kills the child on timeout and reports only "Command failed"; say so in the message. */
export function withTimeoutNote(e: unknown, timeoutMs: number): unknown {
  const err = e as Error & { killed?: boolean; signal?: string | null };
  if (err instanceof Error && err.killed && err.signal) {
    err.message = `timed out after ${Math.round(timeoutMs / 1000)} s: ${err.message}`;
  }
  return e;
}

export async function trySh(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<string | undefined> {
  try {
    return await sh(cmd, args, opts);
  } catch {
    return undefined;
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const now = () => performance.now();
export const since = (t0: number) => Math.round(performance.now() - t0);

export function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split("\n").slice(0, 3).join(" ").slice(0, 400);
}

/** Median; mean of the two middle values for an even count. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

/** Root of the installed package (works from src/ under tsx and from dist/). */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "bench", "fixtures"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not find the opendevicerouter package root (bench/fixtures missing)");
}

export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map((n) => Number(n) || 0);
  const y = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}
