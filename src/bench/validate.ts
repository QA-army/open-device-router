import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { summarise, type SimbenchResult } from "./simbench.js";
import { packageRoot } from "./util.js";

let compiled: ReturnType<Ajv["compile"]> | undefined;

/**
 * Schema check plus consistency checks a hand-edited file would fail: the summary must be
 * recomputable from the samples, and ci-verified needs a GitHub Actions run URL in this repo.
 * Passing does not prove a self-reported number is true; it proves the file is internally consistent.
 */
export function validateSimbench(data: unknown): string[] {
  compiled ??= new Ajv({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(join(packageRoot(), "bench", "schema", "simbench.schema.json"), "utf8")));
  if (!compiled(data)) return (compiled.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
  const r = data as SimbenchResult;
  const errors: string[] = [];
  const again = summarise(r.samples);
  if (JSON.stringify(again) !== JSON.stringify(r.summary)) errors.push("summary does not match the samples");
  if (r.tier === "ci-verified" && !/^https:\/\/github\.com\/QA-army\/open-device-router\/actions\/runs\/\d+$/.test(r.harness.run_url ?? "")) {
    errors.push("ci-verified results need a run_url for a QA-army/open-device-router Actions run");
  }
  if (Date.parse(r.finished_at) < Date.parse(r.started_at)) errors.push("finished_at is before started_at");
  for (const s of r.samples) {
    if (s.ok && s.run_to_first_frame_ms === undefined) errors.push(`${s.kind} sample ${s.index} is ok but has no run_to_first_frame_ms`);
    if (!s.ok && !s.error) errors.push(`${s.kind} sample ${s.index} failed without an error`);
  }
  if (r.parallel) {
    for (const l of r.parallel.levels) {
      if (l.ok + l.failed !== l.n || l.devices.length !== l.n) errors.push(`parallel level N=${l.n} does not add up`);
    }
  }
  return errors;
}
