#!/usr/bin/env node
// Turns a "SimBench result" GitHub issue into a result file under bench/results/simbench/self-reported/.
// Runs in the simbench-intake workflow. The issue body is untrusted: it arrives through the environment,
// is only ever parsed as JSON, and is never passed to a shell.
// Env: ISSUE_BODY, ISSUE_URL, ISSUE_NUMBER. Writes `file=<path>` to $GITHUB_OUTPUT on success.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const body = process.env.ISSUE_BODY ?? "";
const url = process.env.ISSUE_URL ?? "";
const number = Number(process.env.ISSUE_NUMBER);

function fail(message) {
  console.error(message);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `error<<EOF_ODR\n${message}\nEOF_ODR\n`);
  process.exit(1);
}

if (!/^https:\/\/github\.com\/QA-army\/open-device-router\/issues\/\d+$/.test(url) || !Number.isInteger(number)) fail("not an issue in QA-army/open-device-router");
const match = body.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
if (!match) fail("No JSON block found. Paste the whole result file from `odr bench` into the Result field.");
let data;
try {
  data = JSON.parse(match[1]);
} catch (e) {
  fail(`The Result field is not valid JSON (${e.message}).`);
}
if (data?.schema !== "simbench/v1") fail("The result is not a simbench/v1 file. Run `npx opendevicerouter bench` and paste the JSON it writes.");
if (data.tier !== "self-reported") fail(`Issues can only add self-reported results; this file says tier "${data.tier}".`);
if (data.platform !== "ios" && data.platform !== "android") fail("platform must be ios or android");
if (data.submission) fail("submission is added by this workflow; remove it from the file.");
data.submission = { issue: url, received_at: new Date().toISOString().replace(/\.\d+Z$/, "Z") };

const stamp = String(data.started_at ?? "").replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
if (!/^\d{8}T\d{6}Z$/.test(stamp)) fail("started_at is missing or malformed");
const file = join(here, "results", "simbench", "self-reported", data.platform, `${stamp}-issue${number}.json`);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
console.log(relative(join(here, ".."), file));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `file=${relative(join(here, ".."), file)}\n`);
