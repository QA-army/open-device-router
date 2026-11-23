import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadState, odrHome, withLock } from "../core/ledger.js";
import type { RouteRequest, SpendPolicy } from "../core/router.js";
import { BUILD_FORMATS, INPUTS, KEYS, type BuildFormat, type DeviceKind, type Input, type Key, type Platform, type Provider } from "../core/types.js";
import { allocate, RouteRefusedError, SessionError, sweep } from "../session/session.js";
import { reconcile } from "../session/reconcile.js";
import { serveSession } from "../session/serve.js";
import type { BuildSource } from "../session/types.js";
import { envNames, keySteps } from "./keys.js";

function fail(message: string, code = 1): never {
  console.error(`odr: ${message}`);
  process.exit(code);
}

export const REQUEST_OPTIONS = {
  platform: { type: "string" },
  kind: { type: "string" },
  surface: { type: "string" },
  model: { type: "string" },
  os: { type: "string" },
  "build-format": { type: "string" },
  needs: { type: "string" },
  keys: { type: "string" },
  minutes: { type: "string" },
  parallel: { type: "string" },
  provider: { type: "string" },
  "budget-usd": { type: "string" },
} as const;

const list = <T extends string>(v: string | undefined, allowed: readonly T[], flag: string): T[] | undefined => {
  if (!v) return undefined;
  const items = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const i of items) if (!(allowed as readonly string[]).includes(i)) fail(`--${flag} accepts ${allowed.join(", ")}; got ${i}`);
  return items as T[];
};

export function requestFromFlags(values: Record<string, string | boolean | undefined>): RouteRequest {
  const minutes = Number(values.minutes);
  if (!(minutes > 0)) fail("--minutes must be a number greater than 0");
  const platform = values.platform as string | undefined;
  if (platform && !["ios", "android", "web"].includes(platform)) fail("--platform must be ios, android or web");
  const kind = values.kind as string | undefined;
  if (kind && !["simulator", "emulator", "real", "browser"].includes(kind)) fail("--kind must be simulator, emulator, real or browser");
  const bf = values["build-format"] as string | undefined;
  if (bf && !(BUILD_FORMATS as readonly string[]).includes(bf)) fail(`--build-format must be one of ${BUILD_FORMATS.join(", ")}`);
  const budget = values["budget-usd"] !== undefined ? Number(values["budget-usd"]) : undefined;
  if (budget !== undefined && !(budget >= 0)) fail("--budget-usd must be 0 or more");
  const spend: SpendPolicy = budget !== undefined ? { mode: "budget", max_usd: budget } : { mode: "free-only" };
  const req: RouteRequest = { minutes, spend };
  if (values.surface) req.surface = values.surface as RouteRequest["surface"];
  if (platform) req.platform = platform as Platform;
  if (kind) req.kind = kind as DeviceKind;
  if (values.model) req.model = String(values.model);
  if (values.os) req.os = String(values.os);
  if (bf) req.build_format = bf as BuildFormat;
  const needs = list<Input>(values.needs as string | undefined, INPUTS, "needs");
  if (needs) req.needs = needs;
  const keys = list<Key>(values.keys as string | undefined, KEYS, "keys");
  if (keys) req.keys = keys;
  if (values.parallel) req.parallel = Number(values.parallel);
  if (values.provider) req.provider = String(values.provider);
  return req;
}

function buildFormatOf(path: string): BuildFormat {
  if (path.endsWith(".apk")) return "apk";
  if (path.endsWith(".aab")) return "aab";
  if (path.endsWith(".ipa")) return "ipa";
  if (path.endsWith(".app.zip") || path.endsWith(".zip")) return "app-zip";
  if (path.endsWith(".app") || path.endsWith(".app/")) return "app";
  return fail(`cannot tell the build format of ${path}; pass --build-format`);
}

export async function cmdRun(argv: string[], providers: Provider[]): Promise<void> {
  const dash = argv.indexOf("--");
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const cmd = dash === -1 ? [] : argv.slice(dash + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      ...REQUEST_OPTIONS,
      build: { type: "string" },
      "build-url": { type: "string" },
      "build-id": { type: "string" },
      "app-id": { type: "string" },
      launch: { type: "string" },
      "no-launch": { type: "boolean" },
      tenant: { type: "string" },
      "run-id": { type: "string" },
      hold: { type: "string" },
      json: { type: "boolean" },
      quiet: { type: "boolean" },
    },
  });
  const req = requestFromFlags(values);
  let build: BuildSource | undefined;
  if (values.build || values["build-url"] || values["build-id"]) {
    const format = (values["build-format"] as BuildFormat | undefined) ?? (values.build ? buildFormatOf(values.build) : values["build-url"] ? buildFormatOf(values["build-url"]) : fail("--build-id needs --build-format"));
    build = {
      format,
      ...(values.build ? { path: values.build } : {}),
      ...(values["build-url"] ? { url: values["build-url"] } : {}),
      ...(values["build-id"] ? { provider_build_id: values["build-id"] } : {}),
      ...(values["app-id"] ? { app_id: values["app-id"] } : {}),
    };
  }
  const log = values.quiet ? () => {} : (l: string) => console.error(l);
  const home = odrHome();
  let session;
  try {
    session = await allocate(req, {
      providers,
      home,
      log,
      ...(build ? { build } : {}),
      ...(values["no-launch"] ? { launch: false } : values.launch ? { launch: values.launch } : {}),
      ...(values.tenant ? { tenant: values.tenant } : {}),
      ...(values["run-id"] ? { runId: values["run-id"] } : {}),
    });
  } catch (error) {
    const rc = error instanceof RouteRefusedError ? error.receipt : (error as SessionError).receipt;
    if (values.json && rc) console.log(JSON.stringify(rc, null, 2));
    if (error instanceof RouteRefusedError) {
      for (const c of error.decision.considered) {
        if (c.skip && c.skip !== "not_connected" && c.skip !== "surface_not_offered") log(`  ${c.provider}[${c.allowance}${c.plan ? `:${c.plan}` : ""}]: ${c.skip}${c.detail ? ` (${c.detail})` : ""}`);
      }
      fail(error.message, 3);
    }
    fail(`${(error as SessionError).code ?? "error"}: ${(error as Error).message}`, 4);
  }

  const served = await serveSession(session);
  const dir = join(home, "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${session.id}.json`);
  writeFileSync(
    file,
    JSON.stringify({ schema: "odr.session/v1", id: session.id, provider: session.provider, url: served.url, token: served.token, device: session.device, profile: session.profile, receipt: session.receiptFile }, null, 2),
    { mode: 0o600 },
  );

  let code = 0;
  let outcome: "ok" | "failed" | "cancelled" = "ok";
  if (cmd.length) {
    log(`odr: running ${cmd[0]} with ODR_SESSION_FILE=${file}`);
    const child = spawn(cmd[0]!, cmd.slice(1), {
      stdio: "inherit",
      env: { ...process.env, ODR_SESSION_FILE: file, ODR_SESSION_ID: session.id, ODR_RECEIPT: session.receiptFile },
    });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    process.on("SIGINT", forward("SIGINT"));
    process.on("SIGTERM", forward("SIGTERM"));
    code = await new Promise<number>((resolve) => child.on("close", (c, sig) => resolve(c ?? (sig ? 128 : 1))));
    outcome = code === 0 ? "ok" : code >= 128 ? "cancelled" : "failed";
  } else {
    const hold = Number(values.hold ?? 0);
    if (hold > 0) {
      log(`odr: holding ${session.id} for ${hold} s. ODR_SESSION_FILE=${file}`);
      await new Promise((r) => setTimeout(r, hold * 1000));
    }
  }
  await served.close();
  rmSync(file, { force: true });
  const receipt = await session.release(outcome);
  if (values.json) console.log(JSON.stringify(receipt, null, 2));
  else {
    const t = receipt.timings_ms;
    log(`odr: ${receipt.outcome}. ${receipt.device?.model ?? "?"} on ${receipt.route?.provider}. run-to-first-frame ${t.run_to_first_frame ?? "-"} ms, teardown ${t.teardown ?? "-"} ms, closure ${receipt.closure.status} (${receipt.closure.method}).`);
    log(`odr: receipt ${session.receiptFile}`);
  }
  if (receipt.closure.status !== "verified" && code === 0) code = 5;
  process.exit(code);
}

export async function cmdSweep(argv: string[], providers: Provider[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" } } });
  const res = await sweep({ providers });
  if (values.json) return void console.log(JSON.stringify(res, null, 2));
  if (!res.length) return void console.log("Nothing to sweep.");
  for (const r of res) console.log(`${r.id} ${r.provider}: ${r.action}${r.closure?.detail ? ` (${r.closure.detail})` : ""}`);
  if (res.some((r) => r.action === "closure_unverified")) process.exit(5);
}

export function cmdSessions(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" }, all: { type: "boolean" } } });
  const st = loadState();
  const rows = st.reservations.filter((r) => values.all || !["closed", "refused"].includes(r.status));
  if (values.json) return void console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return void console.log("No open sessions.");
  for (const r of rows) console.log(`${r.id}  ${r.provider.padEnd(16)} ${r.status.padEnd(18)} ${r.surface.padEnd(16)} pid ${r.owner.pid}@${r.owner.host}  expires ${r.expires_at}`);
}

export function cmdForget(argv: string[]): void {
  const id = argv[0] ?? fail("usage: odr session forget <id>  (marks a reservation closed after you checked the provider dashboard)");
  withLock(odrHome(), (st) => {
    const r = st.reservations.find((x) => x.id === id) ?? fail(`no reservation ${id}`);
    r.status = "closed";
    r.closure = "manual";
    r.closed_at = new Date().toISOString();
  });
  console.log(`${id} marked closed by hand.`);
}

export async function cmdReconcile(argv: string[], providers: Provider[]): Promise<void> {
  const p = providers.find((x) => x.id === argv[0]) ?? fail("usage: odr reconcile <provider>");
  try {
    const r = await reconcile(p);
    console.log(`${p.id} ${r.period}: provider reports ${r.provider_minutes} min, odr recorded ${r.local_minutes} min${r.added_minutes ? `; added ${r.added_minutes} min to the ledger` : ""}.`);
  } catch (error) {
    fail((error as Error).message, (error as { code?: string }).code === "no_usage_api" ? 6 : 1);
  }
}

export function cmdKeys(argv: string[], providers: Provider[]): void {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" }, all: { type: "boolean" } } });
  const st = loadState();
  let list = providers.filter((p) => p.control);
  if (positionals[0]) list = list.filter((p) => p.id === positionals[0]);
  else if (!values.all) list = list.filter((p) => !st.connections[p.id]);
  if (values.json) {
    return void console.log(JSON.stringify(list.map((p) => ({ id: p.id, env: envNames(p), signup: p.signup.url, key_location: p.credentials.location, login_command: p.credentials.login_command, set: envNames(p).filter((n) => process.env[n]), steps: keySteps(p) })), null, 2));
  }
  if (!list.length) return void console.log("Every provider with a session driver is connected. `odr keys --all` lists them anyway.");
  for (const p of list) {
    const names = envNames(p);
    const missing = names.filter((n) => !process.env[n]);
    console.log(`${p.name} (${p.id})${names.length ? `  ${missing.length ? `missing: ${missing.join(", ")}` : "keys set"}` : ""}`);
    for (const s of keySteps(p)) console.log(`  - ${s}`);
    console.log("");
  }
}

export async function cmdDoctor(providers: Provider[]): Promise<void> {
  const st = loadState();
  const out: string[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  out.push(`node ${process.versions.node}${major >= 22 ? "" : "  (need 22.12+ for the Appetize CLI)"}`);
  const has = async (m: string) => import(m as string).then(() => true, () => false);
  out.push(`agent-device: ${(await has("agent-device")) ? "installed" : "not installed (npm i agent-device) - needed for local, GitHub runners, Limrun, Revyl"}`);
  out.push(`@midscene/core: ${(await has("@midscene/core/device")) ? "installed" : "not installed (optional, for midsceneInterface)"}`);
  const { execFile } = await import("node:child_process");
  const which = (bin: string, args: string[]) => new Promise<boolean>((r) => execFile(bin, args, (e) => r(!e)));
  out.push(`appetize CLI: ${(await which(process.env.ODR_APPETIZE_CLI ?? "appetize", ["--version"])) ? "found" : "not found (npm i -g @appetize/cli)"}`);
  out.push(`xcrun simctl: ${(await which("xcrun", ["simctl", "help"])) ? "found" : "not found (iOS Simulator needs macOS + Xcode)"}`);
  out.push(`adb: ${(await which("adb", ["version"])) ? "found" : "not found (Android needs platform-tools)"}`);
  out.push("");
  for (const p of providers.filter((x) => x.control)) {
    const c = st.connections[p.id];
    const missing = envNames(p).filter((n) => !process.env[n]);
    out.push(`${p.id.padEnd(16)} ${c ? `connected${c.plan ? ` (${c.plan})` : ""}` : "not connected"}${missing.length ? `, missing ${missing.join(", ")}` : ""}`);
  }
  const open = st.reservations.filter((r) => ["reserved", "active", "releasing", "closure_unverified"].includes(r.status));
  out.push("", `${open.length} open or unverified reservation(s)${open.length ? "; run `odr sweep`" : ""}`);
  console.log(out.join("\n"));
}
