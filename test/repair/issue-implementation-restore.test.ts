import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "yaml";

import {
  REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
  renderIssueImplementationJob,
} from "../../dist/repair/comment-router/dispatch.js";
import { issueImplementationStatusMarker } from "../../dist/repair/issue-implementation-status.js";
import { branchPushes, runExecuteFixFixture } from "./execute-fix-cli-fixture.ts";

const skip = process.platform === "win32";
const STATE = "repos/openclaw/clawsweeper-state";
const FIXTURE_JOB = "jobs/openclaw/inbox/issue-openclaw-fixture-7.md";
const STATE_TOKEN = "state-token-value";
const issueFix = {
  clusterId: "issue-openclaw-fixture-7",
  fixArtifact: { repair_strategy: "new_fix_pr", source_prs: [], deterministic_rebase_only: false },
  issue: { number: 7, state: "open", labels: [] },
  codex: `if (!ctx.review) ctx.fs.writeFileSync("CONTRIBUTING.md", "Implemented.\\n");`,
};

type Routes = Record<string, unknown>;

// The gh stub answers only the listed API calls and logs each call. It logs
// which token the call used, but never the token value.
function writeGhStub(root: string) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "gh"),
    [
      "#!/usr/bin/env node",
      'const fs = require("fs");',
      "const args = process.argv.slice(2);",
      "const token = process.env.GH_TOKEN === process.env.EXPECTED_STATE_TOKEN ? 'state' : process.env.GH_TOKEN ? 'other' : 'none';",
      "fs.appendFileSync(process.env.GH_LOG, JSON.stringify({ args, token }) + '\\n');",
      'const routes = JSON.parse(fs.readFileSync(process.env.GH_ROUTES, "utf8"));',
      "const patch = args.indexOf('PATCH');",
      "if (patch >= 0) { fs.appendFileSync(process.env.GH_BODIES, fs.readFileSync(args.at(-1), 'utf8')); console.log('{}'); process.exit(0); }",
      "const key = args.includes('--paginate') ? 'paginate' : args[1] === 'graphql' ? 'graphql ' + args.at(-1) : args.join(' ');",
      "if (Object.hasOwn(routes, key)) { console.log(JSON.stringify(routes[key])); process.exit(0); }",
      "console.error('gh: Not Found (HTTP 404)');",
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return bin;
}

// The last state commit removed the job, so the job is the version in the
// parent commit.
function historyRoutes(jobPath: string, content: string, parentReadable = true): Routes {
  const blob = (object: unknown) => ({ data: { repository: { object } } });
  return {
    [`api ${STATE}/commits?sha=state&path=${encodeURIComponent(jobPath)}&per_page=1`]: [
      { sha: "c2", parents: [{ sha: "c1" }] },
    ],
    [`graphql expression=c2:${jobPath}`]: blob(null),
    ...(parentReadable ? { [`graphql expression=c1:${jobPath}`]: blob({ text: content }) } : {}),
  };
}

function restoreJob(
  t: TestContext,
  jobPath: string,
  routes: Routes,
  stateToken: string | null = STATE_TOKEN,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-job-restore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = writeGhStub(root);
  const files = {
    log: path.join(root, "gh.log"),
    routes: path.join(root, "routes.json"),
    output: path.join(root, "github-output"),
  };
  fs.writeFileSync(files.routes, JSON.stringify(routes));
  const result = spawnSync(
    "bash",
    [path.join(process.cwd(), "scripts/restore-repair-job.sh"), jobPath, "this worker"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: root,
        GH_TOKEN: "app-token-value",
        GH_LOG: files.log,
        GH_ROUTES: files.routes,
        EXPECTED_STATE_TOKEN: STATE_TOKEN,
        GITHUB_OUTPUT: files.output,
        ...(stateToken ? { CLAWSWEEPER_STATE_REPO_TOKEN: stateToken } : {}),
      },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const outputs = Object.fromEntries(
    fs
      .readFileSync(files.output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const ghCalls = fs.existsSync(files.log)
    ? fs
        .readFileSync(files.log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; token: string })
    : [];
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}${JSON.stringify(ghCalls)}`,
    new RegExp(STATE_TOKEN),
  );
  return {
    job: fs.readFileSync(path.join(root, jobPath), "utf8"),
    outputs,
    ghCalls,
    root,
    bin,
  };
}

test(
  "a restored allowed issue job keeps its original permissions and reaches the push",
  { skip },
  (t) => {
    const original = renderIssueImplementationJob({
      repo: "openclaw/fixture",
      issueNumber: 7,
      triggerSource: REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
      strictBugOnly: true,
    });
    const restored = restoreJob(t, FIXTURE_JOB, historyRoutes(FIXTURE_JOB, original));

    assert.equal(restored.job, original);
    assert.equal(restored.outputs.job_restore, "history");
    assert.equal(restored.outputs.job_restore_reason, "");
    assert.deepEqual(
      restored.ghCalls.map((call) => call.token),
      ["state", "state", "state"],
    );

    const run = runExecuteFixFixture(t, { ...issueFix, job: restored.job });
    assert.doesNotMatch(run.output, /refusing fix execution/);
    assert.ok(run.codexCalls.length > 0, run.output);
    assert.deepEqual(
      branchPushes(run.gitCalls).map((call) => call.args.at(-1)?.split(":")[1]),
      ["refs/heads/clawsweeper/issue-openclaw-fixture-7"],
      run.output,
    );
  },
);

test(
  "a restored handoff-only issue job stays handoff-only and stops before any push or PR",
  { skip },
  (t) => {
    // Intake writes a hard-blocker handoff job, for example for a locked issue.
    const original = renderIssueImplementationJob({
      repo: "openclaw/fixture",
      issueNumber: 7,
      triggerSource: REVIEW_REPRODUCIBLE_BUG_TRIGGER_SOURCE,
      operatorOverride: true,
      overrideBlockerClass: "hard",
      overrideAction: "Write a human handoff for the locked issue.",
    });
    const restored = restoreJob(t, FIXTURE_JOB, historyRoutes(FIXTURE_JOB, original));

    assert.equal(restored.job, original);
    assert.match(restored.job, /^allow_fix_pr: false$/m);

    const run = runExecuteFixFixture(t, { ...issueFix, job: restored.job });
    assert.notEqual(run.status, 0, run.output);
    assert.match(run.output, /refusing fix execution: job must allow fix and raise_pr/);
    assert.deepEqual(run.codexCalls, []);
    assert.deepEqual(branchPushes(run.gitCalls), []);
    assert.deepEqual(run.publications, []);
  },
);

test(
  "an issue job without a usable state version is restored without code permissions",
  { skip },
  (t) => {
    const allowed = renderIssueImplementationJob({ repo: "openclaw/fixture", issueNumber: 7 });
    const otherIssue = renderIssueImplementationJob({ repo: "openclaw/fixture", issueNumber: 8 });
    const cases: Array<[string, Routes, string | null]> = [
      ["no state token", historyRoutes(FIXTURE_JOB, allowed), null],
      ["no state history", {}, STATE_TOKEN],
      ["the state API fails", historyRoutes(FIXTURE_JOB, allowed, false), STATE_TOKEN],
      [
        "the state version is for another issue",
        historyRoutes(FIXTURE_JOB, otherIssue),
        STATE_TOKEN,
      ],
    ];
    for (const [name, routes, token] of cases) {
      const restored = restoreJob(t, FIXTURE_JOB, routes, token);
      assert.equal(restored.outputs.job_restore, "handoff", name);
      assert.match(
        restored.outputs.job_restore_reason,
        /could not get the original job back/,
        name,
      );
      assert.match(restored.job, /^allow_fix_pr: false$/m, name);
      assert.match(restored.job, /^source_issue_number: 7$/m, name);
      assert.match(restored.job, /^blocked_actions:\n {2}- fix\n {2}- raise_pr$/m, name);

      const run = runExecuteFixFixture(t, { ...issueFix, job: restored.job });
      assert.notEqual(run.status, 0, `${name}: ${run.output}`);
      assert.match(run.output, /refusing fix execution: job must allow fix and raise_pr/, name);
      assert.deepEqual(branchPushes(run.gitCalls), [], name);
      assert.deepEqual(run.publications, [], name);
    }
  },
);

test(
  "the worker status steps report a restored job without code permissions as blocked",
  { skip },
  (t) => {
    const jobPath = "jobs/openclaw/inbox/issue-openclaw-openclaw-167865.md";
    const restored = restoreJob(t, jobPath, {}, null);
    const reason = restored.outputs.job_restore_reason;
    assert.ok(reason);

    const workflow = parse(
      fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8"),
    ) as { jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }> };
    const stepRun = (name: string) => {
      const run = Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .find((step) => step.name === name)?.run;
      assert.ok(run, name);
      return run;
    };
    // pnpm runs the real dist script for each package script.
    fs.writeFileSync(
      path.join(restored.bin, "pnpm"),
      [
        "#!/usr/bin/env bash",
        'script="$2"; shift 2',
        'case "$script" in',
        '  repair:policy-run) exec node "$DIST/repair-policy-run.js" "$@" ;;',
        '  repair:issue-implementation-status) exec node "$DIST/issue-implementation-status.js" "$@" ;;',
        "esac",
        "exit 9",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const marker = issueImplementationStatusMarker(167865);
    const routes = {
      "api repos/openclaw/openclaw/issues/167865": { title: "Gateway drops queued replies" },
      paginate: [
        [{ id: 6085201584, user: { login: "clawsweeper[bot]" }, body: `${marker}\nQueued` }],
      ],
    };
    const routesPath = path.join(restored.root, "status-routes.json");
    fs.writeFileSync(routesPath, JSON.stringify(routes));
    const bodies = path.join(restored.root, "bodies.jsonl");
    const runStep = (name: string, env: Record<string, string>) => {
      fs.rmSync(bodies, { force: true });
      const result = spawnSync("bash", ["-e", "-c", stepRun(name)], {
        cwd: restored.root,
        encoding: "utf8",
        env: {
          PATH: `${restored.bin}${path.delimiter}${process.env.PATH}`,
          HOME: restored.root,
          DIST: path.join(process.cwd(), "dist/repair"),
          GH_TOKEN: "status-token-value",
          GH_LOG: path.join(restored.root, "status-gh.log"),
          GH_ROUTES: routesPath,
          GH_BODIES: bodies,
          CLAWSWEEPER_ALLOWED_OWNER: "openclaw",
          CLUSTER_JOB_PATH: jobPath,
          CLUSTER_RUN_URL: "https://github.com/openclaw/clawsweeper/actions/runs/100",
          ...env,
        },
      });
      assert.equal(result.status, 0, `${name}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /"status":"updated"/, name);
      return JSON.parse(fs.readFileSync(bodies, "utf8")).body as string;
    };

    for (const step of [
      "Publish automatic implementation planning status",
      "Publish automatic implementation build status",
    ]) {
      const body = runStep(step, { JOB_RESTORE_REASON: reason });
      assert.match(body, /Automatic implementation stopped before completion\./, step);
      assert.ok(body.includes(`Reason: ${reason}`), step);
    }
    const completion = runStep("Publish automatic implementation completion status", {
      JOB_RESTORE_REASON: reason,
      EXECUTE_OUTCOME: "failure",
      POST_FLIGHT_OUTCOME: "skipped",
    });
    assert.ok(completion.includes(`Reason: ${reason}`));
    const planningFailure = runStep("Publish automatic implementation planning failure status", {});
    assert.match(
      planningFailure,
      /Reason: The worker failed while it planned the implementation\./,
    );
    assert.match(
      runStep("Publish automatic implementation planning status", { JOB_RESTORE_REASON: "" }),
      /State: Planning/,
    );
  },
);
