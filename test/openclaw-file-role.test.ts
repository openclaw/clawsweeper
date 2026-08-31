import assert from "node:assert/strict";
import test from "node:test";
import { isOpenClawTestRolePath } from "../dist/openclaw-file-role.js";
import { namedTestRoles, pinnedTestRolePaths } from "./openclaw-file-role-fixture.ts";

test("explicit OpenClaw test roles include all five pinned support fixtures", () => {
  for (const path of pinnedTestRolePaths) assert.equal(isOpenClawTestRolePath(path), true, path);
});

test("test and support code leaves accept the existing code extension family", () => {
  for (const prefix of ["", "c", "m"]) {
    for (const language of ["j", "t"]) {
      for (const jsx of ["", "x"]) {
        const extension = `${prefix}${language}s${jsx}`;
        for (const role of ["test", "spec", ...namedTestRoles]) {
          const leaves = [role, `schema.${role}`];
          if (namedTestRoles.includes(role as (typeof namedTestRoles)[number])) {
            leaves.push(`schema-${role}`);
          }
          for (const leaf of leaves) {
            for (const root of ["", "src/config/"]) {
              const path = `${root}${leaf}.${extension}`;
              assert.equal(isOpenClawTestRolePath(path), true, path);
            }
          }
        }
      }
    }
  }
  for (const path of ["src/schema.e2e.test.ts", "src/schema.live.test.ts"]) {
    assert.equal(isOpenClawTestRolePath(path), true, path);
  }
});

test("explicit test directories retain non-code assets at root and nested boundaries", () => {
  for (const directory of ["test", "tests", "__tests__", ...namedTestRoles]) {
    for (const root of ["", "src/config/"]) {
      for (const leaf of ["schema.ts", "nested/fixture.json", "README.md"]) {
        const path = `${root}${directory}/${leaf}`;
        assert.equal(isOpenClawTestRolePath(path), true, path);
      }
    }
  }
});

test("generic names and nonterminal test roles do not establish a test role", () => {
  for (const role of ["support", "helper", "helpers", "harness", "fixture", "fixtures", "utils"]) {
    for (const path of [`src/config/schema.${role}.ts`, `src/${role}/schema.ts`]) {
      assert.equal(isOpenClawTestRolePath(path), false, path);
    }
  }
  for (const role of namedTestRoles) {
    for (const path of [
      `src/config/schema.${role}.production.ts`,
      `src/config/schema.${role}ive.ts`,
      `src/config/schema${role}.ts`,
      `src/config/schema.${role}.md`,
      `src/config/schema.${role}.json`,
      `src/config/${role}-production/schema.ts`,
    ])
      assert.equal(isOpenClawTestRolePath(path), false, path);
  }
  for (const path of [
    "src/config/schema.TEST.ts",
    "src/config/schema.test.TS",
    "src/TESTS/schema.ts",
    "src/config/schema.test-support.ts ",
    "src\\test-support\\schema.ts",
    "src/config/schema.test.py",
    "src/config/schema.spec.md",
    "src/config/schema.test.ts/production.ts",
    "src/config/schema.test-support.ts/production.ts",
    "src/contest/schema.ts",
    "src/spec/schema.ts",
    "scripts/check-probe.ts",
    "scripts/check-client.ts",
    "scripts/check-harness.ts",
    "scripts/e2e/check.ts",
    "src/schema.suite.ts",
    "src/schema.e2e.ts",
    "src/schema.e2e-harness.ts",
  ])
    assert.equal(isOpenClawTestRolePath(path), false, path);
});
