import { readFileSync } from "node:fs";
import type { DeviceProfile, Key, Size } from "../core/types.js";
import type { DeviceIdentity, Point, Screenshot } from "../session/types.js";

// Client for a session started by `odr run -- <cmd>`. Reads ODR_SESSION_FILE.

export interface SessionFile {
  schema: "odr.session/v1";
  id: string;
  provider: string;
  url: string;
  token: string;
  device: DeviceIdentity;
  profile: DeviceProfile;
  receipt: string;
}

export interface SessionLike {
  readonly id: string;
  readonly provider: string;
  readonly device?: DeviceIdentity;
  readonly profile: DeviceProfile;
  screenshot(): Promise<Screenshot>;
  size(): Promise<Size>;
  tap(x: number, y: number, opts?: { durationMs?: number }): Promise<void>;
  type(text: string): Promise<void>;
  swipe(from: Point, to: Point, opts?: { durationMs?: number }): Promise<void>;
  key(k: Key): Promise<void>;
  release?(): Promise<unknown>;
}

export async function attach(file: string | undefined = process.env.ODR_SESSION_FILE): Promise<SessionLike> {
  if (!file) throw new Error("ODR_SESSION_FILE is not set; run this under `odr run -- <cmd>`");
  const s = JSON.parse(readFileSync(file, "utf8")) as SessionFile;
  if (s.schema !== "odr.session/v1") throw new Error(`unsupported session file ${s.schema}`);
  const headers = { authorization: `Bearer ${s.token}` };
  const call = async (path: string, payload?: unknown): Promise<Response> => {
    const res = await fetch(`${s.url}${path}`, payload === undefined ? { headers } : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      throw Object.assign(new Error(e.message ?? `odr ${path} returned ${res.status}`), { code: e.code ?? "error" });
    }
    return res;
  };
  let size: Size | undefined;
  return {
    id: s.id,
    provider: s.provider,
    device: s.device,
    profile: s.profile,
    async screenshot() {
      const res = await call("/screenshot");
      const png = Buffer.from(await res.arrayBuffer());
      size = { width: Number(res.headers.get("x-input-width")), height: Number(res.headers.get("x-input-height")) };
      return { png, width: png.readUInt32BE(16), height: png.readUInt32BE(20), input: size };
    },
    async size() {
      return size ?? (size = (await (await call("/size")).json()) as Size);
    },
    tap: async (x, y, opts) => void (await call("/tap", { x, y, ...(opts?.durationMs ? { durationMs: opts.durationMs } : {}) })),
    type: async (text) => void (await call("/type", { text })),
    swipe: async (from, to, opts) => void (await call("/swipe", { from, to, ...(opts?.durationMs ? { durationMs: opts.durationMs } : {}) })),
    key: async (key) => void (await call("/key", { key })),
  };
}
