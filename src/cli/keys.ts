import type { Provider } from "../core/types.js";

// One place an agent or a person reads to get every key odr can use. Generated from the registry.

export function envNames(p: Provider): string[] {
  return [...new Set([...(p.hands.env ?? []), ...(p.credentials.env ?? [])])];
}

export function keySteps(p: Provider): string[] {
  const out: string[] = [];
  const names = envNames(p);
  if (!p.signup.required && p.credentials.acquire === "none") {
    out.push("No account or key needed.");
    return out;
  }
  if (p.signup.url) out.push(`Sign up yourself (a person must accept the terms): ${p.signup.url}`);
  if (p.signup.human_steps?.length) out.push(`Steps only a person can do: ${p.signup.human_steps.join(", ")}`);
  if (p.credentials.login_command) out.push(`Log in from a terminal: \`${p.credentials.login_command}\``);
  if (p.credentials.location) out.push(`Copy the key from: ${p.credentials.location}`);
  if (names.length) {
    out.push(`Set it locally: ${names.map((n) => `\`export ${n}=...\``).join(" ")}`);
    out.push(`Set it for GitHub Actions: ${names.map((n) => `\`gh secret set ${n}\``).join(" ")}`);
  }
  out.push(`Record the connection: \`odr connect ${p.id} --done\``);
  return out;
}

export function keysMarkdown(providers: Provider[]): string {
  const launch = providers.filter((p) => p.status === "launch" || p.id === "local");
  const lines = [
    "# Keys",
    "",
    "Generated from `registry/providers/*.yaml` by `npm run docs:keys`. Do not edit by hand.",
    "",
    "odr never creates accounts and never stores keys. Each key lives in your shell or your CI secret store.",
    "A person signs up and accepts each provider's terms; an agent can do everything after that.",
    "",
    "Fastest path: `odr keys` prints this for the providers you have not connected yet, and `odr doctor` tells you what is missing.",
    "",
    "| Provider | Env vars | Free allowance (vendor-documented) | Card | Get a key |",
    "|---|---|---|---|---|",
  ];
  for (const p of launch) {
    const allowance = p.allowances.filter((a) => !a.plan).map((a) => (a.unit === "unlimited" ? "unlimited" : `${a.amount} ${a.unit} ${a.type}`)).join("; ") || "-";
    lines.push(`| ${p.name} | ${envNames(p).map((n) => `\`${n}\``).join(", ") || "none"} | ${allowance} | ${p.signup.card_required === true ? "yes" : p.signup.card_required === false ? "no" : "unknown"} | ${p.signup.url ? `[sign up](${p.signup.url})` : "-"} |`);
  }
  for (const p of launch) {
    lines.push("", `## ${p.name}`, "");
    for (const s of keySteps(p)) lines.push(`- ${s}`);
    if (p.credentials.notes) lines.push(`- Note: ${p.credentials.notes}`);
    if (p.credentials.source) lines.push(`- Source: ${p.credentials.source}`);
  }
  lines.push("", "Other providers in the registry have no session driver yet. See `odr providers`.", "");
  return lines.join("\n");
}
