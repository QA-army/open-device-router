import { odrHome, withLock, type Reconciliation } from "../core/ledger.js";
import type { Provider } from "../core/types.js";

/**
 * Pulls the provider's own usage figure for this month and records it. If the provider reports more
 * than odr measured (usage from a dashboard, another machine, or a lost worker), the difference is
 * added to the ledger so free-only routing stops earlier, never later.
 */
export async function reconcile(
  provider: Provider,
  opts: { home?: string; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<Reconciliation & { added_minutes: number }> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? odrHome(env);
  const now = opts.now ?? new Date();
  const month = now.toISOString().slice(0, 7);
  let providerMinutes: number;
  if (provider.id === "appetize") {
    const { appetizeUsage } = await import("./drivers/appetize.js");
    providerMinutes = await appetizeUsage(env, month);
  } else {
    throw Object.assign(new Error(`${provider.id} has no usage API odr can read; free-only routing treats its remaining allowance as an estimate`), {
      code: "no_usage_api",
    });
  }
  return withLock(home, (state) => {
    const connection = state.connections[provider.id];
    if (!connection) throw new Error(`${provider.id} is not connected`);
    const index = provider.allowances.findIndex((a) => (a.plan ?? undefined) === (connection.plan ?? undefined) && a.type === "monthly");
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const local = state.usage
      .filter((u) => u.provider === provider.id && Date.parse(u.at) >= start)
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
        note: `reconcile ${month}: provider reported ${providerMinutes} min, odr had ${local}`,
      });
    }
    const rec: Reconciliation = { provider: provider.id, at: now.toISOString(), period: month, provider_minutes: providerMinutes, local_minutes: local };
    state.reconciliations.push(rec);
    return { ...rec, added_minutes: added };
  });
}
