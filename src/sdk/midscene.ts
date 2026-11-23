import type { SessionLike } from "./attach.js";
import type { Key } from "../core/types.js";

// Midscene custom interface over an odr session, so Midscene's agent can drive any routed device.
// https://midscenejs.com/integrate-with-any-interface.html
// @midscene/core is an optional peer dependency; pass its `/device` module in, or it is imported.

/* eslint-disable @typescript-eslint/no-explicit-any */
type DeviceHelpers = {
  defineActionTap: (fn: (p: { x: number; y: number }, o?: { duration?: number }) => Promise<void>) => any;
  defineActionInput: (k: { keyboardPress: (key: string) => Promise<void>; typeText: (v: string) => Promise<void> }) => any;
  defineActionKeyboardPress: (fn: (key: string) => Promise<void>) => any;
  defineActionSwipe: (c: { swipe: (a: { x: number; y: number }, b: { x: number; y: number }, o?: { duration?: number; repeat?: number }) => Promise<void>; size: () => Promise<{ width: number; height: number }>; inputMode?: "touch" }) => any;
};

const KEY_NAMES: Record<string, Key> = {
  enter: "enter",
  return: "enter",
  backspace: "backspace",
  delete: "backspace",
  tab: "tab",
  home: "home",
  back: "back",
};

export interface OdrMidsceneInterface {
  interfaceType: string;
  screenshotBase64(): Promise<string>;
  size(): Promise<{ width: number; height: number }>;
  actionSpace(): any[];
  describe(): string;
  destroy(): Promise<void>;
}

export async function midsceneInterface(
  session: SessionLike,
  opts: { device?: DeviceHelpers; releaseOnDestroy?: boolean } = {},
): Promise<OdrMidsceneInterface> {
  const d: DeviceHelpers = opts.device ?? ((await import("@midscene/core/device" as string)) as DeviceHelpers);
  const key = async (name: string) => {
    const k = KEY_NAMES[name.toLowerCase()];
    if (!k) throw new Error(`odr: key "${name}" is not supported on ${session.provider}`);
    await session.key(k);
  };
  const size = () => session.size();
  const actions = [
    d.defineActionTap(async (p, o) => session.tap(p.x, p.y, o?.duration ? { durationMs: o.duration } : undefined)),
    d.defineActionInput({ keyboardPress: key, typeText: (v) => session.type(v) }),
    d.defineActionKeyboardPress(key),
    d.defineActionSwipe({
      swipe: async (a, b, o) => {
        for (let i = 0; i < Math.max(1, o?.repeat ?? 1); i++) await session.swipe(a, b, o?.duration ? { durationMs: o.duration } : undefined);
      },
      size,
      inputMode: "touch",
    }),
  ];
  return {
    interfaceType: `odr-${session.provider}`,
    async screenshotBase64() {
      const shot = await session.screenshot();
      return `data:image/png;base64,${shot.png.toString("base64")}`;
    },
    size,
    actionSpace: () => actions,
    describe: () => `${session.device?.model ?? session.profile.model} on ${session.provider} (odr ${session.id})`,
    async destroy() {
      if (opts.releaseOnDestroy !== false) await session.release?.();
    },
  };
}
