import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mockGhBinEnv } from "../helpers.ts";

const JOB = [
  "---",
  "repo: openclaw/openclaw",
  "cluster_id: self-heal-mode",
  "mode: autonomous",
  "allowed_actions:",
  "  - comment",
  "candidates:",
  "  - '#1'",
  "---",
  "",
].join("\n");

test("self-heal retries keep the snapshot mode and default to plan without one", () => {
  // The CLI reads jobs and run records below the repository root of its dist tree.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-self-heal-"));
  const now = new Date().toISOString();
  try {
    for (const name of ["config", "dist", "node_modules"]) {
      fs.symlinkSync(path.resolve(name), path.join(root, name), "dir");
    }
    fs.mkdirSync(path.join(root, "jobs/openclaw/inbox"), { recursive: true });
    fs.mkdirSync(path.join(root, "results/runs"), { recursive: true });
    for (const name of ["live", "snapshot"]) {
      fs.writeFileSync(path.join(root, `jobs/openclaw/inbox/${name}.md`), JOB);
    }
    fs.writeFileSync(
      path.join(root, "results/runs/snapshot.json"),
      JSON.stringify({
        effective_mode: "execute",
        run_id: "20",
        source_job: "jobs/openclaw/inbox/snapshot.md",
        workflow_conclusion: "failure",
        workflow_updated_at: now,
      }),
    );
    const gh = path.join(root, "gh.mjs");
    const runs = [
      {
        conclusion: "failure",
        databaseId: 10,
        displayTitle: "repair jobs/openclaw/inbox/live.md",
        updatedAt: now,
        workflowName: "repair cluster worker",
      },
    ];
    fs.writeFileSync(gh, `process.stdout.write(${JSON.stringify(JSON.stringify(runs))});\n`);

    const result = spawnSync(
      process.execPath,
      [
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        path.join(root, "dist/repair/self-heal-failed-runs.js"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, ...mockGhBinEnv(gh), CLAWSWEEPER_REPO: "openclaw/clawsweeper" },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout) as {
      candidates: Array<{ mode: string; source_job: string }>;
      status: string;
    };
    assert.equal(summary.status, "dry_run");
    assert.deepEqual(
      summary.candidates.map(({ mode, source_job }) => [source_job, mode]),
      [
        ["jobs/openclaw/inbox/snapshot.md", "execute"],
        ["jobs/openclaw/inbox/live.md", "plan"],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
