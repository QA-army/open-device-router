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
  | "appetize-cli"
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
  /** Plan this allowance belongs to. Undefined = the default free plan. */
  plan?: string;
  overage: Overage;
  overage_usd_per_minute?: number;
  overage_source?: string;
  source: string;
  notes?: string;
}

/** stops and throttled never bill. bills means metered charges after the allowance. */
export type Overage = "stops" | "throttled" | "bills" | "not_applicable" | "unknown";

export type Platform = "ios" | "android" | "web";
export type DeviceKind = "simulator" | "emulator" | "real" | "browser";
export const INPUTS = ["screenshot", "tap", "type", "swipe", "key", "install", "launch"] as const;
export type Input = (typeof INPUTS)[number];
export const KEYS = ["enter", "backspace", "tab", "home", "back"] as const;
export type Key = (typeof KEYS)[number];
export const BUILD_FORMATS = ["apk", "aab", "app-zip", "app", "ipa"] as const;
export type BuildFormat = (typeof BUILD_FORMATS)[number];
export type Evidence = "observed" | "vendor-documented" | "proposed" | "unknown";

export interface Size {
  width: number;
  height: number;
}

export interface DeviceProfile {
  id: string;
  platform: Platform;
  kind: DeviceKind;
  /** `*` = any model the provider offers. */
  model: string;
  /** `*` = any OS version. */
  os: string;
  provider_device?: string;
  logical?: Size;
  pixels?: Size;
  evidence: Evidence;
  observed_at?: string;
  source?: string;
  notes?: string;
}

export interface Control {
  driver: "agent-device" | "appetize-cli" | "aws-device-farm" | "stub";
  package?: string;
  min_version?: string;
  lease_backend?: string;
  lease_provider?: string;
  inputs: Input[];
  keys?: Key[];
  screenshot: "whole_session" | "unknown";
  build_formats: BuildFormat[];
  install: "after_allocation" | "upload_before_allocation" | "none";
  closure_check: "provider_api" | "driver" | "none";
  usage_api?: string;
  max_session_minutes?: number;
  evidence: Evidence;
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
  profiles?: DeviceProfile[];
  control?: Control;
  notes?: string;
  sources: string[];
}

export function surfaceOf(platform: Platform, kind: DeviceKind): Surface | undefined {
  if (platform === "ios") return kind === "simulator" ? "ios-simulator" : kind === "real" ? "ios-real" : undefined;
  if (platform === "android") return kind === "emulator" ? "android-emulator" : kind === "real" ? "android-real" : undefined;
  return kind === "browser" ? "desktop-browser" : undefined;
}

export function deviceOf(surface: Surface): { platform: Platform; kind: DeviceKind } {
  switch (surface) {
    case "ios-simulator":
      return { platform: "ios", kind: "simulator" };
    case "ios-real":
      return { platform: "ios", kind: "real" };
    case "android-emulator":
      return { platform: "android", kind: "emulator" };
    case "android-real":
      return { platform: "android", kind: "real" };
    default:
      return { platform: "web", kind: "browser" };
  }
}

export function isSurface(value: string): value is Surface {
  return (SURFACES as readonly string[]).includes(value);
}
