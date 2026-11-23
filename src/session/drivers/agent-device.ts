import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Key } from "../../core/types.js";
import type { AllocateContext, Allocated, BuildSource, ClosureResult, Driver, DriverModule, Locator, Point, Screenshot } from "../types.js";

const run = promisify(execFile);

// Drives local simulators/emulators and agent-device cloud backends (Limrun, Revyl) through the
// agent-device Node client, in an in-process daemon this driver owns. agent-device is an optional
// peer dependency, loaded on first use.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Client = any;

async function loadAgentDevice(): Promise<any> {
  try {
    return await import("agent-device" as string);
  } catch {
    const e = new Error("agent-device is not installed. Run: npm i agent-device") as Error & { code: string };
    e.code = "driver_missing";
    throw e;
  }
}

class AgentDeviceDriver implements Driver {
  readonly name = "agent-device" as const;
  #host: any;
  #client!: Client;
  #ov: Record<string, unknown> = {};
  #lease?: { leaseId: string; tenant: string; runId: string; leaseBackend: string; leaseProvider?: string };
  #dir = "";
  #shots = 0;
  #platform: "ios" | "android" = "ios";
  #bootedByUs = false;
  #session = "";
  #deviceId?: string;
  #released = false;
  #closeReport?: { released?: boolean; closed?: boolean };

  async allocate(ctx: AllocateContext): Promise<Allocated> {
    const ad = await loadAgentDevice();
    const { profile, control } = ctx;
    this.#platform = profile.platform === "android" ? "android" : "ios";
    this.#dir = mkdtempSync(join(tmpdir(), "odr-ad-"));
    this.#session = `odr-${ctx.reservation.slice(2, 10)}`;
    ctx.onLocator({
      driver: "agent-device",
      session: this.#session,
      platform: this.#platform,
      ...(control.lease_provider ? { lease_provider: control.lease_provider } : {}),
    });
    this.#host = await ad.startAgentDevice({ stateDir: join(this.#dir, "state") });
    this.#client = this.#host.client;
    // Tenant isolation in agent-device is bound to a provider lease, so it is only set for lease backends.
    this.#ov = control.lease_backend
      ? { session: this.#session, tenant: ctx.tenant, runId: ctx.run_id, sessionIsolation: "tenant" }
      : { session: this.#session };

    if (control.lease_backend) {
      const lease = await this.#client.leases.allocate({
        ...this.#ov,
        tenant: ctx.tenant,
        runId: ctx.run_id,
        leaseBackend: control.lease_backend,
        ...(control.lease_provider ? { leaseProvider: control.lease_provider } : {}),
        platform: this.#platform,
        ttlMs: Math.max(120_000, ctx.minutes * 60_000 + 120_000),
        retainOnClose: true,
        ...(ctx.request.os && !/[<>*]/.test(ctx.request.os) ? { osVersion: ctx.request.os } : {}),
      });
      this.#lease = {
        leaseId: lease.leaseId,
        tenant: ctx.tenant,
        runId: ctx.run_id,
        leaseBackend: control.lease_backend,
        ...(control.lease_provider ? { leaseProvider: control.lease_provider } : {}),
      };
      this.#ov.leaseId = lease.leaseId;
      ctx.onLocator({ driver: "agent-device", session: this.#session, platform: this.#platform, lease_id: lease.leaseId, tenant: ctx.tenant, run_id: ctx.run_id, ...(control.lease_provider ? { lease_provider: control.lease_provider } : {}) });
    }

    const wanted = profile.model !== "*" ? (profile.provider_device ?? profile.model) : ctx.request.model;
    const before = await this.#listBooted();
    const boot = await this.#client.devices.boot({
      ...this.#ov,
      platform: this.#platform,
      ...(wanted ? { device: wanted } : {}),
      pick: "newest",
      // No display (CI, containers): start emulators with -no-window. ODR_HEADLESS=1|0 overrides.
      headless: ctx.env.ODR_HEADLESS ? ctx.env.ODR_HEADLESS === "1" : process.platform === "linux" && !ctx.env.DISPLAY && !ctx.env.WAYLAND_DISPLAY,
      timeoutMs: 600_000,
    });
    this.#deviceId = boot.id;
    this.#bootedByUs = !before.has(boot.id);
    ctx.onLocator({
      driver: "agent-device",
      session: this.#session,
      platform: this.#platform,
      device_id: boot.id,
      booted_by_odr: this.#bootedByUs,
      ...(this.#lease ? { lease_id: this.#lease.leaseId, tenant: ctx.tenant, run_id: ctx.run_id } : {}),
      ...(control.lease_provider ? { lease_provider: control.lease_provider } : {}),
    });
    const devices: any[] = await this.#client.devices.list({ ...this.#ov, platform: this.#platform }).catch(() => []);
    const d = devices.find((x) => x.id === boot.id);
    return {
      device: {
        provider: ctx.provider.id,
        platform: profile.platform,
        kind: profile.kind,
        model: d?.model ?? boot.device,
        ...(d?.osVersion ? { os_version: String(d.osVersion) } : {}),
        provider_device: boot.device,
        device_id: boot.id,
        confirmed_by: "driver",
      },
      phases: {},
    };
  }

  async #listBooted(): Promise<Set<string>> {
    try {
      const list: any[] = await this.#client.devices.list({ ...this.#ov, platform: this.#platform });
      return new Set(list.filter((d) => d.booted).map((d) => d.id));
    } catch {
      return new Set();
    }
  }

  async install(build: BuildSource): Promise<string | undefined> {
    if (build.url) {
      const r = await this.#client.apps.installFromSource({ ...this.#ov, platform: this.#platform, source: { kind: "url", url: build.url } });
      return r.bundleId ?? r.packageName ?? r.appId ?? r.launchTarget;
    }
    if (!build.path) throw new Error("build needs a path or url");
    const r = await this.#client.apps.install({ ...this.#ov, platform: this.#platform, appPath: build.path, ...(build.app_id ? { app: build.app_id } : {}) });
    return r.bundleId ?? r.package ?? r.appId ?? build.app_id;
  }

  async launch(appId: string): Promise<void> {
    await this.#client.apps.open({ ...this.#ov, platform: this.#platform, app: appId, relaunch: true, timeoutMs: 600_000 });
  }

  async screenshot(): Promise<Screenshot> {
    const path = join(this.#dir, `s${this.#shots++ % 4}.png`);
    const r = await this.#client.capture.screenshot({ ...this.#ov, path });
    const png = readFileSync(r.path ?? path);
    const width = r.width ?? png.readUInt32BE(16);
    const height = r.height ?? png.readUInt32BE(20);
    return { png, width, height, input: { width: r.logicalWidth ?? width, height: r.logicalHeight ?? height } };
  }

  async tap(p: Point): Promise<void> {
    await this.#client.interactions.press({ ...this.#ov, x: Math.round(p.x), y: Math.round(p.y) });
  }

  async type(text: string): Promise<void> {
    await this.#client.interactions.type({ ...this.#ov, text });
  }

  async swipe(from: Point, to: Point, opts?: { durationMs?: number }): Promise<void> {
    await this.#client.interactions.swipe({
      ...this.#ov,
      from: { x: Math.round(from.x), y: Math.round(from.y) },
      to: { x: Math.round(to.x), y: Math.round(to.y) },
      ...(opts?.durationMs ? { pauseMs: opts.durationMs } : {}),
    });
  }

  async key(k: Key): Promise<void> {
    if (k === "enter") await this.#client.command.keyboard({ ...this.#ov, action: "enter" });
    else if (k === "home") await this.#client.command.home({ ...this.#ov });
    else if (k === "back") await this.#client.command.back({ ...this.#ov });
    else throw new Error(`agent-device driver has no ${k} key`);
  }

  async heartbeat(): Promise<void> {
    if (this.#lease) await this.#client.leases.heartbeat({ ...this.#ov, ...this.#lease, ttlMs: 180_000 });
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    const report: { released?: boolean; closed?: boolean } = {};
    if (this.#client) {
      await this.#client.sessions.close({ ...this.#ov, shutdown: this.#bootedByUs }).catch(() => undefined);
      if (this.#lease) {
        const r = await this.#client.leases.release({ ...this.#ov, ...this.#lease }).catch(() => ({ released: false }));
        report.released = r.released;
      }
    }
    if (this.#host) {
      const shut = await this.#host.close().catch(() => undefined);
      report.closed = shut ? shutdownClean(shut) : false;
    }
    this.#closeReport = report;
    if (this.#dir) rmSync(this.#dir, { recursive: true, force: true });
  }

  async verifyClosed(): Promise<ClosureResult> {
    const r = this.#closeReport ?? {};
    if (!this.#host) return { status: "verified", method: "driver", detail: "no daemon was started" };
    if (this.#lease && r.released !== true) return { status: "unverified", method: "driver", detail: "lease release not confirmed" };
    if (r.closed === false) return { status: "unverified", method: "driver", detail: "daemon shutdown pending" };
    if (this.#bootedByUs && this.#deviceId) {
      // Shutdown is asynchronous on both platforms; give it up to 60 s before calling it unverified.
      let off = await deviceIsOff(this.#platform, this.#deviceId);
      for (let i = 0; off === false && i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        off = await deviceIsOff(this.#platform, this.#deviceId);
      }
      if (off === false) return { status: "unverified", method: "driver", detail: "device still booted 60 s after shutdown" };
    }
    return { status: "verified", method: "driver", detail: this.#lease ? "lease released, daemon closed" : "session closed, daemon closed" };
  }

  handle(): Record<string, unknown> {
    return { session: this.#session, device_id: this.#deviceId, lease_id: this.#lease?.leaseId };
  }
}

async function deviceIsOff(platform: "ios" | "android", id: string): Promise<boolean | undefined> {
  try {
    if (platform === "ios") {
      const { stdout } = await run("xcrun", ["simctl", "list", "devices", "-j"]);
      const all = Object.values(JSON.parse(stdout).devices as Record<string, { udid: string; state: string }[]>).flat();
      const d = all.find((x) => x.udid === id);
      return d ? d.state !== "Booted" : true;
    }
    const { stdout } = await run("adb", ["devices"]);
    return !stdout.split("\n").some((l) => l.startsWith(id));
  } catch {
    return undefined;
  }
}

async function sweep(locator: Locator, env: NodeJS.ProcessEnv): Promise<ClosureResult> {
  const platform = locator.platform === "android" ? "android" : "ios";
  if (locator.lease_provider) {
    // The dead worker's daemon held the provider connection. A new daemon cannot adopt its runner;
    // the provider's own TTL ends the instance. Report honestly instead of guessing.
    void env;
    return { status: "unverified", method: "driver", detail: `${locator.lease_provider} lease ${locator.lease_id ?? "?"} ends at the provider TTL; check the provider dashboard` };
  }
  if (!locator.device_id || locator.booted_by_odr !== true) {
    return { status: "verified", method: "driver", detail: "odr did not boot this device; left running" };
  }
  const id = String(locator.device_id);
  try {
    if (platform === "ios") await run("xcrun", ["simctl", "shutdown", id]);
    else await run("adb", ["-s", id, "emu", "kill"]);
  } catch {
    /* already off */
  }
  const off = await deviceIsOff(platform, id);
  return off ? { status: "verified", method: "driver", detail: "device shut down" } : { status: "unverified", method: "driver", detail: "could not confirm shutdown" };
}

export const agentDeviceDriver: DriverModule = { create: () => new AgentDeviceDriver(), sweep };

/** True when agent-device's ShutdownReport shows nothing left running or in flight. */
export function shutdownClean(r: any): boolean {
  return (
    r?.platformOwners === "closed" &&
    (r.providerReleases?.pending?.length ?? 0) === 0 &&
    (r.providerReleases?.unknown?.length ?? 0) === 0 &&
    (r.requests?.abandoned ?? 0) === 0 &&
    (r.plugins?.pending?.length ?? 0) === 0 &&
    (r.runners?.handedOff?.length ?? 0) === 0
  );
}
