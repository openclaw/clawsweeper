import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveResultTargets } from "../../dist/repair/resolve-result-targets.js";

function artifactsWithResults(repos: readonly string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-result-targets-"));
  for (const [index, repo] of repos.entries()) {
    const runDir = path.join(root, `run-${index}`, `cluster-${index}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "result.json"),
      `${JSON.stringify({ repo, cluster_id: index })}\n`,
    );
  }
  return root;
}

test("result targets resolve to the validated non-default repository from worker artifacts", () => {
  const resolved = resolveResultTargets({
    artifactsDir: artifactsWithResults(["openclaw", "openclaw"].map((o) => `${o}/gitcrawl`)),
    allowedOwner: "openclaw",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(resolved, { owner: "openclaw", repositories: ["gitcrawl"] });
});

test("result targets dedupe and sort multiple allowed repositories", () => {
  const resolved = resolveResultTargets({
    artifactsDir: artifactsWithResults(["openclaw/zebra", "openclaw/alpha", "openclaw/zebra"]),
    allowedOwner: "openclaw",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(resolved.repositories, ["alpha", "zebra"]);
});

test("result targets fall back to the configured default when artifacts carry no result", () => {
  const resolved = resolveResultTargets({
    artifactsDir: artifactsWithResults([]),
    allowedOwner: "openclaw",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(resolved, { owner: "openclaw", repositories: ["openclaw"] });
});

test("result targets fail closed on a repository outside the allowed owner", () => {
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults(["evil/openclaw"]),
        allowedOwner: "openclaw",
        fallbackRepo: "openclaw/openclaw",
      }),
    /outside openclaw/,
  );
});

test("result targets fail closed on malformed repository identities", () => {
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults(["unknown/unknown/extra"]),
        allowedOwner: "openclaw",
        fallbackRepo: "openclaw/openclaw",
      }),
    /invalid target repository/,
  );
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults([]),
        allowedOwner: "openclaw",
        fallbackRepo: "elsewhere/openclaw",
      }),
    /must be owned by openclaw/,
  );
});

test("result publication mints its reader token from resolved targets, not a fixed repository", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-publish-results.yml", "utf8");
  assert.match(workflow, /repair:resolve-result-targets/);
  assert.match(workflow, /owner: \$\{\{ steps\.result-targets\.outputs\.owner \}\}/);
  assert.match(workflow, /repositories: \$\{\{ steps\.result-targets\.outputs\.repositories \}\}/);
  const resolveIndex = workflow.indexOf("- name: Resolve result target repositories");
  const downloadIndex = workflow.indexOf("- name: Download worker artifacts");
  const mintIndex = workflow.indexOf("- name: Create target read token");
  assert.ok(downloadIndex >= 0 && resolveIndex > downloadIndex && mintIndex > resolveIndex);
  // The ClawSweeper app token needs read access only; state publication uses
  // the state credential, and the target reader is minted per validated target.
  assert.doesNotMatch(workflow, /permission-contents: write/);
});

test("intake hydrates state with a read-only, non-persisted credential", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-intake.yml", "utf8");
  assert.match(workflow, /contents-permission: read/);
  assert.match(workflow, /actions-permission: read/);
  assert.match(workflow, /persist-credentials: "false"/);
  assert.doesNotMatch(workflow, /permission-contents: write/);
});

test("self-heal treats a failed publisher rerun as non-blocking", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-self-heal.yml", "utf8");
  const rerunIndex = workflow.indexOf('if ! gh run rerun "$run_id"');
  const selfHealIndex = workflow.indexOf("- name: Self-heal failed cluster runs");
  assert.ok(rerunIndex >= 0 && selfHealIndex > rerunIndex);
  assert.match(workflow, /warning title=Publisher rerun failed/);
});
