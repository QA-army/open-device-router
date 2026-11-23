import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { Key } from "../../core/types.js";
import type { AllocateContext, Allocated, BuildSource, ClosureResult, Driver, DriverModule, Locator, Point, Screenshot } from "../types.js";
import { pngSize } from "../png.js";

const run = promisify(execFile);
const API = "https://api.appetize.io";

// Drives Appetize through its own CLI (@appetize/cli, Node 22+) and REST API.
// Each session gets its own short CLI home so daemons never share state and so the daemon's Unix
// socket path stays under the OS length limit. Closure is checked against GET /v2/sessions, not
// against the CLI's exit code: `session stop` can report success while its daemon is still alive.
// Docs: https://docs.appetize.io/ai-agents/sessions, https://docs.appetize.io/rest-api/sessions

interface SessionRow {
  targetId?: string;
  startTime?: string | null;
  sessionRequestedTime?: string | null;
  endTime?: string | null;
  closeTime?: string | null;
  sessionLengthSeconds?: number;
  queueTimeSeconds?: number;
  device?: string;
  osVersion?: string;
  platform?: string;
}

function token(env: NodeJS.ProcessEnv): string {
  const t = env.APPETIZE_API_TOKEN;
  if (!t) {
    const e = new Error("APPETIZE_API_TOKEN is not set. Get one at https://appetize.io/account (odr keys appetize)") as Error & { code: string };
    e.code = "missing_credentials";
    throw e;
  }
  return t;
}

function cliBin(env: NodeJS.ProcessEnv): string {
  return env.ODR_APPETIZE_CLI ?? "appetize";
}

async function api<T>(env: NodeJS.ProcessEnv, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "X-API-KEY": token(env), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Appetize ${init.method ?? "GET"} ${path.split("?")[0]} returned ${res.status}`);
  return (await res.json()) as T;
}

/** Sessions for a target that started in [from, now]. Pages are 1-based. */
export async function sessionsSince(env: NodeJS.ProcessEnv, from: Date, targetId?: string): Promise<SessionRow[]> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const rows: SessionRow[] = [];
  for (let page = 1; page <= 5; page++) {
    const q = new URLSearchParams({ startDate: day(from), endDate: day(new Date()), limit: "100", page: String(page) });
    if (targetId) q.set("targetId", targetId);
    const r = await api<{ results: SessionRow[]; nextPage: number | null }>(env, `/v2/sessions?${q}`);
    rows.push(...r.results);
    if (!r.nextPage) break;
  }
  const t = from.getTime() - 60_000;
  return rows.filter((r) => Date.parse(r.sessionRequestedTime ?? r.startTime ?? "") >= t);
}

/** Model slug Appetize expects, e.g. "iPhone 16 Pro" -> "iphone16pro". */
export function deviceSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Escapes text for `appetize type`, where `{...}` names a key and `{{` is a literal brace. */
export function escapeTypeText(text: string): string {
  return text.replace(/\{/g, "{{");
}

const KEY_ARGS: Record<Key, string[]> = {
  enter: ["type", "--", "{Enter}"],
  backspace: ["type", "--", "{Backspace}"],
  tab: ["type", "--", "{Tab}"],
  home: ["press", "home"],
  back: ["press", "back"],
};

const PHASES = ["requesting", "queued", "starting", "downloadingApp", "installingApp", "launchingApp", "ready"] as const;

async function ownedDaemons(home: string): Promise<number[]> {
  try {
    const { stdout } = await run("ps", ["-Ao", "pid=,args="]);
    const pids: number[] = [];
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || !/appetize/i.test(m[2]!) || Number(m[1]) === process.pid) continue;
      const pid = Number(m[1]);
      let envText = "";
      try {
        envText = process.platform === "linux"
          ? readFileSync(`/proc/${pid}/environ`, "latin1")
          : (await run("ps", ["-wwE", "-p", String(pid), "-o", "command="])).stdout;
      } catch {
        continue;
      }
      if (envText.includes(`APPETIZE_CLI_HOME=${home}`)) pids.push(pid);
    }
    return pids;
  } catch {
    return [];
  }
}

async function killOwned(home: string): Promise<number> {
  const pids = await ownedDaemons(home);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* gone */
    }
  }
  if (pids.length) {
    await new Promise((r) => setTimeout(r, 3_000));
    for (const pid of await ownedDaemons(home)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  return (await ownedDaemons(home)).length;
}

class AppetizeDriver implements Driver {
  readonly name = "appetize-cli" as const;
  #env: NodeJS.ProcessEnv = {};
  #home = "";
  #sid = "";
  #target?: string;
  #uploaded = false;
  #startedAt = new Date();
  #platform: "ios" | "android" = "ios";
  #handle: Record<string, unknown> = {};
  #row?: SessionRow;
  #released = false;
  #daemonsLeft = 0;
  #input = { width: 1, height: 1 };

  #cli(args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
    // Scope flags go before `--` so text typed into the app can never be read as a flag.
    const dash = args.indexOf("--");
    const head = dash === -1 ? args : args.slice(0, dash);
    const tail = dash === -1 ? [] : args.slice(dash);
    return run(cliBin(this.#env), [...head, "--session-id", this.#sid, "--json", "--quiet", ...tail], {
      env: { ...this.#env, APPETIZE_CLI_HOME: this.#home },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  async prepareBuild(build: BuildSource, ctx: AllocateContext): Promise<string> {
    this.#env = ctx.env;
    const platform = ctx.profile.platform === "android" ? "android" : "ios";
    const timeLimit = Math.min(ctx.control.max_session_minutes ?? ctx.minutes, ctx.minutes + 2) * 60;
    let res: { publicKey: string };
    const common = { platform, note: `odr:${ctx.reservation}`, timeout: 600, timeLimit, maxConcurrent: 1 };
    if (build.url) {
      res = await api(this.#env, "/v1/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...common, url: build.url, appPermissions: { run: "authenticated" } }),
      });
    } else if (build.path) {
      const form = new FormData();
      form.set("file", new Blob([readFileSync(build.path)]), basename(build.path));
      for (const [k, v] of Object.entries(common)) form.set(k, String(v));
      form.set("appPermissions.run", "authenticated");
      res = await api(this.#env, "/v1/apps", { method: "POST", body: form });
    } else {
      throw new Error("build needs a path, url or provider_build_id");
    }
    this.#target = res.publicKey;
    this.#uploaded = true;
    ctx.onLocator({ driver: "appetize-cli", build_id: res.publicKey, uploaded_by_odr: true });
    return res.publicKey;
  }

  async allocate(ctx: AllocateContext): Promise<Allocated> {
    this.#env = ctx.env;
    token(this.#env);
    this.#platform = ctx.profile.platform === "android" ? "android" : "ios";
    this.#target ??= ctx.prepared_build;
    this.#home = mkdtempSync("/tmp/odr-a-");
    this.#sid = `odr${ctx.reservation.slice(2, 10)}`;
    this.#startedAt = new Date();
    const device = ctx.profile.provider_device ?? deviceSlug(ctx.profile.model !== "*" ? ctx.profile.model : (ctx.request.model ?? (this.#platform === "ios" ? "iphone16pro" : "pixel9pro")));
    const os = ctx.profile.os !== "*" ? ctx.profile.os : ctx.request.os && /^[\d.]+$/.test(ctx.request.os) ? ctx.request.os : undefined;
    ctx.onLocator({
      driver: "appetize-cli",
      cli_home: this.#home,
      session_id: this.#sid,
      started_at: this.#startedAt.toISOString(),
      ...(this.#target ? { build_id: this.#target } : {}),
      ...(this.#uploaded ? { uploaded_by_odr: true } : {}),
    });
    const args = ["session", "start", device, ...(this.#target ? ["--target", this.#target] : []), ...(os ? ["--device-os-version", os] : []), "--session-id", this.#sid, "--json"];
    let started: { record: Record<string, unknown>; phases: Map<string, number> };
    try {
      started = await this.#start(args);
    } catch (error) {
      // The CLI's daemon handshake has a fixed short timeout; one forced retry with a clean daemon.
      if (!/time(d)? ?out|handshake|ECONNREFUSED|socket/i.test((error as Error).message)) throw error;
      await killOwned(this.#home);
      started = await this.#start([...args, "--force"]);
    }
    this.#handle = { ...started.record };
    const p = started.phases;
    const at = (k: string) => p.get(k);
    const phases: Allocated["phases"] = {};
    const q0 = at("queued"), q1 = at("starting");
    if (q0 !== undefined && q1 !== undefined) phases.provider_queue_ms = q1 - q0;
    const i0 = at("downloadingApp") ?? at("installingApp"), i1 = at("launchingApp");
    if (i0 !== undefined && i1 !== undefined) phases.install_ms = i1 - i0;
    const l0 = at("launchingApp"), l1 = at("ready");
    if (l0 !== undefined && l1 !== undefined) phases.launch_ms = l1 - l0;

    // Confirm the device from Appetize's own session history: a requested model is not always the one granted.
    const row = await this.#findRow(20_000);
    const shot = await this.screenshot().catch(() => undefined);
    return {
      device: {
        provider: ctx.provider.id,
        platform: ctx.profile.platform,
        kind: ctx.profile.kind,
        model: row?.device ?? device,
        ...(row?.osVersion ? { os_version: row.osVersion } : os ? { os_version: os } : {}),
        provider_device: row?.device ?? device,
        confirmed_by: row ? "provider_api" : "requested_only",
      },
      phases,
      ...(this.#target && shot ? { launched_app: this.#target } : {}),
    };
  }

  #start(args: string[]): Promise<{ record: Record<string, unknown>; phases: Map<string, number> }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cliBin(this.#env), args, { env: { ...this.#env, APPETIZE_CLI_HOME: this.#home }, stdio: ["ignore", "pipe", "pipe"] });
      const phases = new Map<string, number>();
      let out = "", err = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => {
        err += d;
        for (const ph of PHASES) if (!phases.has(ph) && String(d).includes(ph)) phases.set(ph, Date.now());
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e.message.includes("ENOENT") ? Object.assign(new Error("Appetize CLI not found. Run: npm i -g @appetize/cli (Node 22+)"), { code: "driver_missing" }) : e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`appetize session start failed: ${err.trim().split("\n").pop() ?? code}`));
        try {
          const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
          resolve({ record: JSON.parse(json) as Record<string, unknown>, phases });
        } catch {
          reject(new Error("appetize session start printed no session record"));
        }
      });
    });
  }

  async #findRow(waitMs: number): Promise<SessionRow | undefined> {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        const rows = await sessionsSince(this.#env, this.#startedAt, this.#target);
        const row = rows.sort((a, b) => Date.parse(b.startTime ?? "") - Date.parse(a.startTime ?? ""))[0];
        if (row) return (this.#row = row);
      } catch {
        /* history can lag */
      }
      if (Date.now() > until) return undefined;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  async install(build: BuildSource): Promise<string | undefined> {
    void build;
    throw new Error("Appetize installs the build at session start; pass the build to allocate()");
  }

  async launch(appId: string): Promise<void> {
    await this.#cli(["launch", appId]).catch(async () => {
      // Older CLIs: relaunch the target app.
      await this.#cli(["restart"]);
    });
  }

  async screenshot(): Promise<Screenshot> {
    const file = join(this.#home, "shot.png");
    await this.#cli(["screenshot", file]);
    const png = readFileSync(file);
    const size = pngSize(png);
    if (!size) throw new Error("Appetize screenshot is not a PNG");
    // Appetize positions are normalized 0..1, so the driver exposes pixel space and converts.
    this.#input = { width: size.width, height: size.height };
    return { png, width: size.width, height: size.height, input: { ...this.#input } };
  }

  #norm(p: Point): string {
    const x = Math.min(1, Math.max(0, p.x / this.#input.width));
    const y = Math.min(1, Math.max(0, p.y / this.#input.height));
    return `${x.toFixed(4)},${y.toFixed(4)}`;
  }

  async tap(p: Point, opts?: { durationMs?: number }): Promise<void> {
    if (opts?.durationMs) await this.#cli(["gesture", "--", `{${this.#norm(p)}}>{wait=${Math.round(opts.durationMs)}}/`]);
    else await this.#cli(["tap", "--select-position", this.#norm(p)]);
  }

  async type(text: string): Promise<void> {
    await this.#cli(["type", "--", escapeTypeText(text)]);
  }

  async swipe(from: Point, to: Point, opts?: { durationMs?: number }): Promise<void> {
    const wait = Math.round(opts?.durationMs ?? 300);
    await this.#cli(["gesture", "--", `{${this.#norm(from)}}>{wait=50}{${this.#norm(to)}}{wait=${Math.max(0, wait - 50)}}/`]);
  }

  async key(k: Key): Promise<void> {
    if (k === "back" && this.#platform !== "android") throw new Error("back is Android only on Appetize");
    await this.#cli(KEY_ARGS[k]);
  }

  async heartbeat(): Promise<void> {
    /* The screenshot probe is the heartbeat: the session ends on inactivity, not on missed pings. */
  }

  async release(): Promise<void> {
    if (this.#released || !this.#home) return;
    this.#released = true;
    await this.#cli(["session", "stop"], 60_000).catch(() => undefined);
    this.#daemonsLeft = await killOwned(this.#home);
    if (this.#uploaded && this.#target) {
      await fetch(`${API}/v1/apps/${this.#target}`, { method: "DELETE", headers: { "X-API-KEY": token(this.#env) } }).catch(() => undefined);
    }
    rmSync(this.#home, { recursive: true, force: true });
  }

  async verifyClosed(): Promise<ClosureResult> {
    if (!this.#home) return { status: "verified", method: "none", detail: "no session was started" };
    return closedAtProvider(this.#env, this.#startedAt, this.#target, this.#daemonsLeft, (r) => (this.#row = r));
  }

  async providerMinutes(): Promise<number | undefined> {
    const s = this.#row?.sessionLengthSeconds;
    return typeof s === "number" ? Math.round((s / 60) * 100) / 100 : undefined;
  }

  handle(): Record<string, unknown> {
    return { ...this.#handle, session_id: this.#sid, build_id: this.#target };
  }
}

async function closedAtProvider(
  env: NodeJS.ProcessEnv,
  from: Date,
  target: string | undefined,
  daemonsLeft: number,
  keep: (r: SessionRow) => void = () => {},
): Promise<ClosureResult> {
  if (daemonsLeft > 0) return { status: "unverified", method: "driver", detail: `${daemonsLeft} CLI daemon(s) still running` };
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const rows = await sessionsSince(env, from, target);
      if (rows.length && rows.every((r) => r.closeTime || r.endTime)) {
        keep(rows[0]!);
        return { status: "verified", method: "provider_api", detail: `${rows.length} session(s) closed per /v2/sessions` };
      }
      if (!rows.length && Date.now() > until) return { status: "unverified", method: "provider_api", detail: "no session record found" };
    } catch (error) {
      if (Date.now() > until) return { status: "unverified", method: "provider_api", detail: (error as Error).message };
    }
    if (Date.now() > until) return { status: "unverified", method: "provider_api", detail: "session still open per /v2/sessions" };
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function sweep(locator: Locator, env: NodeJS.ProcessEnv): Promise<ClosureResult> {
  const home = typeof locator.cli_home === "string" ? locator.cli_home : undefined;
  let left = 0;
  if (home) {
    await run(cliBin(env), ["session", "stop", "--session-id", String(locator.session_id ?? ""), "--json", "--quiet"], { env: { ...env, APPETIZE_CLI_HOME: home }, timeout: 60_000 }).catch(() => undefined);
    left = await killOwned(home);
    rmSync(home, { recursive: true, force: true });
  }
  const target = typeof locator.build_id === "string" ? locator.build_id : undefined;
  if (locator.uploaded_by_odr && target) {
    await fetch(`${API}/v1/apps/${target}`, { method: "DELETE", headers: { "X-API-KEY": token(env) } }).catch(() => undefined);
  }
  if (!locator.started_at) return { status: "verified", method: "none", detail: "no session was started" };
  return closedAtProvider(env, new Date(String(locator.started_at)), target, left);
}

/** Minutes Appetize reports for a month, summed over builds. GET /v1/usageSummary. */
export async function appetizeUsage(env: NodeJS.ProcessEnv, month: string): Promise<number> {
  const r = await api<{ data: { month: string; minutes: number }[] }>(env, `/v1/usageSummary?startMonth=${month}`);
  return r.data.filter((d) => d.month.startsWith(month)).reduce((s, d) => s + (d.minutes ?? 0), 0);
}

export const appetizeDriver: DriverModule = { create: () => new AppetizeDriver(), sweep };
