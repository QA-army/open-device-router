import { allowanceWindow, odrHome, withLock, type Connection, type Reconciliation } from "../core/ledger.js";
import type { Provider } from "../core/types.js";
import type { DeviceFarmApi } from "./drivers/aws-device-farm-api.js";

function allowanceIndex(provider: Provider, connection: Connection): number {
  const plan = connection.plan ?? undefined;
  const matches = provider.allowances
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => (a.plan ?? undefined) === plan);
  return (matches.find(({ a }) => a.type === "monthly") ?? matches.find(({ a }) => a.type === "one_time" || a.type === "daily"))?.i ?? -1;
}

/**
 * Pulls the provider's own usage figure and records it. If the provider reports more than odr
 * measured (a dashboard, another machine, or a lost worker), the difference is added to the ledger
 * so free-only routing stops earlier, never later. AWS Device Farm sums metered device minutes
 * across every project; if that sum cannot be completed the call throws and nothing is recorded.
 */
export async function reconcile(
  provider: Provider,
  opts: { home?: string; env?: NodeJS.ProcessEnv; now?: Date; deviceFarm?: DeviceFarmApi } = {},
): Promise<Reconciliation & { added_minutes: number }> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? odrHome(env);
  const now = opts.now ?? new Date();
  const month = now.toISOString().slice(0, 7);
  let providerMinutes: number;
  let period = month;
  if (provider.id === "appetize") {
    const { appetizeUsage } = await import("./drivers/appetize.js");
    providerMinutes = await appetizeUsage(env, month);
  } else if (provider.id === "aws-device-farm") {
    const { createDeviceFarmCli, meteredDeviceMinutes } = await import("./drivers/aws-device-farm-api.js");
    providerMinutes = await meteredDeviceMinutes(opts.deviceFarm ?? createDeviceFarmCli(env));
    period = "one_time";
  } else {
    throw Object.assign(new Error(`${provider.id} has no usage API odr can read; free-only routing treats its remaining allowance as an estimate`), {
      code: "no_usage_api",
    });
  }
  return withLock(home, (state) => {
    const connection = state.connections[provider.id];
    if (!connection) throw new Error(`${provider.id} is not connected`);
    const index = allowanceIndex(provider, connection);
    const window = index >= 0 ? allowanceWindow(provider.allowances[index]!, connection, now) : undefined;
    const local = state.usage
      .filter((u) => {
        if (u.provider !== provider.id) return false;
        const t = Date.parse(u.at);
        if (!window) return t >= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
        if (t < window.start.getTime()) return false;
        return !(window.end && t >= window.end.getTime());
      })
      .reduce((s, u) => s + u.minutes, 0);
    const added = Math.max(0, Math.round((providerMinutes - local) * 100) / 100);
    if (added > 0 && index >= 0) {
      state.usage.push({
        provider: provider.id,
        allowance: index,
        amount: added,
        minutes: added,
        surface: provider.surfaces[0]!,
        at: now.toISOString(),
        source: "provider",
        note: `reconcile ${period}: provider reported ${providerMinutes} min, odr had ${local}`,
      });
    }
    const rec: Reconciliation = { provider: provider.id, at: now.toISOString(), period, provider_minutes: providerMinutes, local_minutes: local };
    state.reconciliations.push(rec);
    return { ...rec, added_minutes: added };
  });
}
