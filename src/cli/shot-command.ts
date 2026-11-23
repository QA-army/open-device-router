import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runShot, shotMarkdown } from "../bench/shot.js";

export const SHOT_HELP = `odr shot - boot a fresh device, install your app, capture the first frame it draws

  odr shot --platform ios --app path/to/My.app [--bundle-id id] [--runtime 26.0] [--device-type "iPhone 17"]
  odr shot --platform android --apk path/to/app.apk [--package id] [--avd name] [--headless] [--no-tap]
           [--out dir] [--markdown file] [--json]

Writes first-frame.png, a second frame (after-tap.png on Android, settled.png on iOS) and shot.json
with boot, install and launch timings. The first frame is the first screenshot that differs from the
screen before launch. On Android odr taps the centre of the screen and records whether anything
changed. iOS has no tap step: simctl has no input command.

It records what the app drew; it does not decide pass or fail. Exit code is 0 when a frame was
captured and 1 when not.
`;

export async function cmdShot(argv: string[]): Promise<void> {
  if (argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(SHOT_HELP);
    return;
  }
  const { values: v } = parseArgs({
    args: argv,
    options: {
      platform: { type: "string" },
      app: { type: "string" },
      apk: { type: "string" },
      "bundle-id": { type: "string" },
      package: { type: "string" },
      runtime: { type: "string" },
      "device-type": { type: "string" },
      avd: { type: "string" },
      headless: { type: "boolean" },
      "no-tap": { type: "boolean" },
      out: { type: "string" },
      markdown: { type: "string" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  const platform = v.platform ?? (v.apk ? "android" : v.app ? "ios" : undefined);
  if (platform !== "ios" && platform !== "android") throw new Error("pass --platform ios --app <.app> or --platform android --apk <.apk>");
  const app = platform === "ios" ? v.app : v.apk;
  if (!app) throw new Error(platform === "ios" ? "--app <path to .app built for the simulator> is required" : "--apk <path> is required");
  if (!existsSync(app)) throw new Error(`${app} not found`);
  const outDir = resolve(v.out ?? "odr-shot");
  const r = await runShot({
    platform,
    app: resolve(app),
    appId: platform === "ios" ? v["bundle-id"] : v.package,
    runtime: v.runtime,
    deviceType: v["device-type"],
    avd: v.avd,
    headless: v.headless,
    tap: !v["no-tap"],
    outDir,
    log: v.json ? undefined : (l) => process.stderr.write(`${l}\n`),
  });
  if (v.markdown) writeFileSync(v.markdown, `${shotMarkdown(r)}\n`);
  if (v.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (r.ok) {
    const s = (ms?: number | null) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
    process.stdout.write(`first frame ${s(r.timings_ms.launch_to_first_frame)} after launch, ${s(r.timings_ms.run_to_first_frame)} from start\n${outDir}\n`);
  } else process.stdout.write(`no frame captured: ${r.error}\n`);
  if (!r.ok) process.exitCode = 1;
}
