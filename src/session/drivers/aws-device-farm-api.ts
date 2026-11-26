import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Thin Device Farm control-plane client. The live transport is the AWS CLI, which uses the
// standard credential chain (env, profile, web identity, container role). This module never reads
// or logs credential values. Tests pass a fake client with the same methods.

const run = promisify(execFile);

/** Device Farm's public mobile fleet is called in us-west-2 unless AWS_DEVICE_FARM_REGION overrides it. */
export function deviceFarmRegion(env: NodeJS.ProcessEnv): string {
  return env.AWS_DEVICE_FARM_REGION || "us-west-2";
}

export interface DeviceMinutes {
  metered?: number;
  total?: number;
  unmetered?: number;
}

export interface RemoteSession {
  arn?: string;
  name?: string;
  status?: string;
  result?: string;
  started?: string;
  stopped?: string;
  billingMethod?: string;
  deviceMinutes?: DeviceMinutes;
  device?: { arn?: string; name?: string; platform?: string; os?: string; model?: string };
  appUpload?: string;
}

export interface DeviceRow {
  arn: string;
  name?: string;
  platform?: string;
  os?: string;
  model?: string;
  availability?: string;
}

export interface UploadRow {
  arn: string;
  url?: string;
  status?: string;
  metadata?: string;
}

export interface RunRow {
  arn?: string;
  status?: string;
  deviceMinutes?: DeviceMinutes;
  billingMethod?: string;
}

export interface ProjectRow {
  arn: string;
  name?: string;
}

/**
 * The operations odr uses. Shaped like the Device Farm API (CreateRemoteAccessSession,
 * GetRemoteAccessSession, StopRemoteAccessSession, CreateUpload, GetUpload, DeleteUpload,
 * ListDevices, ListProjects, ListRemoteAccessSessions, ListRuns) so tests can mock the SDK surface.
 */
export interface DeviceFarmApi {
  listProjects(nextToken?: string): Promise<{ projects: ProjectRow[]; nextToken?: string }>;
  listDevices(input: { arn: string; filters?: { attribute: string; operator: string; values: string[] }[] }, nextToken?: string): Promise<{ devices: DeviceRow[]; nextToken?: string }>;
  createUpload(input: { projectArn: string; name: string; type: "ANDROID_APP" | "IOS_APP"; contentType: string }): Promise<{ upload: UploadRow }>;
  getUpload(arn: string): Promise<{ upload: UploadRow }>;
  deleteUpload(arn: string): Promise<void>;
  createRemoteAccessSession(input: {
    projectArn: string;
    deviceArn: string;
    appArn?: string;
    name: string;
    interactionMode: "INTERACTIVE";
    configuration: { billingMethod: "METERED" };
  }): Promise<{ remoteAccessSession: RemoteSession }>;
  getRemoteAccessSession(arn: string): Promise<{ remoteAccessSession: RemoteSession }>;
  stopRemoteAccessSession(arn: string): Promise<{ remoteAccessSession: RemoteSession }>;
  listRemoteAccessSessions(projectArn: string, nextToken?: string): Promise<{ remoteAccessSessions: RemoteSession[]; nextToken?: string }>;
  listRuns(projectArn: string, nextToken?: string): Promise<{ runs: RunRow[]; nextToken?: string }>;
}

export type AwsExec = (args: string[], env: NodeJS.ProcessEnv) => Promise<unknown>;

const PAGE_CAP = 20;

export function awsCredentialGaps(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!env.AWS_DEVICE_FARM_PROJECT_ARN) missing.push("AWS_DEVICE_FARM_PROJECT_ARN");
  const access = Boolean(env.AWS_ACCESS_KEY_ID);
  const secret = Boolean(env.AWS_SECRET_ACCESS_KEY);
  const other = Boolean(env.AWS_PROFILE) || Boolean(env.AWS_WEB_IDENTITY_TOKEN_FILE) || Boolean(env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI);
  if (access && secret) return missing;
  if (other && access === secret) return missing;
  if (access !== secret && !other) {
    if (!access) missing.push("AWS_ACCESS_KEY_ID");
    if (!secret) missing.push("AWS_SECRET_ACCESS_KEY");
    return missing;
  }
  if (!other) missing.push("AWS_PROFILE or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY or AWS_WEB_IDENTITY_TOKEN_FILE");
  return missing;
}

async function defaultExec(args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  try {
    const { stdout } = await run("aws", args, { env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    const op = args[1] ?? "devicefarm";
    const error = new Error(`aws ${op} failed. Check the AWS CLI, the region, and that a credential is available. odr did not read the credential.`) as Error & { code: string };
    error.code = "provider_api";
    throw error;
  }
}

export function createDeviceFarmCli(env: NodeJS.ProcessEnv, exec: AwsExec = defaultExec): DeviceFarmApi {
  const region = deviceFarmRegion(env);
  const call = async (operation: string, extra: string[] = [], input?: unknown): Promise<Record<string, unknown>> => {
    const args = ["devicefarm", operation, "--region", region, "--output", "json"];
    if (input !== undefined) args.push("--cli-input-json", JSON.stringify(input));
    args.push(...extra);
    const body = (await exec(args, env)) as Record<string, unknown>;
    return body ?? {};
  };
  return {
    async listProjects(nextToken) {
      const body = await call("list-projects", nextToken ? ["--next-token", nextToken] : []);
      return { projects: (body.projects as ProjectRow[]) ?? [], nextToken: body.nextToken as string | undefined };
    },
    async listDevices(input, nextToken) {
      const body = await call("list-devices", nextToken ? ["--next-token", nextToken] : [], input);
      return { devices: (body.devices as DeviceRow[]) ?? [], nextToken: body.nextToken as string | undefined };
    },
    async createUpload(input) {
      const body = await call("create-upload", [], input);
      return { upload: body.upload as UploadRow };
    },
    async getUpload(arn) {
      const body = await call("get-upload", [], { arn });
      return { upload: body.upload as UploadRow };
    },
    async deleteUpload(arn) {
      await call("delete-upload", [], { arn });
    },
    async createRemoteAccessSession(input) {
      const body = await call("create-remote-access-session", [], input);
      return { remoteAccessSession: body.remoteAccessSession as RemoteSession };
    },
    async getRemoteAccessSession(arn) {
      const body = await call("get-remote-access-session", [], { arn });
      return { remoteAccessSession: body.remoteAccessSession as RemoteSession };
    },
    async stopRemoteAccessSession(arn) {
      const body = await call("stop-remote-access-session", [], { arn });
      return { remoteAccessSession: body.remoteAccessSession as RemoteSession };
    },
    async listRemoteAccessSessions(projectArn, nextToken) {
      const body = await call("list-remote-access-sessions", nextToken ? ["--next-token", nextToken] : [], { arn: projectArn });
      return { remoteAccessSessions: (body.remoteAccessSessions as RemoteSession[]) ?? [], nextToken: body.nextToken as string | undefined };
    },
    async listRuns(projectArn, nextToken) {
      const body = await call("list-runs", nextToken ? ["--next-token", nextToken] : [], { arn: projectArn });
      return { runs: (body.runs as RunRow[]) ?? [], nextToken: body.nextToken as string | undefined };
    },
  };
}

export function unconfirmed(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "usage_unconfirmed" });
}

function meteredOf(row: { arn?: string; status?: string; billingMethod?: string; deviceMinutes?: DeviceMinutes }, kind: string): number {
  if (row.status !== "COMPLETED") {
    throw unconfirmed(`cannot confirm free minutes: ${kind} ${row.arn ?? "unknown"} is ${row.status ?? "in an unknown state"}`);
  }
  const metered = row.deviceMinutes?.metered;
  if (metered !== undefined && Number.isFinite(metered)) return metered;
  if (row.billingMethod === "UNMETERED" && row.deviceMinutes?.unmetered !== undefined) return 0;
  throw unconfirmed(`cannot confirm free minutes: ${kind} ${row.arn ?? "unknown"} has no metered deviceMinutes`);
}

async function eachPage<T>(load: (token?: string) => Promise<{ items: T[]; nextToken?: string }>): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < PAGE_CAP; page++) {
    const batch = await load(token);
    items.push(...batch.items);
    if (!batch.nextToken) return items;
    token = batch.nextToken;
  }
  throw unconfirmed("cannot confirm free minutes: Device Farm was still returning pages");
}

/**
 * Sum of metered device minutes on the account: every project's remote-access sessions and
 * automated runs. An open session, a missing meter, or a truncated page list throws, so the
 * router keeps refusing rather than assuming the trial is intact.
 * Runs already include their jobs' minutes, so jobs are not added again.
 */
export async function meteredDeviceMinutes(api: DeviceFarmApi): Promise<number> {
  const projects = await eachPage(async (token) => {
    const page = await api.listProjects(token);
    return { items: page.projects, nextToken: page.nextToken };
  });
  let total = 0;
  for (const project of projects) {
    const sessions = await eachPage(async (token) => {
      const page = await api.listRemoteAccessSessions(project.arn, token);
      return { items: page.remoteAccessSessions, nextToken: page.nextToken };
    });
    for (const session of sessions) total += meteredOf(session, "remote access session");
    const runs = await eachPage(async (token) => {
      const page = await api.listRuns(project.arn, token);
      return { items: page.runs, nextToken: page.nextToken };
    });
    for (const run of runs) total += meteredOf(run, "test run");
  }
  return Math.round(total * 100) / 100;
}
