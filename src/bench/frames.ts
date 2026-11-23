import { decodePng, frameDifference, frameProblem } from "../session/png.js";

/**
 * The fixture apps fill the screen with HSV(taps * 67 mod 360, 0.8, 0.6) and draw white text.
 * Before any tap that is roughly rgb(153, 31, 31). After one tap the hue moves 67 degrees.
 */
export const FIXTURE_START_RGB: [number, number, number] = [153, 31, 31];
const TOLERANCE = 48;

/** Share of a 32x32 grid of pixels within tolerance of `rgb`. 0 when the frame cannot be decoded. */
export function colourShare(png: Buffer, rgb: [number, number, number]): number {
  let f;
  try {
    f = decodePng(png);
  } catch {
    return 0;
  }
  let hit = 0;
  for (let gy = 0; gy < 32; gy += 1) {
    for (let gx = 0; gx < 32; gx += 1) {
      const c = f.rgb(Math.floor(((gx + 0.5) * f.width) / 32), Math.floor(((gy + 0.5) * f.height) / 32));
      if (Math.abs(c[0] - rgb[0]) <= TOLERANCE && Math.abs(c[1] - rgb[1]) <= TOLERANCE && Math.abs(c[2] - rgb[2]) <= TOLERANCE) hit += 1;
    }
  }
  return hit / 1024;
}

/** Share of a 32x32 grid where red clearly dominates green and blue (robust to sRGB vs Display P3). */
export function redShare(png: Buffer): number {
  let f;
  try {
    f = decodePng(png);
  } catch {
    return 0;
  }
  let hit = 0;
  for (let gy = 0; gy < 32; gy += 1) {
    for (let gx = 0; gx < 32; gx += 1) {
      const [r, g, b] = f.rgb(Math.floor(((gx + 0.5) * f.width) / 32), Math.floor(((gy + 0.5) * f.height) / 32));
      if (r >= 90 && r - g >= 60 && r - b >= 60) hit += 1;
    }
  }
  return hit / 1024;
}

/** The fixture's first frame (taps 0, red) covers at least half the screen. */
export function isFixtureFirstFrame(png: Buffer): boolean {
  return frameProblem(png) === undefined && redShare(png) >= 0.5;
}

/** After one tap the fixture's hue moves 67 degrees, so the red share collapses. */
export function isFixtureTapped(png: Buffer): boolean {
  return frameProblem(png) === undefined && redShare(png) < 0.2;
}

/** For any app: usable, and different enough from what was on screen before launch. */
export function isAppFrame(png: Buffer, beforeLaunch: Buffer | undefined, threshold = 0.2): boolean {
  if (frameProblem(png) !== undefined) return false;
  if (!beforeLaunch) return true;
  try {
    return frameDifference(beforeLaunch, png) >= threshold;
  } catch {
    return true;
  }
}

/** A tap changed the frame: at least 20% of sampled pixels differ. */
export function frameChanged(before: Buffer, after: Buffer, threshold = 0.2): boolean {
  try {
    return frameDifference(before, after) >= threshold;
  } catch {
    return false;
  }
}
