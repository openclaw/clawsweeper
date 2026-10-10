import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const previousRun = "https://github.com/openclaw/clawsweeper/actions/runs/29091427650";
const currentRun = "https://github.com/openclaw/clawsweeper/actions/runs/29091585991";

// The status CLI writes under the repository root of its dist build. Link the built
// dist into a private root so each run reads and writes only its own status file.
function runStatus(previous: Record<string, unknown> | null, args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-sweep-status-"));
  try {
    for (const entry of ["dist", "node_modules", "config"]) {
      symlinkSync(join(process.cwd(), entry), join(root, entry), "dir");
    }
    const statusPath = join(root, "results", "sweep-status", "openclaw-openclaw.json");
    if (previous) {
      mkdirSync(join(root, "results", "sweep-status"), { recursive: true });
      writeFileSync(statusPath, JSON.stringify(previous));
    }
    const result = spawnSync(
      process.execPath,
      [
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        join(root, "dist", "clawsweeper.js"),
        "status",
        "--target-repo",
        "openclaw/openclaw",
        "--detail",
        "fixture",
        ...args,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    return { apply: status.apply_health, lastClose: status.last_close_apply_health };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("sweep status keeps the retained apply health and its run URL when no health is given", () => {
  const retained = { mode: "close", run_url: previousRun };
  assert.deepEqual(
    runStatus({ apply_health: retained }, ["--state", "Review running", "--run-url", currentRun]),
    { apply: retained, lastClose: retained },
  );
});

test("sweep status stamps the current run URL on new apply health", () => {
  assert.deepEqual(
    runStatus(null, [
      "--state",
      "Apply complete",
      "--run-url",
      previousRun,
      "--apply-health-json",
      '{"mode":"close"}',
    ]),
    {
      apply: { mode: "close", run_url: previousRun },
      lastClose: { mode: "close", run_url: previousRun },
    },
  );
});

test("an apply status update without health clears stale apply health but keeps the last close", () => {
  const close = { mode: "close", run_url: previousRun };
  assert.deepEqual(runStatus({ apply_health: close }, ["--state", "Apply started"]), {
    apply: null,
    lastClose: close,
  });
});

test("non-close apply health keeps the previous last close health", () => {
  const close = { mode: "close", run_url: previousRun };
  assert.deepEqual(
    runStatus({ apply_health: { mode: "prune" }, last_close_apply_health: close }, [
      "--state",
      "Apply complete",
      "--apply-health-json",
      '{"mode":"comments"}',
    ]),
    { apply: { mode: "comments" }, lastClose: close },
  );
});
