import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishClusterIntake } from "../../dist/repair/publish-cluster-intake.js";

test("cluster intake publication writes git-only operational state directly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-publish-"));
  const intentPath = path.join(root, "intent.json");
  fs.writeFileSync(
    intentPath,
    JSON.stringify({
      schema: "clawsweeper-cluster-intake-intent-v1",
      target_repo: "openclaw/openclaw",
      repo_slug: "openclaw-openclaw",
      store_sha256: "a".repeat(64),
      store_exported_at: "2026-07-26T12:00:00.000Z",
      manifest_path: "artifacts/gitcrawl-clusters.json",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
      accepted_at: "2026-07-26T12:01:00.000Z",
      runner: "codex",
      execution_runner: "ubuntu-latest",
      model: "internal",
      selector_summary: { evaluated: 1, rejected: 1, reason_counts: { stale: 1 } },
      jobs: [],
    }),
  );
  const publishes: string[][] = [];

  try {
    const options = {
      env: {
        CLAWSWEEPER_WEBHOOK_SECRET: "publish-cluster-test-secret",
      },
      root,
      publishGit: (input: { paths: readonly string[] }) => {
        publishes.push([...input.paths]);
        return "committed" as const;
      },
    };
    assert.deepEqual(await publishClusterIntake(intentPath, options), {
      deduped: false,
      pending: false,
    });
    assert.deepEqual(await publishClusterIntake(intentPath, options), {
      deduped: true,
      pending: false,
    });
    assert.equal(publishes.length, 2);
    assert.deepEqual(publishes[0], ["results/cluster-repair-intake/openclaw-openclaw.json"]);
    assert.equal(
      fs.existsSync(path.join(root, "results/cluster-repair-intake/openclaw-openclaw.json")),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI ignores the pnpm-forwarded -- separator instead of reading it as a path", () => {
  // `pnpm run repair:publish-cluster-intake -- <intent>` forwards the literal
  // `--` on the hosted runner (live proof run 30303202343 failed with
  // ENOENT '.../--'); the CLI must use the first real positional.
  const result = spawnSync(process.execPath, ["dist/repair/publish-cluster-intake.js", "--"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: publish-cluster-intake/);
});
