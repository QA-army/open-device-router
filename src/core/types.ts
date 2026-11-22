// Types mirror schema/provider.schema.json. The schema is the contract; keep these in sync with it.

export const SURFACES = [
  "ios-simulator",
  "android-emulator",
  "ios-real",
  "android-real",
  "desktop-browser",
  "mobile-browser",
] as const;
export type Surface = (typeof SURFACES)[number];

export type Tri = boolean | "unknown";
export type ProviderStatus = "launch" | "baseline" | "researched" | "candidate";
export type HandsKind =
  | "agent-device"
  | "cdp-passthrough"
  | "webdriver-passthrough"
  | "playwright-connect"
  | "unknown";
export type AllowanceType =
  | "self_hosted"
  | "public_repo"
  | "daily"
  | "monthly"
  | "oss_program"
  | "one_time"
  | "unverified";
export type AllowanceUnit =
  | "device_minute"
  | "browser_minute"
  | "minute"
  | "credit"
  | "usd"
  | "test_run"
  | "unlimited";

export interface Hands {
  kind: HandsKind;
  surfaces?: Surface[];
  provider_id?: string;
  plugin?: string;
  env?: string[];
  connect_args?: string[];
  requires?: string[];
  source?: string;
  notes?: string;
}

export interface SignupField {
  name: string;
  required?: Tri;
  from: "user" | "agent" | "user_or_sso";
  notes?: string;
}

export interface Signup {
  required: boolean;
  url?: string;
  evidence: Array<"live_page" | "docs" | "not_researched" | "not_applicable">;
  sso?: string[];
  fields?: SignupField[];
  human_steps?: string[];
  card_required?: Tri;
  phone_required?: Tri;
  work_email_required?: Tri;
  notes?: string;
}

export interface Credentials {
  kind: string;
  acquire: "device_code" | "browser_login" | "iam_role" | "manual_copy" | "none" | "unknown";
  login_command?: string;
  location?: string;
  env?: string[];
  source?: string;
  notes?: string;
}

export interface Allowance {
  type: AllowanceType;
  amount?: number;
  unit: AllowanceUnit;
  per_minute?: Partial<Record<Surface, number>>;
  scope?: string;
  surfaces?: Surface[];
  manual_only?: boolean;
  max_session_minutes?: number;
  max_parallel?: number;
  expires_days?: number;
  source: string;
  notes?: string;
}

export interface Policy {
  max_accounts_per_org: 1;
  benchmark_publication:
    | "allowed_with_replication"
    | "no_clause_found"
    | "restricted"
    | "unknown"
    | "not_applicable";
  third_party_access?: "restricted" | "no_clause_found" | "unknown" | "not_applicable";
  terms_url?: string;
  terms_checked_note?: string;
  notes?: string;
}

export interface Provider {
  id: string;
  name: string;
  status: ProviderStatus;
  checked_at: string;
  homepage: string;
  surfaces: Surface[];
  hands: Hands;
  signup: Signup;
  credentials: Credentials;
  allowances: Allowance[];
  paid?: { summary: string; source: string };
  policy: Policy;
  notes?: string;
  sources: string[];
}

export function isSurface(value: string): value is Surface {
  return (SURFACES as readonly string[]).includes(value);
}
