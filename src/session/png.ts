import { inflateSync } from "node:zlib";

// Minimal PNG reader for the "usable frame" check. Supports 8-bit grayscale, RGB, RGBA, gray+alpha
// and palette images without interlacing, which covers simctl, adb screencap and Appetize output.

export interface Frame {
  width: number;
  height: number;
  /** Returns [r,g,b] for a pixel. */
  rgb(x: number, y: number): [number, number, number];
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function decodePng(buf: Buffer): Frame {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  let palette: Buffer | undefined;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      color = data[9]!;
      interlace = data[12]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, interlace ${interlace})`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  if (!channels) throw new Error(`unsupported PNG color type ${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let v = line[i]!;
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return {
    width,
    height,
    rgb(x, y) {
      const i = (y * width + x) * channels;
      if (color === 3) {
        const p = out[i]! * 3;
        return [palette![p]!, palette![p + 1]!, palette![p + 2]!];
      }
      if (channels <= 2) return [out[i]!, out[i]!, out[i]!];
      return [out[i]!, out[i + 1]!, out[i + 2]!];
    },
  };
}

/**
 * Why a frame is not usable, or undefined when it is. Usable = decodes as a PNG of at least 16x16
 * and is not one flat colour (a black or white boot screen). Samples a 32x32 grid.
 */
export function frameProblem(buf: Buffer): string | undefined {
  let f: Frame;
  try {
    f = decodePng(buf);
  } catch (e) {
    return `undecodable (${(e as Error).message})`;
  }
  if (f.width < 16 || f.height < 16) return `too small (${f.width}x${f.height})`;
  const first = f.rgb(0, 0).map((v) => v >> 3).join(",");
  for (let gy = 0; gy < 32; gy++) {
    for (let gx = 0; gx < 32; gx++) {
      const c = f.rgb(Math.floor((gx * f.width) / 32), Math.floor((gy * f.height) / 32)).map((v) => v >> 3).join(",");
      if (c !== first) return undefined;
    }
  }
  return `flat colour ${f.rgb(0, 0).join(",")} at ${f.width}x${f.height}`;
}

export function isUsableFrame(buf: Buffer): boolean {
  return frameProblem(buf) === undefined;
}

/** Share of sampled pixels that differ between two frames of the same size. */
export function frameDifference(a: Buffer, b: Buffer): number {
  const fa = decodePng(a), fb = decodePng(b);
  if (fa.width !== fb.width || fa.height !== fb.height) return 1;
  let diff = 0, n = 0;
  for (let y = 0; y < fa.height; y += Math.max(1, Math.floor(fa.height / 64))) {
    for (let x = 0; x < fa.width; x += Math.max(1, Math.floor(fa.width / 32))) {
      const p = fa.rgb(x, y), q = fb.rgb(x, y);
      n++;
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 30) diff++;
    }
  }
  return n ? diff / n : 0;
}
