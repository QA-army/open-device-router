import { spawn } from "node:child_process";
import { loadState } from "../core/ledger.js";
import type { Provider } from "../core/types.js";
import { credentialStatus, freeMinuteSummary, nextUnconnected, onboardingCatalog, type OnboardingEntry } from "../onboarding/catalog.js";

// Agent-facing onboarding. Prints the next signup and checks that credentials are present.
// It never submits a form, never accepts terms, and never prints a credential value.

function entryText(e: OnboardingEntry, index: number, total: number): string {
  const lines = [
    `${index} of ${total}: ${e.name} (${e.id})`,
    `Adapter: ${e.adapter}${e.stub_reason ? ` — ${e.stub_reason}` : ""}`,
    e.signup_url ? `Sign up yourself (do not automate this): ${e.signup_url}` : `No signup URL. Homepage: ${e.homepage}`,
  ];
  if (e.human_steps.length) lines.push(`You do these yourself: ${e.human_steps.join(", ")}`);
  lines.push(`Card: ${e.card_required}. Phone: ${e.phone_required}.`);
  if (e.login_command) lines.push(`Login command (you run it): ${e.login_command}`);
  if (e.credential_location) lines.push(`Where the key is shown: ${e.credential_location}`);
  if (e.credential_env.length) lines.push(`Env vars (set them yourself; odr only checks that they exist): ${e.credential_env.join(", ")}`);
  const allowance = e.allowances.map((a) => `${a.amount ?? "unlimited"} ${a.unit} (${a.type}, overage ${a.overage})`).join("; ");
  if (allowance) lines.push(`Free allowance, vendor-documented: ${allowance}`);
  lines.push(e.verify);
  lines.push(`When that is done: odr connect ${e.id} --done`);
  return lines.join("\n");
}

export function cmdOnboard(argv: string[], providers: Provider[]): void {
  const [sub, ...rest] = argv;
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  if (!sub || sub === "status" || (sub === "--json" && args.length === 0)) {
    const catalog = onboardingCatalog(providers);
    const state = loadState();
    const summary = freeMinuteSummary(providers, state);
    const body = { catalog, ...summary, next: nextUnconnected(providers, state) ?? null };
    if (json || sub === "--json") return void console.log(JSON.stringify(body, null, 2));
    console.log(`${summary.connected.length} connected, ${summary.not_connected.length} not connected.`);
    console.log(`Metered minutes still on the ledger: ${summary.total_metered_minutes}.`);
    console.log(summary.note);
    console.log("");
    const next = nextUnconnected(providers, state);
    if (!next) return void console.log("Every provider in the registry is connected. `odr onboard summary` lists free minutes.");
    const index = catalog.findIndex((e) => e.id === next.id) + 1;
    console.log(entryText(next, index, catalog.length));
    console.log("\nNext: open that URL for the person, wait until they finish, then `odr onboard verify " + next.id + "`.");
    return;
  }
  if (sub === "next") {
    const catalog = onboardingCatalog(providers);
    const next = nextUnconnected(providers, loadState());
    if (json) return void console.log(JSON.stringify(next ?? null, null, 2));
    if (!next) return void console.log("Every provider in the registry is connected.");
    console.log(entryText(next, catalog.findIndex((e) => e.id === next.id) + 1, catalog.length));
    return;
  }
  if (sub === "summary") {
    const summary = freeMinuteSummary(providers, loadState());
    if (json) return void console.log(JSON.stringify(summary, null, 2));
    console.log(`Connected: ${summary.connected.join(", ") || "none"}`);
    console.log(`Metered minutes on the ledger: ${summary.total_metered_minutes}`);
    for (const [unit, n] of Object.entries(summary.by_unit)) console.log(`  ${unit}: ${n}`);
    if (summary.unlimited.length) console.log(`Unlimited: ${summary.unlimited.join(", ")}`);
    for (const o of summary.other) console.log(`  ${o.provider}: ${o.remaining} ${o.unit} (not added to the minute total)`);
    if (summary.excluded.length) {
      console.log("Left out:");
      for (const e of summary.excluded) console.log(`  ${e.name}: ${e.reason} (${e.source})`);
    }
    return;
  }
  if (sub === "verify") {
    const id = rest.find((a) => !a.startsWith("--"));
    const p = providers.find((x) => x.id === id);
    if (!p) {
      console.error("odr: usage: odr onboard verify <provider>");
      process.exit(1);
    }
    const check = credentialStatus(p, process.env);
    const body = { id: p.id, adapter: onboardingCatalog([p])[0]?.adapter, ...check };
    if (json) console.log(JSON.stringify(body, null, 2));
    else console.log(`${p.id}: ${check.ready ? "ready to record" : "not ready"}. ${check.detail}${check.missing.length ? ` Missing: ${check.missing.join(", ")}` : ""}`);
    if (!check.ready) process.exit(1);
    return;
  }
  if (sub === "open") {
    const id = rest.find((a) => !a.startsWith("--"));
    const entry = onboardingCatalog(providers).find((e) => e.id === id);
    if (!entry) {
      console.error("odr: usage: odr onboard open <provider>");
      process.exit(1);
    }
    const url = entry.signup_url ?? entry.homepage;
    console.log(url);
    console.log("A person has to finish this page. odr does not type into it or accept terms.");
    const bin = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(bin, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => console.error(`odr: could not launch ${bin}. Open the URL above yourself.`));
    child.unref();
    return;
  }
  console.error("odr: usage: odr onboard [status|next|verify <id>|summary|open <id>] [--json]");
  process.exit(1);
}
