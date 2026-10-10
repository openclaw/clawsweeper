import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

type Workflow = { jobs: Record<string, { steps: { run?: string }[] }> };
const base = process.env.EXACT_REVIEW_CLIENT_BASE;
// The inherited sweep comparisons require the last pre-extraction workflow.
// The batch/reconcile comparisons use this PR's actual base instead.
const sweepBase = process.env.EXACT_REVIEW_SWEEP_BASE ?? "c2753fb49e2542716365a167b055aac6709f9040";
function scripts(path: string, old: boolean, revision = base) {
  const text = old
    ? execFileSync("git", ["show", `${revision}:${path}`], { encoding: "utf8" })
    : readFileSync(path, "utf8");
  const workflow = YAML.parse(text) as Workflow;
  return Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step?.run ?? "");
}
function inline(script: string, index = 0) {
  const bodies = [...script.matchAll(/node[^\n]*<<'NODE'\n([\s\S]*?)^\s*NODE/gm)];
  if (bodies.length) return bodies[index]![1]!;
  return [...script.matchAll(/node -e '([^']*)'/g)][index]![1]!;
}
function run(argv: string[], env: NodeJS.ProcessEnv, root: string) {
  writeFileSync(join(root, "output"), "");
  writeFileSync(join(root, "requests"), "");
  const result = spawnSync(process.execPath, argv, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      GITHUB_OUTPUT: join(root, "output"),
      REQUEST_LOG: join(root, "requests"),
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    output: readFileSync(join(root, "output"), "utf8"),
    requests: readFileSync(join(root, "requests"), "utf8"),
  };
}

for (const [command, environments] of [
  [
    "reservation",
    [
      { RESERVATION: '{"status":"posted","owner":"worker","commentId":7}' },
      { RESERVATION: '{"status":"held","retryAt":"2026-01-01","retryKind":"throttle"}' },
      { RESERVATION: '{"status":"superseded"}' },
      { RESERVATION: '{"status":"held","retryAt":"bad"}' },
    ],
  ],
  ["retryAt", [{}]],
  ["sourceAction", [{ CLAIM_DECISION: '{"sourceAction":"opened"}' }, { CLAIM_DECISION: "{}" }]],
  [
    "lifecycleKind",
    [
      { DIRECT_LIFECYCLE_PLAN: '{"kind":"router"}' },
      { DIRECT_LIFECYCLE_PLAN: '{"kind":"requeue","extra":true}' },
    ],
  ],
  ["legacyArtifact", [{}]],
  [
    "context",
    [
      { CLAIM_DECISION: '{"targetRepo":"openclaw/openclaw","itemNumber":7}' },
      { CLAIM_DECISION: "{}" },
    ],
  ],
] as [string, NodeJS.ProcessEnv[]][]) {
  test(
    `${command} preserves the extracted inline script's outputs and exits`,
    { skip: !base },
    () => {
      const root = mkdtempSync(join(tmpdir(), "queue-extraction-"));
      try {
        const report = join(root, "report.md");
        writeFileSync(report, "review_lease_owner: unknown\n");
        const retry = join(root, "retry.json");
        writeFileSync(retry, '{"retry_at":"2026-01-01"}');
        const argv =
          command === "context"
            ? ["src/repair/exact-review-queue-context.ts"]
            : [
                "src/repair/exact-review-queue-response.ts",
                command,
                ...(command === "retryAt" ? [retry] : []),
              ];
        const currentSteps = scripts(".github/workflows/sweep.yml", false);
        const index = currentSteps.findIndex((step) =>
          command === "context"
            ? step.includes(argv[0]!)
            : step.includes("exact-review-queue-response.") && step.includes(` ${command}`),
        );
        assert.notEqual(index, -1);
        for (const environment of environments) {
          const env = { ...environment, REPORT_PATH: report };
          const actual = run(argv, env, root);
          if (base) {
            const step = scripts(".github/workflows/sweep.yml", true, sweepBase)[index]!;
            const original =
              command === "retryAt"
                ? [...step.matchAll(/node -e '([^']*)'/g)][0]![1]!
                : inline(step);
            if (command === "retryAt") {
              assert.deepEqual(actual, run(["-e", original, retry], env, root));
            } else {
              const module = original.replace(
                'const fs = require("node:fs");',
                'import fs from "node:fs";',
              );
              assert.deepEqual(actual, run(["--input-type=module", "-e", module], env, root));
            }
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}

for (const record of ["router", "terminal"]) {
  test(`batch ${record} preserves serialized request bytes`, () => {
    const root = mkdtempSync(join(tmpdir(), "queue-batch-"));
    try {
      for (const revision of ["3", "0"]) {
        const env = {
          REVISION: revision,
          FENCE_KEY: "repo#7",
          TARGET_REPO: "repo/name",
          ITEM_NUMBER: "7",
          GITHUB_RUN_ID: "20",
          GITHUB_RUN_ATTEMPT: "2",
          LIFECYCLE_ROUTER_OUTCOME: "not_required",
          LIFECYCLE_TERMINAL: "policy_noop",
        };
        const result = run(
          ["src/repair/exact-review-queue-request.ts", "batch-lifecycle", record],
          env,
          root,
        );
        assert.equal(result.status, revision === "3" ? 0 : 1);
        if (base) {
          const step = scripts(".github/workflows/exact-review-batch-publish.yml", true).find((s) =>
            s.includes("export LIFECYCLE_TERMINAL="),
          )!;
          assert.deepEqual(
            result,
            run(["-e", inline(step, record === "router" ? 0 : 1)], env, root),
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("reconcile body preserves request bytes and invalid-attempt failure", () => {
  const root = mkdtempSync(join(tmpdir(), "queue-reconcile-"));
  try {
    for (const attempt of ["1", "0", "bad"]) {
      const env = { SOURCE_RUN_ID: "20", SOURCE_RUN_ATTEMPT: attempt };
      const result = run(["src/repair/exact-review-queue-reconcile.ts", "body"], env, root);
      assert.equal(result.status, attempt === "1" ? 0 : 1);
      if (base) {
        const step = scripts(".github/workflows/exact-review-reconcile-run.yml", true).find((s) =>
          s.includes("payload="),
        )!;
        assert.deepEqual(result, run(["-e", inline(step)], env, root));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcile sweep preserves signed queue requests and partial-failure outcomes", () => {
  const root = mkdtempSync(join(tmpdir(), "queue-reconcile-sweep-"));
  try {
    const mock = join(root, "fetch.mjs");
    writeFileSync(
      mock,
      `import fs from 'node:fs';
      globalThis.fetch = async (url, options) => {
        fs.appendFileSync(process.env.REQUEST_LOG, JSON.stringify({url, ...options}) + '\\n');
        const queue = url.includes('/internal/');
        const value = url.endsWith('claimed-runs') ? {runs:[{run_id:'20',run_attempt:1,claim_generation:2}]} : queue ? {reconciled:1} : {id:20,run_attempt:1,status:'completed',conclusion:'success'};
        const ok = queue || process.env.UNAVAILABLE !== 'true';
        return {ok, status:ok?200:503, json:async()=>value,text:async()=>JSON.stringify(value)};
      };`,
    );
    for (const unavailable of ["false", "true"]) {
      const env = {
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-only",
        GH_TOKEN: "fixture-only",
        GITHUB_REPOSITORY: "repo/name",
        QUEUE_URL: "https://queue.invalid",
        UNAVAILABLE: unavailable,
      };
      const actual = run(
        ["--import", mock, "src/repair/exact-review-queue-reconcile.ts", "sweep"],
        env,
        root,
      );
      assert.equal(actual.status, unavailable === "true" ? 1 : 0);
      if (base) {
        const step = scripts(".github/workflows/exact-review-reconcile.yml", true).find((s) =>
          s.includes("createHmac"),
        )!;
        assert.deepEqual(
          actual,
          run(["--import", mock, "--input-type=module", "-e", inline(step)], env, root),
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
