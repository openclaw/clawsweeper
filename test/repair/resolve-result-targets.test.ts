import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

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

test("result targets honor the production owner-list contract", () => {
  // CLAWSWEEPER_ALLOWED_OWNER is a comma/whitespace-separated list (issue
  // #604); production sets "openclaw,steipete".
  const resolved = resolveResultTargets({
    artifactsDir: artifactsWithResults(["steipete/vibetunnel"]),
    allowedOwner: "openclaw,steipete",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(resolved, { owner: "steipete", repositories: ["vibetunnel"] });
  const fallback = resolveResultTargets({
    artifactsDir: artifactsWithResults([]),
    allowedOwner: "openclaw, steipete",
    fallbackRepo: "openclaw/openclaw",
  });
  assert.deepEqual(fallback, { owner: "openclaw", repositories: ["openclaw"] });
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults(["evil/openclaw"]),
        allowedOwner: "openclaw,steipete",
        fallbackRepo: "openclaw/openclaw",
      }),
    /outside openclaw,steipete/,
  );
});

test("result targets fail closed when results span multiple owners", () => {
  assert.throws(
    () =>
      resolveResultTargets({
        artifactsDir: artifactsWithResults(["openclaw/openclaw", "steipete/vibetunnel"]),
        allowedOwner: "openclaw,steipete",
        fallbackRepo: "openclaw/openclaw",
      }),
    /span multiple owners/,
  );
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

function workflowStepRun(file: string, name: string): string {
  const workflow = parse(fs.readFileSync(`.github/workflows/${file}`, "utf8")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const run = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.name === name)?.run;
  assert.ok(run, name);
  return run;
}

test("intake target validation honors the owner-list contract", () => {
  const run = workflowStepRun("repair-cluster-intake.yml", "Resolve target repository");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-intake-target-"));
  try {
    const resolve = (allowedOwner: string, targetRepo: string) => {
      const output = path.join(root, "output");
      fs.writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", run], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          ALLOWED_OWNER: allowedOwner,
          TARGET_REPO: targetRepo,
          GITHUB_OUTPUT: output,
        },
      });
      return { status: result.status, output: fs.readFileSync(output, "utf8") };
    };

    const allowed = resolve("steipete, openclaw", "OpenClaw/Gitcrawl");
    assert.equal(allowed.status, 0);
    assert.match(allowed.output, /^owner=OpenClaw$/m);
    assert.match(allowed.output, /^name=Gitcrawl$/m);
    assert.match(allowed.output, /^slug=openclaw-gitcrawl$/m);
    const outside = resolve("steipete openclaw-labs", "openclaw/gitcrawl");
    assert.equal(outside.status, 2);
    assert.equal(outside.output, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("self-heal treats a failed publisher rerun as non-blocking", () => {
  const run = workflowStepRun("repair-self-heal.yml", "Retry failed cluster result publications");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-self-heal-rerun-"));
  try {
    const bin = path.join(root, "bin");
    const reruns = path.join(root, "reruns");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/usr/bin/env bash
if [ "$1" = api ]; then printf '%s' "$RUNS_JSON"; exit 0; fi
if [ "$1 $2" = "run rerun" ]; then printf '%s\\n' "$3" >> "$RERUNS"; [ "$3" != 1 ]; exit; fi
exit 2
`,
      { mode: 0o755 },
    );
    const recent = new Date(Date.now() - 60_000).toISOString().slice(0, 19) + "Z";
    const runs = [
      { id: 1, created_at: recent, conclusion: "failure", run_attempt: 1 },
      { id: 2, created_at: recent, conclusion: "cancelled", run_attempt: 2 },
      { id: 3, created_at: recent, conclusion: "failure", run_attempt: 3 },
      { id: 4, created_at: "2020-01-01T00:00:00Z", conclusion: "failure", run_attempt: 1 },
      { id: 5, created_at: recent, conclusion: "success", run_attempt: 1 },
    ];
    const result = spawnSync("bash", ["-c", run], {
      encoding: "utf8",
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        RUNS_JSON: JSON.stringify({ workflow_runs: runs }),
        RERUNS: reruns,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(reruns, "utf8"), "1\n2\n");
    assert.match(result.stdout, /::warning title=Publisher rerun failed::.*run 1;/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
