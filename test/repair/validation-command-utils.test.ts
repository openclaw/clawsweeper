import assert from "node:assert/strict";
import test from "node:test";

import {
  packageScriptRequirement,
  parseAllowedValidationCommand,
} from "../../dist/repair/validation-command-utils.js";

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

test("workspace option values retain their meaning before and after run", () => {
  for (const [manager, option] of [
    ["pnpm", "--filter"],
    ["npm", "--workspace"],
    ["bun", "--filter"],
  ]) {
    for (const value of ["false", "app", "@example/app"]) {
      for (const tokens of [[option, value], [`${option}=${value}`]]) {
        const commands = [
          [manager, ...tokens, "run", "check"],
          [manager, "run", ...tokens, "check"],
          ...(manager === "npm" ? [[manager, "run", "check", ...tokens]] : []),
        ];
        for (const parts of commands) {
          assert.deepEqual(parseAllowedValidationCommand(parts.join(" ")), parts);
          const requirement = packageScriptRequirement(parts);
          assert.equal(requirement?.name, "check");
          assert.equal(requirement?.workspaceAll, false);
          assert.deepEqual(requirement?.workspaceSelectors, [value]);
        }
      }
    }
  }
});

test("package option parsing rejects missing values and invalid booleans in every option position", () => {
  for (const command of [
    "pnpm --filter= run check",
    "pnpm --filter --silent run check",
    "pnpm run --filter",
    "pnpm run --filter= check",
    "pnpm --recursive=maybe check",
    "pnpm run --recursive=maybe check",
    "npm --workspace= run check",
    "npm run --workspace -- check",
    "npm run check --workspace",
    "npm run check --workspace=",
    "npm --workspaces=maybe run check",
    "npm run --workspaces=maybe check",
    "npm run check --workspaces=maybe",
    "bun --filter= run check",
    "bun run --filter -- check",
  ]) {
    assert.throws(
      () => parseAllowedValidationCommand(command),
      /unsafe validation command/,
      command,
    );
  }
});

test("wrapped validators retain mutation checks without rejecting read-only short flags", () => {
  for (const wrapper of ["pnpm exec", "uv run", "bundle exec", "composer exec"]) {
    for (const command of [
      "vitest run -u",
      "jest -u=true",
      "ava -u",
      "cargo fmt",
      "prettier -w file.ts",
    ]) {
      assert.throws(
        () => parseAllowedValidationCommand(`${wrapper} ${command}`),
        /unsafe validation command/,
      );
    }
    for (const command of ["cargo fmt --check", "python -u tests/check.py"]) {
      assert.deepEqual(
        parseAllowedValidationCommand(`${wrapper} ${command}`),
        `${wrapper} ${command}`.split(" "),
      );
    }
  }
});
