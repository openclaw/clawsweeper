import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTargetFixture,
  OPENCLAW_SHAPED_CONTRACT,
} from "../e2e/automerge/target-fixtures.mjs";

test("openclaw-shaped automerge fixture preserves production repository contracts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-openclaw-shaped-test-"));
  try {
    const fixture = createTargetFixture(root, { fixture: "openclaw-shaped" });
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(fixture.seed, "package.json"), "utf8"),
    );
    const workspace = fs.readFileSync(path.join(fixture.seed, "pnpm-workspace.yaml"), "utf8");
    const lockfile = fs.readFileSync(path.join(fixture.seed, "pnpm-lock.yaml"), "utf8");

    assert.equal(packageJson.engines.node, OPENCLAW_SHAPED_CONTRACT.node);
    assert.equal(packageJson.packageManager, OPENCLAW_SHAPED_CONTRACT.packageManager);
    assert.deepEqual(Object.keys(packageJson.scripts).sort(), [
      "check:changed",
      "check:test-types",
      "lint",
      "test",
    ]);
    for (const pattern of ["- .", "- ui", "- packages/*", "- extensions/*", "- examples/*"]) {
      assert.match(workspace, new RegExp(escapeRegExp(pattern)));
    }
    assert.match(workspace, /minimumReleaseAge: 2880/);
    assert.match(workspace, /nodeLinker: hoisted/);
    assert.match(workspace, /overrides:/);
    assert.match(workspace, /allowBuilds:/);
    assert.match(lockfile, /version: link:packages\/fixture-core/);
    assert.match(lockfile, /version: link:\.\.\/\.\.\/packages\/fixture-core/);
    assert.equal(fixture.repairTarget, OPENCLAW_SHAPED_CONTRACT.repairTarget);
    assert.deepEqual(fixture.files, [OPENCLAW_SHAPED_CONTRACT.repairTarget]);
    assert.equal(fs.readlinkSync(path.join(fixture.seed, "CLAUDE.md")), "AGENTS.md");
    assert.equal(fixture.behindMain, true);
    assert.notEqual(
      spawnSync(
        "/usr/bin/git",
        [
          "--git-dir",
          fixture.remote,
          "merge-base",
          "--is-ancestor",
          fixture.baseSha,
          fixture.headSha,
        ],
        { stdio: "ignore" },
      ).status,
      0,
      "the contributor head must start behind the latest fixture main",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
