import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Key } from "../../core/types.js";
import type { AllocateContext, Allocated, BuildSource, ClosureResult, Driver, DriverModule, Locator, Point, Screenshot } from "../types.js";
import {
  awsCredentialGaps,
  createDeviceFarmCli,
  type DeviceFarmApi,
  type RemoteSession,
} from "./aws-device-farm-api.js";

// Remote-access sessions on AWS Device Farm. Lifecycle (upload, create, stop, delete, closure,
// metered minutes) goes through the Device Farm API. Pixel input is supplied by an interactor.
// Without one, the driver refuses before CreateRemoteAccessSession so a metered session is not
// started and then abandoned. Docs: https://docs.aws.amazon.com/devicefarm/latest/developerguide/remote-access.html
// and https://docs.aws.amazon.com/devicefarm/latest/APIReference/API_CreateRemoteAccessSession.html

export interface DeviceControls {
  screenshot(): Promise<Screenshot>;
  tap(p: Point, opts?: { durationMs?: number }): Promise<void>;
  type(text: string): Promise<void>;
  swipe(from: Point, to: Point, opts?: { durationMs?: number }): Promise<void>;
  key(k: Key): Promise<void>;
  launch(appId: string): Promise<void>;
  close(): Promise<void>;
}

export interface DeviceFarmDriverDeps {
  api?: DeviceFarmApi;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  putFile?: (url: string, file: string, contentType: string) => Promise<void>;
  /** When omitted, the driver will not start a remote session. Tests and a future agent-device attach pass this. */
  controls?: (session: RemoteSession) => DeviceControls;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function putFile(url: string, file: string, contentType: string): Promise<void> {
  const body = readFileSync(file);
  const res = await fetch(url, { method: "PUT", body, headers: { "Content-Type": contentType }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Device Farm upload PUT returned ${res.status}`);
}

function contentType(format: string): string {
  return format === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream";
}

function uploadType(format: string): "ANDROID_APP" | "IOS_APP" {
  if (format === "apk") return "ANDROID_APP";
  if (format === "ipa") return "IOS_APP";
  throw new Error(`Device Farm remote access accepts apk or ipa, not ${format}`);
}

function platformFilter(platform: string): "ANDROID" | "IOS" {
  return platform === "android" ? "ANDROID" : "IOS";
}

export function createAwsDeviceFarmDriver(deps: DeviceFarmDriverDeps = {}): Driver {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const send = deps.putFile ?? putFile;
  let api = deps.api;
  let uploadArn: string | undefined;
  let sessionArn: string | undefined;
  let deviceArn: string | undefined;
  let projectArn = "";
  let controls: DeviceControls | undefined;
  let finalSession: RemoteSession | undefined;
  let startedAt = 0;
  let minutes = 0;
  let released = false;
  let sawCompleted = false;

  const client = (): DeviceFarmApi => {
    api ??= createDeviceFarmCli(env);
    return api;
  };

  const requireCreds = () => {
    const missing = awsCredentialGaps(env);
    if (missing.length) {
      throw Object.assign(new Error(`AWS Device Farm credentials are incomplete (${missing.join(", ")}). odr does not read credential values.`), { code: "missing_credentials" });
    }
    projectArn = env.AWS_DEVICE_FARM_PROJECT_ARN ?? "";
  };

  const locator = (extra: Locator = {}): Locator => ({
    driver: "aws-device-farm",
    project_arn: projectArn,
    region: env.AWS_DEVICE_FARM_REGION || "us-west-2",
    ...(uploadArn ? { upload_arn: uploadArn } : {}),
    ...(sessionArn ? { session_arn: sessionArn } : {}),
    ...(deviceArn ? { device_arn: deviceArn } : {}),
    ...extra,
  });

  const poll = async (read: () => Promise<string | undefined>, want: string, label: string): Promise<void> => {
    const deadline = now() + 180_000;
    let status: string | undefined;
    for (let i = 0; i < 40; i++) {
      status = await read();
      if (status === want) return;
      if (status === "FAILED" || status === "ERRORED") throw new Error(`${label} ${status}`);
      if (now() > deadline) break;
      await wait(1_000);
    }
    throw new Error(`${label} did not reach ${want} (last status ${status ?? "unknown"})`);
  };

  return {
    name: "aws-device-farm",

    async prepareBuild(build) {
      requireCreds();
      if (!build.path) throw new Error("Device Farm upload needs a local apk or ipa path");
      const created = await client().createUpload({
        projectArn,
        name: basename(build.path),
        type: uploadType(build.format),
        contentType: contentType(build.format),
      });
      uploadArn = created.upload?.arn;
      if (!uploadArn || !created.upload?.url) throw new Error("Device Farm CreateUpload did not return an upload ARN and URL");
      await send(created.upload.url, build.path, contentType(build.format));
      await poll(async () => (await client().getUpload(uploadArn!)).upload?.status, "SUCCEEDED", "upload");
      return uploadArn;
    },

    async allocate(ctx: AllocateContext): Promise<Allocated> {
      requireCreds();
      minutes = ctx.minutes;
      if (ctx.prepared_build) uploadArn = ctx.prepared_build;
      ctx.onLocator(locator());
      if (!deps.controls) {
        throw Object.assign(
          new Error("AWS Device Farm pixel control is not wired. odr will not start a metered remote session it cannot drive. Pass an interactor in tests; live taps stay on agent-device once that attach path is confirmed."),
          { code: "interaction_unavailable" },
        );
      }
      const want = platformFilter(ctx.profile.platform);
      const listed = await client().listDevices({
        arn: projectArn,
        filters: [
          { attribute: "PLATFORM", operator: "EQUALS", values: [want] },
          { attribute: "AVAILABILITY", operator: "EQUALS", values: ["AVAILABLE"] },
        ],
      });
      const model = ctx.profile.model !== "*" ? ctx.profile.model.toLowerCase() : ctx.request.model?.toLowerCase();
      const device = listed.devices.find((d) => !model || (d.name ?? d.model ?? "").toLowerCase().includes(model));
      if (!device?.arn) throw new Error(`no available ${want} device in the Device Farm project`);
      deviceArn = device.arn;
      ctx.onLocator(locator());
      const created = await client().createRemoteAccessSession({
        projectArn,
        deviceArn,
        ...(uploadArn ? { appArn: uploadArn } : {}),
        name: `odr-${ctx.reservation}`,
        interactionMode: "INTERACTIVE",
        configuration: { billingMethod: "METERED" },
      });
      sessionArn = created.remoteAccessSession?.arn;
      if (!sessionArn) throw new Error("Device Farm did not return a remote access session ARN");
      ctx.onLocator(locator());
      await poll(async () => (await client().getRemoteAccessSession(sessionArn!)).remoteAccessSession?.status, "RUNNING", "remote access session");
      const live = (await client().getRemoteAccessSession(sessionArn)).remoteAccessSession;
      controls = deps.controls(live);
      startedAt = now();
      const reported = live.device;
      return {
        device: {
          provider: ctx.provider.id,
          platform: ctx.profile.platform,
          kind: "real",
          ...(reported?.name || reported?.model ? { model: reported.name ?? reported.model } : { model: device.name ?? device.model }),
          ...(reported?.os || device.os ? { os_version: reported?.os ?? device.os } : {}),
          provider_device: deviceArn,
          device_id: sessionArn,
          confirmed_by: "provider_api",
        },
        phases: {},
      };
    },

    async install() {
      return undefined;
    },

    async launch(appId: string) {
      await controls?.launch(appId);
    },

    async screenshot() {
      if (!controls) throw new Error("remote session has no interactor");
      return controls.screenshot();
    },

    async tap(p, opts) {
      await controls?.tap(p, opts);
    },

    async type(text) {
      await controls?.type(text);
    },

    async swipe(from, to, opts) {
      await controls?.swipe(from, to, opts);
    },

    async key(k) {
      await controls?.key(k);
    },

    async heartbeat() {
      if (!startedAt || released) return;
      if (now() - startedAt >= minutes * 60_000) {
        await this.release();
        throw Object.assign(new Error("reserved free minutes are used up; the remote session was stopped"), { code: "free_minutes_cap" });
      }
    },

    async release() {
      if (released) return;
      released = true;
      await controls?.close().catch(() => undefined);
      if (sessionArn) {
        await client().stopRemoteAccessSession(sessionArn).catch(() => undefined);
        const deadline = now() + 60_000;
        for (let i = 0; i < 40; i++) {
          finalSession = (await client().getRemoteAccessSession(sessionArn).catch(() => ({ remoteAccessSession: undefined }))).remoteAccessSession;
          if (finalSession?.status === "COMPLETED") {
            sawCompleted = true;
            break;
          }
          if (now() > deadline) break;
          await wait(1_000);
        }
      }
      if (uploadArn) await client().deleteUpload(uploadArn).catch(() => undefined);
    },

    async verifyClosed(): Promise<ClosureResult> {
      if (!sessionArn) return { status: "verified", method: "provider_api", detail: "no remote session was created" };
      if (sawCompleted || finalSession?.status === "COMPLETED") {
        return { status: "verified", method: "provider_api", detail: "GetRemoteAccessSession status COMPLETED" };
      }
      return { status: "unverified", method: "provider_api", detail: `session status ${finalSession?.status ?? "unknown"}` };
    },

    async providerMinutes() {
      const metered = finalSession?.deviceMinutes?.metered;
      if (metered !== undefined && Number.isFinite(metered)) return metered;
      if (!startedAt) return undefined;
      return Math.ceil(Math.max(0, now() - startedAt) / 60_000);
    },

    handle() {
      return { session_arn: sessionArn, device_arn: deviceArn, upload_arn: uploadArn, project_arn: projectArn };
    },
  };
}

export async function sweepDeviceFarm(locator: Locator, env: NodeJS.ProcessEnv, api?: DeviceFarmApi): Promise<ClosureResult> {
  const client = api ?? createDeviceFarmCli(env);
  const sessionArn = locator.session_arn ? String(locator.session_arn) : "";
  const uploadArn = locator.upload_arn ? String(locator.upload_arn) : "";
  if (!sessionArn && !uploadArn) return { status: "verified", method: "provider_api", detail: "nothing was created" };
  if (sessionArn) await client.stopRemoteAccessSession(sessionArn).catch(() => undefined);
  if (uploadArn) await client.deleteUpload(uploadArn).catch(() => undefined);
  if (!sessionArn) return { status: "verified", method: "provider_api", detail: "upload deleted; no session" };
  const status = (await client.getRemoteAccessSession(sessionArn).catch(() => ({ remoteAccessSession: undefined }))).remoteAccessSession?.status;
  return status === "COMPLETED"
    ? { status: "verified", method: "provider_api", detail: "remote session completed" }
    : { status: "unverified", method: "provider_api", detail: `session status ${status ?? "unknown"}` };
}

export const awsDeviceFarmDriver: DriverModule = {
  create: () => createAwsDeviceFarmDriver(),
  sweep: (locator, env) => sweepDeviceFarm(locator, env),
};
