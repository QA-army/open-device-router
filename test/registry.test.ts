import assert from "node:assert/strict";
import { test } from "node:test";
import { freeTiersMarkdown } from "../src/cli/free-tiers.js";
import type { Provider } from "../src/core/types.js";
import { ageInDays, checkPolicy, findProvider, loadRegistry } from "../src/registry/load.js";

const { providers, issues } = loadRegistry();
const now = new Date("2026-11-22T12:00:00Z");

function clone(id: string): Provider {
  return structuredClone(findProvider(providers, id)!);
}

test("every shipped entry passes the schema and policy rules", () => {
  assert.deepEqual(issues.filter((i) => i.level === "error"), []);
});

test("the twelve researched providers are present", () => {
  const ids = [
    "aws-device-farm", "browserstack", "sauce-labs", "testmu-ai", "testingbot", "browserbase",
    "cloudflare-browser-rendering", "azure-playwright-workspaces", "revyl", "appetize", "genymotion-saas", "limrun",
  ];
  for (const id of ids) {
    const p = findProvider(providers, id);
    assert.ok(p, `${id} missing`);
    assert.ok(p.status === "launch" || p.status === "researched", `${id} should be researched`);
  }
});

test("four to six launch targets, each with a control path and no restricted benchmark terms", () => {
  const launch = providers.filter((p) => p.status === "launch");
  assert.ok(launch.length >= 4 && launch.length <= 6, `${launch.length} launch targets`);
  for (const p of launch) {
    assert.notEqual(p.hands.kind, "unknown");
    assert.notEqual(p.policy.benchmark_publication, "restricted");
  }
});

test("every entry allows one account per organization", () => {
  for (const p of providers) assert.equal(p.policy.max_accounts_per_org, 1);
});

test("a launch provider with restricted benchmark terms is rejected", () => {
  const p = clone("limrun");
  p.policy.benchmark_publication = "restricted";
  const found = checkPolicy(p, "limrun.yaml", now);
  assert.ok(found.some((i) => i.level === "error" && i.message.includes("restricted")));
});

test("file name must match id", () => {
  const found = checkPolicy(clone("revyl"), "other.yaml", now);
  assert.ok(found.some((i) => i.message.includes("revyl.yaml")));
});

test("a required card must be listed as a human step", () => {
  const p = clone("aws-device-farm");
  p.signup.human_steps = ["accept_terms"];
  const found = checkPolicy(p, "aws-device-farm.yaml", now);
  assert.ok(found.some((i) => i.message.includes("payment_card")));
  assert.ok(found.some((i) => i.message.includes("phone_code")));
});

test("an allowance source must be listed in sources", () => {
  const p = clone("revyl");
  p.allowances[0]!.source = "https://example.com/elsewhere";
  assert.ok(checkPolicy(p, "revyl.yaml", now).some((i) => i.message.includes("sources")));
});

test("a future checked_at is rejected", () => {
  const p = clone("revyl");
  p.checked_at = "2030-01-01";
  assert.ok(checkPolicy(p, "revyl.yaml", now).some((i) => i.message.includes("future")));
});

test("age is counted in whole days", () => {
  assert.equal(ageInDays("2026-11-22", now), 0);
  assert.equal(ageInDays("2026-10-01", now), 52);
});

test("free-tiers page lists every provider and labels itself as unmeasured", () => {
  const md = freeTiersMarkdown(providers);
  for (const p of providers) assert.ok(md.includes(`[${p.name}](`), `${p.id} missing from page`);
  assert.ok(md.includes("vendor-documented"));
});
