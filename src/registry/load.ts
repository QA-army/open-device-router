import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { parse } from "yaml";
import type { Provider } from "../core/types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");
export const DEFAULT_REGISTRY_DIR = join(REPO_ROOT, "registry", "providers");
export const SCHEMA_PATH = join(REPO_ROOT, "schema", "provider.schema.json");

export interface Issue {
  file: string;
  level: "error" | "warning";
  message: string;
}

export interface Registry {
  providers: Provider[];
  issues: Issue[];
}

const DAY_MS = 86_400_000;

/** Whole days between the entry's checked_at date and `now`. */
export function ageInDays(checkedAt: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(`${checkedAt}T00:00:00Z`)) / DAY_MS);
}

/** Rules the JSON schema cannot express. Returns issues for one already schema-valid entry. */
export function checkPolicy(p: Provider, file: string, now: Date): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string) => issues.push({ file, level: "error", message });
  const warn = (message: string) => issues.push({ file, level: "warning", message });

  if (file !== `${p.id}.yaml`) err(`file name must be ${p.id}.yaml to match id`);

  const checked = Date.parse(`${p.checked_at}T00:00:00Z`);
  if (Number.isNaN(checked)) err(`checked_at is not a real date: ${p.checked_at}`);
  else if (checked > now.getTime() + DAY_MS) err(`checked_at is in the future: ${p.checked_at}`);

  const provided = new Set(p.surfaces);
  for (const s of p.hands.surfaces ?? []) {
    if (!provided.has(s)) err(`hands.surfaces lists ${s}, which is not in surfaces`);
  }
  if (p.hands.kind === "agent-device" && p.hands.plugin && !p.hands.provider_id) {
    err("hands.plugin needs hands.provider_id");
  }
  if (p.hands.kind !== "unknown" && p.id !== "local" && !p.hands.source && !p.hands.notes) {
    err("hands needs a source or a note explaining the control path");
  }

  if (p.signup.required && !p.signup.evidence.includes("not_researched") && !p.signup.url) {
    err("signup.url is required once signup has been researched");
  }
  if (p.signup.card_required === true && !p.signup.human_steps?.includes("payment_card")) {
    err("card_required is true, so human_steps must include payment_card");
  }
  if (p.signup.phone_required === true && !p.signup.human_steps?.includes("phone_code")) {
    err("phone_required is true, so human_steps must include phone_code");
  }
  if (p.signup.required && !p.signup.evidence.includes("not_researched") && !p.signup.human_steps?.includes("accept_terms")) {
    err("a researched signup must list accept_terms as a human step");
  }

  if ((p.status === "launch" || p.status === "researched") && p.signup.evidence.includes("not_researched")) {
    err(`status ${p.status} requires researched signup evidence`);
  }
  if (p.status === "launch") {
    if (p.hands.kind === "unknown") err("a launch provider needs a verified control path (hands.kind)");
    if (p.policy.benchmark_publication === "restricted") {
      err("a launch provider cannot have benchmark_publication: restricted");
    }
    if (!p.policy.terms_url) err("a launch provider needs policy.terms_url");
    if (p.allowances.length === 0) err("a launch provider needs at least one allowance");
  }
  if (p.policy.benchmark_publication === "restricted" && !p.policy.terms_url) {
    err("benchmark_publication: restricted needs policy.terms_url");
  }

  p.allowances.forEach((a, i) => {
    const at = `allowances[${i}]`;
    if (a.unit === "unlimited" && a.amount !== undefined) err(`${at}: unlimited must not set amount`);
    if (a.unit !== "unlimited" && a.amount === undefined) err(`${at}: amount is required for unit ${a.unit}`);
    for (const s of a.surfaces ?? []) {
      if (!provided.has(s)) err(`${at}: surfaces lists ${s}, which is not in surfaces`);
    }
    for (const s of Object.keys(a.per_minute ?? {})) {
      if (!provided.has(s as never)) err(`${at}: per_minute lists ${s}, which is not in surfaces`);
    }
    if (!p.sources.includes(a.source)) err(`${at}: source must also appear in sources`);
    if ((a.unit === "credit" || a.unit === "usd" || a.unit === "test_run") && !a.per_minute) {
      warn(`${at}: unit ${a.unit} has no per_minute rate, so the router will not use it`);
    }
    if (a.type === "unverified") warn(`${at}: renewal is unverified, so the router will not use it`);
  });
  if (p.paid && !p.sources.includes(p.paid.source)) err("paid.source must also appear in sources");

  return issues;
}

export function loadRegistry(dir: string = DEFAULT_REGISTRY_DIR, now: Date = new Date()): Registry {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
  const providers: Provider[] = [];
  const issues: Issue[] = [];
  const seen = new Set<string>();

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".yaml")) {
      if (!file.startsWith(".")) issues.push({ file, level: "error", message: "provider files must end in .yaml" });
      continue;
    }
    let data: unknown;
    try {
      data = parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      issues.push({ file, level: "error", message: `YAML parse error: ${(e as Error).message}` });
      continue;
    }
    if (!validate(data)) {
      for (const e of validate.errors ?? []) {
        issues.push({ file, level: "error", message: `${e.instancePath || "/"} ${e.message ?? "is invalid"}` });
      }
      continue;
    }
    const p = data as unknown as Provider;
    if (seen.has(p.id)) issues.push({ file, level: "error", message: `duplicate id ${p.id}` });
    seen.add(p.id);
    issues.push(...checkPolicy(p, file, now));
    providers.push(p);
  }
  return { providers, issues };
}

export function findProvider(providers: Provider[], id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}
