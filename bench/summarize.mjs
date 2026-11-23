#!/usr/bin/env node
// Builds bench/RESULTS.md from bench/results/**.json. `--check` fails if the page does not match the data,
// so numbers in RESULTS.md can only come from result files.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, "results");
const outFile = join(here, "RESULTS.md");
const MIN_FOR_P95 = 20;

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return name.endsWith(".json") ? [full] : [];
    });
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted, p) {
  if (sorted.length === 0) return undefined;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return undefined;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
const secs = (ms) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const pct = (n, d) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(1)}%`);

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(JSON.parse(readFileSync(join(here, "schema", "result.schema.json"), "utf8")));
const validateSession = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(join(here, "schema", "session.schema.json"), "utf8")));
const validateSimbench = new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(join(here, "schema", "simbench.schema.json"), "utf8")));
const sessions = [];
const simbench = [];

/** Same summary as src/bench/simbench.ts summarise(); a file whose summary differs was edited by hand. */
function simbenchSummary(samples) {
  const cold = samples.filter((x) => x.kind === "cold"), warm = samples.filter((x) => x.kind === "warm");
  const okC = cold.filter((x) => x.ok), okW = warm.filter((x) => x.ok);
  const taps = samples.map((x) => x.tap_to_change_ms).filter((v) => typeof v === "number");
  const m = (v) => median(v) ?? null;
  return {
    cold: { n: cold.length, ok: okC.length, median_run_to_first_frame_ms: m(okC.map((x) => x.run_to_first_frame_ms)), median_boot_ms: m(okC.map((x) => x.boot_ms)) },
    warm: { n: warm.length, ok: okW.length, median_run_to_first_frame_ms: m(okW.map((x) => x.run_to_first_frame_ms)) },
    tap: { n: taps.length, median_ms: m(taps) },
  };
}

const results = [];
const problems = [];
for (const file of walk(resultsDir)) {
  const rel = relative(here, file);
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(`${rel}: not valid JSON (${e.message})`);
    continue;
  }
  if (data.schema === "simbench/v1") {
    if (!validateSimbench(data)) {
      for (const e of validateSimbench.errors) problems.push(`${rel}: ${e.instancePath || "/"} ${e.message}`);
      continue;
    }
    if (JSON.stringify(simbenchSummary(data.samples)) !== JSON.stringify(data.summary)) problems.push(`${rel}: summary does not match the samples`);
    if (data.tier === "ci-verified") {
      if (!rel.startsWith(join("results", "simbench", "ci"))) problems.push(`${rel}: ci-verified SimBench results live under results/simbench/ci/`);
      if (!/^https:\/\/github\.com\/QA-army\/open-device-router\/actions\/runs\/\d+$/.test(data.harness.run_url ?? "")) problems.push(`${rel}: ci-verified needs a run URL in QA-army/open-device-router`);
    } else if (data.tier === "self-reported") {
      if (!rel.startsWith(join("results", "simbench", "self-reported"))) problems.push(`${rel}: self-reported SimBench results live under results/simbench/self-reported/`);
      if (!data.submission?.issue) problems.push(`${rel}: self-reported results are added from a GitHub issue (submission.issue)`);
    } else problems.push(`${rel}: tier ${data.tier} is not published yet`);
    if (!data.samples.some((x) => x.ok)) problems.push(`${rel}: no sample reached the fixture's first frame`);
    simbench.push({ rel, ...data });
    continue;
  }
  if (data.schema === "odr.bench.session/v1") {
    if (!validateSession(data)) {
      for (const e of validateSession.errors) problems.push(`${rel}: ${e.instancePath || "/"} ${e.message}`);
      continue;
    }
    if (!rel.startsWith(join("results", data.provider, "session", data.platform))) problems.push(`${rel}: must live under results/${data.provider}/session/${data.platform}/`);
    if (data.harness.commit === "uncommitted" || !data.harness.run_url) problems.push(`${rel}: only results from a public CI run with a commit and run URL are published`);
    if (!data.samples.some((x) => x.device)) {
      problems.push(`${rel}: no sample reached a device. Treated as a harness or environment fault; investigate before publishing`);
    }
    sessions.push({ rel, ...data });
    continue;
  }
  if (!validate(data)) {
    for (const e of validate.errors) problems.push(`${rel}: ${e.instancePath || "/"} ${e.message}`);
    continue;
  }
  if (!rel.startsWith(join("results", data.provider, data.target))) {
    problems.push(`${rel}: must live under results/${data.provider}/${data.target}/`);
  }
  if (data.harness.commit === "uncommitted" || !data.harness.run_url) {
    problems.push(`${rel}: only results from a public CI run with a commit and run URL are published`);
  }
  if (!data.samples.some((x) => x.ok)) {
    // A run where nothing started cannot be told apart from a broken harness, so it is never published automatically.
    problems.push(`${rel}: no sample started. Treated as a harness or environment fault; investigate before publishing`);
  }
  results.push({ rel, ...data });
}
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  if (!process.argv.includes("--drop-rejected")) process.exit(1);
  // CI publish only: remove rejected files so one broken target does not block the others.
  const bad = new Set(problems.map((p) => p.split(":")[0]));
  for (const rel of bad) {
    rmSync(join(here, rel), { force: true });
    console.error(`dropped ${rel}; it stays in the workflow artifacts`);
  }
  for (const list of [results, sessions, simbench]) {
    for (let i = list.length - 1; i >= 0; i -= 1) if (bad.has(list[i].rel)) list.splice(i, 1);
  }
}

const lines = [];
lines.push("# Benchmark results");
lines.push("");
lines.push("<!-- Generated by `npm run bench:summarize` from bench/results/. Do not edit by hand. -->");
lines.push("");
lines.push("Method, definitions and limits: [METHODOLOGY.md](METHODOLOGY.md). Raw data: [results/](results/).");
lines.push("");

if (sessions.length > 0) {
  lines.push("## Sessions: Run to first frame");
  lines.push("");
  lines.push(
    "Full lifecycle through the SDK: reserve, allocate, install the fixture build, launch, first usable screenshot, hold with a screenshot every 5 s, one tap, release, verify closure. \"Run to first frame\" starts when `allocate()` is called. All runs pooled; medians only.",
  );
  lines.push("");
  lines.push("| Provider | Platform | Device | Runs | Samples | OK + closed | Run to first frame | Allocate | Install | Launch | First frame | Teardown | Dropped | Screenshot misses | Tap changed frame | Last run |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const groups = new Map();
  for (const r of sessions) {
    const dev = r.samples.find((s) => s.device?.os_version)?.device ?? r.samples.find((s) => s.device)?.device;
    const key = [r.provider, r.platform, dev ? `${dev.model ?? "?"}, ${dev.os_version ?? "?"}` : "n/a", r.environment.runner_label].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const key of [...groups.keys()].sort()) {
    const runs = groups.get(key);
    const [provider, platform, device] = key.split("|");
    const all = runs.flatMap((r) => r.samples);
    const good = all.filter((s) => s.outcome === "ok" && s.closure === "verified");
    const med = (k) => secs(median(good.map((s) => s.timings_ms[k]).filter((v) => v !== undefined)));
    const dropped = all.filter((s) => s.health?.dropped).length;
    const misses = all.reduce((n, s) => n + s.hold.screenshots_failed, 0);
    const shots = all.reduce((n, s) => n + s.hold.screenshots_ok + s.hold.screenshots_failed, 0);
    const tapped = good.filter((s) => (s.tap_frame_change ?? 0) > 0.01).length;
    const last = runs.map((r) => r.started_at).sort().at(-1).slice(0, 10);
    lines.push(
      `| ${provider} | ${platform} | ${device} | ${runs.length} | ${all.length} | ${good.length} (${pct(good.length, all.length)}) | ${med("run_to_first_frame")} | ${med("allocate")} | ${med("install")} | ${med("launch")} | ${med("first_frame")} | ${med("teardown")} | ${dropped} | ${misses} of ${shots} | ${tapped} of ${good.length} | ${last} |`,
    );
  }
  lines.push("");
  lines.push("| Started (UTC) | Provider | Platform | Samples | OK + closed | Run to first frame (min / median / max) | Commit | Run | Raw |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of [...sessions].sort((a, b) => b.started_at.localeCompare(a.started_at))) {
    const good = r.samples.filter((s) => s.outcome === "ok" && s.closure === "verified");
    const t = good.map((s) => s.timings_ms.run_to_first_frame).filter((v) => v !== undefined).sort((a, b) => a - b);
    lines.push(
      `| ${r.started_at.slice(0, 16).replace("T", " ")} | ${r.provider} | ${r.platform} | ${r.samples.length} | ${good.length} | ${secs(t[0])} / ${secs(median(t))} / ${secs(t.at(-1))} | \`${r.harness.commit.slice(0, 7)}\` | [run](${r.harness.run_url}) | [json](${r.rel.split("\\").join("/")}) |`,
    );
  }
  lines.push("");
}

const ci = simbench.filter((r) => r.tier === "ci-verified");
const self = simbench.filter((r) => r.tier === "self-reported");
const raw = (r) => `[json](${r.rel.split("\\").join("/")})`;
const targetOf = (r) => (r.platform === "ios" ? `${r.target.device_type}, iOS ${r.target.runtime_version}` : `${r.target.system_image ?? r.target.avd}`);
if (ci.length > 0) {
  lines.push("## SimBench: GitHub-hosted runners (CI-verified)");
  lines.push("");
  lines.push(
    "`odr bench` on GitHub-hosted runners, one fresh device per cold sample. Run to first frame starts before the simulator is created (iOS) or the emulator process is started (Android) and ends at the first screenshot showing the fixture app. Warm = install and launch on an already booted device. Cost is an estimate from the published per-minute rate; public repositories run standard runners at no charge.",
  );
  lines.push("");
  lines.push("| Runner | Platform | Target | Runs | Cold OK | Cold run to first frame | Boot | Warm run to first frame | Tap to change | Parallel (max N) | Est. cost per cold session | Last run |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const groups = new Map();
  for (const r of ci) {
    const key = [r.environment.runner_label, r.platform, targetOf(r)].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const key of [...groups.keys()].sort()) {
    const runs = groups.get(key);
    const [runner, platform, target] = key.split("|");
    const all = runs.flatMap((r) => r.samples);
    const pooled = simbenchSummary(all);
    const par = runs.map((r) => r.parallel?.max_ok_n).filter((v) => typeof v === "number");
    const cost = runs.map((r) => r.cost?.estimated_usd_per_cold_session).filter((v) => typeof v === "number");
    lines.push(
      `| ${runner} | ${platform} | ${target} | ${runs.length} | ${pooled.cold.ok} of ${pooled.cold.n} | ${secs(pooled.cold.median_run_to_first_frame_ms ?? undefined)} | ${secs(pooled.cold.median_boot_ms ?? undefined)} | ${secs(pooled.warm.median_run_to_first_frame_ms ?? undefined)} | ${pooled.tap.n ? secs(pooled.tap.median_ms) : "not measured"} | ${par.length ? `N=${Math.min(...par)}` : "-"} | ${cost.length ? `$${median(cost.map((c) => Math.round(c * 10000))) / 10000}` : "-"} | ${runs.map((r) => r.started_at).sort().at(-1).slice(0, 10)} |`,
    );
  }
  lines.push("");
  lines.push("Parallel shows the lowest max N across runs. Rule: " + (ci.find((r) => r.parallel)?.parallel.rule ?? "see METHODOLOGY.md") );
  lines.push("");
}
if (self.length > 0) {
  lines.push("## SimBench: self-reported");
  lines.push("");
  lines.push(
    "Submitted by people running `npx opendevicerouter bench` on their own machines. Each file passed the schema and a consistency check (the summary is recomputed from the raw samples). Nobody reproduced them, so they are not compared with the CI-verified table.",
  );
  lines.push("");
  lines.push("| Submitted | Platform | Target | Chip | RAM | Xcode | Power | Cold OK | Cold run to first frame | Warm | Parallel (max N) | Issue | Raw |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of [...self].sort((a, b) => b.started_at.localeCompare(a.started_at))) {
    const e = r.environment;
    lines.push(
      `| ${r.started_at.slice(0, 10)} | ${r.platform} | ${targetOf(r)} | ${e.chip} | ${Math.round(e.memory_gb)} GB | ${e.xcode ? e.xcode.replace(/ Build version.*/, "") : "-"} | ${e.power} | ${r.summary.cold.ok} of ${r.summary.cold.n} | ${secs(r.summary.cold.median_run_to_first_frame_ms ?? undefined)} | ${secs(r.summary.warm.median_run_to_first_frame_ms ?? undefined)} | ${r.parallel?.max_ok_n ? `N=${r.parallel.max_ok_n}` : "-"} | [issue](${r.submission.issue}) | ${raw(r)} |`,
    );
  }
  lines.push("");
}

if (results.length === 0) {
  lines.push("No results yet. Nothing has been measured, so there are no numbers to show.");
  lines.push("");
} else {
  const groups = new Map();
  for (const r of results) {
    const key = [r.provider, r.target, r.environment.runner_label, r.device.name, r.device.os_version].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  lines.push("## Cold boot (device only)");
  lines.push("");
  lines.push(
    `All runs to date, pooled. p95 is shown only from ${MIN_FOR_P95} successful samples up. "Failed boots" counts samples where the device did not finish booting or could not return a screenshot.`,
  );
  lines.push("");
  lines.push("| Provider | Target | Runner | Device | Runs | Samples | Failed boots | Boot median | Boot p95 | First frame median | Teardown median | Last run |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const key of [...groups.keys()].sort()) {
    const runs = groups.get(key);
    const first = runs[0];
    const all = runs.flatMap((r) => r.samples);
    const ok = all.filter((s) => s.ok);
    const boots = ok.map((s) => s.boot_ms).sort((a, b) => a - b);
    const last = runs.map((r) => r.started_at).sort().at(-1).slice(0, 10);
    lines.push(
      `| ${first.provider} | ${first.target} | ${first.environment.runner_label} | ${first.device.name}, ${first.device.os_version} | ${runs.length} | ${all.length} | ${all.length - ok.length} (${pct(all.length - ok.length, all.length)}) | ${secs(median(boots))} | ${boots.length >= MIN_FOR_P95 ? secs(percentile(boots, 95)) : `n < ${MIN_FOR_P95}`} | ${secs(median(ok.map((s) => s.first_frame_ms)))} | ${secs(median(all.filter((s) => s.teardown_ms !== undefined).map((s) => s.teardown_ms)))} | ${last} |`,
    );
  }
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push("| Started (UTC) | Provider | Target | Image | Samples | Failed | Boot min | Boot median | Boot max | Setup | Commit | Run | Raw |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const byTime = [...results].sort((a, b) => b.started_at.localeCompare(a.started_at) || a.rel.localeCompare(b.rel));
  for (const r of byTime) {
    const ok = r.samples.filter((s) => s.ok);
    const boots = ok.map((s) => s.boot_ms).sort((a, b) => a - b);
    const image = [r.environment.image_os, r.environment.image_version].filter(Boolean).join(" ") || "n/a";
    lines.push(
      `| ${r.started_at.slice(0, 16).replace("T", " ")} | ${r.provider} | ${r.target} | ${image} | ${r.samples.length} | ${r.samples.length - ok.length} | ${secs(boots[0])} | ${secs(median(boots))} | ${secs(boots.at(-1))} | ${secs(r.setup_ms)} | \`${r.harness.commit.slice(0, 7)}\` | [run](${r.harness.run_url}) | [json](${r.rel.split("\\").join("/")}) |`,
    );
  }
  lines.push("");
}

const md = lines.join("\n");

// README "Measured" block: generated from the same data, so the README never carries a typed number.
const readmeFile = join(here, "..", "README.md");
const block = ["<!-- MEASURED:START -->", "<!-- Generated by `npm run bench:summarize`. Do not edit. -->"];
if (sessions.length > 0) {
  block.push("", "**Measured on public CI** ([results](bench/RESULTS.md), [method](bench/METHODOLOGY.md)). Run to first frame = `allocate()` called until the first usable screenshot of the freshly installed fixture app, on a device odr booted for that sample, with verified closure. Some Android samples so far started from the emulator's quick-boot snapshot; the method page lists them.", "");
  block.push("| Where | Device | Sessions (OK + closed) | Run to first frame, median | Screenshot misses while held | Last run |");
  block.push("| --- | --- | --- | --- | --- | --- |");
  const byTarget = new Map();
  for (const r of sessions) {
    const k = `${r.provider}|${r.platform}`;
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(r);
  }
  for (const k of [...byTarget.keys()].sort()) {
    const runs = byTarget.get(k);
    const all = runs.flatMap((r) => r.samples);
    const good = all.filter((x) => x.outcome === "ok" && x.closure === "verified");
    const dev = all.find((x) => x.device?.os_version)?.device;
    const misses = all.reduce((n, x) => n + x.hold.screenshots_failed, 0);
    const shots = all.reduce((n, x) => n + x.hold.screenshots_ok + x.hold.screenshots_failed, 0);
    const where = { "github-actions": "GitHub-hosted runner" }[runs[0].provider] ?? runs[0].provider;
    block.push(`| ${where} (${runs[0].environment.runner_label}) | ${dev ? `${dev.model}, ${runs[0].platform === "ios" ? "iOS" : "Android"} ${dev.os_version}` : runs[0].platform} | ${good.length} of ${all.length} across ${runs.length} run(s) | ${secs(median(good.map((x) => x.timings_ms.run_to_first_frame).filter((v) => v !== undefined)))} | ${misses} of ${shots} | ${runs.map((r) => r.started_at).sort().at(-1).slice(0, 10)} |`);
  }
  block.push("", "Small samples; read the limits in the method page. Cloud providers are not in this table until their terms allow publication.");
} else {
  block.push("", "No session results published yet.");
}
block.push("<!-- MEASURED:END -->");
const readme = existsSync(readmeFile) ? readFileSync(readmeFile, "utf8") : "";
const re = /<!-- MEASURED:START -->[\s\S]*?<!-- MEASURED:END -->/;
const newReadme = re.test(readme) ? readme.replace(re, block.join("\n")) : readme;
if (process.argv.includes("--check")) {
  if (!existsSync(outFile) || readFileSync(outFile, "utf8") !== md) {
    console.error("bench/RESULTS.md does not match bench/results/. Run `npm run bench:summarize`.");
    process.exit(1);
  }
  if (newReadme !== readme) {
    console.error("README.md measured block does not match bench/results/. Run `npm run bench:summarize`.");
    process.exit(1);
  }
  console.log(`bench/RESULTS.md matches ${results.length} result file(s)`);
} else {
  writeFileSync(outFile, md);
  if (newReadme !== readme) writeFileSync(readmeFile, newReadme);
  console.log(`wrote bench/RESULTS.md from ${results.length} result file(s)`);
}
