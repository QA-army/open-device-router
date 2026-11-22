import type { Provider, Surface } from "../core/types.js";

// Thin adapter. odr does not implement taps, swipes or snapshots: agent-device does
// (https://github.com/callstack/agent-device). This file only turns a routing decision
// into the agent-device invocation for the chosen provider. It does not spawn anything.

export interface HandsPlan {
  kind: Provider["hands"]["kind"];
  /** Things the machine needs before the commands work. */
  requires: string[];
  /** Variables that must be set. Names only; odr never reads their values. */
  envRequired: string[];
  envMissing: string[];
  commands: string[];
  notes: string[];
}

export interface HandsOptions {
  surface: Surface;
  session: string;
  /** Bundle identifier or package name of the app under test. */
  app?: string;
  env?: NodeJS.ProcessEnv;
}

export function platformFor(surface: Surface): "ios" | "android" | "web" {
  if (surface === "ios-simulator" || surface === "ios-real") return "ios";
  if (surface === "android-emulator" || surface === "android-real") return "android";
  return "web";
}

export function planHands(p: Provider, opts: HandsOptions): HandsPlan {
  const env = opts.env ?? process.env;
  const hands = p.hands;
  const notes = hands.notes ? [hands.notes] : [];
  if (hands.source) notes.push(`App install and provider-specific steps: ${hands.source}`);

  if (hands.kind !== "agent-device") {
    return {
      kind: hands.kind,
      requires: hands.requires ?? [],
      envRequired: [],
      envMissing: [],
      commands: [],
      notes: [
        ...notes,
        hands.kind === "unknown"
          ? "No verified control path for this provider yet."
          : `Pass-through (${hands.kind}): point your existing test client at the provider endpoint. The odr proxy is not implemented; see ROADMAP.md.`,
      ],
    };
  }

  const platform = platformFor(opts.surface);
  const app = opts.app ?? "<bundle-id-or-package>";
  const envRequired = hands.env ?? [];
  const requires = ["agent-device (Node.js 22.12 or newer)", ...(hands.requires ?? [])];
  if (platform === "web") requires.push("Node.js 24 or newer for agent-device web targets");
  const commands: string[] = [];

  if (hands.provider_id) {
    if (hands.plugin) commands.push(`agent-device plugins add ${hands.plugin}`);
    commands.push(`export AGENT_DEVICE_SESSION=${opts.session}`);
    commands.push(
      ["agent-device connect", hands.provider_id, "--platform", platform, ...(hands.connect_args ?? [])].join(" "),
    );
    commands.push(`agent-device open ${app}`);
  } else {
    commands.push(`export AGENT_DEVICE_SESSION=${opts.session}`);
    commands.push(`agent-device open ${app} --platform ${platform}`);
  }
  commands.push("agent-device snapshot -i");
  commands.push("agent-device close");
  if (hands.provider_id) commands.push("agent-device disconnect");

  return {
    kind: hands.kind,
    requires,
    envRequired,
    envMissing: envRequired.filter((name) => !env[name]),
    commands,
    notes,
  };
}
