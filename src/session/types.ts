import type { RouteRequest } from "../core/router.js";
import type { BuildFormat, Control, DeviceProfile, Key, Platform, DeviceKind, Provider, Size } from "../core/types.js";

/** An app build to put on the device. */
export interface BuildSource {
  format: BuildFormat;
  /** Local file. */
  path?: string;
  /** HTTPS URL the driver may fetch. */
  url?: string;
  /** Build already uploaded to the provider (e.g. an Appetize buildId). Skips upload. */
  provider_build_id?: string;
  /** Bundle id or package name, when known. Otherwise the driver reports it after install. */
  app_id?: string;
}

/** The device the provider actually gave us. Only fields the provider or host reported are set. */
export interface DeviceIdentity {
  provider: string;
  platform: Platform;
  kind: DeviceKind;
  model?: string;
  os_version?: string;
  provider_device?: string;
  /** Simulator UDID, emulator serial or provider device id. Not a credential. */
  device_id?: string;
  /** Where the identity came from. */
  confirmed_by: "provider_api" | "driver" | "requested_only";
}

export interface Screenshot {
  png: Buffer;
  width: number;
  height: number;
  /** Input coordinate space: tap/swipe take points in this space. */
  input: Size;
}

export interface Point {
  x: number;
  y: number;
}

/** Non-secret facts a sweeper needs to find and stop a device after this process is gone. */
export type Locator = Record<string, string | number | boolean>;

export interface PhaseTimes {
  provider_queue_ms?: number;
  install_ms?: number;
  launch_ms?: number;
}

export interface AllocateContext {
  reservation: string;
  request: RouteRequest;
  provider: Provider;
  control: Control;
  profile: DeviceProfile;
  build?: BuildSource;
  /** Provider build id produced by prepareBuild, when install happens before allocation. */
  prepared_build?: string;
  minutes: number;
  tenant: string;
  run_id: string;
  env: NodeJS.ProcessEnv;
  /** Called before the provider is asked for a device so a crash still leaves a cleanup trail. */
  onLocator: (locator: Locator) => void;
  log: (line: string) => void;
}

export interface Allocated {
  device: DeviceIdentity;
  phases: PhaseTimes;
  /** Bundle id / package already launched by the provider (Appetize launches on start). */
  launched_app?: string;
}

export interface ClosureResult {
  status: "verified" | "unverified" | "failed";
  method: "provider_api" | "driver" | "none";
  detail?: string;
}

/**
 * A driver turns one provider's control path into the session operations the SDK exposes.
 * Drivers hold the private handle (tokens, session ids, viewer URLs). It never leaves the driver
 * except through `handle()`, which the SDK only returns to the caller.
 */
export interface Driver {
  readonly name: Control["driver"];
  prepareBuild?(build: BuildSource, ctx: AllocateContext): Promise<string>;
  allocate(ctx: AllocateContext): Promise<Allocated>;
  install(build: BuildSource): Promise<string | undefined>;
  launch(appId: string): Promise<void>;
  screenshot(): Promise<Screenshot>;
  tap(p: Point, opts?: { durationMs?: number }): Promise<void>;
  type(text: string): Promise<void>;
  swipe(from: Point, to: Point, opts?: { durationMs?: number }): Promise<void>;
  key(k: Key): Promise<void>;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
  verifyClosed(): Promise<ClosureResult>;
  /** Minutes the provider reports for this session, when it reports them. */
  providerMinutes?(): Promise<number | undefined>;
  handle(): Record<string, unknown>;
}

export interface DriverModule {
  create(): Driver;
  /** Stop whatever a dead worker left behind, from its locator alone. */
  sweep(locator: Locator, env: NodeJS.ProcessEnv): Promise<ClosureResult>;
}
