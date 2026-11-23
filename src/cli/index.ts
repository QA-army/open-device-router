#!/usr/bin/env node
import { parseArgs } from "node:util";
import { costInUnits, loadState, odrHome, remainingFor, saveState, type Connection } from "../core/ledger.js";
import { route, TYPE_ORDER } from "../core/router.js";
import { isSurface, SURFACES, type Allowance, type Provider, type Surface } from "../core/types.js";
import { ageInDays, findProvider, loadRegistry } from "../registry/load.js";
import { freeTiersMarkdown } from "./free-tiers.js";
import { keysMarkdown } from "./keys.js";
import { cmdBench } from "./bench-command.js";
import { cmdDoctor, cmdForget, cmdKeys, cmdReconcile, cmdRun, cmdSessions, cmdSweep, REQUEST_OPTIONS, requestFromFlags } from "./session-commands.js";
import { VERSION } from "../version.js";

const HELP = `odr - OpenDeviceRouter ${VERSION} (pre-release)

Sessions
  odr run --platform ios|android [--model m] [--os 18|>=17] [--build app.apk|--build-url u|--build-id id]
          [--needs tap,type,swipe,key] [--keys enter,home] --minutes n [--budget-usd n] [--json] [-- cmd ...]
                                   allocate a device, install and launch, wait for the first usable frame,
                                   run cmd with ODR_SESSION_FILE set, then release and verify closure
  odr sessions [--all]             open reservations in the ledger
  odr sweep                        stop devices left by dead or lost workers
  odr session forget <id>          mark a reservation closed after checking the provider by hand
  odr reconcile <id>               pull the provider's own usage figure (Appetize today)

Benchmark
  odr bench [--platform ios|android] [--cold 3] [--warm 3] [--parallel 1,2,4,8] [--submit]
                                   SimBench: cold and warm sessions on this machine, a JSON result
                                   and a share card. \`odr bench help\` for details

Keys and accounts
  odr keys [id] [--all]            where to get each key, env var names, gh secret lines
  odr doctor                       what is installed, connected and missing
  odr connect <id>                 signup and credential checklist
  odr connect <id> --done [--plan p] [--max-usd-month n] [--surfaces a,b] [--oss-program]
  odr disconnect <id>

Registry and planning
  odr providers [--status s] [--surface s] [--json]
  odr show <id>
  odr plan (same request flags as run) [--json]   dry run: which provider, which profile, why
  odr status [--json]              connected providers and free capacity left
  odr record <id> --surface <s> --minutes <n>     manual debit for sessions odr did not run
  odr validate | odr freshness | odr free-tiers [--write|--check] | odr keys-doc [--write|--check]

Default spend policy is free-only: odr refuses rather than pick capacity that could bill.
State: ${odrHome()} (ODR_HOME). No credentials are stored there.
`;

function fail(message: string, code = 1): never {
  console.error(`odr: ${message}`);
  process.exit(code);
}

function loadValid(): Provider[] {
  const { providers, issues } = loadRegistry();
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length > 0) fail(`registry has ${errors.length} error(s); run \`odr validate\``);
  return providers;
}

function need(providers: Provider[], id: string | undefined): Provider {
  if (!id) fail("provider id is required");
  const p = findProvider(providers, id);
  if (!p) fail(`unknown provider "${id}". Run \`odr providers\`.`);
  return p;
}

function surfaceArg(value: string | undefined): Surface {
  if (!value || !isSurface(value)) fail(`--surface must be one of: ${SURFACES.join(", ")}`);
  return value;
}

function minutesArg(value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) fail("--minutes must be a number greater than 0");
  return n;
}

function describeAllowance(a: Allowance): string {
  const amount = a.unit === "unlimited" ? "unlimited" : `${a.amount} ${a.unit}`;
  const limits = [
    a.max_session_minutes ? `${a.max_session_minutes}-min sessions` : "",
    a.max_parallel ? `${a.max_parallel} parallel` : "",
    a.expires_days ? `expires after ${a.expires_days} days` : "",
  ].filter(Boolean);
  return `${a.type}: ${amount}${limits.length ? ` (${limits.join(", ")})` : ""}`;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd()).join("\n");
}

function cmdProviders(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { status: { type: "string" }, surface: { type: "string" }, json: { type: "boolean" } },
  });
  let list = loadValid();
  if (values.status) list = list.filter((p) => p.status === values.status);
  if (values.surface) {
    const s = surfaceArg(values.surface);
    list = list.filter((p) => p.surfaces.includes(s));
  }
  if (values.json) return void console.log(JSON.stringify(list, null, 2));
  const rows = [["ID", "STATUS", "HANDS", "FREE ALLOWANCE (vendor-documented)", "CHECKED"]];
  for (const p of list) {
    rows.push([p.id, p.status, p.hands.kind, p.allowances.map(describeAllowance).join("; ") || "-", p.checked_at]);
  }
  console.log(table(rows));
}

function cmdValidate(): void {
  const { providers, issues } = loadRegistry();
  for (const i of issues) console.log(`${i.level.toUpperCase().padEnd(7)} ${i.file}: ${i.message}`);
  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.length - errors;
  console.log(`${providers.length} entries checked, ${errors} error(s), ${warnings} warning(s)`);
  if (errors > 0) process.exit(1);
}

function cmdFreshness(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: { "max-age-days": { type: "string", default: "45" }, json: { type: "boolean" } },
  });
  const max = Number(values["max-age-days"]);
  if (!Number.isFinite(max) || max < 0) fail("--max-age-days must be a number");
  const now = new Date();
  const stale = loadValid()
    .map((p) => ({ id: p.id, checked_at: p.checked_at, age_days: ageInDays(p.checked_at, now) }))
    .filter((e) => e.age_days > max);
  if (values.json) console.log(JSON.stringify({ max_age_days: max, stale }, null, 2));
  else if (stale.length === 0) console.log(`All entries were checked within ${max} days.`);
  else for (const e of stale) console.log(`${e.id}: checked ${e.checked_at} (${e.age_days} days ago)`);
  if (stale.length > 0) process.exit(1);
}

function cmdConnect(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      done: { type: "boolean" },
      surfaces: { type: "string" },
      "oss-program": { type: "boolean" },
      "skip-env-check": { type: "boolean" },
      plan: { type: "string" },
      "max-usd-month": { type: "string" },
    },
  });
  const p = need(loadValid(), positionals[0]);

  if (!values.done) {
    const lines: string[] = [`${p.name} (${p.id}), entry checked ${p.checked_at}`, ""];
    lines.push("Use one account that you or your organization owns. odr does not create accounts.");
    lines.push("");
    if (!p.signup.required) lines.push("1. No signup needed.");
    else if (p.signup.evidence.includes("not_researched")) {
      lines.push(`1. Signup has not been researched yet. Start at ${p.homepage}`);
    } else {
      lines.push(`1. Sign up or sign in yourself: ${p.signup.url}`);
      if (p.signup.sso?.length) lines.push(`   Sign-in options: ${p.signup.sso.join(", ")}`);
      for (const f of p.signup.fields ?? []) {
        lines.push(`   Field: ${f.name} (${f.from === "agent" ? "an agent can fill this from the repo" : "you supply this"})`);
      }
      if (p.signup.human_steps?.length) lines.push(`   You do these yourself: ${p.signup.human_steps.join(", ")}`);
      lines.push(`   Card: ${p.signup.card_required}. Phone: ${p.signup.phone_required}.`);
      if (p.signup.notes) lines.push(`   Note: ${p.signup.notes}`);
    }
    lines.push("");
    const c = p.credentials;
    if (c.acquire === "none") lines.push("2. No credential needed.");
    else {
      lines.push(`2. Get a credential (${c.kind}, ${c.acquire}):`);
      if (c.login_command) lines.push(`   Run: ${c.login_command}`);
      if (c.location) lines.push(`   Or copy it from: ${c.location}`);
      if (c.notes) lines.push(`   Note: ${c.notes}`);
      const names = p.hands.env?.length ? p.hands.env : (c.env ?? []);
      if (names.length) lines.push(`   Keep it in your own environment or secret store as: ${names.join(", ")}`);
    }
    lines.push("");
    lines.push(`3. Free allowance (vendor-documented): ${p.allowances.map(describeAllowance).join("; ") || "none listed"}`);
    if (p.paid) lines.push(`   After that: ${p.paid.summary} odr will not route past the free allowance.`);
    if (p.policy.notes) lines.push(`   Terms note: ${p.policy.notes}`);
    lines.push("");
    lines.push(`4. Then run: odr connect ${p.id} --done`);
    console.log(lines.join("\n"));
    return;
  }

  const missing = (p.hands.env ?? []).filter((name) => !process.env[name]);
  if (missing.length > 0 && !values["skip-env-check"]) {
    fail(`${missing.join(", ")} not set. Export it, or pass --skip-env-check if the credential lives elsewhere.`);
  }
  const connection: Connection = { connected_at: new Date().toISOString() };
  if (values.surfaces) {
    const list = values.surfaces.split(",").map((s) => s.trim());
    for (const s of list) if (!isSurface(s) || !p.surfaces.includes(s)) fail(`${p.id} does not offer surface "${s}"`);
    connection.surfaces = list as Surface[];
  }
  if (values["oss-program"]) connection.oss_program = true;
  if (values.plan) {
    if (!p.allowances.some((a) => a.plan === values.plan)) fail(`${p.id} has no plan "${values.plan}" in the registry`);
    connection.plan = values.plan;
  }
  if (values["max-usd-month"] !== undefined) {
    const cap = Number(values["max-usd-month"]);
    if (!(cap >= 0)) fail("--max-usd-month must be 0 or more");
    connection.max_usd_month = cap;
  }
  const state = loadState();
  const previous = state.connections[p.id];
  // Keep the original date so a one-time allowance does not look new again.
  if (previous) connection.connected_at = previous.connected_at;
  state.connections[p.id] = connection;
  saveState(state);
  console.log(`${p.id} connected. No credential was stored. Run \`odr status\`.`);
}

function cmdDisconnect(argv: string[]): void {
  const p = need(loadValid(), argv[0]);
  const state = loadState();
  if (!state.connections[p.id]) fail(`${p.id} is not connected`);
  delete state.connections[p.id];
  saveState(state);
  console.log(`${p.id} disconnected. Usage history kept.`);
}

function cmdStatus(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" } } });
  const providers = loadValid();
  const state = loadState();
  const now = new Date();
  const out: Array<Record<string, unknown>> = [];
  for (const [id, connection] of Object.entries(state.connections)) {
    const p = findProvider(providers, id);
    if (!p) continue;
    p.allowances.forEach((a, i) => {
      const left = remainingFor(state, id, i, a, connection, now);
      out.push({
        provider: id,
        allowance: i,
        type: a.type,
        unit: a.unit,
        used: left.used,
        remaining: Number.isFinite(left.remaining) ? left.remaining : "unlimited",
        expired: left.expired,
        resets_or_expires: left.window.end?.toISOString() ?? null,
      });
    });
  }
  if (values.json) return void console.log(JSON.stringify(out, null, 2));
  if (out.length === 0) return void console.log("Nothing connected. Try `odr connect local` or `odr providers`.");
  const rows = [["PROVIDER", "ALLOWANCE", "USED", "LEFT (estimate)", "RESETS / EXPIRES (UTC)"]];
  for (const r of out) {
    rows.push([
      String(r.provider),
      `${r.type} ${r.unit}`,
      String(r.used),
      r.expired ? "expired" : String(r.remaining),
      r.resets_or_expires ? String(r.resets_or_expires).slice(0, 16).replace("T", " ") : "-",
    ]);
  }
  console.log(table(rows));
  console.log("\nLEFT is odr's own count (sessions it ran plus `odr record`), net of open reservations. `odr reconcile <id>` pulls the provider's figure where it has a usage API.");
}

function cmdPlan(argv: string[]): void {
  const { values } = parseArgs({ args: argv, options: { ...REQUEST_OPTIONS, json: { type: "boolean" } } });
  const providers = loadValid();
  const request = requestFromFlags(values);
  if (request.surface && !isSurface(request.surface)) surfaceArg(request.surface);
  const decision = route(request, providers, loadState());
  if (values.json) {
    console.log(JSON.stringify(decision, null, 2));
    if (!decision.chosen) process.exit(3);
    return;
  }
  console.log(`Request: ${JSON.stringify(request)}`);
  console.log(`Order:   free first, then ${TYPE_ORDER.join(" > ")}\n`);
  const rows = [["PROVIDER", "ALLOWANCE", "PROFILE", "COST", "LEFT", "USD", "RESULT"]];
  for (const c of decision.considered) {
    if (c.skip === "not_connected" || c.skip === "surface_not_offered" || c.skip === "not_selected") continue;
    rows.push([
      c.provider,
      `${c.plan ? `${c.plan} ` : ""}${c.type} ${c.unit}`,
      c.profile ?? "-",
      String(c.cost),
      Number.isFinite(c.remaining) ? `${c.remaining}${c.basis === "local_estimate" ? " (est)" : ""}` : "unlimited",
      String(c.usd),
      c.eligible ? "eligible" : `skipped: ${c.skip}${c.detail ? ` (${c.detail})` : ""}`,
    ]);
  }
  if (rows.length > 1) console.log(`${table(rows)}\n`);
  console.log(decision.reason);
  if (!decision.chosen) process.exit(3);
  console.log("\nDry run. Nothing was reserved. `odr run` with the same flags allocates it.");
}

function cmdRecord(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { surface: { type: "string" }, minutes: { type: "string" }, note: { type: "string" } },
  });
  const providers = loadValid();
  const p = need(providers, positionals[0]);
  const surface = surfaceArg(values.surface);
  const minutes = minutesArg(values.minutes);
  const state = loadState();
  if (!state.connections[p.id]) fail(`${p.id} is not connected`);
  // Debit the allowance the router would pick for this provider alone.
  const decision = route({ surface, minutes }, [p], state);
  let index = decision.chosen?.allowance;
  if (index === undefined) {
    // Over the estimate: still record against the first allowance that can be metered, so the ledger shows it.
    index = p.allowances.findIndex((a) => a.type !== "unverified" && costInUnits(a, surface, minutes) !== undefined);
    if (index === -1) fail(`${p.id} has no allowance that can be metered for ${surface}`);
    console.error(`odr: warning: this session exceeds the estimated free capacity left on ${p.id}`);
  }
  const amount = costInUnits(p.allowances[index]!, surface, minutes)!;
  state.usage.push({
    provider: p.id,
    allowance: index,
    amount,
    minutes,
    surface,
    at: new Date().toISOString(),
    ...(values.note ? { note: values.note } : {}),
  });
  saveState(state);
  console.log(`Recorded ${minutes} min on ${p.id} (${amount} ${p.allowances[index]!.unit}).`);
}

async function cmdFreeTiers(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { write: { type: "boolean" }, check: { type: "boolean" } } });
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { REPO_ROOT } = await import("../registry/load.js");
  const file = join(REPO_ROOT, "docs", "free-tiers.md");
  const md = freeTiersMarkdown(loadValid());
  if (values.write) {
    writeFileSync(file, md);
    console.log(`wrote ${file}`);
  } else if (values.check) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== md) {
      fail("docs/free-tiers.md is out of date. Run `npm run docs:free-tiers`.");
    }
    console.log("docs/free-tiers.md is up to date");
  } else process.stdout.write(md);
}

async function cmdKeysDoc(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { write: { type: "boolean" }, check: { type: "boolean" } } });
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { REPO_ROOT } = await import("../registry/load.js");
  const file = join(REPO_ROOT, "docs", "keys.md");
  const md = keysMarkdown(loadValid());
  if (values.write) {
    writeFileSync(file, md);
    console.log(`wrote ${file}`);
  } else if (values.check) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== md) fail("docs/keys.md is out of date. Run `npm run docs:keys`.");
    console.log("docs/keys.md is up to date");
  } else process.stdout.write(md);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "providers":
      return cmdProviders(rest);
    case "show":
      return void console.log(JSON.stringify(need(loadValid(), rest[0]), null, 2));
    case "validate":
      return cmdValidate();
    case "freshness":
      return cmdFreshness(rest);
    case "free-tiers":
      return cmdFreeTiers(rest);
    case "connect":
      return cmdConnect(rest);
    case "disconnect":
      return cmdDisconnect(rest);
    case "status":
      return cmdStatus(rest);
    case "plan":
      return cmdPlan(rest);
    case "record":
    case "use":
      return cmdRecord(rest);
    case "run":
      return cmdRun(rest, loadValid());
    case "sessions":
      return cmdSessions(rest);
    case "session":
      if (rest[0] === "forget") return cmdForget(rest.slice(1));
      return fail("usage: odr session forget <id>");
    case "sweep":
      return cmdSweep(rest, loadValid());
    case "reconcile":
      return cmdReconcile(rest, loadValid());
    case "keys":
      return cmdKeys(rest, loadValid());
    case "keys-doc":
      return cmdKeysDoc(rest);
    case "doctor":
      return cmdDoctor(loadValid());
    case "bench":
      return cmdBench(rest);
    case "mcp":
    case "proxy":
      fail(`\`${command}\` is not implemented yet. See ROADMAP.md.`, 2);
    default:
      fail(`unknown command "${command}". Run \`odr help\`.`);
  }
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
