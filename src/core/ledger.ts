import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { Allowance, Surface } from "./types.js";

// The ledger holds what odr itself recorded: connections, reservations and measured usage.
// Every write goes through withLock(), so concurrent workers on one machine cannot both spend the
// same remaining allowance. Where a provider exposes a usage API, `odr reconcile` records the
// provider's own figure and the router trusts it over the local estimate.
// The ledger stores no credentials and no private session handles.

export interface Connection {
  connected_at: string;
  /** Plan on the provider account, e.g. "starter". Undefined = default free plan. */
  plan?: string;
  /** Narrows the provider's surfaces, e.g. a Linux machine that cannot run iOS Simulator. */
  surfaces?: Surface[];
  /** Set by the user after the provider approved them for its open-source program. */
  oss_program?: boolean;
  /** Optional monthly spend ceiling for budget routing on this provider, in USD. */
  max_usd_month?: number;
}

export interface UsageEvent {
  provider: string;
  allowance: number;
  amount: number;
  minutes: number;
  surface: Surface;
  at: string;
  /** odr = measured by odr; provider = adjustment from the provider's usage API; manual = `odr debit`. */
  source?: "odr" | "provider" | "manual";
  reservation?: string;
  usd?: number;
  note?: string;
}

export type ReservationStatus =
  | "reserved"
  | "active"
  | "releasing"
  | "closed"
  | "closure_unverified"
  | "refused";

export interface Reservation {
  id: string;
  provider: string;
  allowance: number;
  surface: Surface;
  minutes: number;
  amount: number;
  usd: number;
  created_at: string;
  heartbeat_at: string;
  /** A reservation whose heartbeat lapses past this is treated as a lost worker by `odr sweep`. */
  expires_at: string;
  owner: { pid: number; host: string };
  status: ReservationStatus;
  /** Non-secret cleanup locator written by the driver before it asks the provider for a device. */
  locator?: Record<string, string | number | boolean>;
  closed_at?: string;
  closure?: string;
}

export interface Reconciliation {
  provider: string;
  at: string;
  period: string;
  provider_minutes: number;
  local_minutes: number;
}

export interface State {
  version: 2;
  connections: Record<string, Connection>;
  usage: UsageEvent[];
  reservations: Reservation[];
  reconciliations: Reconciliation[];
}

export function odrHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ODR_HOME ?? join(homedir(), ".opendevicerouter");
}

export function emptyState(): State {
  return { version: 2, connections: {}, usage: [], reservations: [], reconciliations: [] };
}

export function loadState(home: string = odrHome()): State {
  const file = join(home, "state.json");
  if (!existsSync(file)) return emptyState();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { version: number; connections?: State["connections"]; usage?: State["usage"] };
  if (parsed.version === 1) {
    return { ...emptyState(), connections: parsed.connections ?? {}, usage: parsed.usage ?? [] };
  }
  if (parsed.version !== 2) throw new Error(`unsupported state version in ${file}`);
  return { ...emptyState(), ...(parsed as unknown as State) };
}

export function saveState(state: State, home: string = odrHome()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_STALE_MS = 30_000;

/**
 * Runs `fn` on the current state while holding an exclusive lock on the ledger, then saves it.
 * The lock is a directory, created atomically. A lock left by a dead process on this host, or older
 * than 30 s, is broken.
 */
export function withLock<T>(home: string, fn: (state: State) => T, timeoutMs = 15_000): T {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "state.lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (lockIsStale(lock)) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the ledger lock at ${lock}`);
      sleepSync(5 + Math.floor(Math.random() * 20));
    }
  }
  try {
    const state = loadState(home);
    const result = fn(state);
    saveState(state, home);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function lockIsStale(lock: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid: number; host: string; at: number };
    if (owner.host === hostname() && !pidAlive(owner.pid)) return true;
    return Date.now() - owner.at > LOCK_STALE_MS;
  } catch {
    // Directory exists but owner.json is not written yet, or is unreadable. Judge by age.
    try {
      return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

const DAY_MS = 86_400_000;

export interface Window {
  start: Date;
  /** When the allowance stops being usable. Undefined when it does not lapse. */
  end?: Date;
}

/** The period over which usage counts against an allowance. Daily and monthly use UTC boundaries. */
export function allowanceWindow(a: Allowance, connection: Connection, now: Date): Window {
  const connected = new Date(connection.connected_at);
  if (a.type === "daily") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start, end: new Date(start.getTime() + DAY_MS) };
  }
  if (a.type === "monthly") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { start, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  }
  const end = a.expires_days ? new Date(connected.getTime() + a.expires_days * DAY_MS) : undefined;
  return end ? { start: connected, end } : { start: connected };
}

function inWindow(at: string, window: Window): boolean {
  const t = Date.parse(at);
  if (t < window.start.getTime()) return false;
  return !(window.end && t >= window.end.getTime());
}

export function usedInWindow(state: State, provider: string, allowance: number, window: Window): number {
  let used = 0;
  for (const u of state.usage) {
    if (u.provider !== provider || u.allowance !== allowance) continue;
    if (inWindow(u.at, window)) used += u.amount;
  }
  return used;
}

/** Reservations that still hold capacity: running, releasing, or not yet proven closed. */
export function holdsCapacity(r: Reservation): boolean {
  return r.status === "reserved" || r.status === "active" || r.status === "releasing" || r.status === "closure_unverified";
}

export function reservedInWindow(state: State, provider: string, allowance: number, window: Window): number {
  let held = 0;
  for (const r of state.reservations) {
    if (r.provider !== provider || r.allowance !== allowance || !holdsCapacity(r)) continue;
    if (inWindow(r.created_at, window)) held += r.amount;
  }
  return held;
}

export function openSessions(state: State, provider: string): number {
  return state.reservations.filter((r) => r.provider === provider && holdsCapacity(r)).length;
}

export interface Remaining {
  /** Infinity for unlimited allowances. In the allowance's own unit. Already net of open reservations. */
  remaining: number;
  used: number;
  reserved: number;
  expired: boolean;
  window: Window;
}

export function remainingFor(
  state: State,
  provider: string,
  index: number,
  a: Allowance,
  connection: Connection,
  now: Date,
): Remaining {
  const window = allowanceWindow(a, connection, now);
  const expired = window.end !== undefined && now.getTime() >= window.end.getTime();
  const used = usedInWindow(state, provider, index, window);
  const reserved = reservedInWindow(state, provider, index, window);
  if (a.unit === "unlimited") return { remaining: Infinity, used, reserved, expired, window };
  const remaining = expired ? 0 : Math.max(0, (a.amount ?? 0) - used - reserved);
  return { remaining, used, reserved, expired, window };
}

/** USD odr has recorded or reserved on a provider this UTC month. */
export function spentThisMonth(state: State, provider: string, now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  let usd = 0;
  for (const u of state.usage) if (u.provider === provider && Date.parse(u.at) >= start) usd += u.usd ?? 0;
  for (const r of state.reservations) {
    if (r.provider === provider && holdsCapacity(r) && Date.parse(r.created_at) >= start) usd += r.usd;
  }
  return usd;
}

/** Units of an allowance consumed by `minutes` on `surface`, or undefined when it cannot be metered. */
export function costInUnits(a: Allowance, surface: Surface, minutes: number): number | undefined {
  switch (a.unit) {
    case "unlimited":
      return 0;
    case "device_minute":
    case "browser_minute":
    case "minute":
      return minutes;
    default: {
      const rate = a.per_minute?.[surface];
      return rate === undefined ? undefined : rate * minutes;
    }
  }
}

export function newReservationId(): string {
  return `r_${randomBytes(8).toString("hex")}`;
}

export function lastReconciliation(state: State, provider: string): Reconciliation | undefined {
  return state.reconciliations.filter((r) => r.provider === provider).sort((a, b) => b.at.localeCompare(a.at))[0];
}
