// Child process for the concurrency test: one worker trying to allocate.
import { allocate } from "../../src/session/session.js";
import { fakeDriver } from "./fake-driver.js";
import { loadRegistry } from "../../src/registry/load.js";

const { providers } = loadRegistry();
if (process.env.ODR_TEST_NO_PARALLEL) for (const p of providers) for (const a of p.allowances) delete a.max_parallel;

const log = { calls: [] as string[], released: 0 };
try {
  const s = await allocate(
    { platform: "ios", minutes: 10 },
    { home: process.env.ODR_HOME, providers, drivers: { "agent-device": fakeDriver(log) }, handleSignals: false, heartbeatMs: 60_000 },
  );
  process.stdout.write(`OK ${s.id}\n`);
  process.exit(0);
} catch (error) {
  process.stdout.write(`REFUSED ${(error as { code?: string }).code}\n`);
  process.exit(2);
}
