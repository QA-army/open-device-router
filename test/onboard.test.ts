import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyState } from "../src/core/ledger.js";
import { loadRegistry } from "../src/registry/load.js";
import { EXCLUDED, adapterOf, credentialStatus, freeMinuteSummary, nextUnconnected, onboardingCatalog } from "../src/onboarding/catalog.js";

const { providers } = loadRegistry();

test("onboarding lists every registry provider, launch targets first, and marks stubs", () => {
  const catalog = onboardingCatalog(providers);
  assert.equal(catalog.length, providers.length);
  assert.deepEqual(catalog.slice(0, 6).map((e) => e.id), ["local", "github-actions", "appetize", "revyl", "limrun", "aws-device-farm"]);
  assert.equal(catalog.find((e) => e.id === "aws-device-farm")?.adapter, "built");
  assert.equal(catalog.find((e) => e.id === "browserstack")?.adapter, "stub");
  assert.equal(catalog.find((e) => e.id === "kobiton")?.adapter, "stub");
  assert.equal(catalog.find((e) => e.id === "mobilerun")?.adapter, "stub");
  assert.equal(catalog.find((e) => e.id === "run-cloud")?.adapter, "stub");
  assert.equal(adapterOf(providers.find((p) => p.id === "local")!), "built");
  const kobiton = catalog.find((e) => e.id === "kobiton")!;
  assert.equal(kobiton.signup_url, "https://portal.kobiton.com/register");
  assert.ok(kobiton.allowances.some((a) => a.amount === 300));
  assert.equal(EXCLUDED[0]?.id, "firebase-test-lab");
  assert.equal(catalog.some((e) => e.id === "firebase-test-lab"), false);
});

test("next skips providers that are already connected", () => {
  const state = emptyState();
  state.connections.local = { connected_at: "2026-11-01T00:00:00.000Z" };
  state.connections["github-actions"] = { connected_at: "2026-11-01T00:00:00.000Z" };
  assert.equal(nextUnconnected(providers, state)?.id, "appetize");
});

test("credential check reports names only", () => {
  const aws = providers.find((p) => p.id === "aws-device-farm")!;
  const missing = credentialStatus(aws, {});
  assert.equal(missing.ready, false);
  assert.ok(missing.missing.includes("AWS_DEVICE_FARM_PROJECT_ARN"));
  const ready = credentialStatus(aws, {
    AWS_PROFILE: "dev",
    AWS_DEVICE_FARM_PROJECT_ARN: "arn:aws:devicefarm:us-west-2:000000000000:project:abc",
    AWS_SECRET_ACCESS_KEY: "do-not-print",
  });
  assert.equal(ready.ready, true);
  assert.equal(JSON.stringify(ready).includes("do-not-print"), false);
  const half = credentialStatus(aws, { AWS_ACCESS_KEY_ID: "AKIA_TEST", AWS_DEVICE_FARM_PROJECT_ARN: "arn" });
  assert.ok(half.missing.includes("AWS_SECRET_ACCESS_KEY"));
  assert.equal(JSON.stringify(half).includes("AKIA_TEST"), false);
});

test("free minute summary adds minute units and leaves credits out of the total", () => {
  const state = emptyState();
  const at = "2026-11-01T00:00:00.000Z";
  state.connections["aws-device-farm"] = { connected_at: at };
  state.connections.revyl = { connected_at: at };
  state.connections.limrun = { connected_at: at };
  state.connections.local = { connected_at: at };
  state.reconciliations.push({ provider: "aws-device-farm", at: "2026-11-26T00:00:00.000Z", period: "one_time", provider_minutes: 100, local_minutes: 0 });
  state.usage.push({ provider: "aws-device-farm", allowance: 0, amount: 100, minutes: 100, surface: "android-real", at: "2026-11-26T00:00:00.000Z", source: "provider" });
  const summary = freeMinuteSummary(providers, state, new Date("2026-11-26T12:00:00.000Z"));
  const aws = summary.rows.find((r) => r.provider === "aws-device-farm");
  assert.equal(aws?.remaining, 900);
  assert.equal(aws?.counted, true);
  assert.ok(summary.unlimited.includes("local"));
  assert.ok(summary.other.some((o) => o.provider === "limrun" && o.unit === "credit"));
  assert.equal(summary.total_metered_minutes, 900 + 1200);
  assert.equal(JSON.stringify(summary).includes("SECRET"), false);
});
