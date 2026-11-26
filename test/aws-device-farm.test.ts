import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyState, loadState, saveState } from "../src/core/ledger.js";
import { loadRegistry } from "../src/registry/load.js";
import { allocate, sweep, RouteRefusedError, SessionError } from "../src/session/session.js";
import { createDeviceFarmCli, meteredDeviceMinutes, type DeviceFarmApi, type RemoteSession } from "../src/session/drivers/aws-device-farm-api.js";
import { createAwsDeviceFarmDriver, sweepDeviceFarm, type DeviceControls } from "../src/session/drivers/aws-device-farm.js";
import { reconcile } from "../src/session/reconcile.js";
import type { DriverModule } from "../src/session/types.js";
import { makePng } from "./fixtures/fake-driver.js";

const { providers } = loadRegistry();
const aws = providers.find((p) => p.id === "aws-device-farm")!;
const SECRET = "SECRET_VALUE_DO_NOT_LEAK";
const CREDS: NodeJS.ProcessEnv = {
  AWS_ACCESS_KEY_ID: "AKIA_TEST",
  AWS_SECRET_ACCESS_KEY: SECRET,
  AWS_DEVICE_FARM_PROJECT_ARN: "arn:aws:devicefarm:us-west-2:000000000000:project:11111111-1111-1111-1111-111111111111",
};

function homeWithReconcile(): string {
  const h = mkdtempSync(join(tmpdir(), "odr-aws-"));
  const s = emptyState();
  s.connections["aws-device-farm"] = { connected_at: new Date(Date.now() - 86_400_000).toISOString() };
  s.reconciliations.push({
    provider: "aws-device-farm",
    at: new Date().toISOString(),
    period: "one_time",
    provider_minutes: 0,
    local_minutes: 0,
  });
  saveState(s, h);
  return h;
}

function controls(): DeviceControls {
  return {
    async screenshot() {
      const png = makePng(40, 80);
      return { png, width: 40, height: 80, input: { width: 20, height: 40 } };
    },
    async tap() {},
    async type() {},
    async swipe() {},
    async key() {},
    async launch() {},
    async close() {},
  };
}

interface Fake {
  api: DeviceFarmApi;
  calls: string[];
  status: string;
  metered?: number;
  devices: { arn: string; name: string; platform: string; os: string; availability: string }[];
}

function fakeApi(): Fake {
  const calls: string[] = [];
  const fake: Fake = {
    calls,
    status: "RUNNING",
    metered: 1,
    devices: [{ arn: "device-1", name: "Pixel", platform: "ANDROID", os: "14", availability: "AVAILABLE" }],
    api: {
      async listProjects() {
        calls.push("listProjects");
        return { projects: [{ arn: CREDS.AWS_DEVICE_FARM_PROJECT_ARN! }] };
      },
      async listDevices(input) {
        calls.push(`listDevices:${input.filters?.map((f) => f.values.join(",")).join("|")}`);
        return { devices: fake.devices };
      },
      async createUpload() {
        calls.push("createUpload");
        return { upload: { arn: "upload-1", url: `https://uploads.example/presigned?X-Amz-Signature=${SECRET}`, status: "INITIALIZED" } };
      },
      async getUpload() {
        calls.push("getUpload");
        return { upload: { arn: "upload-1", status: "SUCCEEDED" } };
      },
      async deleteUpload(arn) {
        calls.push(`deleteUpload:${arn}`);
      },
      async createRemoteAccessSession(input) {
        calls.push(`createSession:${input.configuration.billingMethod}:${input.deviceArn}:${input.appArn ?? ""}`);
        return { remoteAccessSession: { arn: "session-1", status: "PENDING", device: { name: "Pixel", os: "14" } } };
      },
      async getRemoteAccessSession() {
        calls.push("getSession");
        const row: RemoteSession = { arn: "session-1", status: fake.status, deviceMinutes: fake.metered === undefined ? undefined : { metered: fake.metered } };
        return { remoteAccessSession: row };
      },
      async stopRemoteAccessSession() {
        calls.push("stopSession");
        fake.status = "COMPLETED";
        return { remoteAccessSession: { arn: "session-1", status: fake.status, deviceMinutes: { metered: fake.metered } } };
      },
      async listRemoteAccessSessions() {
        return { remoteAccessSessions: [] };
      },
      async listRuns() {
        return { runs: [] };
      },
    },
  };
  return fake;
}

function moduleFor(fake: Fake, extra: { controls?: boolean; now?: () => number } = {}): DriverModule {
  return {
    create: () =>
      createAwsDeviceFarmDriver({
        api: fake.api,
        env: CREDS,
        sleep: async () => {},
        ...(extra.now ? { now: extra.now } : {}),
        putFile: async (url) => {
          fake.calls.push(`put:${url.includes(SECRET) ? "secret-url" : "url"}`);
        },
        ...(extra.controls === false ? {} : { controls: () => controls() }),
      }),
    sweep: (locator, env) => sweepDeviceFarm(locator, env, fake.api),
  };
}

test("AWS free-only allocate is refused before any Device Farm call when minutes are unconfirmed", async () => {
  const h = mkdtempSync(join(tmpdir(), "odr-aws-"));
  const s = emptyState();
  s.connections["aws-device-farm"] = { connected_at: new Date().toISOString() };
  saveState(s, h);
  const fake = fakeApi();
  await assert.rejects(
    allocate({ surface: "android-real", minutes: 5 }, { home: h, providers, drivers: { "aws-device-farm": moduleFor(fake) }, handleSignals: false }),
    (e: RouteRefusedError) => e.code === "route_refused",
  );
  assert.deepEqual(fake.calls, []);
  assert.equal(loadState(h).reservations.length, 0);
});

test("a mocked Device Farm session uploads, starts metered, stops, deletes, and writes a receipt", async () => {
  const h = homeWithReconcile();
  const fake = fakeApi();
  const s = await allocate(
    { surface: "android-real", minutes: 5, build_format: "apk" },
    {
      home: h,
      providers,
      drivers: { "aws-device-farm": moduleFor(fake) },
      handleSignals: false,
      launch: false,
      build: { format: "apk", path: "/tmp/app.apk", app_id: "com.example.app" },
    },
  );
  assert.equal(s.device.model, "Pixel");
  assert.equal(s.device.confirmed_by, "provider_api");
  assert.ok(fake.calls.indexOf("createUpload") < fake.calls.indexOf("createSession:METERED:device-1:upload-1"));
  const locator = loadState(h).reservations[0]!.locator!;
  assert.equal(locator.session_arn, "session-1");
  assert.equal(locator.upload_arn, "upload-1");
  assert.equal(JSON.stringify(locator).includes(SECRET), false);
  const receipt = await s.release();
  assert.equal(receipt.outcome, "ok");
  assert.equal(receipt.closure.status, "verified");
  assert.equal(receipt.usage?.provider_minutes, 1);
  assert.equal(receipt.schema, "odr.receipt/v1");
  const text = JSON.stringify(receipt) + readFileSync(s.receiptFile, "utf8");
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes("presigned"), false);
  assert.ok(fake.calls.includes("stopSession"));
  assert.ok(fake.calls.includes("deleteUpload:upload-1"));
  assert.equal(loadState(h).reservations[0]!.status, "closed");
});

test("a failed allocation still stops the session and deletes the upload", async () => {
  const h = homeWithReconcile();
  const fake = fakeApi();
  fake.devices = [];
  await assert.rejects(
    allocate(
      { surface: "android-real", minutes: 5, build_format: "apk" },
      { home: h, providers, drivers: { "aws-device-farm": moduleFor(fake) }, handleSignals: false, build: { format: "apk", path: "/tmp/app.apk" } },
    ),
    (e: SessionError) => e.receipt?.outcome === "failed",
  );
  assert.equal(fake.calls.includes("createSession:METERED:device-1:upload-1"), false);
  assert.ok(fake.calls.includes("deleteUpload:upload-1"));
  assert.notEqual(loadState(h).reservations[0]!.status, "active");
});

test("cancel releases the remote session", async () => {
  const h = homeWithReconcile();
  const fake = fakeApi();
  const s = await allocate({ surface: "ios-real", minutes: 5 }, { home: h, providers, drivers: { "aws-device-farm": moduleFor(fake) }, handleSignals: false });
  const receipt = await s.release("cancelled");
  assert.equal(receipt.outcome, "cancelled");
  assert.ok(fake.calls.includes("stopSession"));
  assert.ok(fake.calls.some((c) => c.startsWith("listDevices:IOS")));
});

test("unverified closure keeps the reservation when Device Farm never reports COMPLETED", async () => {
  const h = homeWithReconcile();
  const fake = fakeApi();
  fake.api.stopRemoteAccessSession = async () => {
    fake.calls.push("stopSession");
    return { remoteAccessSession: { arn: "session-1", status: "RUNNING" } };
  };
  const s = await allocate({ surface: "android-real", minutes: 5 }, { home: h, providers, drivers: { "aws-device-farm": moduleFor(fake) }, handleSignals: false });
  const receipt = await s.release();
  assert.equal(receipt.closure.status, "unverified");
  assert.equal(loadState(h).reservations[0]!.status, "closure_unverified");
});

test("without an interactor the driver does not create a metered session", async () => {
  const fake = fakeApi();
  const driver = createAwsDeviceFarmDriver({ api: fake.api, env: CREDS, sleep: async () => {}, controls: undefined });
  await assert.rejects(
    driver.allocate({
      reservation: "r_test",
      request: { surface: "android-real", minutes: 5 },
      provider: aws,
      control: aws.control!,
      profile: aws.profiles![1]!,
      minutes: 5,
      tenant: "t",
      run_id: "run",
      env: CREDS,
      log: () => {},
      onLocator: () => {},
    }),
    (e: Error & { code?: string }) => e.code === "interaction_unavailable",
  );
  assert.equal(fake.calls.includes("createSession:METERED:device-1:"), false);
});

test("heartbeat stops the session when the reserved minutes are used up", async () => {
  let t = 1_000_000;
  const fake = fakeApi();
  const driver = createAwsDeviceFarmDriver({
    api: fake.api,
    env: CREDS,
    sleep: async () => {},
    now: () => t,
    controls: () => controls(),
  });
  await driver.allocate({
    reservation: "r_cap",
    request: { surface: "android-real", minutes: 10 },
    provider: aws,
    control: aws.control!,
    profile: aws.profiles![1]!,
    minutes: 10,
    tenant: "t",
    run_id: "run",
    env: CREDS,
    log: () => {},
    onLocator: () => {},
  });
  t += 10 * 60_000;
  await assert.rejects(driver.heartbeat(), (e: Error & { code?: string }) => e.code === "free_minutes_cap");
  assert.ok(fake.calls.includes("stopSession"));
});

test("metered minutes sum sessions and runs, and refuse when a session is still open or unmetered-unknown", async () => {
  const api = fakeApi().api;
  api.listProjects = async () => ({ projects: [{ arn: "p1" }] });
  api.listRemoteAccessSessions = async () => ({
    remoteAccessSessions: [
      { arn: "s1", status: "COMPLETED", billingMethod: "METERED", deviceMinutes: { metered: 4 } },
      { arn: "s2", status: "COMPLETED", billingMethod: "UNMETERED", deviceMinutes: { metered: 0, unmetered: 80 } },
    ],
  });
  api.listRuns = async () => ({ runs: [{ arn: "run-1", status: "COMPLETED", deviceMinutes: { metered: 6 } }] });
  assert.equal(await meteredDeviceMinutes(api), 10);

  api.listRemoteAccessSessions = async () => ({ remoteAccessSessions: [{ arn: "s3", status: "RUNNING", deviceMinutes: { metered: 1 } }] });
  await assert.rejects(meteredDeviceMinutes(api), (e: Error & { code?: string }) => e.code === "usage_unconfirmed");

  api.listRemoteAccessSessions = async () => ({ remoteAccessSessions: [{ arn: "s4", status: "COMPLETED" }] });
  await assert.rejects(meteredDeviceMinutes(api), (e: Error) => /no metered deviceMinutes/.test(e.message));
});

test("reconcile records the Device Farm total and a later route sees the reduced trial", async () => {
  const h = mkdtempSync(join(tmpdir(), "odr-aws-"));
  const s = emptyState();
  s.connections["aws-device-farm"] = { connected_at: "2026-11-01T00:00:00.000Z" };
  saveState(s, h);
  const api = fakeApi().api;
  api.listProjects = async () => ({ projects: [{ arn: "p1" }] });
  api.listRemoteAccessSessions = async () => ({
    remoteAccessSessions: [{ arn: "s1", status: "COMPLETED", billingMethod: "METERED", deviceMinutes: { metered: 40 } }],
  });
  api.listRuns = async () => ({ runs: [] });
  const rec = await reconcile(aws, { home: h, deviceFarm: api, now: new Date("2026-11-26T12:00:00Z") });
  assert.equal(rec.provider_minutes, 40);
  assert.equal(rec.period, "one_time");
  assert.equal(rec.added_minutes, 40);
  const state = loadState(h);
  assert.equal(state.usage[0]!.source, "provider");
  assert.equal(state.usage[0]!.amount, 40);
});

test("the AWS CLI client puts no credential in the argument list", async () => {
  let seen: string[] = [];
  const cli = createDeviceFarmCli(CREDS, async (args) => {
    seen = args;
    return { projects: [], nextToken: undefined };
  });
  await cli.listProjects();
  assert.deepEqual(seen.slice(0, 6), ["devicefarm", "list-projects", "--region", "us-west-2", "--output", "json"]);
  assert.equal(seen.join(" ").includes(SECRET), false);
  assert.equal(seen.join(" ").includes("AKIA_TEST"), false);
});

test("sweep stops a session left in the locator", async () => {
  const h = homeWithReconcile();
  const fake = fakeApi();
  const state = loadState(h);
  state.reservations.push({
    id: "r_00000000000000cc",
    provider: "aws-device-farm",
    allowance: 0,
    surface: "android-real",
    minutes: 5,
    amount: 5,
    usd: 0,
    created_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
    owner: { pid: 999999, host: "elsewhere" },
    status: "active",
    locator: { driver: "aws-device-farm", session_arn: "session-1", upload_arn: "upload-1", project_arn: "p" },
  });
  saveState(state, h);
  const res = await sweep({ home: h, providers, drivers: { "aws-device-farm": moduleFor(fake) } });
  assert.equal(res[0]!.action, "closed");
  assert.ok(fake.calls.includes("stopSession"));
  assert.ok(fake.calls.includes("deleteUpload:upload-1"));
});
