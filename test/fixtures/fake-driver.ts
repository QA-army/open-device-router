import { deflateSync } from "node:zlib";
import type { Driver, DriverModule, Locator } from "../../src/session/types.js";

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGB PNG. flat=true gives a single color (a boot screen); otherwise a gradient. */
export function makePng(w: number, h: number, flat = false): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = flat ? 0 : (x * 255) / w;
      raw[i + 1] = flat ? 0 : (y * 255) / h;
      raw[i + 2] = flat ? 0 : 128;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface FakeLog {
  calls: string[];
  released: number;
}

export function fakeDriver(log: FakeLog, opts: { blankFrames?: number; failAllocate?: boolean; failScreenshotsAfter?: number; unverified?: boolean } = {}): DriverModule {
  let shots = 0;
  const create = (): Driver => ({
    name: "agent-device",
    async allocate(ctx) {
      log.calls.push("allocate");
      ctx.onLocator({ driver: "fake", reservation: ctx.reservation });
      if (opts.failAllocate) throw new Error("provider said no");
      return { device: { provider: ctx.provider.id, platform: ctx.profile.platform, kind: ctx.profile.kind, model: "Fake Phone", os_version: "18.2", confirmed_by: "driver" }, phases: {} };
    },
    async install() {
      log.calls.push("install");
      return "com.example.fixture";
    },
    async launch(id) {
      log.calls.push(`launch:${id}`);
    },
    async screenshot() {
      shots++;
      if (opts.failScreenshotsAfter !== undefined && shots > opts.failScreenshotsAfter) throw new Error("capture failed");
      const png = makePng(40, 80, shots <= (opts.blankFrames ?? 0));
      return { png, width: 40, height: 80, input: { width: 20, height: 40 } };
    },
    async tap(p) {
      log.calls.push(`tap:${p.x},${p.y}`);
    },
    async type(t) {
      log.calls.push(`type:${t}`);
    },
    async swipe(a, b) {
      log.calls.push(`swipe:${a.x},${a.y}->${b.x},${b.y}`);
    },
    async key(k) {
      log.calls.push(`key:${k}`);
    },
    async heartbeat() {
      log.calls.push("heartbeat");
    },
    async release() {
      log.released++;
      log.calls.push("release");
    },
    async verifyClosed() {
      return opts.unverified ? { status: "unverified", method: "driver", detail: "fake" } : { status: "verified", method: "driver" };
    },
    handle: () => ({ secret_session_token: "do-not-leak" }),
  });
  return {
    create,
    async sweep(locator: Locator) {
      log.calls.push(`sweep:${locator.reservation}`);
      return { status: "verified", method: "driver" };
    },
  };
}
