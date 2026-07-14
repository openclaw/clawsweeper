import assert from "node:assert/strict";
import test from "node:test";

import { packageScriptRequirement } from "../../dist/repair/validation-command-utils.js";

test("pnpm built-ins and aliases cannot fall back to same-named package scripts", () => {
  const nonScriptCommands = [
    "dislink",
    "dist-tags",
    "find",
    "home",
    "info",
    "issues",
    "m",
    "multi",
    "owners",
    "pack-app",
    "peers",
    "purge",
    "s",
    "sbom",
    "se",
    "show",
    "ss",
    "stars",
    "undeprecate",
    "uni",
    "v",
    "with",
    "xmas",
  ];

  for (const command of nonScriptCommands) {
    assert.equal(
      packageScriptRequirement(["pnpm", command]),
      null,
      `${command} must retain pnpm built-in behavior`,
    );
  }
});

test("pnpm script aliases resolve before implicit script fallback", () => {
  assert.equal(packageScriptRequirement(["pnpm", "run-script", "check"])?.name, "check");
  for (const script of ["pub", "r", "x"]) {
    assert.equal(packageScriptRequirement(["pnpm", script])?.name, script);
  }
  for (const alias of ["t", "tst"]) {
    assert.equal(packageScriptRequirement(["pnpm", alias])?.name, "test");
  }
  assert.equal(packageScriptRequirement(["npm", "tst"])?.name, "test");
  assert.equal(packageScriptRequirement(["pnpm", "Check"])?.name, "Check");
});
