import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderCard } from "../bench/card.js";
import { fmt, runSimbench, SIMBENCH_SCHEMA, type SimbenchResult } from "../bench/simbench.js";
import { validateSimbench } from "../bench/validate.js";

export const BENCH_HELP = `odr bench - SimBench: cold and warm simulator/emulator sessions on this machine

  odr bench [--platform ios|android] [--cold 3] [--warm 3] [--parallel 1,2,4,8]
            [--runtime 26.0] [--device-type "iPhone 17"] [--avd name] [--headless]
            [--out dir] [--json] [--submit]
  odr bench card <result.json> [--out card.png]     redraw the share card
  odr bench submit <result.json>                    open a GitHub issue with the result (needs gh)
  odr bench validate <result.json>...               check files against simbench/v1

Measures create, boot, first screenshot, install, launch and first app frame with a fixture app built
from source on this machine (build time is recorded and excluded). Android also measures tap to
visible change. iOS taps are not measured in simbench/v1.

Nothing leaves the machine unless you pass --submit. Results record chip, RAM, OS, Xcode and power
source; never hostname, username, serial number or device UDID.
Android: with --avd, cold boots skip snapshots but keep your data. Without it, odr creates
an AVD named odr-simbench from your newest installed system image and wipes only that one.
`;

const REPO = "QA-army/open-device-router";
const ISSUE_FORM = `https://github.com/${REPO}/issues/new?template=simbench-result.yml`;

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function intList(v: string | undefined, name: string): number[] | undefined {
  if (v === undefined) return undefined;
  const list = v.split(",").map((s) => Number(s.trim()));
  if (list.some((n) => !Number.isInteger(n) || n < 1 || n > 16)) throw new Error(`${name} must be a comma list of whole numbers from 1 to 16`);
  return [...new Set(list)];
}

function count(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error(`${name} must be a whole number from 0 to 20`);
  return n;
}

export function issueBody(r: SimbenchResult): string {
  const s = r.summary;
  const lines = [
    `Platform: ${r.platform}`,
    `Target: ${Object.values(r.target).filter(Boolean).join(", ")}`,
    `Machine: ${r.environment.chip}, ${r.environment.memory_gb} GB, ${r.environment.os} ${r.environment.os_version ?? ""}${r.environment.xcode ? `, ${r.environment.xcode}` : ""}`,
    `Cold run to first frame (median): ${fmt(s.cold.median_run_to_first_frame_ms)} (${s.cold.ok}/${s.cold.n} ok)`,
    `Warm run to first frame (median): ${fmt(s.warm.median_run_to_first_frame_ms)} (${s.warm.ok}/${s.warm.n} ok)`,
    ...(r.parallel ? [`Parallel: max N=${r.parallel.max_ok_n ?? "none"} (${r.parallel.stop_reason})`] : []),
    "",
    "### Result",
    "",
    "```json",
    JSON.stringify(r, null, 2),
    "```",
  ];
  return lines.join("\n");
}

function submit(file: string, r: SimbenchResult): void {
  const title = `SimBench result: ${r.platform} ${r.target.runtime_version ?? r.target.system_image ?? ""} on ${r.environment.chip}`.slice(0, 120);
  const bodyFile = join(dirname(file), `${basename(file, ".json")}.issue.md`);
  writeFileSync(bodyFile, issueBody(r));
  try {
    const url = execFileSync("gh", ["issue", "create", "--repo", REPO, "--title", title, "--label", "simbench-result", "--body-file", bodyFile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    console.log(`submitted: ${url}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message.split("\n")[0] : String(e);
    console.log(`could not submit with gh (${detail}).`);
    console.log(`Open ${ISSUE_FORM} and paste the contents of ${file} into the result field.`);
  }
}

function readResult(path: string | undefined): { file: string; result: SimbenchResult } {
  if (!path) throw new Error("result file is required");
  const file = resolve(path);
  const result = JSON.parse(readFileSync(file, "utf8")) as SimbenchResult;
  if (result.schema !== SIMBENCH_SCHEMA) throw new Error(`${path} is not a ${SIMBENCH_SCHEMA} result`);
  return { file, result };
}

export async function cmdBench(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "card") {
    const { values, positionals } = parseArgs({ args: args.slice(1), allowPositionals: true, options: { out: { type: "string" } } });
    const { file, result } = readResult(positionals[0]);
    const out = resolve(values.out ?? file.replace(/\.json$/, ".png"));
    writeFileSync(out, renderCard(result));
    console.log(out);
    return;
  }
  if (sub === "submit") {
    const { file, result } = readResult(args[1]);
    submit(file, result);
    return;
  }
  if (sub === "validate") {
    let bad = 0;
    for (const f of args.slice(1)) {
      const errors = validateSimbench(JSON.parse(readFileSync(f, "utf8")));
      if (errors.length) {
        bad += 1;
        console.error(`${f}:\n  ${errors.join("\n  ")}`);
      } else console.log(`${f}: ok`);
    }
    if (bad) process.exitCode = 1;
    return;
  }
  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(BENCH_HELP);
    return;
  }

  const { values } = parseArgs({
    args,
    options: {
      platform: { type: "string" },
      cold: { type: "string" },
      warm: { type: "string" },
      parallel: { type: "string" },
      runtime: { type: "string" },
      "device-type": { type: "string" },
      avd: { type: "string" },
      headless: { type: "boolean" },
      out: { type: "string" },
      json: { type: "boolean" },
      submit: { type: "boolean" },
      "cost-rate": { type: "string" },
      "cost-sku": { type: "string" },
      "cost-source": { type: "string" },
    },
  });
  const platform = (values.platform ?? (process.platform === "darwin" ? "ios" : "android")) as "ios" | "android";
  if (platform !== "ios" && platform !== "android") throw new Error("--platform must be ios or android");
  const rate = values["cost-rate"] !== undefined ? Number(values["cost-rate"]) : undefined;
  if (rate !== undefined && !(rate >= 0)) throw new Error("--cost-rate must be a number of USD per minute");
  const log = values.json ? (l: string) => console.error(l) : (l: string) => console.log(l);

  const result = await runSimbench({
    platform,
    cold: count(values.cold, 3, "--cold"),
    warm: count(values.warm, 3, "--warm"),
    parallel: intList(values.parallel, "--parallel"),
    runtime: values.runtime,
    deviceType: values["device-type"],
    avd: values.avd,
    headless: values.headless,
    ...(rate !== undefined ? { cost: { rate, sku: values["cost-sku"] ?? "unknown", source: values["cost-source"] ?? "unknown" } } : {}),
    log,
  });

  const outDir = resolve(values.out ?? "simbench-results");
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${platform}-${stamp(result.started_at)}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(`${base}.png`, renderCard(result));

  if (values.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const s = result.summary;
    console.log("");
    console.log(`cold: ${fmt(s.cold.median_run_to_first_frame_ms)} median to first frame (${s.cold.ok}/${s.cold.n} ok), boot ${fmt(s.cold.median_boot_ms)}`);
    console.log(`warm: ${fmt(s.warm.median_run_to_first_frame_ms)} median to first frame (${s.warm.ok}/${s.warm.n} ok)`);
    if (s.tap.n) console.log(`tap:  ${fmt(s.tap.median_ms)} median to visible change`);
    if (result.parallel) console.log(`parallel: max N=${result.parallel.max_ok_n ?? "none"} (${result.parallel.stop_reason})`);
    console.log(`result: ${base}.json`);
    console.log(`card:   ${base}.png`);
    if (!values.submit) console.log(`share:  odr bench submit ${base}.json   (opens a public GitHub issue)`);
  }
  if (values.submit) submit(`${base}.json`, result);
  if (result.summary.cold.ok === 0 && result.summary.warm.ok === 0) process.exitCode = 1;
}
