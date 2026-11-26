import type { ClosureResult, Driver, DriverModule, Locator } from "../types.js";

// Providers without a verified session driver. allocate refuses before any provider call.
// Onboarding still lists them so a person can sign up; odr run will not start a session.

const MESSAGE = "session driver is not built. odr will not start this provider. Use `odr onboard` to record the account, then a provider odr can drive.";

function create(providerId = "stub"): Driver {
  let id = providerId;
  return {
    name: "stub",
    async prepareBuild(_build, ctx) {
      id = ctx.provider.id;
      throw Object.assign(new Error(`${id}: ${MESSAGE}`), { code: "adapter_stub" });
    },
    async allocate(ctx) {
      id = ctx.provider.id;
      ctx.onLocator({ driver: "stub", provider: id });
      throw Object.assign(new Error(`${id}: ${MESSAGE}`), { code: "adapter_stub" });
    },
    async install() {
      throw Object.assign(new Error(MESSAGE), { code: "adapter_stub" });
    },
    async launch() {
      throw Object.assign(new Error(MESSAGE), { code: "adapter_stub" });
    },
    async screenshot() {
      throw Object.assign(new Error(MESSAGE), { code: "adapter_stub" });
    },
    async tap() {
      throw Object.assign(new Error(MESSAGE), { code: "adapter_stub" });
    },
    async type() {
      throw Object.assign(new Error(MESSAGE), { code: "adapter_stub" });
    },
    async swipe() {
      throw Object.assign(new Error(MESSAGE), { code: "adapter_stub" });
    },
    async key() {
      throw Object.assign(new Error(MESSAGE), { code: "adapter_stub" });
    },
    async heartbeat() {},
    async release() {},
    async verifyClosed(): Promise<ClosureResult> {
      return { status: "verified", method: "none", detail: `${id} stub never started a session` };
    },
    handle: () => ({}),
  };
}

async function sweep(locator: Locator): Promise<ClosureResult> {
  return { status: "verified", method: "none", detail: `${String(locator.provider ?? "stub")} stub has nothing to stop` };
}

export const stubDriver: DriverModule = { create: () => create(), sweep };
