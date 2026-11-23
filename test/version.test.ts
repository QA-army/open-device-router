import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { VERSION } from "../src/version.js";

test("src/version.ts matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});
