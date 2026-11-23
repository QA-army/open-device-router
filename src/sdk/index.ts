// Public SDK. `import { allocate } from "opendevicerouter"`.
export { allocate, withSession, sweep, OdrSession, RouteRefusedError, SessionError } from "../session/session.js";
export type { AllocateOptions, SweepResult } from "../session/session.js";
export type { Receipt, Outcome } from "../session/receipt.js";
export { RECEIPT_SCHEMA } from "../session/receipt.js";
export type { BuildSource, DeviceIdentity, Screenshot, Point, ClosureResult } from "../session/types.js";
export { route, resolveSurface, matchProfile, osMatches, TYPE_ORDER } from "../core/router.js";
export type { RouteRequest, Decision, Candidate, SkipReason, SpendPolicy } from "../core/router.js";
export type { Provider, DeviceProfile, Control, Input, Key, BuildFormat, Platform, DeviceKind } from "../core/types.js";
export { loadRegistry } from "../registry/load.js";
export { reconcile } from "../session/reconcile.js";
export { VERSION } from "../version.js";
export { attach } from "./attach.js";
export type { SessionLike, SessionFile } from "./attach.js";
export { midsceneInterface } from "./midscene.js";
export { serveSession } from "../session/serve.js";
export { decodePng, isUsableFrame, frameProblem, frameDifference } from "../session/png.js";
