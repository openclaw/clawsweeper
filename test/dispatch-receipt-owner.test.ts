import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

const SCRIPT = join(process.cwd(), "scripts", "dispatch-receipt-owner.sh");
const EXPECTED_TITLE = "Assist openclaw/openclaw#42 [router-proof]";

function fixtureEnv(options: {
  jobs101?: unknown[];
  jobs102?: unknown[];
  runs: unknown[];
  failJobs?: boolean;
}) {
  const binDir = mkdtempSync(join(tmpdir(), "dispatch-receipt-owner-"));
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
case "$*" in
  *actions/workflows/*) printf '%s\\n' "$FAKE_RUNS_JSON" ;;
  *actions/runs/101/jobs*)
    [ "\${FAKE_FAIL_JOBS:-0}" = 1 ] && exit 7
    printf '%s\\n' "$FAKE_JOBS_101_JSON"
    ;;
  *actions/runs/102/jobs*)
    [ "\${FAKE_FAIL_JOBS:-0}" = 1 ] && exit 7
    printf '%s\\n' "$FAKE_JOBS_102_JSON"
    ;;
  *) echo "unexpected gh args: $*" >&2; exit 9 ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  return {
    binDir,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "openclaw/clawsweeper",
      FAKE_RUNS_JSON: JSON.stringify({ workflow_runs: options.runs }),
      FAKE_JOBS_101_JSON: JSON.stringify({ jobs: options.jobs101 ?? [] }),
      FAKE_JOBS_102_JSON: JSON.stringify({ jobs: options.jobs102 ?? [] }),
      FAKE_FAIL_JOBS: options.failJobs ? "1" : "0",
    },
  };
}

function runGate(options: Parameters<typeof fixtureEnv>[0], requiredJobName = "assist") {
  const fixture = fixtureEnv(options);
  try {
    return execFileSync("bash", [SCRIPT, "assist.yml", EXPECTED_TITLE, "200", requiredJobName], {
      encoding: "utf8",
      env: fixture.env,
    }).trim();
  } finally {
    rmSync(fixture.binDir, { recursive: true, force: true });
  }
}

test("dispatch receipt gate keeps an older active run as owner", () => {
  assert.equal(
    runGate({
      runs: [{ id: 101, display_title: EXPECTED_TITLE, status: "in_progress" }],
    }),
    "owner",
  );
});

test("dispatch receipt gate allows retry after failed owner and receipt-only success", () => {
  for (const requiredJobName of ["assist", "Plan and review cluster"]) {
    assert.equal(
      runGate(
        {
          runs: [
            { id: 101, display_title: EXPECTED_TITLE, status: "completed", conclusion: "failure" },
            { id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "success" },
          ],
          jobs102: [
            { name: "Deduplicate command dispatch receipt", conclusion: "success" },
            { name: requiredJobName, conclusion: "skipped" },
          ],
        },
        requiredJobName,
      ),
      "none",
    );
  }
});

test("dispatch receipt gate keeps a successfully executed worker as owner", () => {
  assert.equal(
    runGate({
      runs: [
        { id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "success" },
      ],
      jobs102: [{ name: "assist", conclusion: "success" }],
    }),
    "owner",
  );
});

test("dispatch receipt gate fails closed when worker job verification fails", () => {
  const fixture = fixtureEnv({
    runs: [{ id: 102, display_title: EXPECTED_TITLE, status: "completed", conclusion: "success" }],
    failJobs: true,
  });
  try {
    const result = spawnSync("bash", [SCRIPT, "assist.yml", EXPECTED_TITLE, "200", "assist"], {
      encoding: "utf8",
      env: fixture.env,
    });
    assert.equal(result.status, 7);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(fixture.binDir, { recursive: true, force: true });
  }
});
