import { deflateSync } from "node:zlib";
import { fmt, type SimbenchResult } from "./simbench.js";

// 1200x630 share card for a SimBench result, drawn with a 5x7 pixel font and encoded as PNG with
// node:zlib only. Colours follow opendevicerouter.com (sites/opendevicerouter-com/styles.css).

type RGB = [number, number, number];
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const PALETTE = {
  bg: hex("#000000"),
  panel: hex("#0c0c0f"),
  line: hex("#25252b"),
  lineStrong: hex("#3b3b44"),
  text: hex("#f2efe9"),
  muted: hex("#8d8d96"),
  peri: hex("#8a8dff"),
  green: hex("#a8ffc4"),
  coral: hex("#ff5a3c"),
};

const W = 1200, H = 630;

// prettier-ignore
const GLYPHS: Record<string, string[]> = {
  "0": ["01110","10001","10011","10101","11001","10001","01110"], "1": ["00100","01100","00100","00100","00100","00100","01110"],
  "2": ["01110","10001","00001","00010","00100","01000","11111"], "3": ["11110","00001","00001","01110","00001","00001","11110"],
  "4": ["00010","00110","01010","10010","11111","00010","00010"], "5": ["11111","10000","11110","00001","00001","10001","01110"],
  "6": ["00110","01000","10000","11110","10001","10001","01110"], "7": ["11111","00001","00010","00100","01000","01000","01000"],
  "8": ["01110","10001","10001","01110","10001","10001","01110"], "9": ["01110","10001","10001","01111","00001","00010","01100"],
  A: ["01110","10001","10001","11111","10001","10001","10001"], B: ["11110","10001","10001","11110","10001","10001","11110"],
  C: ["01110","10001","10000","10000","10000","10001","01110"], D: ["11100","10010","10001","10001","10001","10010","11100"],
  E: ["11111","10000","10000","11110","10000","10000","11111"], F: ["11111","10000","10000","11110","10000","10000","10000"],
  G: ["01110","10001","10000","10111","10001","10001","01111"], H: ["10001","10001","10001","11111","10001","10001","10001"],
  I: ["01110","00100","00100","00100","00100","00100","01110"], J: ["00111","00010","00010","00010","00010","10010","01100"],
  K: ["10001","10010","10100","11000","10100","10010","10001"], L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"], N: ["10001","10001","11001","10101","10011","10001","10001"],
  O: ["01110","10001","10001","10001","10001","10001","01110"], P: ["11110","10001","10001","11110","10000","10000","10000"],
  Q: ["01110","10001","10001","10001","10101","10010","01101"], R: ["11110","10001","10001","11110","10100","10010","10001"],
  S: ["01111","10000","10000","01110","00001","00001","11110"], T: ["11111","00100","00100","00100","00100","00100","00100"],
  U: ["10001","10001","10001","10001","10001","10001","01110"], V: ["10001","10001","10001","10001","10001","01010","00100"],
  W: ["10001","10001","10001","10101","10101","10101","01010"], X: ["10001","10001","01010","00100","01010","10001","10001"],
  Y: ["10001","10001","01010","00100","00100","00100","00100"], Z: ["11111","00001","00010","00100","01000","10000","11111"],
  ".": ["00000","00000","00000","00000","00000","01100","01100"], ",": ["00000","00000","00000","00000","01100","00100","01000"],
  ":": ["00000","01100","01100","00000","01100","01100","00000"], "-": ["00000","00000","00000","11111","00000","00000","00000"],
  "/": ["00001","00010","00010","00100","01000","01000","10000"], "%": ["11001","11010","00010","00100","01000","01011","10011"],
  "(": ["00010","00100","01000","01000","01000","00100","00010"], ")": ["01000","00100","00010","00010","00010","00100","01000"],
  "+": ["00000","00100","00100","11111","00100","00100","00000"], "=": ["00000","00000","11111","00000","11111","00000","00000"],
  "<": ["00010","00100","01000","10000","01000","00100","00010"], ">": ["01000","00100","00010","00001","00010","00100","01000"],
  "@": ["01110","10001","10111","10101","10111","10000","01110"], "_": ["00000","00000","00000","00000","00000","00000","11111"],
  " ": ["00000","00000","00000","00000","00000","00000","00000"],
};

class Canvas {
  readonly px = Buffer.alloc(W * H * 3);
  fill(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx += 1) {
        const i = (yy * W + xx) * 3;
        this.px[i] = c[0];
        this.px[i + 1] = c[1];
        this.px[i + 2] = c[2];
      }
    }
  }
  /** Draws upper-cased text; returns its width. Characters without a glyph render as spaces. */
  text(s: string, x: number, y: number, scale: number, c: RGB, maxWidth = W - x - 48): number {
    const step = 6 * scale;
    const chars = [...s.toUpperCase()].slice(0, Math.max(0, Math.floor((maxWidth + scale) / step)));
    chars.forEach((ch, i) => {
      const g = GLYPHS[ch] ?? GLYPHS[" "]!;
      g.forEach((row, ry) => {
        for (let rx = 0; rx < 5; rx += 1) if (row[rx] === "1") this.fill(x + i * step + rx * scale, y + ry * scale, scale, scale, c);
      });
    });
    return chars.length * step - scale;
  }
}

export function textWidth(s: string, scale: number): number {
  return [...s].length * 6 * scale - scale;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function machineLine(r: SimbenchResult): string {
  const e = r.environment;
  const parts = [e.chip.replace(/\(R\)|\(TM\)|CPU|@.*$/g, "").replace(/\s+/g, " ").trim(), `${Math.round(e.memory_gb)} GB`];
  if (e.xcode) parts.push(e.xcode.replace(/Build version.*/i, "").trim());
  if (e.runner_label) parts.push(e.runner_label);
  return parts.join(" - ");
}

function targetLine(r: SimbenchResult): string {
  if (r.platform === "ios") return `IOS ${r.target.runtime_version ?? "?"} - ${r.target.device_type ?? "?"}`;
  return `ANDROID - ${String(r.target.system_image ?? r.target.avd ?? "?").replace(/^system-images;/, "").replace(/;/g, " ")}`;
}

export function renderCard(r: SimbenchResult): Buffer {
  const c = new Canvas();
  const P = PALETTE;
  c.fill(0, 0, W, H, P.bg);
  // frame
  c.fill(24, 24, W - 48, 2, P.lineStrong);
  c.fill(24, H - 26, W - 48, 2, P.lineStrong);
  c.fill(24, 24, 2, H - 48, P.lineStrong);
  c.fill(W - 26, 24, 2, H - 48, P.lineStrong);

  const x = 64;
  c.text("SIMBENCH/V1", x, 64, 4, P.green);
  const tier = r.tier.toUpperCase();
  c.text(tier, W - 64 - textWidth(tier, 3), 68, 3, r.tier === "ci-verified" ? P.green : P.peri);
  c.text(targetLine(r), x, 120, 3, P.muted);

  const cold = r.summary.cold;
  const headline = cold.median_run_to_first_frame_ms === null ? "NO COLD RESULT" : fmt(cold.median_run_to_first_frame_ms).toUpperCase();
  c.text(headline, x, 176, 14, P.text);
  c.text(`COLD BOOT TO FIRST APP FRAME - MEDIAN OF ${cold.ok}/${cold.n}`, x, 296, 3, P.muted);

  c.fill(x, 340, W - 128, 2, P.line);
  const cells: [string, string][] = [
    ["BOOT", fmt(cold.median_boot_ms)],
    ["WARM", fmt(r.summary.warm.median_run_to_first_frame_ms)],
    ["TAP", r.summary.tap.median_ms === null ? "N/A" : fmt(r.summary.tap.median_ms)],
    ["PARALLEL", r.parallel ? (r.parallel.max_ok_n === null ? "N/A" : `N=${r.parallel.max_ok_n}`) : "-"],
  ];
  const cw = (W - 128) / cells.length;
  cells.forEach(([k, v], i) => {
    const cx = Math.round(x + i * cw);
    c.text(k, cx, 372, 3, P.muted, cw - 16);
    c.text(v.toUpperCase(), cx, 408, 6, P.text, cw - 16);
  });
  c.fill(x, 478, W - 128, 2, P.line);

  c.text(machineLine(r), x, 504, 3, P.muted);
  c.text("NPX OPENDEVICEROUTER BENCH", x, 552, 3, P.green);
  const site = "OPENDEVICEROUTER.COM";
  c.text(site, W - 64 - textWidth(site, 3), 552, 3, P.muted);
  return encodePng(W, H, c.px);
}
