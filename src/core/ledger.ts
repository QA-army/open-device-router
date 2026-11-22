import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Allowance, Surface } from "./types.js";

// The ledger is a local estimate built from what odr itself recorded. It is not the
// provider's own usage figure; reconciling against provider usage APIs is on the roadmap.
// It stores no credentials.

export interface Connection {
  connected_at: string;
  /** Narrows the provider's surfaces, e.g. a Linux machine that cannot run iOS Simulator. */
  surfaces?: Surface[];
  /** Set by the user after the provider approved them for its open-source program. */
  oss_program?: boolean;
}

export interface UsageEvent {
  provider: string;
  allowance: number;
  amount: number;
  minutes: number;
  surface: Surface;
  at: string;
  note?: string;
}

export interface State {
  version: 1;
  connections: Record<string, Connection>;
  usage: UsageEvent[];
}

export function odrHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ODR_HOME ?? join(homedir(), ".opendevicerouter");
}

export function emptyState(): State {
  return { version: 1, connections: {}, usage: [] };
}

export function loadState(home: string = odrHome()): State {
  const file = join(home, "state.json");
  if (!existsSync(file)) return emptyState();
  const parsed = JSON.parse(readFileSync(file, "utf8")) as State;
  if (parsed.version !== 1) throw new Error(`unsupported state version in ${file}`);
  return parsed;
}

export function saveState(state: State, home: string = odrHome()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, "state.json");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
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

export function usedInWindow(state: State, provider: string, allowance: number, window: Window): number {
  let used = 0;
  for (const u of state.usage) {
    if (u.provider !== provider || u.allowance !== allowance) continue;
    const at = Date.parse(u.at);
    if (at < window.start.getTime()) continue;
    if (window.end && at >= window.end.getTime()) continue;
    used += u.amount;
  }
  return used;
}

export interface Remaining {
  /** Infinity for unlimited allowances. In the allowance's own unit. */
  remaining: number;
  used: number;
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
  if (a.unit === "unlimited") return { remaining: Infinity, used, expired, window };
  const remaining = expired ? 0 : Math.max(0, (a.amount ?? 0) - used);
  return { remaining, used, expired, window };
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
