import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The dashboard Worker imports these modules directly and has no Node APIs.
// They must not load Node code at runtime.
const WORKER_LEAF_MODULES = ["src/repair/exact-review-guard-labels.ts", "src/repair/markers.ts"];

for (const file of WORKER_LEAF_MODULES) {
  test(`${file} has no runtime imports`, () => {
    const source = readFileSync(file, "utf8");
    const imports = source.match(/^\s*(?:import|export)\b[^;]*\bfrom\s*["'][^"']+["']/gm) ?? [];
    for (const statement of imports) {
      assert.match(statement, /^\s*(?:import|export)\s+type\b/, `${file}: ${statement}`);
      assert.doesNotMatch(statement, /["']node:/, `${file}: ${statement}`);
    }
    assert.doesNotMatch(source, /^\s*import\s*["']|\brequire\(|\bimport\(/m, file);
  });
}
