import { remainingFor, type State } from "../core/ledger.js";
import type { Provider } from "../core/types.js";
import { envNames } from "../cli/keys.js";
import { awsCredentialGaps } from "../session/drivers/aws-device-farm-api.js";

// Machine-readable onboarding catalog. Facts come from the provider registry.
// A person completes every signup; this module only orders the steps and checks that
// credential env vars are present. It never reads their values.

/** README target order, then everyone else in free-tier status order. */
export const LAUNCH_ORDER = ["local", "github-actions", "appetize", "revyl", "limrun", "aws-device-farm"];

const STATUS_ORDER = ["baseline", "launch", "researched", "candidate"];

export interface ExcludedPlatform {
  id: string;
  name: string;
  reason: string;
  source: string;
  checked_at: string;
}

/** Checked and left out. Not a route and not a signup step. */
export const EXCLUDED: ExcludedPlatform[] = [
  {
    id: "firebase-test-lab",
    name: "Firebase Test Lab",
    reason:
      "Deprecated. Test executions keep working until 2027-09-30, then the console and API shut down. The replacement, Google Cloud Developer Device Platform, requires billing and does not offer the old no-billing allowance.",
    source: "https://firebase.google.com/docs/test-lab/migrate-faq",
    checked_at: "2026-11-26",
  },
];

export type AdapterState = "built" | "stub";

export function adapterOf(p: Provider): AdapterState {
  if (p.control && p.control.driver !== "stub" && p.control.evidence !== "proposed") return "built";
  return "stub";
}

export interface OnboardingAllowance {
  type: string;
  amount?: number;
  unit: string;
  scope?: string;
  overage: string;
  manual_only?: boolean;
  source: string;
}

export interface OnboardingEntry {
  id: string;
  name: string;
  status: string;
  adapter: AdapterState;
  homepage: string;
  signup_url?: string;
  human_steps: string[];
  card_required: boolean | "unknown" | "n/a";
  phone_required: boolean | "unknown" | "n/a";
  credential_kind: string;
  credential_env: string[];
  login_command?: string;
  credential_location?: string;
  allowances: OnboardingAllowance[];
  verify: string;
  stub_reason?: string;
}

export function onboardingCatalog(providers: Provider[]): OnboardingEntry[] {
  const ranked = [...providers].sort((a, b) => {
    const ai = LAUNCH_ORDER.indexOf(a.id);
    const bi = LAUNCH_ORDER.indexOf(b.id);
    if (ai >= 0 || bi >= 0) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    const as = STATUS_ORDER.indexOf(a.status);
    const bs = STATUS_ORDER.indexOf(b.status);
    return (as === -1 ? 99 : as) - (bs === -1 ? 99 : bs) || a.id.localeCompare(b.id);
  });
  return ranked.map((p) => {
    const adapter = adapterOf(p);
    const env = envNames(p);
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      adapter,
      homepage: p.homepage,
      ...(p.signup.url ? { signup_url: p.signup.url } : {}),
      human_steps: p.signup.human_steps ?? [],
      card_required: p.signup.required ? (p.signup.card_required ?? "unknown") : "n/a",
      phone_required: p.signup.required ? (p.signup.phone_required ?? "unknown") : "n/a",
      credential_kind: p.credentials.kind,
      credential_env: env,
      ...(p.credentials.login_command ? { login_command: p.credentials.login_command } : {}),
      ...(p.credentials.location ? { credential_location: p.credentials.location } : {}),
      allowances: p.allowances.map((a) => ({
        type: a.type,
        ...(a.amount !== undefined ? { amount: a.amount } : {}),
        unit: a.unit,
        ...(a.scope ? { scope: a.scope } : {}),
        overage: a.overage,
        ...(a.manual_only ? { manual_only: true } : {}),
        source: a.source,
      })),
      verify: verifyHint(p),
      ...(adapter === "stub" ? { stub_reason: "Registry and onboarding only. odr run will not start a session on this provider." } : {}),
    };
  });
}

function verifyHint(p: Provider): string {
  if (p.credentials.kind === "iam_role") {
    return "odr onboard verify aws-device-farm checks that a credential source and AWS_DEVICE_FARM_PROJECT_ARN are set, without reading them. odr reconcile aws-device-farm is the live check that remaining free minutes can be confirmed.";
  }
  if (p.credentials.acquire === "none") return "No credential. odr connect " + p.id + " --done records the machine.";
  const env = p.hands.env ?? [];
  if (!env.length) return `No env var is listed. After you finish signup yourself, run odr connect ${p.id} --done.`;
  return `odr onboard verify ${p.id} checks that ${env.join(", ")} ${env.length === 1 ? "is" : "are"} set. The value is not read.`;
}

export interface CredentialCheck {
  ready: boolean;
  missing: string[];
  detail: string;
}

/** Presence only. Never returns a credential value. */
export function credentialStatus(p: Provider, env: NodeJS.ProcessEnv = process.env): CredentialCheck {
  if (p.credentials.acquire === "none") return { ready: true, missing: [], detail: "no credential" };
  if (p.credentials.kind === "iam_role") {
    const missing = awsCredentialGaps(env);
    return {
      ready: missing.length === 0,
      missing,
      detail: "standard AWS credential chain plus AWS_DEVICE_FARM_PROJECT_ARN. Values are not read.",
    };
  }
  const names = p.hands.env ?? [];
  if (!names.length) {
    return { ready: true, missing: [], detail: `no env var is listed for ${p.id}. After signup, run odr connect ${p.id} --done.` };
  }
  const missing = names.filter((name) => !env[name]);
  return {
    ready: missing.length === 0,
    missing,
    detail: missing.length ? "one or more env vars are unset. Values are not read." : "env vars are set. Values are not read.",
  };
}

export function nextUnconnected(providers: Provider[], state: State): OnboardingEntry | undefined {
  const connected = new Set(Object.keys(state.connections));
  return onboardingCatalog(providers).find((e) => !connected.has(e.id));
}

const MINUTE_UNITS = new Set(["device_minute", "browser_minute", "minute"]);

export interface MinuteRow {
  provider: string;
  allowance: number;
  unit: string;
  remaining: number | "unlimited";
  expired: boolean;
  manual_only: boolean;
  /** Included in total_metered_minutes. Credits and dollars are listed separately. */
  counted: boolean;
}

export interface FreeMinuteSummary {
  connected: string[];
  not_connected: string[];
  rows: MinuteRow[];
  total_metered_minutes: number;
  by_unit: Record<string, number>;
  unlimited: string[];
  other: { provider: string; unit: string; remaining: number }[];
  excluded: ExcludedPlatform[];
  note: string;
}

export function freeMinuteSummary(providers: Provider[], state: State, now: Date = new Date()): FreeMinuteSummary {
  const rows: MinuteRow[] = [];
  const by_unit: Record<string, number> = {};
  const unlimited: string[] = [];
  const other: FreeMinuteSummary["other"] = [];
  let total = 0;
  for (const [id, connection] of Object.entries(state.connections)) {
    const p = providers.find((x) => x.id === id);
    if (!p) continue;
    p.allowances.forEach((a, allowance) => {
      if ((a.plan ?? undefined) !== (connection.plan ?? undefined)) return;
      const left = remainingFor(state, id, allowance, a, connection, now);
      if (a.unit === "unlimited") {
        unlimited.push(id);
        rows.push({ provider: id, allowance, unit: a.unit, remaining: "unlimited", expired: left.expired, manual_only: Boolean(a.manual_only), counted: false });
        return;
      }
      const remaining = left.remaining;
      const minute = MINUTE_UNITS.has(a.unit);
      const counted = minute && !left.expired && !a.manual_only && Number.isFinite(remaining);
      if (counted) {
        total += remaining;
        by_unit[a.unit] = (by_unit[a.unit] ?? 0) + remaining;
      } else if (!minute && Number.isFinite(remaining)) {
        other.push({ provider: id, unit: a.unit, remaining });
      }
      rows.push({
        provider: id,
        allowance,
        unit: a.unit,
        remaining,
        expired: left.expired,
        manual_only: Boolean(a.manual_only),
        counted,
      });
    });
  }
  const connected = Object.keys(state.connections).sort();
  const not_connected = onboardingCatalog(providers).map((e) => e.id).filter((id) => !state.connections[id]);
  return {
    connected,
    not_connected,
    rows,
    total_metered_minutes: Math.round(total * 100) / 100,
    by_unit,
    unlimited,
    other,
    excluded: EXCLUDED,
    note: "total_metered_minutes sums device, browser, and plain minutes still on the ledger for the connected plan. Credits and dollar allowances are under other and are not added in. The figure is odr's estimate until a provider reconcile says otherwise. Nothing here was measured by a benchmark run.",
  };
}
