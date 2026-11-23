import type { RemainingBasis, RouteRequest } from "../core/router.js";
import type { AllowanceUnit, Surface } from "../core/types.js";
import type { ClosureResult, DeviceIdentity } from "./types.js";

export const RECEIPT_SCHEMA = "odr.receipt/v1";

export type Outcome = "ok" | "failed" | "cancelled" | "worker_lost" | "refused";

/**
 * Versioned, machine-readable record of one session. Contains no credentials and no private
 * session handle; safe to attach to CI logs.
 */
export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  id: string;
  odr_version: string;
  created_at: string;
  closed_at?: string;
  request: RouteRequest;
  route?: {
    provider: string;
    allowance: number;
    plan?: string;
    profile?: string;
    surface: Surface;
    basis?: RemainingBasis;
    usd_reserved: number;
    reason: string;
  };
  device?: DeviceIdentity;
  /** All durations in milliseconds. run_to_first_frame is measured from the allocate() call. */
  timings_ms: {
    queue?: number;
    upload?: number;
    allocate?: number;
    provider_queue?: number;
    install?: number;
    launch?: number;
    first_frame?: number;
    run_to_first_frame?: number;
    session?: number;
    teardown?: number;
  };
  health: {
    heartbeats: number;
    heartbeat_failures: number;
    screenshots_ok: number;
    screenshots_failed: number;
    dropped: boolean;
    dropped_reason?: string;
  };
  usage?: {
    minutes: number;
    amount: number;
    unit: AllowanceUnit;
    usd_estimate: number;
    provider_minutes?: number;
    source: "odr" | "provider";
  };
  closure: ClosureResult | { status: "not_started"; method: "none" };
  outcome: Outcome;
  error?: { code: string; message: string };
}
