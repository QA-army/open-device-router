import assert from "node:assert/strict";
import { test } from "node:test";
import { shotMarkdown, type ShotResult } from "../src/bench/shot.js";

const base: ShotResult = {
  schema: "odr.shot/v1",
  platform: "android",
  app_id: "dev.odr.fixture",
  device: { avd: "odr-simbench", system_image: "system-images;android-34;google_apis;x86_64" },
  started_at: "2026-11-23T00:00:00.000Z",
  finished_at: "2026-11-23T00:01:00.000Z",
  ok: true,
  timings_ms: { boot: 40_000, install: 2_000, launch: 300, launch_to_first_frame: 1_200, launch_to_settled: 3_100, run_to_first_frame: 43_500, tap_to_change: 400 },
  second_frame: { kind: "after_tap", changed: true },
  files: { first: "first-screen.png", second: "after-tap.png", first_change: "first-change.png" },
  tool: { name: "opendevicerouter", version: "0.1.0" },
  harness: { repository: "QA-army/open-device-router", commit: "abc", run_url: null },
};

test("shot markdown: per-platform marker, timings, images only when URLs are given", () => {
  const md = shotMarkdown(base, (f) => `https://example.test/${f}`);
  assert.ok(md.startsWith("<!-- odr-first-screenshot:android -->"));
  assert.match(md, /<img src="https:\/\/example.test\/first-screen.png"/);
  assert.doesNotMatch(md, /first-change.png"/);
  assert.match(md, /After a centre tap \|/);
  assert.match(md, /\| 40\.0 s \| 2\.0 s \| 1\.2 s \| 3\.1 s \| 43\.5 s \| 0\.4 s \|/);
  assert.doesNotMatch(md, /\bpassed\b|\bfailed\b/i);
  assert.doesNotMatch(shotMarkdown(base), /<img/);
});

test("shot markdown: iOS has no tap figure and failures show the error", () => {
  const ios: ShotResult = { ...base, platform: "ios", timings_ms: { ...base.timings_ms, tap_to_change: null }, second_frame: { kind: "settled", changed: false } };
  assert.match(shotMarkdown(ios), /not measured on iOS/);
  const bad: ShotResult = { ...base, ok: false, error: "frame did not appear within 60 s" };
  assert.match(shotMarkdown(bad), /No frame captured: frame did not appear within 60 s/);
});
