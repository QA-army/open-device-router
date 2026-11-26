import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  costInUnits,
  newReservationId,
  odrHome,
  pidAlive,
  withLock,
  type Reservation,
  type State,
} from "../core/ledger.js";
import { resolveSurface, route, type Candidate, type Decision, type RouteRequest } from "../core/router.js";
import type { DeviceProfile, Input, Key, Provider, Size } from "../core/types.js";
import { loadRegistry } from "../registry/load.js";
import { frameProblem, pngSize } from "./png.js";
import { RECEIPT_SCHEMA, type Outcome, type Receipt } from "./receipt.js";
import type {
  AllocateContext,
  BuildSource,
  ClosureResult,
  DeviceIdentity,
  Driver,
  DriverModule,
  Locator,
  Point,
  Screenshot,
} from "./types.js";
import { VERSION } from "../version.js";

export class RouteRefusedError extends Error {
  readonly code = "route_refused";
  constructor(readonly decision: Decision, readonly receipt: Receipt) {
    super(decision.reason);
  }
}

export class SessionError extends Error {
  constructor(readonly code: string, message: string, readonly receipt?: Receipt) {
    super(message);
  }
}

export interface AllocateOptions {
  /** Ledger directory. Defaults to ODR_HOME or ~/.opendevicerouter. */
  home?: string;
  providers?: Provider[];
  /** Build to install. Required format must be offered by the provider. */
  build?: BuildSource;
  /** App to launch after install: a bundle id/package, or true to launch the installed build. Default true when a build is given. */
  launch?: string | boolean;
  tenant?: string;
  runId?: string;
  /** Heartbeat interval. Each heartbeat renews the reservation and takes a probe screenshot. Default 20 s. */
  heartbeatMs?: number;
  /** Give up on the first usable frame after this long. Default 180 s. */
  firstFrameTimeoutMs?: number;
  /** Take a screenshot on each heartbeat to prove the device can still be captured. Default true. */
  probeScreenshots?: boolean;
  /** Release on SIGINT, SIGTERM, uncaught exceptions and process exit. Default true. */
  handleSignals?: boolean;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Driver modules by control driver name. Tests inject fakes here. */
  drivers?: Partial<Record<string, DriverModule>>;
}

async function builtinDriver(name: string): Promise<DriverModule> {
  if (name === "agent-device") return (await import("./drivers/agent-device.js")).agentDeviceDriver;
  if (name === "appetize-cli") return (await import("./drivers/appetize.js")).appetizeDriver;
  if (name === "aws-device-farm") return (await import("./drivers/aws-device-farm.js")).awsDeviceFarmDriver;
  if (name === "stub") return (await import("./drivers/stub.js")).stubDriver;
  throw new SessionError("no_driver", `no driver named ${name}`);
}

export async function driverModule(name: string, drivers?: AllocateOptions["drivers"]): Promise<DriverModule> {
  return drivers?.[name] ?? (await builtinDriver(name));
}

const live = new Set<OdrSession>();
let hooked = false;

function hookProcess(): void {
  if (hooked) return;
  hooked = true;
  const releaseAll = async (outcome: Outcome) => {
    await Promise.allSettled([...live].map((s) => s.release(outcome)));
  };
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(sig, () => {
      void releaseAll("cancelled").finally(() => process.exit(code));
    });
  }
  process.on("uncaughtException", (error) => {
    console.error(error);
    void releaseAll("failed").finally(() => process.exit(1));
  });
  process.on("beforeExit", () => {
    if (live.size) void releaseAll("cancelled");
  });
}

function writeReceipt(home: string, receipt: Receipt): string {
  const dir = join(home, "receipts");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${receipt.id}.json`);
  writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function updateReservation(home: string, id: string, patch: (r: Reservation, s: State) => void): void {
  withLock(home, (state) => {
    const r = state.reservations.find((x) => x.id === id);
    if (r) patch(r, state);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A device session. Every input goes through the provider's own control path. */
export class OdrSession {
  readonly id: string;
  readonly provider: string;
  device!: DeviceIdentity;
  readonly profile: DeviceProfile;
  readonly receiptFile: string;
  #driver: Driver;
  #home: string;
  #receipt: Receipt;
  #candidate: Candidate;
  #provider: Provider;
  #timer?: NodeJS.Timeout;
  #releasing?: Promise<Receipt>;
  #activeAt?: number;
  #misses = 0;
  #size?: Size;
  #opts: AllocateOptions;

  constructor(args: {
    id: string;
    provider: Provider;
    profile: DeviceProfile;
    driver: Driver;
    home: string;
    receipt: Receipt;
    candidate: Candidate;
    opts: AllocateOptions;
  }) {
    this.id = args.id;
    this.provider = args.provider.id;
    this.#provider = args.provider;
    this.profile = args.profile;
    this.#driver = args.driver;
    this.#home = args.home;
    this.#receipt = args.receipt;
    this.#candidate = args.candidate;
    this.#opts = args.opts;
    this.receiptFile = join(args.home, "receipts", `${args.id}.json`);
  }

  /** Private provider handle (session id, viewer URL, adb serial). Never written to the receipt. */
  handle(): Record<string, unknown> {
    return this.#driver.handle();
  }

  /** A copy of the receipt so far. */
  receipt(): Receipt {
    return structuredClone(this.#receipt);
  }

  get released(): boolean {
    return this.#releasing !== undefined;
  }

  #guard(input: Input): void {
    if (this.#releasing) throw new SessionError("released", "session already released");
    if (this.#receipt.health.dropped) throw new SessionError("session_dropped", this.#receipt.health.dropped_reason ?? "session dropped");
    const c = this.#provider.control!;
    if (!c.inputs.includes(input)) throw new SessionError("input_not_supported", `${this.provider} does not support ${input}`);
  }

  async screenshot(): Promise<Screenshot> {
    this.#guard("screenshot");
    try {
      const shot = await this.#driver.screenshot();
      if (!pngSize(shot.png)) throw new Error("provider returned a non-PNG screenshot");
      this.#receipt.health.screenshots_ok++;
      this.#size = shot.input;
      return shot;
    } catch (error) {
      this.#receipt.health.screenshots_failed++;
      throw error;
    }
  }

  /** Input coordinate space. Taken from the last screenshot, else the device profile. */
  async size(): Promise<Size> {
    if (this.#size) return this.#size;
    if (this.profile.logical) return this.profile.logical;
    return (await this.screenshot()).input;
  }

  async tap(x: number, y: number, opts?: { durationMs?: number }): Promise<void> {
    this.#guard("tap");
    await this.#driver.tap({ x, y }, opts);
  }

  async type(text: string): Promise<void> {
    this.#guard("type");
    await this.#driver.type(text);
  }

  async swipe(from: Point, to: Point, opts?: { durationMs?: number }): Promise<void> {
    this.#guard("swipe");
    await this.#driver.swipe(from, to, opts);
  }

  async key(k: Key): Promise<void> {
    this.#guard("key");
    if (!(this.#provider.control!.keys ?? []).includes(k)) throw new SessionError("key_not_supported", `${this.provider} does not support key ${k}`);
    await this.#driver.key(k);
  }

  async install(build: BuildSource): Promise<string | undefined> {
    this.#guard("install");
    return this.#driver.install(build);
  }

  async launch(appId: string): Promise<void> {
    this.#guard("launch");
    await this.#driver.launch(appId);
  }

  async heartbeat(): Promise<void> {
    if (this.#releasing) return;
    const h = this.#receipt.health;
    try {
      await this.#driver.heartbeat();
      if (this.#opts.probeScreenshots !== false) await this.screenshot();
      h.heartbeats++;
      this.#misses = 0;
      const ttl = Math.max((this.#opts.heartbeatMs ?? 20_000) * 3, 60_000);
      updateReservation(this.#home, this.id, (r) => {
        r.heartbeat_at = new Date().toISOString();
        r.expires_at = new Date(Date.now() + ttl).toISOString();
      });
    } catch (error) {
      h.heartbeat_failures++;
      this.#misses++;
      if (this.#misses >= 2 && !h.dropped) {
        h.dropped = true;
        h.dropped_reason = `screenshot_lost: ${(error as Error).message}`;
      }
    }
  }

  /** @internal */
  _startHeartbeat(): void {
    this.#activeAt = Date.now();
    const every = this.#opts.heartbeatMs ?? 20_000;
    this.#timer = setInterval(() => void this.heartbeat(), every);
    this.#timer.unref();
  }

  /** Stops the device and verifies closure. Safe to call more than once; later calls return the same receipt. */
  release(outcome: Outcome = "ok", error?: unknown): Promise<Receipt> {
    if (this.#releasing) return this.#releasing;
    this.#releasing = this.#release(outcome, error);
    return this.#releasing;
  }

  async #release(outcome: Outcome, error?: unknown): Promise<Receipt> {
    if (this.#timer) clearInterval(this.#timer);
    const rc = this.#receipt;
    if (error && !rc.error) {
      rc.error = { code: (error as { code?: string }).code ?? "error", message: (error as Error).message ?? String(error) };
    }
    if (rc.health.dropped && outcome === "ok") outcome = "failed";
    rc.outcome = outcome;
    updateReservation(this.#home, this.id, (r) => {
      r.status = "releasing";
    });
    const t = Date.now();
    let closure: ClosureResult;
    try {
      await this.#driver.release();
    } catch (e) {
      rc.error ??= { code: "release_failed", message: (e as Error).message };
    }
    try {
      closure = await this.#driver.verifyClosed();
    } catch (e) {
      closure = { status: "failed", method: "none", detail: (e as Error).message };
    }
    rc.timings_ms.teardown = Date.now() - t;
    rc.closure = closure;
    const ended = Date.now();
    const minutes = this.#activeAt ? Math.round(((ended - this.#activeAt) / 60_000) * 100) / 100 : 0;
    rc.timings_ms.session = this.#activeAt ? ended - this.#activeAt : 0;
    let providerMinutes: number | undefined;
    try {
      providerMinutes = await this.#driver.providerMinutes?.();
    } catch {
      providerMinutes = undefined;
    }
    const a = this.#provider.allowances[this.#candidate.allowance]!;
    const surface = rc.route!.surface;
    const billed = providerMinutes ?? minutes;
    const amount = costInUnits(a, surface, billed) ?? 0;
    const rate = a.overage === "bills" ? (a.overage_usd_per_minute ?? 0) : 0;
    const usd = Math.round(Math.max(0, amount - this.#candidate.remaining) * rate * 100) / 100;
    rc.usage = {
      minutes,
      amount,
      unit: a.unit,
      usd_estimate: usd,
      ...(providerMinutes !== undefined ? { provider_minutes: providerMinutes } : {}),
      source: providerMinutes !== undefined ? "provider" : "odr",
    };
    rc.closed_at = new Date().toISOString();
    updateReservation(this.#home, this.id, (r, state) => {
      r.status = closure.status === "verified" ? "closed" : "closure_unverified";
      r.closed_at = rc.closed_at;
      r.closure = `${closure.status}:${closure.method}`;
      state.usage.push({
        provider: this.provider,
        allowance: this.#candidate.allowance,
        amount,
        minutes: billed,
        surface,
        at: rc.closed_at!,
        source: providerMinutes !== undefined ? "provider" : "odr",
        reservation: this.id,
        usd,
      });
    });
    writeReceipt(this.#home, rc);
    live.delete(this);
    return structuredClone(rc);
  }
}

function withDefaultNeeds(req: RouteRequest, opts: AllocateOptions): RouteRequest {
  const needs = new Set<Input>(req.needs ?? []);
  needs.add("screenshot");
  if (opts.build) needs.add("install");
  if (opts.launch || opts.build) needs.add("launch");
  return {
    ...req,
    needs: [...needs],
    build_format: req.build_format ?? opts.build?.format,
    require_control: true,
  };
}

function baseReceipt(id: string, request: RouteRequest): Receipt {
  return {
    schema: RECEIPT_SCHEMA,
    id,
    odr_version: VERSION,
    created_at: new Date().toISOString(),
    request,
    timings_ms: {},
    health: { heartbeats: 0, heartbeat_failures: 0, screenshots_ok: 0, screenshots_failed: 0, dropped: false },
    closure: { status: "not_started", method: "none" },
    outcome: "failed",
  };
}

/**
 * Reserves capacity, allocates a device, optionally installs and launches a build, and waits for
 * the first usable screenshot. If any step fails, the device is released before the error is thrown.
 */
export async function allocate(request: RouteRequest, opts: AllocateOptions = {}): Promise<OdrSession> {
  const t0 = Date.now();
  const env = opts.env ?? process.env;
  const home = opts.home ?? odrHome(env);
  const log = opts.log ?? (() => {});
  const providers = opts.providers ?? loadValidProviders();
  const req = withDefaultNeeds(request, opts);
  const surface = resolveSurface(req);
  const id = newReservationId();
  const receipt = baseReceipt(id, request);

  let decision!: Decision;
  withLock(home, (state) => {
    decision = route(req, providers, state, new Date());
    const c = decision.chosen;
    if (!c) return;
    const now = new Date();
    state.reservations.push({
      id,
      provider: c.provider,
      allowance: c.allowance,
      surface,
      minutes: req.minutes,
      amount: c.cost,
      usd: c.usd,
      created_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      // Allocation and upload get 15 minutes before a sweeper may treat this worker as lost.
      expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
      owner: { pid: process.pid, host: hostname() },
      status: "reserved",
    });
  });
  receipt.timings_ms.queue = Date.now() - t0;
  const chosen = decision.chosen;
  if (!chosen) {
    receipt.outcome = "refused";
    receipt.error = { code: "route_refused", message: decision.reason };
    writeReceipt(home, receipt);
    throw new RouteRefusedError(decision, receipt);
  }
  const provider = providers.find((p) => p.id === chosen.provider)!;
  const control = provider.control!;
  const profile = provider.profiles!.find((p) => p.id === chosen.profile)!;
  receipt.route = {
    provider: provider.id,
    allowance: chosen.allowance,
    ...(chosen.plan ? { plan: chosen.plan } : {}),
    profile: profile.id,
    surface,
    ...(chosen.basis ? { basis: chosen.basis } : {}),
    usd_reserved: chosen.usd,
    reason: decision.reason,
  };

  let mod: DriverModule;
  try {
    mod = await driverModule(control.driver, opts.drivers);
  } catch (error) {
    updateReservation(home, id, (r) => {
      r.status = "refused";
    });
    receipt.error = { code: "no_driver", message: (error as Error).message };
    writeReceipt(home, receipt);
    throw error;
  }
  const driver = mod.create();
  const session = new OdrSession({ id, provider, profile, driver, home, receipt, candidate: chosen, opts });
  live.add(session);
  if (opts.handleSignals !== false) hookProcess();
  const onAbort = () => void session.release("cancelled", new SessionError("cancelled", "aborted by caller"));
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  const ctx: AllocateContext = {
    reservation: id,
    request: req,
    provider,
    control,
    profile,
    build: opts.build,
    minutes: req.minutes,
    tenant: opts.tenant ?? env.ODR_TENANT ?? "odr",
    run_id: opts.runId ?? env.ODR_RUN_ID ?? id,
    env,
    log,
    onLocator: (locator: Locator) =>
      updateReservation(home, id, (r) => {
        r.locator = locator;
      }),
  };

  try {
    if (opts.build && control.install === "upload_before_allocation" && !opts.build.provider_build_id) {
      const t = Date.now();
      ctx.prepared_build = await driver.prepareBuild!(opts.build, ctx);
      receipt.timings_ms.upload = Date.now() - t;
    } else if (opts.build?.provider_build_id) {
      ctx.prepared_build = opts.build.provider_build_id;
    }
    if (opts.signal?.aborted) throw new SessionError("cancelled", "aborted by caller");
    const t = Date.now();
    const allocated = await driver.allocate(ctx);
    receipt.timings_ms.allocate = Date.now() - t;
    if (allocated.phases.provider_queue_ms !== undefined) receipt.timings_ms.provider_queue = allocated.phases.provider_queue_ms;
    if (allocated.phases.install_ms !== undefined) receipt.timings_ms.install = allocated.phases.install_ms;
    if (allocated.phases.launch_ms !== undefined) receipt.timings_ms.launch = allocated.phases.launch_ms;
    session.device = allocated.device;
    receipt.device = allocated.device;
    updateReservation(home, id, (r) => {
      r.status = "active";
    });

    let appId = allocated.launched_app ?? opts.build?.app_id;
    if (opts.build && control.install === "after_allocation") {
      const ti = Date.now();
      appId = (await driver.install(opts.build)) ?? appId;
      receipt.timings_ms.install = Date.now() - ti;
    }
    const target = typeof opts.launch === "string" ? opts.launch : opts.launch !== false && opts.build ? appId : undefined;
    if (opts.build && opts.launch !== false && !target) {
      throw new SessionError("launch_target_unknown", "installed the build but the app id is unknown; pass build.app_id");
    }
    if (target && !allocated.launched_app) {
      const tl = Date.now();
      await driver.launch(target);
      receipt.timings_ms.launch = Date.now() - tl;
    }

    const tf = Date.now();
    const deadline = tf + (opts.firstFrameTimeoutMs ?? 180_000);
    let lastError = "no usable frame";
    for (;;) {
      if (opts.signal?.aborted) throw new SessionError("cancelled", "aborted by caller");
      try {
        const shot = await session.screenshot();
        const problem = frameProblem(shot.png);
        if (!problem) break;
        lastError = `frame not usable: ${problem}`;
      } catch (error) {
        lastError = (error as Error).message;
      }
      if (Date.now() > deadline) throw new SessionError("first_frame_timeout", `no usable screenshot: ${lastError}`);
      await sleep(1_000);
    }
    receipt.timings_ms.first_frame = Date.now() - tf;
    receipt.timings_ms.run_to_first_frame = Date.now() - t0;
    session._startHeartbeat();
    log(`odr: ${provider.id} ${allocated.device.model ?? profile.model} ready in ${receipt.timings_ms.run_to_first_frame} ms`);
    return session;
  } catch (error) {
    const cancelled = (error as { code?: string }).code === "cancelled";
    const rc = await session.release(cancelled ? "cancelled" : "failed", error);
    if (error instanceof SessionError) throw new SessionError(error.code, error.message, rc);
    throw new SessionError("allocate_failed", (error as Error).message ?? String(error), rc);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export function loadValidProviders(): Provider[] {
  const { providers, issues } = loadRegistry();
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new SessionError("registry_invalid", `registry has ${errors.length} error(s); run odr validate`);
  return providers;
}

/** Runs fn with a session and always releases it, with outcome failed if fn throws. */
export async function withSession<T>(
  request: RouteRequest,
  fn: (s: OdrSession) => Promise<T>,
  opts: AllocateOptions = {},
): Promise<{ result: T; receipt: Receipt }> {
  const s = await allocate(request, opts);
  try {
    const result = await fn(s);
    return { result, receipt: await s.release("ok") };
  } catch (error) {
    const rc = await s.release("failed", error);
    (error as { receipt?: Receipt }).receipt ??= rc;
    throw error;
  }
}

export interface SweepResult {
  id: string;
  provider: string;
  action: "closed" | "closure_unverified" | "never_allocated";
  closure?: ClosureResult;
}

/**
 * Finds reservations whose worker is gone (heartbeat lapsed, or owner pid dead on this host) and
 * stops their devices from the stored locator. Reservations held by sessions in this process are skipped.
 */
export async function sweep(opts: { home?: string; providers?: Provider[]; drivers?: AllocateOptions["drivers"]; env?: NodeJS.ProcessEnv; now?: Date } = {}): Promise<SweepResult[]> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? odrHome(env);
  const providers = opts.providers ?? loadValidProviders();
  const now = opts.now ?? new Date();
  const mine = new Set([...live].map((s) => s.id));
  const host = hostname();
  const stale: Reservation[] = [];
  withLock(home, (state) => {
    for (const r of state.reservations) {
      if (mine.has(r.id)) continue;
      if (!(r.status === "reserved" || r.status === "active" || r.status === "releasing" || r.status === "closure_unverified")) continue;
      const ownerGone = r.owner.host === host ? !pidAlive(r.owner.pid) : false;
      const lapsed = Date.parse(r.expires_at) < now.getTime();
      if (ownerGone || lapsed || (r.status === "closure_unverified" && (ownerGone || r.owner.pid !== process.pid))) {
        r.status = "releasing";
        stale.push(structuredClone(r));
      }
    }
  });
  const results: SweepResult[] = [];
  for (const r of stale) {
    const p = providers.find((x) => x.id === r.provider);
    let closure: ClosureResult | undefined;
    let action: SweepResult["action"];
    if (!r.locator) {
      action = "never_allocated";
    } else if (!p?.control) {
      closure = { status: "unverified", method: "none", detail: "provider has no control path" };
      action = "closure_unverified";
    } else {
      try {
        closure = await (await driverModule(p.control.driver, opts.drivers)).sweep(r.locator, env);
      } catch (error) {
        closure = { status: "failed", method: "none", detail: (error as Error).message };
      }
      action = closure.status === "verified" ? "closed" : "closure_unverified";
    }
    withLock(home, (state) => {
      const x = state.reservations.find((y) => y.id === r.id);
      if (!x) return;
      x.status = action === "closure_unverified" ? "closure_unverified" : "closed";
      x.closed_at = new Date().toISOString();
      x.closure = action === "never_allocated" ? "never_allocated" : `${closure!.status}:${closure!.method}`;
      if (action !== "never_allocated" && !state.usage.some((u) => u.reservation === r.id)) {
        // The worker died before measuring; charge the full reservation.
        state.usage.push({
          provider: r.provider,
          allowance: r.allowance,
          amount: r.amount,
          minutes: r.minutes,
          surface: r.surface,
          at: x.closed_at,
          source: "odr",
          reservation: r.id,
          usd: r.usd,
          note: "sweep: worker lost, charged full reservation",
        });
      }
    });
    results.push({ id: r.id, provider: r.provider, action, ...(closure ? { closure } : {}) });
  }
  return results;
}
