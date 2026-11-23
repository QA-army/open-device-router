import {
  costInUnits,
  lastReconciliation,
  openSessions,
  remainingFor,
  spentThisMonth,
  type State,
} from "./ledger.js";
import {
  deviceOf,
  surfaceOf,
  type Allowance,
  type AllowanceType,
  type BuildFormat,
  type DeviceKind,
  type DeviceProfile,
  type Input,
  type Key,
  type Platform,
  type Provider,
  type Surface,
} from "./types.js";

// Deterministic router. Same request, registry and ledger give the same decision.
// Default spend policy is free-only: it never picks capacity that could bill. Budget mode is opt-in
// per request and capped in USD.

export type SpendPolicy = { mode: "free-only" } | { mode: "budget"; max_usd: number };

export interface RouteRequest {
  /** Either surface, or platform (+ kind). */
  surface?: Surface;
  platform?: Platform;
  kind?: DeviceKind;
  /** Case-insensitive substring of the profile model, e.g. "iPhone 16 Pro" or "pixel". */
  model?: string;
  /** "18.2", "18" (any 18.x), ">=17", "<=15", or "*". */
  os?: string;
  build_format?: BuildFormat;
  needs?: Input[];
  keys?: Key[];
  minutes: number;
  parallel?: number;
  spend?: SpendPolicy;
  /** Only consider this provider. */
  provider?: string;
  /** True when the caller will drive the device (SDK, `odr run`). Providers without a control path are skipped. */
  require_control?: boolean;
}

export type SkipReason =
  | "not_selected"
  | "not_connected"
  | "other_plan"
  | "surface_not_offered"
  | "surface_not_available_here"
  | "no_verified_control_path"
  | "control_path_does_not_cover_surface"
  | "no_session_driver"
  | "screenshot_not_guaranteed"
  | "input_not_supported"
  | "key_not_supported"
  | "build_format_not_supported"
  | "no_matching_profile"
  | "allowance_does_not_cover_surface"
  | "manual_only"
  | "renewal_unverified"
  | "oss_program_not_confirmed"
  | "cannot_meter_unit"
  | "session_longer_than_cap"
  | "parallel_over_cap"
  | "allowance_expired"
  | "not_enough_remaining"
  | "overage_unverified"
  | "overage_bills_remaining_unverified"
  | "overage_rate_unknown"
  | "over_budget"
  | "over_monthly_cap";

/** How sure odr is that the remaining allowance is real. */
export type RemainingBasis = "unlimited" | "provider_reconciled" | "provider_stops" | "local_estimate";

export interface Candidate {
  provider: string;
  allowance: number;
  plan?: string;
  type: AllowanceType;
  unit: Allowance["unit"];
  cost: number;
  remaining: number;
  usd: number;
  profile?: string;
  basis?: RemainingBasis;
  eligible: boolean;
  skip?: SkipReason;
  detail?: string;
}

export interface Decision {
  request: RouteRequest;
  chosen?: Candidate;
  considered: Candidate[];
  reason: string;
}

/** Capacity that costs nothing or renews soonest is spent first; one-time trials are kept for last. */
export const TYPE_ORDER: AllowanceType[] = [
  "self_hosted",
  "public_repo",
  "daily",
  "monthly",
  "oss_program",
  "one_time",
];

const RECONCILE_FRESH_MS = 24 * 3_600_000;

export function resolveSurface(req: RouteRequest): Surface {
  if (req.surface) return req.surface;
  if (!req.platform) throw new Error("request needs a surface or a platform");
  const kind = req.kind ?? (req.platform === "ios" ? "simulator" : req.platform === "android" ? "emulator" : "browser");
  const surface = surfaceOf(req.platform, kind);
  if (!surface) throw new Error(`no surface for ${req.platform} ${kind}`);
  return surface;
}

function versionParts(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));
}

function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when a profile's OS satisfies the request. A wildcard profile satisfies any request. */
export function osMatches(profileOs: string, wanted?: string): boolean {
  if (!wanted || wanted === "*" || profileOs === "*") return true;
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(wanted.trim());
  if (!m) return false;
  const op = m[1] ?? "";
  const v = m[2] ?? "";
  const c = compareVersions(profileOs, v);
  switch (op) {
    case ">=":
      return c >= 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case "<":
      return c < 0;
    default: {
      // "18" matches 18, 18.0, 18.2; "18.2" matches 18.2 and 18.2.x.
      const want = versionParts(v);
      const have = versionParts(profileOs);
      return want.every((n, i) => have[i] === n);
    }
  }
}

export function matchProfile(p: Provider, req: RouteRequest, surface: Surface): DeviceProfile | undefined {
  const { platform, kind } = deviceOf(surface);
  const profiles = (p.profiles ?? []).filter((x) => x.platform === platform && x.kind === kind);
  const ok = profiles.filter(
    (x) =>
      (!req.model || x.model === "*" || x.model.toLowerCase().includes(req.model.toLowerCase()) ||
        x.provider_device?.toLowerCase() === req.model.toLowerCase()) &&
      osMatches(x.os, req.os),
  );
  // Exact profiles first, wildcards last.
  return ok.sort((a, b) => Number(a.model === "*") - Number(b.model === "*") || Number(a.os === "*") - Number(b.os === "*"))[0];
}

function evaluate(
  p: Provider,
  index: number,
  a: Allowance,
  req: RouteRequest,
  surface: Surface,
  state: State,
  now: Date,
): Candidate {
  const base: Candidate = {
    provider: p.id,
    allowance: index,
    plan: a.plan,
    type: a.type,
    unit: a.unit,
    cost: 0,
    remaining: 0,
    usd: 0,
    eligible: false,
  };
  const skip = (reason: SkipReason, extra: Partial<Candidate> = {}): Candidate => ({ ...base, ...extra, eligible: false, skip: reason });

  if (req.provider && req.provider !== p.id) return skip("not_selected");
  const connection = state.connections[p.id];
  if (!connection) return skip("not_connected");
  if ((a.plan ?? undefined) !== (connection.plan ?? undefined)) {
    return skip("other_plan", { detail: `connected plan is ${connection.plan ?? "free"}` });
  }
  if (!p.surfaces.includes(surface)) return skip("surface_not_offered");
  if (connection.surfaces && !connection.surfaces.includes(surface)) return skip("surface_not_available_here");
  if (p.hands.kind === "unknown") return skip("no_verified_control_path");
  if (p.hands.surfaces && !p.hands.surfaces.includes(surface)) return skip("control_path_does_not_cover_surface");

  let profile: DeviceProfile | undefined;
  const drives = req.require_control || (req.needs?.length ?? 0) > 0 || req.keys?.length || req.build_format || req.model || req.os;
  if (drives) {
    const c = p.control;
    if (!c) return skip("no_session_driver");
    if (c.screenshot !== "whole_session") return skip("screenshot_not_guaranteed");
    const missing = (req.needs ?? []).filter((n) => !c.inputs.includes(n));
    if (req.build_format && !missing.includes("install") && !c.inputs.includes("install")) missing.push("install");
    if (missing.length) return skip("input_not_supported", { detail: missing.join(",") });
    const missingKeys = (req.keys ?? []).filter((k) => !(c.keys ?? []).includes(k));
    if (missingKeys.length) return skip("key_not_supported", { detail: missingKeys.join(",") });
    if (req.build_format && (c.install === "none" || !c.build_formats.includes(req.build_format))) {
      return skip("build_format_not_supported", { detail: req.build_format });
    }
    profile = matchProfile(p, req, surface);
    if (!profile) return skip("no_matching_profile");
  }
  base.profile = profile?.id;

  if (a.surfaces && !a.surfaces.includes(surface)) return skip("allowance_does_not_cover_surface");
  if (a.manual_only) return skip("manual_only");
  if (a.type === "unverified") return skip("renewal_unverified");
  if (a.type === "oss_program" && !connection.oss_program) return skip("oss_program_not_confirmed");

  const cost = costInUnits(a, surface, req.minutes);
  if (cost === undefined) return skip("cannot_meter_unit");
  base.cost = cost;
  const cap = Math.min(a.max_session_minutes ?? Infinity, p.control?.max_session_minutes ?? Infinity);
  if (req.minutes > cap) return skip("session_longer_than_cap", { detail: `cap ${cap} min` });
  const parallel = req.parallel ?? 1;
  if (a.max_parallel !== undefined && openSessions(state, p.id) + parallel > a.max_parallel) {
    return skip("parallel_over_cap", { detail: `${openSessions(state, p.id)} open, cap ${a.max_parallel}` });
  }

  const left = remainingFor(state, p.id, index, a, connection, now);
  const rec = lastReconciliation(state, p.id);
  let remaining = left.remaining;
  let basis: RemainingBasis = a.unit === "unlimited" ? "unlimited" : "local_estimate";
  if (rec && now.getTime() - Date.parse(rec.at) < RECONCILE_FRESH_MS && Date.parse(rec.at) >= left.window.start.getTime()) {
    // Trust the provider's figure when it is higher than what odr recorded.
    const extra = Math.max(0, rec.provider_minutes - left.used);
    remaining = Math.max(0, remaining - extra);
    basis = "provider_reconciled";
  } else if (a.overage === "stops" || a.overage === "throttled") {
    basis = "provider_stops";
  }
  base.remaining = remaining;
  base.basis = basis;
  if (left.expired) return skip("allowance_expired");

  const spend = req.spend ?? { mode: "free-only" };
  const shortfall = Math.max(0, cost - remaining);
  if (a.overage === "unknown") return skip("overage_unverified");
  if (spend.mode === "free-only") {
    if (shortfall > 0) return skip("not_enough_remaining");
    if (a.overage === "bills" && basis !== "provider_reconciled") {
      return skip("overage_bills_remaining_unverified", { detail: "run `odr reconcile` or pass a budget" });
    }
    return { ...base, eligible: true };
  }
  // Budget mode.
  if (shortfall > 0 && a.overage !== "bills") return skip("not_enough_remaining");
  let usd = 0;
  if (a.overage === "bills") {
    if (a.overage_usd_per_minute === undefined) return skip("overage_rate_unknown");
    // Without a fresh provider figure, assume the whole session may be billed.
    const billable = basis === "provider_reconciled" ? shortfall : cost;
    usd = Math.round(billable * a.overage_usd_per_minute * 100) / 100;
  }
  if (usd > spend.max_usd) return skip("over_budget", { usd, detail: `needs up to $${usd}` });
  if (connection.max_usd_month !== undefined && spentThisMonth(state, p.id, now) + usd > connection.max_usd_month) {
    return skip("over_monthly_cap", { usd });
  }
  return { ...base, usd, eligible: true };
}

function rank(c: Candidate): number {
  const i = TYPE_ORDER.indexOf(c.type);
  return i === -1 ? TYPE_ORDER.length : i;
}

export function route(req: RouteRequest, providers: Provider[], state: State, now: Date = new Date()): Decision {
  if (!(req.minutes > 0)) throw new Error("minutes must be greater than 0");
  if (req.parallel !== undefined && !(Number.isInteger(req.parallel) && req.parallel >= 1)) {
    throw new Error("parallel must be a whole number of at least 1");
  }
  if (req.spend?.mode === "budget" && !(req.spend.max_usd >= 0)) throw new Error("budget needs max_usd >= 0");
  const surface = resolveSurface(req);
  const considered: Candidate[] = [];
  for (const p of providers) {
    p.allowances.forEach((a, i) => considered.push(evaluate(p, i, a, req, surface, state, now)));
  }
  const eligible = considered
    .filter((c) => c.eligible)
    .sort(
      (a, b) =>
        a.usd - b.usd ||
        rank(a) - rank(b) ||
        b.remaining - b.cost - (a.remaining - a.cost) ||
        a.provider.localeCompare(b.provider) ||
        a.allowance - b.allowance,
    );
  const chosen = eligible[0];
  if (!chosen) {
    const free = (req.spend ?? { mode: "free-only" }).mode === "free-only";
    return {
      request: req,
      considered,
      reason: free
        ? "No connected provider can serve this request from free capacity that odr can verify. odr refuses rather than risk a bill."
        : "No connected provider can serve this request within the budget.",
    };
  }
  return {
    request: req,
    chosen,
    considered,
    reason:
      chosen.usd > 0
        ? `${chosen.provider}: up to $${chosen.usd} within the $${(req.spend as { max_usd: number }).max_usd} budget.`
        : `${chosen.provider}: ${chosen.type} allowance (${chosen.basis}), first in the order ${TYPE_ORDER.join(" > ")}.`,
  };
}
