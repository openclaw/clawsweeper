import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";

import {
  sourceSparseCheckoutEntries,
  SPARSE_REPAIR_BUILD_WORKFLOWS,
} from "./workflow-sparse-checkout-helpers.ts";

const repoRoot = process.cwd();

test("sparse repair workflows install and build in isolation", { timeout: 600_000 }, async (t) => {
  for (const workflowPath of SPARSE_REPAIR_BUILD_WORKFLOWS) {
    await t.test(workflowPath, { timeout: 180_000 }, () => {
      const checkoutRoot = mkdtempSync(join(tmpdir(), "clawsweeper-sparse-repair-"));
      try {
        materializeSparseCheckout(workflowPath, checkoutRoot);
        runPnpm(["install", "--frozen-lockfile"], checkoutRoot, workflowPath);
        runPnpm(["run", "build:repair"], checkoutRoot, workflowPath);
      } finally {
        rmSync(checkoutRoot, { recursive: true, force: true });
      }
    });
  }
});

function materializeSparseCheckout(workflowPath: string, checkoutRoot: string): void {
  for (const entry of sourceSparseCheckoutEntries(workflowPath)) {
    assert.ok(!entry.includes("${{"), `${workflowPath} has a dynamic source checkout entry`);
    const sourcePath = resolve(repoRoot, entry);
    assert.ok(
      sourcePath.startsWith(`${repoRoot}${sep}`),
      `${workflowPath} checkout entry escapes the repository: ${entry}`,
    );
    // Source sparse lists also name generated state paths such as jobs/results. A clean PR
    // checkout legitimately lacks them, and git sparse-checkout treats those patterns as empty.
    if (!existsSync(sourcePath)) continue;

    const destinationPath = resolve(checkoutRoot, entry);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, { recursive: true });
  }
}

function runPnpm(args: string[], cwd: string, workflowPath: string): void {
  const result = spawnSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    timeout: 180_000,
  });
  assert.equal(
    result.status,
    0,
    [`${workflowPath}: pnpm ${args.join(" ")} failed`, result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n"),
  );
}
