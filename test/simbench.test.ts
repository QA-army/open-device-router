import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32, encodePng, renderCard } from "../src/bench/card.js";
import { isAppFrame, isFixtureFirstFrame, isFixtureTapped, redShare } from "../src/bench/frames.js";
import { PARALLEL_RULE, SIMBENCH_SCHEMA, summarise, type Sample, type SimbenchResult } from "../src/bench/simbench.js";
import { median, sh } from "../src/bench/util.js";
import { validateSimbench } from "../src/bench/validate.js";
import { decodePng, isUsableFrame } from "../src/session/png.js";

/** HSV -> RGB as the fixtures compute it. */
function hsv(h: number, s: number, v: number): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** A phone-shaped frame: a status bar, a full fill, and a white text block in the middle. */
function frame(fill: [number, number, number], w = 120, h = 260): Buffer {
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const text = y > 110 && y < 150 && x > 20 && x < 100 && (x + y) % 3 === 0;
      const c = y < 12 ? [0, 0, 0] : text ? [255, 255, 255] : fill;
      px.set(c, (y * w + x) * 3);
    }
  }
  return encodePng(w, h, px);
}

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("encodePng output decodes with the session PNG decoder", () => {
  const png = frame([10, 200, 30]);
  const f = decodePng(png);
  assert.equal(f.width, 120);
  assert.equal(f.height, 260);
  assert.deepEqual(f.rgb(5, 100), [10, 200, 30]);
  assert.deepEqual(f.rgb(5, 2), [0, 0, 0]);
});

test("fixture detection: taps 0 is the first frame, taps 1 is a visible change", () => {
  const first = frame(hsv(0, 0.8, 0.6));
  const tapped = frame(hsv(67, 0.8, 0.6));
  const home = frame([30, 60, 120]);
  assert.ok(redShare(first) > 0.8);
  assert.ok(isFixtureFirstFrame(first));
  assert.ok(!isFixtureFirstFrame(tapped));
  assert.ok(!isFixtureFirstFrame(home));
  assert.ok(isFixtureTapped(tapped));
  assert.ok(!isFixtureTapped(first));
});

test("fixture detection tolerates a Display P3 shift of the start colour", () => {
  assert.ok(isFixtureFirstFrame(frame([140, 45, 40])));
});

test("a flat black boot frame is neither usable nor the fixture", () => {
  const black = encodePng(64, 64, Buffer.alloc(64 * 64 * 3));
  assert.ok(!isUsableFrame(black));
  assert.ok(!isFixtureFirstFrame(black));
  assert.ok(!isFixtureTapped(black));
});

test("isAppFrame needs a change from the pre-launch frame", () => {
  const home = frame([30, 60, 120]);
  assert.ok(!isAppFrame(home, home));
  assert.ok(isAppFrame(frame([200, 200, 200]), home));
});

test("median uses the mean of the middle pair", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([1, 2, 10]), 2);
});

function sample(kind: "cold" | "warm", index: number, ms: number | undefined, tap: number | null = null): Sample {
  return ms === undefined
    ? { kind, index, ok: false, tap_to_change_ms: null, error: "boot did not complete within the timeout" }
    : { kind, index, ok: true, boot_ms: Math.round(ms * 0.6), first_screenshot_ms: Math.round(ms * 0.7), install_step_ms: 900, launch_step_ms: 300, launch_to_first_frame_ms: 1200, run_to_first_frame_ms: ms, tap_to_change_ms: tap };
}

function result(): SimbenchResult {
  const samples = [sample("cold", 0, 61_000), sample("cold", 1, 58_000), sample("cold", 2, undefined), sample("warm", 0, 4_100), sample("warm", 1, 3_900)];
  return {
    schema: SIMBENCH_SCHEMA,
    tier: "self-reported",
    platform: "ios",
    started_at: "2026-11-23T10:00:00.000Z",
    finished_at: "2026-11-23T10:09:00.000Z",
    tool: { name: "opendevicerouter", version: "0.1.0" },
    harness: { repository: "local", commit: "unknown", run_url: null },
    environment: {
      os: "darwin", os_version: "26.1", os_build: "25B78", arch: "arm64", chip: "Apple M3 Pro", machine_model: "Mac15,6", cpu_count: 12, memory_gb: 36,
      xcode: "Xcode 26.1 Build version 17B55", power: "ac", booted_simulators_before: 0, runner_label: null, image_os: null, image_version: null, node: "v22.12.0",
    },
    target: { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-1", runtime_version: "26.1", runtime_build: "23B80", device_type: "iPhone 17" },
    method: { cold: "c", warm: "w", first_frame: "f", input: "not measured", fixture_build_excluded_ms: 8000 },
    samples,
    parallel: {
      levels: [{ n: 1, ok: 1, failed: 0, median_run_to_first_frame_ms: 60_000, max_run_to_first_frame_ms: 60_000, devices: [sample("cold", 0, 60_000)] }],
      max_ok_n: 1,
      stop_reason: "all levels passed",
      rule: PARALLEL_RULE,
    },
    summary: summarise(samples),
  };
}

test("summarise counts only ok samples and splits cold from warm", () => {
  const s = result().summary;
  assert.deepEqual(s.cold, { n: 3, ok: 2, median_run_to_first_frame_ms: 59_500, median_boot_ms: 35_700 });
  assert.deepEqual(s.warm, { n: 2, ok: 2, median_run_to_first_frame_ms: 4_000 });
  assert.deepEqual(s.tap, { n: 0, median_ms: null });
});

test("validateSimbench accepts a tool-written result", () => {
  assert.deepEqual(validateSimbench(JSON.parse(JSON.stringify(result()))), []);
});

test("validateSimbench rejects an edited headline, identifying fields and a fake ci tier", () => {
  const edited = result();
  edited.summary.cold.median_run_to_first_frame_ms = 9_000;
  assert.ok(validateSimbench(edited).includes("summary does not match the samples"));

  const leaky = result() as unknown as { environment: Record<string, unknown> };
  leaky.environment.hostname = "priyankas-mbp";
  assert.ok(validateSimbench(leaky).some((e) => e.includes("additional properties")));

  const fake = result();
  fake.tier = "ci-verified";
  fake.harness.run_url = "https://github.com/someone/fork/actions/runs/1";
  assert.ok(validateSimbench(fake).some((e) => e.includes("ci-verified")));
});

test("renderCard writes a 1200x630 PNG that is not a flat colour", () => {
  const png = renderCard(result());
  const f = decodePng(png);
  assert.equal(f.width, 1200);
  assert.equal(f.height, 630);
  assert.ok(isUsableFrame(png));
});

test("timeout kills are labeled in the error message", async () => {
  await assert.rejects(sh("sleep", ["5"], { timeout: 200 }), /timed out after 0 s: Command failed: sleep 5/);
});
