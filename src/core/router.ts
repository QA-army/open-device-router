import { costInUnits, remainingFor, type State } from "./ledger.js";
import type { Allowance, AllowanceType, Provider, Surface } from "./types.js";

// Stage 1 router: deterministic. Same request, registry and ledger give the same decision.
// It only ever picks free capacity. There is no paid path in this code.

export interface RouteRequest {
  surface: Surface;
  minutes: number;
  parallel?: number;
}

export type SkipReason =
  | "not_connected"
  | "surface_not_offered"
  | "surface_not_available_here"
  | "no_verified_control_path"
  | "control_path_does_not_cover_surface"
  | "allowance_does_not_cover_surface"
  | "manual_only"
  | "renewal_unverified"
  | "oss_program_not_confirmed"
  | "cannot_meter_unit"
  | "session_longer_than_cap"
  | "parallel_over_cap"
  | "allowance_expired"
  | "not_enough_remaining";

export interface Candidate {
  provider: string;
  allowance: number;
  type: AllowanceType;
  unit: Allowance["unit"];
  cost: number;
  remaining: number;
  eligible: boolean;
  skip?: SkipReason;
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

function evaluate(p: Provider, index: number, a: Allowance, req: RouteRequest, state: State, now: Date): Candidate {
  const base = { provider: p.id, allowance: index, type: a.type, unit: a.unit, cost: 0, remaining: 0 };
  const skip = (reason: SkipReason): Candidate => ({ ...base, eligible: false, skip: reason });

  const connection = state.connections[p.id];
  if (!connection) return skip("not_connected");
  if (!p.surfaces.includes(req.surface)) return skip("surface_not_offered");
  if (connection.surfaces && !connection.surfaces.includes(req.surface)) return skip("surface_not_available_here");
  if (p.hands.kind === "unknown") return skip("no_verified_control_path");
  if (p.hands.surfaces && !p.hands.surfaces.includes(req.surface)) return skip("control_path_does_not_cover_surface");
  if (a.surfaces && !a.surfaces.includes(req.surface)) return skip("allowance_does_not_cover_surface");
  if (a.manual_only) return skip("manual_only");
  if (a.type === "unverified") return skip("renewal_unverified");
  if (a.type === "oss_program" && !connection.oss_program) return skip("oss_program_not_confirmed");

  const cost = costInUnits(a, req.surface, req.minutes);
  if (cost === undefined) return skip("cannot_meter_unit");
  if (a.max_session_minutes !== undefined && req.minutes > a.max_session_minutes) {
    return { ...skip("session_longer_than_cap"), cost };
  }
  if (a.max_parallel !== undefined && (req.parallel ?? 1) > a.max_parallel) {
    return { ...skip("parallel_over_cap"), cost };
  }

  const left = remainingFor(state, p.id, index, a, connection, now);
  if (left.expired) return { ...skip("allowance_expired"), cost };
  if (left.remaining < cost) return { ...skip("not_enough_remaining"), cost, remaining: left.remaining };
  return { ...base, cost, remaining: left.remaining, eligible: true };
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
  const considered: Candidate[] = [];
  for (const p of providers) {
    p.allowances.forEach((a, i) => considered.push(evaluate(p, i, a, req, state, now)));
  }
  const eligible = considered
    .filter((c) => c.eligible)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        b.remaining - b.cost - (a.remaining - a.cost) ||
        a.provider.localeCompare(b.provider) ||
        a.allowance - b.allowance,
    );
  const chosen = eligible[0];
  if (!chosen) {
    return {
      request: req,
      considered,
      reason:
        "No connected provider has enough free capacity for this request. odr stops here: it has no paid path.",
    };
  }
  return {
    request: req,
    chosen,
    considered,
    reason: `${chosen.provider}: ${chosen.type} allowance, first in the order ${TYPE_ORDER.join(" > ")}.`,
  };
}
