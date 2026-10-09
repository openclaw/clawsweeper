import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { AGENT_INPUT_SCAN_FAILURE_REASONS } from "../dist/exact-review-failure-reason.js";

import { makeTreeReadOnlyForTest, restoreTreeModesForTest } from "../dist/clawsweeper.js";
import { createReviewRuntime } from "../dist/clawsweeper-review-runtime.js";
import {
  readText,
  reportWithSyncedReviewComment,
  runApplyDecisionsForTest,
  tmpPrefix,
  withMockGh,
  workPlanCandidateReport,
} from "./helpers.ts";
import { scheduledReviewSemanticSourceRevision } from "../dist/scheduled-review-noop.js";
import { runExactReviewDirectPublicationFromEnv } from "../dist/repair/exact-review-direct-publication.js";

test("review workflow emits terminal reasons for non-retryable scanner manifests", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const producers = Object.values(workflow.jobs).flatMap((job: any) =>
    (job.steps ?? []).filter((step: any) => /echo "failure_reason=/.test(step.run ?? "")),
  );
  assert.equal(producers.length, 1, "audit every terminal-reason producer when lanes change");
  const root = mkdtempSync(`${tmpPrefix}terminal-scan-workflow-`);
  try {
    const manifestDir = join(root, "artifacts/event/failure-diagnostics");
    mkdirSync(manifestDir, { recursive: true });
    const output = join(root, "outputs");
    for (const producer of producers) {
      const body = producer.run as string;
      const shell = body.slice(
        body.indexOf('echo "exit_code=$review_exit_code"'),
        body.indexOf('coordination_held_path="artifacts/event/coordination-held.json"'),
      );
      assert.ok(shell.includes('exit "$review_exit_code"'));
      for (const reason of AGENT_INPUT_SCAN_FAILURE_REASONS) {
        for (const retryable of [false, true]) {
          writeFileSync(output, "");
          writeFileSync(
            join(manifestDir, "manifest.json"),
            JSON.stringify({
              classification: "codex_or_content_failure",
              retryable,
              failure: { stage: "agent_input_scan", reason_code: reason },
            }),
          );
          const result = spawnSync("bash", ["-c", `set -euo pipefail\n${shell}`], {
            cwd: root,
            encoding: "utf8",
            env: { ...process.env, review_exit_code: "1", GITHUB_OUTPUT: output },
          });
          assert.equal(result.status, 1, result.stderr);
          const outputs = readFileSync(output, "utf8").split("\n");
          assert.equal(outputs.includes(`failure_reason=${reason}`), !retryable, reason);
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queue completion tolerates only terminal-reason deploy skew", async (t) => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const producers = Object.values(workflow.jobs).flatMap((job: any) =>
    (job.steps ?? []).filter((step: any) => /complete body\)/.test(step.run ?? "")),
  );
  assert.equal(producers.length, 1, "audit every completion reason producer when lanes change");
  const detail = { stage: "agent_input_scan", reason_code: "deadline", retryable: false };
  const cases = [
    { name: "compatible Worker", replies: [200], exit: 0, fallback: false },
    { name: "old Worker", replies: [400, 200], exit: 0, fallback: true },
    {
      name: "unrelated bad request",
      replies: [400],
      error: "invalid_outcome",
      exit: 1,
      fallback: false,
    },
    { name: "malformed response", replies: [400], raw: "not JSON", exit: 1, fallback: false },
    { name: "no reason sent", replies: [400], reason: "", exit: 1, fallback: false },
    { name: "fallback rejected", replies: [400, 400], exit: 1, fallback: true },
    {
      name: "fallback superseded",
      replies: [400, 409],
      error409: "lease_superseded",
      exit: 0,
      fallback: true,
    },
    {
      name: "fallback ownership conflict",
      replies: [400, 409],
      error409: "lease_not_active",
      exit: 1,
      fallback: true,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const requests: Record<string, any>[] = [];
      let completed = false;
      const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body));
        const code = scenario.replies[requests.length - 1] ?? 500;
        completed ||= code === 200;
        res.writeHead(code, { "content-type": "application/json" });
        res.end(
          scenario.raw ??
            JSON.stringify(
              code === 200
                ? { ok: true }
                : {
                    error:
                      code === 409
                        ? scenario.error409
                        : (scenario.error ?? "invalid_review_failure_reason"),
                  },
            ),
        );
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const child = spawn("bash", ["-c", producers[0].run], {
          env: {
            ...process.env,
            SOURCE_CHECKOUT_OUTCOME: "success",
            QUEUE_URL: `http://127.0.0.1:${address.port}`,
            QUEUE_LEASE_ID: "synthetic-lease",
            PROTOCOL_VERSION: "2",
            QUEUE_LEASE_REVISION: "1",
            CLAIM_GENERATION: "1",
            ITEM_KEY: "openclaw/clawsweeper#1",
            GITHUB_RUN_ID: "100",
            GITHUB_RUN_ATTEMPT: "1",
            PRIMARY_OUTCOME: "failure",
            REQUEUE_LATEST: "false",
            RETRY_KIND: "",
            RETRY_AT: "",
            DIRECT_PUBLICATION_ACCEPTED: "false",
            DIRECT_LIFECYCLE_OUTCOME: "",
            REVIEW_FAILURE_REASON: scenario.reason ?? "deadline",
            REVIEW_FAILURE_STAGE: detail.stage,
            REVIEW_FAILURE_REASON_CODE: detail.reason_code,
            REVIEW_FAILURE_RETRYABLE: "false",
            HAS_COMMAND_CONTEXT: "false",
            REVIEW_ITEM_KIND: "pull_request",
            REVIEW_STATUS_VERIFIED: "false",
            REVIEW_ACKNOWLEDGEMENT_COMMENT_ID: "123",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const exit = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(exit, scenario.exit, output);
        assert.equal(completed, scenario.replies.includes(200));
        assert.equal(requests.length, scenario.replies.length);
        assert.deepEqual(requests[0].review_failure, detail);
        assert.equal(
          requests[0].review_failure_reason,
          scenario.reason === "" ? undefined : "deadline",
        );
        assert.equal(
          (output.match(/::warning::/g) ?? []).length,
          scenario.fallback ? 1 : 0,
          output,
        );
        if (scenario.fallback) {
          assert.match(output, /Worker\/workflow deploy skew/);
          const { review_failure_reason, review_failure_status, ...expected } = requests[0];
          assert.equal(review_failure_reason, "deadline");
          assert.deepEqual(review_failure_status, { outcome: "failed", comment_id: 123 });
          assert.deepEqual(
            requests[1],
            expected,
            "only reason and its dependent status are removed",
          );
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  }
});

function runCommentSyncShell(root: string, commands: string[]): string {
  return execFileSync(
    "bash",
    [
      "-lc",
      [
        'export PATH="$NODE_BIN_DIR:$PATH"',
        'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
        'source "$APPLY_HELPER_PATH"',
        ...commands,
      ].join("\n"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_BIN_DIR: dirname(process.execPath),
        APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
        WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
      },
    },
  );
}

test("item review commands use fixed author profiles without a global override", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const commands = Object.values(workflow.jobs).flatMap((job: any) =>
    (job.steps ?? []).flatMap((step: any) =>
      (step.run ?? "")
        .split("\n")
        .filter((line: string) => line.includes("--codex-reasoning-effort")),
    ),
  );
  assert.equal(commands.length, 1);
  assert.equal(workflow.env.CLAWSWEEPER_CODEX_REASONING_EFFORT, undefined);
  const argv = execFileSync(
    "bash",
    ["-c", `printf '%s\\n' ${commands[0].trim().replace(/\\$/, "")}`],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  assert.deepEqual(argv, ["--codex-reasoning-effort", "medium"]);
});

test("queued publication expires only its posted review lease after successful handoff", () => {
  const steps = YAML.parse(readText(".github/workflows/sweep.yml")).jobs["event-review-apply"]
    .steps;
  const index = steps.findIndex((entry) => entry.id === "queue-exact-review-publication");
  const expiry = steps[index + 1];
  assert.equal(expiry.name, "Expire queued exact review lease");
  assert.equal(expiry["continue-on-error"], true);
  assert.equal(expiry.env.GH_TOKEN, "${{ steps.target-write-token.outputs.token }}");
  assert.equal(expiry.env.COMMENT_ID, "${{ steps.reserve-exact-review-lease.outputs.comment_id }}");
  assert.match(expiry.run, /node dist\/clawsweeper.js expire-review-lease/);
  assert.match(expiry.run, /--comment-id "\$COMMENT_ID"/);
  assert.match(expiry.if, /always\(\)/);
  assert.match(expiry.if, /!cancelled\(\)/);
  for (const queued of ["success", "failure"]) {
    for (const accepted of ["true", "false"]) {
      for (const reservation of ["posted", "held", "superseded"]) {
        for (const queueOnly of ["true", "false"]) {
          const expression = expiry.if
            .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
            .replace("always()", "true")
            .replace("cancelled()", "false")
            .replace("steps.claim-exact-review-queue.outputs.claimed", "'true'")
            .replace("steps.queue-exact-review-publication.outcome", JSON.stringify(queued))
            .replace(
              "steps.direct-exact-review-publication.outputs.accepted",
              JSON.stringify(accepted),
            )
            .replace("steps.reserve-exact-review-lease.outputs.status", JSON.stringify(reservation))
            .replace(
              "steps.reserve-exact-review-lease.outputs.queue_only",
              JSON.stringify(queueOnly),
            );
          assert.equal(
            Function(`return (${expression});`)(),
            queued === "success" &&
              accepted !== "true" &&
              reservation === "posted" &&
              queueOnly !== "true",
          );
        }
      }
    }
  }
});

test("command status leases receive the admission live head without changing the queue fence", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const steps = workflow.jobs["event-review-apply"].steps;
  const liveHead = "${{ steps.live-item.outputs.live_head_sha || '' }}";
  for (const id of ["mark-re-review-command-in-progress", "reserve-exact-review-lease"]) {
    const leaseStep = steps.find((entry: any) => entry.id === id);
    assert.equal(leaseStep.env?.EXACT_REVIEW_LIVE_HEAD_SHA, liveHead, id);
    assert.match(leaseStep.run, /--require-queue-authority-fence/, id);
  }
  const commandFence = steps.find((entry: any) => entry.id === "command-status-fence");
  assert.equal(commandFence.env?.EXACT_REVIEW_LIVE_HEAD_SHA, undefined);
  assert.doesNotMatch(commandFence.run, /LIVE_HEAD/);
  assert.equal(
    steps.filter((entry: any) => entry.env?.EXACT_REVIEW_LIVE_HEAD_SHA !== undefined).length,
    2,
  );
});

test("queue-only command review proves allowed and superseded authority before GitHub mutation", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const steps = workflow.jobs["event-review-apply"].steps;
  const reservation = steps.find((entry: any) => entry.id === "reserve-exact-review-lease");
  const commandFence = steps.find((entry: any) => entry.id === "command-status-fence");
  const markCommand = steps.find((entry: any) => entry.id === "mark-re-review-command-in-progress");
  assert.match(markCommand.if, /command-status-fence\.outputs\.authorized == 'true'/);
  const root = mkdtempSync(`${tmpPrefix}queue-only-proof-`);
  try {
    const bin = join(root, "bin");
    const refreshLog = join(root, "status-refresh");
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$REFRESH_LOG"\n');
    chmodSync(join(bin, "pnpm"), 0o700);
    const reservationOutput = join(root, "reservation-output");
    execFileSync("bash", ["-e", "-u", "-c", reservation.run], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        GH_TOKEN: "fixture-token",
        TARGET_REPO: "openclaw/clawsweeper",
        ITEM_NUMBER: "1675",
        CODEX_TIMEOUT_MS: "2700000",
        MEDIA_PROOF_TIMEOUT_MS: "480000",
        RESOLVED_STATUS_COMMENT_ID: "7001",
        COMMAND_STATUS_MARKER: "<!-- clawsweeper-command-status:1675:re_review:fixture -->",
        RUN_URL: "https://github.com/openclaw/clawsweeper/actions/runs/4242",
        REFRESH_LOG: refreshLog,
        GITHUB_OUTPUT: reservationOutput,
        GITHUB_RUN_ID: "4242",
        GITHUB_RUN_ATTEMPT: "3",
      },
    });
    const reservationResult = readText(reservationOutput);
    assert.match(reservationResult, /^status=posted$/m);
    assert.match(reservationResult, /^owner=github-run-4242-3$/m);
    assert.match(reservationResult, /^comment_id=7001$/m);
    assert.match(reservationResult, /^queue_only=true$/m);
    assert.match(readText(refreshLog), /repair:update-command-status/);
    assert.match(readText(refreshLog), /--require-queue-authority-fence/);
    assert.match(readText(refreshLog), /--require-mutation/);

    const fenceScript = commandFence.run.slice(commandFence.run.indexOf('echo "authorized=false"'));
    const supersededOutput = join(root, "superseded-output");
    const mutationLog = join(root, "github-mutations");
    execFileSync(
      "bash",
      [
        "-e",
        "-u",
        "-c",
        `
        control_plane_curl() {
          local output=""
          while [ "$#" -gt 0 ]; do
            if [ "$1" = "--output" ]; then output="$2"; shift 2; else shift; fi
          done
          printf '%s' '{"error":"lease_superseded"}' > "$output"
          printf '409'
        }
        ${fenceScript}
        printf 'unexpected GitHub mutation\n' > "$MUTATION_LOG"
      `,
      ],
      {
        env: {
          ...process.env,
          GITHUB_OUTPUT: supersededOutput,
          GITHUB_RUN_ID: "4242",
          GITHUB_RUN_ATTEMPT: "3",
          MUTATION_LOG: mutationLog,
          QUEUE_URL: "http://127.0.0.1",
          EXACT_REVIEW_ITEM_KEY: "openclaw/clawsweeper#1675",
          EXACT_REVIEW_LEASE_ID: "fixture-lease",
          EXACT_REVIEW_LEASE_REVISION: "8",
          EXACT_REVIEW_CLAIM_GENERATION: "2",
          EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
        },
      },
    );
    const supersededResult = readText(supersededOutput);
    assert.match(supersededResult, /^superseded=true$/m);
    assert.equal(existsSync(mutationLog), false);

    const proofDir = process.env.CLAWSWEEPER_QUEUE_ONLY_PROOF_DIR;
    if (proofDir) {
      mkdirSync(proofDir, { recursive: true });
      writeFileSync(
        join(proofDir, "summary.json"),
        JSON.stringify(
          {
            head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            allowed: {
              output: reservationResult.trim().split("\n"),
              statusRefreshInvocations: 1,
            },
            superseded: { output: supersededResult.trim().split("\n"), githubMutations: 0 },
            surface: "production workflow shell extracted from .github/workflows/sweep.yml",
            limits: "Controlled queue and GitHub boundary; no production mutation or model review.",
          },
          null,
          2,
        ),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact review failure annotation follows logical generation and preserves the failure gate", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const failure = workflow.jobs["event-review-apply"].steps.find(
    (entry: { name?: string }) => entry.name === "Fail unsuccessful exact review generation",
  );
  const evaluate = (template: string, values: Record<string, string>) => {
    const expression = template
      .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
      .replace(/\balways\(\)/g, "true")
      .replace(
        /steps\.([a-z0-9-]+)\.(outputs\.([a-z0-9_]+)|outcome)/g,
        (_match, stepId: string, access: string, output?: string) =>
          JSON.stringify(values[`${stepId}.${output ?? access}`] ?? ""),
      );
    return Function(`"use strict"; return (${expression});`)();
  };
  // Exhaust the independent gate facts; raw process outcome must not override
  // typed deferrals or content failures reported after an exit-zero process.
  for (let mask = 0; mask < 256; mask += 1) {
    const [claimed, accepted, completed, superseded, held, itemSuperseded, generated, deferred] =
      Array.from({ length: 8 }, (_, bit) => Boolean(mask & (1 << bit)));
    if (superseded && held) continue;
    const values = {
      "claim-exact-review-queue.claimed": String(claimed),
      "direct-exact-review-publication.accepted": String(accepted),
      "complete-exact-review-queue.outcome": completed ? "success" : "failure",
      "reserve-exact-review-lease.status": superseded ? "superseded" : held ? "held" : "posted",
      "review-exact-event-item.superseded": String(itemSuperseded),
      "exact-review-generation-result.outcome": generated ? "success" : "failure",
      "exact-review-generation-result.retry_kind": deferred ? "throttle" : "",
    };
    const generationFailed = !generated && !deferred && !held && !superseded;
    const expected =
      claimed && ((!accepted && !completed && !superseded && !itemSuperseded) || generationFailed);
    assert.equal(evaluate(failure.if, values), expected, JSON.stringify(values));
    assert.equal(
      evaluate(failure.env.CLASSIFICATION, values),
      generationFailed ? "codex_or_content_failure" : "queue_completion_failure",
    );
  }
  for (const scenario of [
    {
      name: "completion only",
      generation: "success",
      process: "success",
      retry: "",
      reservation: "posted",
      completion: "failure",
      expected: "queue_completion_failure",
    },
    {
      name: "held deferral",
      generation: "failure",
      process: "skipped",
      retry: "coordination",
      reservation: "held",
      completion: "failure",
      expected: "queue_completion_failure",
    },
    {
      name: "throttle process failure",
      generation: "failure",
      process: "failure",
      retry: "throttle",
      reservation: "posted",
      completion: "failure",
      expected: "queue_completion_failure",
    },
    {
      name: "exit-zero content failure",
      generation: "failure",
      process: "success",
      retry: "",
      reservation: "posted",
      completion: "success",
      expected: "codex_or_content_failure",
    },
    {
      name: "simultaneous failures",
      generation: "failure",
      process: "failure",
      retry: "",
      reservation: "posted",
      completion: "failure",
      expected: "codex_or_content_failure",
    },
  ]) {
    const values = {
      "claim-exact-review-queue.claimed": "true",
      "direct-exact-review-publication.accepted": "false",
      "exact-review-generation-result.outcome": scenario.generation,
      "exact-review-generation-result.retry_kind": scenario.retry,
      "review-exact-event-item.outcome": scenario.process,
      "review-exact-event-item.exit_code": scenario.process === "failure" ? "1" : "0",
      "complete-exact-review-queue.outcome": scenario.completion,
      "reserve-exact-review-lease.status": scenario.reservation,
    };
    assert.equal(evaluate(failure.if, values), true, scenario.name);
    const env = Object.fromEntries(
      Object.entries(failure.env).map(([key, value]) => [
        key,
        String(evaluate(String(value), values)),
      ]),
    );
    const result = spawnSync("bash", ["-c", failure.run], { env, encoding: "utf8" });
    assert.equal(result.status, 1, scenario.name);
    assert.match(result.stdout, new RegExp(`classification=${scenario.expected} `), scenario.name);
    assert.match(
      result.stdout,
      new RegExp(`queue_completion=${scenario.completion}`),
      scenario.name,
    );
  }
});

test("exact event review builds the admission predicate before signals and target runtime setup", () => {
  type Step = {
    name?: string;
    uses?: string;
    id?: string;
    "continue-on-error"?: boolean;
    "timeout-minutes"?: number;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = workflow.jobs["event-review-apply"]!.steps;
  const index = (predicate: (step: Step) => boolean, label: string) => {
    const value = steps.findIndex(predicate);
    assert.notEqual(value, -1, label);
    return value;
  };
  const ordered = [
    ["pnpm build", index((step) => step.uses === "./.github/actions/setup-pnpm", "pnpm")],
    [
      "claim-time no-op revalidation",
      index((step) => step.name === "Check live target item state", "live item"),
    ],
    [
      "target write token",
      index((step) => step.name === "Create target write token", "write token"),
    ],
    [
      "command terminal check",
      index((step) => step.name === "Mark re-review command in progress", "command status"),
    ],
    [
      "eyes reaction",
      index((step) => step.name === "React to target item review start", "reaction"),
    ],
    [
      "target checkout",
      index((step) => step.name === "Check out target repository", "target checkout"),
    ],
    ["Codex setup", index((step) => step.uses === "./.github/actions/setup-codex", "Codex setup")],
    [
      "OpenClaw setup",
      index((step) => step.uses === "./.github/actions/setup-openclaw", "OpenClaw setup"),
    ],
    [
      "review lease reservation",
      index((step) => step.name === "Reserve exact review lease", "lease"),
    ],
  ] as const;
  for (let position = 1; position < ordered.length; position += 1) {
    assert.ok(
      ordered[position - 1]![1] < ordered[position]![1],
      `${ordered[position - 1]![0]} must precede ${ordered[position]![0]}`,
    );
  }
  assert.equal(steps[ordered[2][1]]!["continue-on-error"], true);
  assert.equal(steps[ordered[8][1]]!.id, "reserve-exact-review-lease");
});

test("OpenClaw review jobs provision the pinned sibling Codex source before review", () => {
  type Step = {
    name?: string;
    uses?: string;
    with?: Record<string, string>;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  for (const scenario of [
    {
      job: "event-review-apply",
      action: "./.github/actions/setup-openclaw-codex-source",
      targetRepo: "${{ steps.target.outputs.target_repo }}",
      targetDir: "${{ steps.target.outputs.target_checkout_dir }}",
      reviewStep: "Review exact event item",
    },
  ] as const) {
    const steps = workflow.jobs[scenario.job]!.steps;
    const targetCheckout = steps.findIndex((step) => step.name === "Check out target repository");
    const sourceCheckout = steps.findIndex((step) => step.uses === scenario.action);
    const review = steps.findIndex((step) => step.name === scenario.reviewStep);

    assert.notEqual(targetCheckout, -1, `${scenario.job}: target checkout`);
    assert.notEqual(sourceCheckout, -1, `${scenario.job}: Codex source checkout`);
    assert.notEqual(review, -1, `${scenario.job}: review`);
    assert.ok(targetCheckout < sourceCheckout, `${scenario.job}: source follows target checkout`);
    assert.ok(sourceCheckout < review, `${scenario.job}: source precedes review`);
    assert.deepEqual(steps[sourceCheckout]!.with, {
      "target-repo": scenario.targetRepo,
      "target-dir": scenario.targetDir,
    });
  }
});

test("Codex source setup normalizes OpenClaw casing and stays out of the OpenClaw runner", () => {
  const action = YAML.parse(readText(".github/actions/setup-openclaw-codex-source/action.yml")) as {
    runs: { steps: Array<{ id?: string; if?: string; uses?: string; run?: string }> };
  };
  const normalize = action.runs.steps.find((step) => step.id === "target");
  const cache = action.runs.steps.find((step) => step.uses === "actions/cache/restore@v6");
  assert.ok(normalize);
  assert.match(cache?.if ?? "", /steps\.target\.outputs\.repository == 'openclaw\/openclaw'/u);
  assert.match(cache?.if ?? "", /env\.CLAWSWEEPER_RUNNER != 'openclaw'/u);
  const setup = action.runs.steps.find((step) => step.id === "materialize");
  assert.match(setup?.if ?? "", /env\.CLAWSWEEPER_RUNNER != 'openclaw'/u);
  assert.match(
    setup?.run ?? "",
    /setup_status.*-eq 80[\s\S]*deferring the decision to the materialized review tree[\s\S]*exit 0/,
  );
});

test("automatic OpenClaw bug dispatch uses one gate across direct and deferred publication", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; if?: string; run?: string; env?: Record<string, string> }> }
    >;
  };
  for (const [jobName, stepName] of [
    ["event-review-apply", "Dispatch exact high-confidence bug implementation"],
    ["event-review-publish", "Dispatch deferred high-confidence bug implementation"],
  ]) {
    const step = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === stepName);
    assert.ok(step, `${jobName}: ${stepName}`);
    assert.match(step.if ?? "", /vars\.CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES == '1'/);
    assert.doesNotMatch(step.if ?? "", /CLAWSWEEPER_AUTO_IMPLEMENT_REPRO_BUGS/);
    assert.match(step.run ?? "", /dispatch-issue-implementation-candidates\.mjs/);
    assert.equal(
      step.env?.MAX_DISPATCH,
      "${{ vars.CLAWSWEEPER_AUTO_IMPLEMENT_MAX_DISPATCH_PER_SWEEP || '' }}",
    );
  }
});

test("issue implementation dispatches omit the deleted model input", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
  };
  const dispatches = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
    (job.steps ?? [])
      .filter((step) => step.run?.includes("dispatch-issue-implementation-candidates.mjs"))
      .map((step) => ({ jobName, step })),
  );

  assert.ok(dispatches.length > 0);
  for (const { jobName, step } of dispatches) {
    assert.doesNotMatch(step.run ?? "", /-f\s+model=/, `${jobName}: ${step.name}`);
  }
});

test("automatic bug backfill runs independently of queue-fed scheduled sweeps", () => {
  const workflow = YAML.parse(
    readText(".github/workflows/repair-issue-implementation-backfill.yml"),
  ) as {
    on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        if: string;
        steps: Array<{ uses?: string; name?: string; run?: string; with?: Record<string, string> }>;
      }
    >;
  };
  assert.deepEqual(workflow.on.schedule, [{ cron: "7/10 * * * *" }]);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.deepEqual(workflow.permissions, { actions: "write", contents: "read" });
  assert.match(workflow.jobs.backfill!.if, /CLAWSWEEPER_AUTO_IMPLEMENT_ISSUES == '1'/);
  const checkout = workflow.jobs.backfill!.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout?.uses, "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.equal(checkout?.with?.["persist-credentials"], false);
  const state = workflow.jobs.backfill!.steps.find((step) => step.uses?.endsWith("/setup-state"));
  assert.equal(state?.with?.["coordinator-class"], "cluster_intake");
  assert.equal(state?.with?.["records-repo-slugs"], "openclaw-openclaw");
  const dispatch = workflow.jobs.backfill!.steps.find(
    (step) => step.name === "Dispatch bounded high-confidence bug candidates",
  );
  assert.match(dispatch?.run ?? "", /dispatch-issue-implementation-candidates\.mjs/);
  assert.match(dispatch?.run ?? "", /--report-dir records\/openclaw-openclaw\/items/);
});

test("review and apply primary boundaries ignore ledger-only failures", () => {
  type WorkflowStep = {
    name?: string;
    uses?: string;
    id?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | boolean>;
    "continue-on-error"?: boolean;
  };
  type WorkflowJob = {
    if?: string;
    needs?: string | string[];
    outputs?: Record<string, string>;
    "timeout-minutes"?: number;
    steps: WorkflowStep[];
  };

  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, WorkflowJob>;
  };
  const job = (name: string): WorkflowJob => {
    const value = workflow.jobs[name];
    assert.ok(value, `missing ${name} job`);
    return value;
  };
  const step = (jobName: string, name: string): WorkflowStep => {
    const value = job(jobName).steps.find((candidate) => candidate.name === name);
    assert.ok(value, `missing ${jobName} step ${name}`);
    return value;
  };
  const setupLedger = (jobName: string): WorkflowStep => {
    const value = job(jobName).steps.find((candidate) =>
      candidate.uses?.endsWith("/setup-action-ledger"),
    );
    assert.ok(value, `missing ${jobName} ledger setup`);
    return value;
  };

  for (const jobName of [
    "event-review-apply",
    "event-review-publish",
    "retry-failed-reviews",
    "apply-proof",
    "apply-existing",
  ]) {
    assert.equal(
      setupLedger(jobName)["continue-on-error"],
      true,
      `${jobName} ledger setup must fail open`,
    );
  }
  for (const [jobName, stepName] of [
    ["event-review-apply", "Finalize exact event action ledger"],
  ] as const) {
    assert.equal(
      step(jobName, stepName)["continue-on-error"],
      true,
      `${stepName} must not poison primary review publication`,
    );
  }

  const exactBundle = step("event-review-apply", "Create exact review artifact bundle");
  assert.match(exactBundle.if ?? "", /review-exact-event-item\.outcome == 'success'/);
  assert.doesNotMatch(exactBundle.if ?? "", /action-ledger/);
  const exactPrimary = step("event-review-apply", "Export exact review generation result");
  const exactQueue = step("event-review-apply", "Complete exact-review queue lease");
  const exactUpload = step("event-review-apply", "Upload exact review artifact bundle");
  const exactPublicationQueue = step(
    "event-review-apply",
    "Queue durable exact review publication",
  );
  const exactSteps = job("event-review-apply").steps;
  assert.match(exactPrimary.run ?? "", /outcome=(?:failure|cancelled|success)/);
  assert.match(exactPrimary.run ?? "", /REVIEW_OUTCOME.*cancelled/);
  assert.match(exactPrimary.run ?? "", /PUBLICATION_QUEUE_OUTCOME.*success/);
  assert.match(exactQueue.env?.PRIMARY_OUTCOME ?? "", /exact-review-generation-result/);
  assert.doesNotMatch(exactQueue.run ?? "", /JOB_STATUS|job\.status/);
  assert.ok(exactSteps.indexOf(exactUpload) < exactSteps.indexOf(exactQueue));
  assert.ok(exactSteps.indexOf(exactUpload) < exactSteps.indexOf(exactPublicationQueue));
  assert.ok(exactSteps.indexOf(exactPublicationQueue) < exactSteps.indexOf(exactQueue));
  assert.ok(exactSteps.indexOf(exactQueue) > exactSteps.indexOf(exactPrimary));
  assert.equal(
    job("event-review-publish").steps.some(
      (candidate) => candidate.name === "Publish exact review action ledger",
    ),
    false,
  );

  const proofMarker = step("apply-proof", "Export primary apply proof result");
  assert.match(proofMarker.if ?? "", /always\(\) && !cancelled\(\)/);
  assert.match(proofMarker.if ?? "", /proof-select\.outcome == 'success'/);
  assert.match(proofMarker.if ?? "", /generate-apply-proofs\.outcome == 'success'/);
  assert.doesNotMatch(proofMarker.if ?? "", /success\(\)|action-ledger/);
  assert.match(job("apply-existing").if ?? "", /needs\.apply-proof\.outputs\.proof_ready/);
  assert.doesNotMatch(
    job("apply-existing").if ?? "",
    /needs\.apply-proof\.result|publish-apply-proof-action-ledger/,
  );

  const applySteps = job("apply-existing").steps;
  const applyMarkerIndex = applySteps.findIndex(
    (candidate) => candidate.name === "Export primary apply result",
  );
  const applyFinalizerIndex = applySteps.findIndex(
    (candidate) => candidate.name === "Finalize apply action ledger",
  );
  assert.ok(applyMarkerIndex >= 0);
  assert.ok(applyFinalizerIndex > applyMarkerIndex);
  const applyMarker = applySteps[applyMarkerIndex]!;
  assert.match(applyMarker.if ?? "", /apply-existing-run\.outcome == 'success'/);
  for (const name of [
    "Retry final apply status publication",
    "Continue apply sweep",
    "Queue review backstops",
  ]) {
    const condition = step("apply-existing", name).if ?? "";
    assert.match(condition, /always\(\) && !cancelled\(\)/, name);
    assert.match(condition, /primary-apply-result\.outputs\.succeeded == 'true'/, name);
    assert.doesNotMatch(condition, /success\(\)|action-ledger/, name);
  }

  const telemetryJob = job("publish-apply-observability");
  assert.deepEqual(telemetryJob.needs, [
    "apply-proof",
    "publish-apply-proof-action-ledger",
    "apply-existing",
  ]);
  assert.match(telemetryJob.if ?? "", /always\(\)/);
  assert.doesNotMatch(telemetryJob.if ?? "", /!cancelled\(\)/);
  assert.match(telemetryJob.if ?? "", /needs\.apply-proof\.result == 'failure'/);
  assert.match(
    telemetryJob.if ?? "",
    /needs\.publish-apply-proof-action-ledger\.result == 'failure'/,
  );
  assert.match(telemetryJob.if ?? "", /needs\.apply-existing\.result == 'failure'/);
  assert.match(telemetryJob.if ?? "", /needs\.apply-existing\.result == 'cancelled'/);
  const telemetryStep = step("publish-apply-observability", "Publish apply telemetry");
  assert.match(telemetryStep.env?.APPLY_OUTCOME ?? "", /needs\.apply-proof\.result == 'failure'/);
  assert.match(
    telemetryStep.env?.APPLY_OUTCOME ?? "",
    /needs\.apply-existing\.result == 'success'/,
  );
  assert.doesNotMatch(telemetryStep.env?.APPLY_OUTCOME ?? "", /publish-apply-proof-action-ledger/);
  assert.match(
    telemetryStep.env?.ACTION_LEDGER_OUTCOME ?? "",
    /needs\.publish-apply-proof-action-ledger\.result == 'failure'/,
  );
  assert.match(telemetryStep.env?.TARGET_REPO ?? "", /openclaw\/clawhub/);
  assert.match(
    telemetryStep.env?.APPLY_STARTED_AT ?? "",
    /needs\.apply-existing\.outputs\.observability_started_at/,
  );
  const applyExisting = job("apply-existing");
  assert.match(
    applyExisting.outputs?.observability_started_at ?? "",
    /steps\.apply-telemetry-start\.outputs\.started_at/,
  );
  const telemetryContext = step("apply-existing", "Save apply telemetry context");
  assert.equal(telemetryContext["continue-on-error"], true);
  assert.match(telemetryContext.run ?? "", /apply-observability-context\.json/);
  const telemetryArtifact = step("apply-existing", "Upload apply telemetry health");
  assert.equal(telemetryArtifact["continue-on-error"], true);
  assert.equal(telemetryArtifact.with?.["include-hidden-files"], true);
  const telemetryStart = step("apply-existing", "Publish apply telemetry start");
  assert.equal(telemetryStart["continue-on-error"], true);
  assert.equal(telemetryStart.env?.APPLY_OUTCOME, "in_progress");
  assert.match(telemetryStart.run ?? "", /publish-apply-observability\.mjs/);
  assert.match(telemetryStart.run ?? "", /apply-observability-context\.json/);
  assert.match(telemetryContext.run ?? "", /apply-telemetry-start\.outputs\.started_at/);
});

// The review token can only read the target. Codex reviews always run in the review sandbox.
test("exact review gives Codex only a read-only target token", () => {
  type Step = { id?: string; name?: string; run?: string; with?: Record<string, string> };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  const steps = workflow.jobs["event-review-apply"]!.steps ?? [];
  const permissions = Object.entries(
    steps.find((step) => step.id === "target-read-token")?.with ?? {},
  ).filter(([key]) => key.startsWith("permission-"));
  assert.ok(permissions.length > 0);
  for (const [key, value] of permissions) assert.equal(value, "read", key);
  const review = steps.find((step) => step.name === "Review exact event item");
  assert.match(review?.run ?? "", /--codex-sandbox clawsweeper-review/);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      assert.doesNotMatch(step.run ?? "", /--codex-sandbox danger-full-access/, step.name);
    }
  }
});

test("comment router target token can inspect checks without widening dispatch authority", () => {
  type TokenStep = {
    id?: string;
    with?: Record<string, string>;
  };
  const workflow = YAML.parse(readText(".github/workflows/repair-comment-router.yml")) as {
    jobs: Record<string, { steps: TokenStep[] }>;
  };
  const steps = workflow.jobs["route-comments"]!.steps;
  const targetToken = steps.find((step) => step.id === "app_token");
  const dispatchToken = steps.find((step) => step.id === "dispatch-token");

  assert.ok(targetToken?.with);
  assert.equal(targetToken.with["permission-checks"], "read");
  assert.equal(targetToken.with["permission-statuses"], "read");
  assert.ok(dispatchToken?.with);
  assert.equal("permission-checks" in dispatchToken.with, false);
  assert.equal("permission-statuses" in dispatchToken.with, false);
});

test("exact event branch guard resolves empty and numeric claims to the repository default", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const run = workflow.jobs["event-review-apply"]?.steps.find(
    (candidate) => candidate.name === "Check live target item state",
  )?.run;
  assert.ok(run);

  const temporary = mkdtempSync(tmpPrefix);
  try {
    const fakeBin = join(temporary, "bin");
    mkdirSync(fakeBin);
    const fakeGh = join(fakeBin, "gh");
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${2:-}" in
  repos/openclaw/openclaw)
    printf 'trunk\\n'
    ;;
  repos/openclaw/openclaw/issues/42)
    printf '{"state":"closed","locked":false}\\n'
    ;;
  *)
    exit 1
    ;;
esac
`,
    );
    chmodSync(fakeGh, 0o755);

    for (const branch of ["", "0"]) {
      const outputPath = join(temporary, branch ? `output-${branch}` : "output-empty");
      execFileSync("bash", ["-c", run], {
        env: {
          ...process.env,
          CLAIM_DECISION: JSON.stringify({ targetBranch: branch }),
          CLAIM_TARGET_BRANCH: branch,
          GH_TOKEN: "test-token",
          CLAWSWEEPER_PUBLIC_GH_TOKEN: "test-actions-token",
          GITHUB_OUTPUT: outputPath,
          ITEM_NUMBER: "42",
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          TARGET_REPO: "openclaw/openclaw",
        },
      });
      const outputs = Object.fromEntries(
        readFileSync(outputPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
      assert.equal(outputs.target_branch, "trunk");
      assert.equal(outputs.admission_retry, "false");
      assert.equal(outputs.terminal_noop, "true");
      assert.equal(JSON.parse(outputs.decision ?? "{}").targetBranch, "trunk");
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("scheduled claim-time no-op completes before target checkout with zero GitHub writes", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
  };
  const run = workflow.jobs["event-review-apply"]?.steps.find(
    (candidate) => candidate.name === "Check live target item state",
  )?.run;
  assert.ok(run);
  const temporary = mkdtempSync(tmpPrefix);
  try {
    const fakeBin = join(temporary, "bin");
    mkdirSync(fakeBin);
    const fakeGh = join(fakeBin, "gh");
    const outputPath = join(temporary, "output");
    const logPath = join(temporary, "gh.log");
    const issue = {
      number: 41,
      title: "Unchanged issue",
      body: "Original body",
      state: "open",
      locked: false,
      updated_at: "2026-08-09T21:12:38Z",
      labels: [],
    };
    const human = {
      id: 1,
      user: { login: "reporter" },
      body: "Existing evidence",
      created_at: "2026-08-09T19:00:00Z",
      updated_at: "2026-08-09T19:00:00Z",
    };
    const revision = scheduledReviewSemanticSourceRevision(issue, [human]);
    const comments = [
      human,
      {
        id: 2,
        user: { login: "clawsweeper[bot]" },
        body: `Unchanged review\n\n<!-- clawsweeper-review-version item=41 reviewed_at=2026-08-09T21:12:33Z sha=na source_revision=${revision} lease_owner=old lease_comment_id=2 v=1 -->`,
        created_at: "2026-08-09T20:00:00Z",
        updated_at: "2026-08-09T21:12:33Z",
      },
    ];
    writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [[ " $* " == *" --method "* ]] || [[ " $* " == *" -X "* ]]; then exit 97; fi
if [[ "$*" == *"repos/openclaw/libterminal/issues/41/comments"* ]]; then
  printf '%s\\n' '${JSON.stringify([comments])}'
elif [[ "$*" == *"repos/openclaw/libterminal/issues/41"* ]]; then
  printf '%s\\n' '${JSON.stringify(issue)}'
else
  exit 1
fi
`,
    );
    chmodSync(fakeGh, 0o755);
    execFileSync("bash", ["-c", run], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAIM_DECISION: JSON.stringify({
          targetBranch: "main",
          sourceAction: "scheduled_hot_intake",
          sourceUpdatedAt: issue.updated_at,
        }),
        CLAIM_TARGET_BRANCH: "main",
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        ITEM_NUMBER: "41",
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        TARGET_REPO: "openclaw/libterminal",
      },
    });
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /^scheduled_noop=true$/m);
    assert.match(output, /^proceed=false$/m);
    assert.match(output, /^terminal_noop=false$/m);
    assert.match(output, /^scheduled_semantic_noop=true$/m);
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /--method|-X/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

// Workflow-only guards keep write credentials behind validation and durable publication gates.
test("exact event review publishes directly with a queue-bounded canonical fallback", () => {
  type Step = {
    "continue-on-error"?: boolean;
    name?: string;
    uses?: string;
    id?: string;
    if?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | number | boolean>;
  };
  type Job = {
    needs?: string | string[];
    if?: string;
    "timeout-minutes"?: number;
    permissions?: Record<string, string>;
    concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
    steps: Step[];
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, Job>;
  };
  const reviewer = workflow.jobs["event-review-apply"]!;
  const publisher = workflow.jobs["event-review-publish"]!;
  const step = (job: Job, name: string) => {
    const value = job.steps.find((candidate) => candidate.name === name);
    assert.ok(value, `missing step: ${name}`);
    return value;
  };

  assert.equal(reviewer.permissions?.contents, "read");
  assert.equal(reviewer["timeout-minutes"], 150);
  assert.equal(reviewer.permissions?.issues, "read");
  assert.equal(
    reviewer.steps.some((candidate) => candidate.uses?.endsWith("/setup-state")),
    true,
  );
  assert.equal(
    reviewer.steps.some(
      (candidate) => candidate.name === "Publish event result and apply safe close",
    ),
    false,
  );
  assert.equal(
    step(reviewer, "Review exact event item").env?.GH_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.equal(
    step(reviewer, "Review exact event item").env?.CLAWSWEEPER_PROOF_INSPECTION_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.equal(step(reviewer, "Review exact event item").env?.REPO_TOKEN, undefined);
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--skip-start-comment/);
  for (const name of [
    "Inspect exact review live proof",
    "Resolve exact live-proof Go version",
    "Set up exact live-proof Go toolchain",
    "Enable exact live-proof automatic Go fallback",
    "Install exact live-proof terminal tools",
    "Install exact live-proof recording tools",
    "Execute exact review live proof",
  ]) {
    assert.equal(
      reviewer.steps.some((candidate) => candidate.name === name),
      false,
      `retired automatic live-proof step remains: ${name}`,
    );
  }

  const reserveLease = step(reviewer, "Reserve exact review lease");
  const markCommandInProgress = step(reviewer, "Mark re-review command in progress");
  const reactToReviewStart = step(reviewer, "React to target item review start");
  assert.doesNotMatch(markCommandInProgress.if ?? "", /oversized/);
  assert.match(markCommandInProgress.if ?? "", /has_command_context == 'true'/);
  assert.notEqual(markCommandInProgress["continue-on-error"], true);
  assert.ok(
    reviewer.steps.indexOf(markCommandInProgress) < reviewer.steps.indexOf(reactToReviewStart),
  );
  assert.match(reactToReviewStart.if ?? "", /terminal_state != 'true'/);
  assert.match(reserveLease.if ?? "", /terminal_state != 'true'/);
  assert.equal(reserveLease.env?.GH_TOKEN, "${{ steps.target-write-token.outputs.token }}");
  assert.match(reserveLease.run ?? "", /pnpm run --silent reserve-review-lease/);
  assert.match(reserveLease.run ?? "", /review-timeout-ms/);
  assert.equal(
    reserveLease.env?.RESOLVED_STATUS_COMMENT_ID,
    "${{ steps.mark-re-review-command-in-progress.outputs.status_comment_id || '' }}",
  );
  assert.match(reserveLease.run ?? "", /queue_only=true/);
  assert.match(reserveLease.run ?? "", /repair:update-command-status/);
  assert.match(reserveLease.run ?? "", /--status-comment-id "\$RESOLVED_STATUS_COMMENT_ID"/);
  assert.match(reserveLease.run ?? "", /--require-queue-authority-fence/);
  assert.match(reserveLease.run ?? "", /--require-mutation/);
  assert.ok(
    (reserveLease.run ?? "").indexOf("review_timeout_ms=") <
      (reserveLease.run ?? "").indexOf('if [ -n "$RESOLVED_STATUS_COMMENT_ID" ]'),
  );
  assert.equal(
    step(reviewer, "Review exact event item").env?.REVIEW_LEASE_QUEUE_ONLY,
    "${{ steps.reserve-exact-review-lease.outputs.queue_only || 'false' }}",
  );
  assert.match(step(reviewer, "Review exact event item").run ?? "", /trust-supplied-review-lease/);
  assert.match(reserveLease.run ?? "", /for attempt in 1 2 3 4 5/);
  assert.match(reserveLease.run ?? "", /RANDOM % 4/);
  assert.match(reserveLease.run ?? "", /status.*superseded/);
  assert.match(
    reserveLease.run ?? "",
    /rate limit exceeded\|secondary rate limit\|HTTP 429/,
    "throttled reservations must defer as held instead of failing",
  );
  assert.match(
    reserveLease.run ?? "",
    /\\"status\\":\\"held\\",\\"retryAt\\":\\"\$retry_at\\",\\"retryKind\\":\\"throttle\\"/,
  );
  assert.match(reserveLease.run ?? "", /reservation\.retryKind === "throttle"/);
  assert.match(reserveLease.run ?? "", /append\("retry_kind", retryKind\)/);
  assert.equal(
    reserveLease.env?.EXACT_REVIEW_ITEM_KEY,
    "${{ steps.claim-exact-review-queue.outputs.item_key }}",
  );
  assert.equal(
    reserveLease.env?.EXACT_REVIEW_CLAIM_GENERATION,
    "${{ steps.claim-exact-review-queue.outputs.claim_generation }}",
  );
  assert.equal(
    reserveLease.env?.EXACT_REVIEW_SOURCE_HEAD_SHA,
    "${{ fromJSON(steps.claim-exact-review-queue.outputs.decision).sourceHeadSha || '' }}",
  );
  const resolvePayload = step(reviewer, "Resolve event payload");
  const liveItem = step(reviewer, "Check live target item state");
  assert.match(resolvePayload.run ?? "", /maxExactReviewCodexTimeoutMs = 2_700_000/);
  assert.match(
    resolvePayload.run ?? "",
    /Math\.min\(maxExactReviewCodexTimeoutMs, configuredValue\)/,
  );
  assert.match(
    resolvePayload.run ?? "",
    /codex_timeout_ms: Math\.min\(\s*maxExactReviewCodexTimeoutMs/,
  );
  assert.equal(
    liveItem.env?.CLAIM_DECISION,
    "${{ steps.claim-exact-review-queue.outputs.decision }}",
  );
  assert.equal(liveItem.env?.GH_TOKEN, "${{ steps.target-read-token.outputs.token }}");
  assert.equal(liveItem.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN, "${{ github.token }}");
  assert.equal(
    liveItem.run?.trim(),
    'pnpm run --silent workflow -- exact-review-admission >> "$GITHUB_OUTPUT"',
  );
  const targetToken = reviewer.steps.find((step) => step.id === "target-write-token");
  assert.match(targetToken?.if ?? "", /scheduled_semantic_noop != 'true'/);
  assert.doesNotMatch(targetToken?.if ?? "", /outputs\.proceed == 'true'/);
  const setupPnpm = reviewer.steps.find((step) => step.id === "setup-pnpm");
  assert.match(setupPnpm?.if ?? "", /target_enabled == 'true'/);
  assert.ok(reviewer.steps.indexOf(setupPnpm!) < reviewer.steps.indexOf(liveItem));
  const bundle = reviewer.steps.find((step) => step.id === "create-exact-review-bundle");
  assert.match(bundle?.if ?? "", /scheduled_semantic_noop != 'true'/);
  const semanticNoopResult = reviewer.steps.find(
    (step) => step.id === "exact-review-generation-result",
  );
  assert.match(semanticNoopResult?.run ?? "", /SCHEDULED_SEMANTIC_NOOP.*outcome=success/s);
  assert.match(
    step(reviewer, "Review exact event item").if ?? "",
    /reserve-exact-review-lease\.outputs\.status == 'posted'/,
  );
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--review-lease-owner/);
  assert.match(step(reviewer, "Review exact event item").run ?? "", /--review-lease-comment-id/);
  assert.match(
    step(reviewer, "Review exact event item").run ?? "",
    /exact-review-queue-request\.js heartbeat --phase review\)/,
  );
  assert.equal(
    step(reviewer, "Review exact event item").env?.EXACT_REVIEW_ITEM_KIND,
    "${{ fromJSON(steps.claim-exact-review-queue.outputs.decision).itemKind }}",
  );
  assert.match(
    step(reviewer, "Review exact event item").run ?? "",
    /review_exit_code.*-eq 78[\s\S]*failure_reason=incomplete_source/,
  );
  assert.match(
    step(reviewer, "Review exact event item").run ?? "",
    /review_exit_code.*-eq 79[\s\S]*failure_reason=findings/,
  );
  assert.match(
    step(reviewer, "Review exact event item").run ?? "",
    /classification == "source_preparation"[\s\S]*retryable == false[\s\S]*reason_code == "source_incompatible"[\s\S]*failure_reason=source_incompatible/,
  );
  assert.match(
    step(reviewer, "Review exact event item").run ?? "",
    /failure_stage=.*failure\.stage[\s\S]*failure_reason_code=.*failure\.reason_code[\s\S]*failure_retryable=.*retryable/,
  );
  assert.match(
    step(reviewer, "Review exact event item").run ?? "",
    /kill -TERM -- "-\$review_pgid"/,
  );
  assert.match(step(reviewer, "Review exact event item").run ?? "", /sleep 60/);

  const create = step(reviewer, "Create exact review artifact bundle");
  const directSetupState = reviewer.steps.find(
    (candidate) => candidate.id === "direct-setup-state",
  );
  assert.ok(directSetupState);
  assert.equal(
    directSetupState.with?.["records-item-number"],
    "${{ steps.target.outputs.item_number }}",
  );
  const prepareDirect = step(reviewer, "Deliver GitHub effects and prepare direct state mutation");
  const postDirect = step(reviewer, "Post direct exact review publication result");
  const finalizeDirect = step(reviewer, "Finalize direct exact review lifecycle");
  const directImplementationDispatch = step(
    reviewer,
    "Dispatch exact high-confidence bug implementation",
  );
  const upload = step(reviewer, "Upload exact review artifact bundle");
  const failureDiagnostics = step(reviewer, "Upload exact review failure diagnostics");
  const queuePublication = step(reviewer, "Queue durable exact review publication");
  const complete = step(reviewer, "Complete exact-review queue lease");
  const generationResult = step(reviewer, "Export exact review generation result");
  const deferHeldReview = step(reviewer, "Defer exact review while same-head lease is held");
  const failGeneration = step(reviewer, "Fail unsuccessful exact review generation");
  const releaseGeneration = step(reviewer, "Release unsuccessful workflow-owned review lease");
  const markUnsuccessful = step(reviewer, "Mark unsuccessful re-review");
  const resolveAutomaticStatus = step(reviewer, "Resolve automatic review status comment");
  const reviewStatusFence = step(reviewer, "Fence automatic review in progress");
  const markAutomatic = step(reviewer, "Mark automatic review in progress");
  const releaseReviewStatusFence = step(reviewer, "Release automatic review status fence");
  const completeStatusFence = step(reviewer, "Fence automatic review completion");
  const markComplete = step(reviewer, "Mark automatic review complete");
  const releaseCompleteStatusFence = step(reviewer, "Release automatic review completion fence");
  const fenceAutomatic = step(reviewer, "Fence terminal automatic review failure");
  const terminalReviewStatus = step(reviewer, "Mark terminal automatic review failure");
  const releaseTerminalStatusFence = step(
    reviewer,
    "Release terminal automatic review status fence",
  );
  assert.match(create.if ?? "", /review-exact-event-item\.outcome == 'success'/);
  assert.match(create.if ?? "", /review-exact-event-item\.outputs\.retry_at == ''/);
  assert.match(create.if ?? "", /review-exact-event-item\.outputs\.superseded != 'true'/);
  assert.doesNotMatch(create.if ?? "", /live-proof|live_proof|inspect-exact|execute-exact/);
  assert.equal(create.env?.EXACT_REVIEW_PRODUCER_JOB, "event-review-apply");
  assert.equal(create.env?.EXACT_REVIEW_DECISION, "${{ steps.live-item.outputs.decision }}");
  assert.equal(create.env?.EXACT_REVIEW_LIVE_PROOF_DIR, undefined);
  assert.doesNotMatch(directSetupState.if ?? "", /live-proof|live_proof|execute-exact/);
  assert.match(create.run ?? "", /mkdir -p \.artifacts/);
  assert.ok(
    (create.run ?? "").indexOf("mkdir -p .artifacts") <
      (create.run ?? "").indexOf("exact-review-bundle create"),
  );
  assert.equal(upload.uses, "actions/upload-artifact@v7");
  assert.equal(failureDiagnostics.uses, "actions/upload-artifact@v7");
  assert.equal(failureDiagnostics["continue-on-error"], true);
  assert.match(
    failureDiagnostics.if ?? "",
    /review-exact-event-item\.outputs\.failure_diagnostics == 'true'/,
  );
  assert.match(failureDiagnostics.if ?? "", /always\(\) && !cancelled\(\)/);
  assert.equal(
    failureDiagnostics.with?.name,
    "exact-review-failure-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(failureDiagnostics.with?.path, "artifacts/event/failure-diagnostics/");
  assert.equal(failureDiagnostics.with?.["retention-days"], 14);
  assert.equal(failureDiagnostics.with?.["include-hidden-files"], false);
  assert.equal(failureDiagnostics.with?.["if-no-files-found"], "error");
  assert.match(resolveAutomaticStatus.if ?? "", /itemKind == 'pull_request'/);
  assert.match(resolveAutomaticStatus.run ?? "", /page <= 10/);
  assert.doesNotMatch(resolveAutomaticStatus.run ?? "", /--paginate/);
  assert.match(resolveAutomaticStatus.run ?? "", /leaving existing comments untouched/);
  assert.match(resolveAutomaticStatus.run ?? "", /clawsweeper-pr-ack:/);
  assert.match(resolveAutomaticStatus.run ?? "", /clawsweeper-review-progress:start/);
  assert.match(reviewStatusFence.if ?? "", /automatic-review-status\.outputs\.status_comment_id/);
  const acknowledgedStatusHeartbeat =
    /exact-review-queue-request\.js heartbeat --phase status \\\n\s*--review-acknowledgement-comment-id "\$REVIEW_ACKNOWLEDGEMENT_COMMENT_ID"/;
  assert.match(reviewStatusFence.run ?? "", acknowledgedStatusHeartbeat);
  assert.match(reviewStatusFence.if ?? "", /has_command_context != 'true'/);
  assert.match(
    reviewStatusFence.if ?? "",
    /reserve-exact-review-lease\.outputs\.status == 'posted'/,
  );
  assert.match(markAutomatic.if ?? "", /review-status-fence\.outputs\.authorized/);
  assert.match(markAutomatic.run ?? "", /repair:update-review-status/);
  assert.match(markAutomatic.run ?? "", /--state reviewing/);
  assert.match(releaseReviewStatusFence.run ?? "", /heartbeat --phase review\)/);
  assert.match(releaseReviewStatusFence.run ?? "", /authorized=false/);
  assert.match(releaseReviewStatusFence.run ?? "", /authorized=true/);
  assert.match(releaseReviewStatusFence.run ?? "", /status.*409/);
  const reviewExactItem = step(reviewer, "Review exact event item");
  assert.match(reviewExactItem.if ?? "", /review-status-fence\.outcome == 'skipped'/);
  assert.match(
    reviewExactItem.if ?? "",
    /release-review-status-fence\.outputs\.authorized == 'true'/,
  );
  assert.match(completeStatusFence.if ?? "", /review-exact-event-item\.outputs\.exit_code == '0'/);
  assert.match(
    completeStatusFence.if ?? "",
    /review-exact-event-item\.outputs\.superseded != 'true'/,
  );
  assert.doesNotMatch(completeStatusFence.if ?? "", /terminal_during_review != 'true'/);
  assert.match(completeStatusFence.if ?? "", /review-exact-event-item\.outputs\.retry_at == ''/);
  assert.match(completeStatusFence.run ?? "", acknowledgedStatusHeartbeat);
  assert.match(completeStatusFence.run ?? "", /internal\/exact-review\/heartbeat/);
  assert.match(markComplete.if ?? "", /review-complete-status-fence\.outputs\.authorized/);
  assert.match(markComplete.env?.REVIEW_STATUS_STATE ?? "", /terminal_during_review/);
  assert.match(markComplete.run ?? "", /--state "\$REVIEW_STATUS_STATE"/);
  assert.notEqual(markComplete["continue-on-error"], true);
  assert.match(releaseCompleteStatusFence.run ?? "", /heartbeat --phase finalizing\)/);
  assert.ok(
    reviewer.steps.indexOf(markComplete) < reviewer.steps.indexOf(releaseCompleteStatusFence),
  );
  assert.match(fenceAutomatic.if ?? "", /failure_reason != ''/);
  assert.equal(fenceAutomatic["continue-on-error"], true);
  assert.match(fenceAutomatic.run ?? "", acknowledgedStatusHeartbeat);
  assert.match(fenceAutomatic.run ?? "", /internal\/exact-review\/heartbeat/);
  assert.match(terminalReviewStatus.if ?? "", /terminal-review-status-fence\.outputs\.authorized/);
  assert.match(terminalReviewStatus.run ?? "", /--state blocked/);
  assert.match(terminalReviewStatus.run ?? "", /--failure-reason/);
  assert.match(releaseTerminalStatusFence.run ?? "", /heartbeat --phase finalizing\)/);
  assert.ok(
    reviewer.steps.indexOf(terminalReviewStatus) <
      reviewer.steps.indexOf(releaseTerminalStatusFence),
  );
  assert.ok(reviewer.steps.indexOf(terminalReviewStatus) < reviewer.steps.indexOf(complete));
  // The queue request command builds review_failure_status from these step results.
  assert.match(complete.run ?? "", /payload="\$\(node "\$request" complete body\)"/);
  assert.match(complete.env?.REVIEW_STATUS_VERIFIED ?? "", /terminal-review-status/);
  assert.match(complete.env?.REVIEW_ACKNOWLEDGEMENT_COMMENT_ID ?? "", /automatic-review-status/);
  assert.ok(reviewer.steps.indexOf(failureDiagnostics) > reviewer.steps.indexOf(queuePublication));
  assert.ok(reviewer.steps.indexOf(failureDiagnostics) > reviewer.steps.indexOf(complete));
  assert.ok(reviewer.steps.indexOf(failureDiagnostics) < reviewer.steps.indexOf(failGeneration));
  assert.doesNotMatch(queuePublication.if ?? "", /failure-diagnostics/);
  assert.doesNotMatch(JSON.stringify(queuePublication), /failure-diagnostics/);
  assert.match(prepareDirect.run ?? "", /repair:publish-event-result/);
  assert.equal(prepareDirect.env?.GH_TOKEN, "${{ steps.target-write-token.outputs.token }}");
  assert.equal(prepareDirect.env?.REPO_TOKEN, "${{ github.token }}");
  assert.equal(
    prepareDirect.env?.EXACT_REVIEW_BATCH_MUTATION_OUTPUT,
    ".artifacts/direct-publication-outcome.json",
  );
  assert.match(postDirect.run ?? "", /repair:exact-review-direct-publication/);
  assert.equal(
    postDirect.env?.EXACT_REVIEW_DIRECT_SOURCE_ACTION,
    "${{ fromJSON(steps.claim-exact-review-queue.outputs.decision).sourceAction }}",
  );
  assert.match(
    finalizeDirect.if ?? "",
    /direct-exact-review-publication\.outputs\.accepted == 'true'/,
  );
  assert.equal(finalizeDirect.id, "finalize-direct-exact-review-lifecycle");
  assert.equal(
    finalizeDirect.env?.DIRECT_PUBLICATION_SUPERSEDED,
    "${{ steps.direct-exact-review-publication.outputs.superseded }}",
  );
  assert.match(finalizeDirect.run ?? "", /direct_lifecycle_requeue=false/);
  assert.match(finalizeDirect.run ?? "", /direct_lifecycle_requeue=true/);
  assert.doesNotMatch(finalizeDirect.run ?? "", /internal\/exact-review\/enqueue/);
  assert.match(finalizeDirect.run ?? "", /lifecycle\/router-receipt/);
  assert.match(finalizeDirect.run ?? "", /lifecycle\/terminal-disposition/);
  assert.match(finalizeDirect.run ?? "", /router-direct-proof/);
  assert.match(finalizeDirect.run ?? "", /lifecycle_deferred_coverage="true"/);
  const directLifecycleHandoff = Math.max(
    (finalizeDirect.run ?? "").indexOf("lifecycle/router-receipt"),
    (finalizeDirect.run ?? "").indexOf("lifecycle/terminal-disposition"),
  );
  assert.ok(directLifecycleHandoff >= 0);
  assert.match(
    directImplementationDispatch.run ?? "",
    /dispatch-issue-implementation-candidates\.mjs/,
  );
  assert.match(
    directImplementationDispatch.if ?? "",
    /finalize-direct-exact-review-lifecycle\.outcome == 'success'/,
  );
  assert.ok(
    reviewer.steps.indexOf(finalizeDirect) < reviewer.steps.indexOf(directImplementationDispatch),
  );
  assert.ok(reviewer.steps.indexOf(directImplementationDispatch) < reviewer.steps.indexOf(upload));
  assert.doesNotMatch(finalizeDirect.run ?? "", /lifecycle\/command-ack\/attempt/);
  assert.doesNotMatch(finalizeDirect.run ?? "", /repair:update-command-status/);
  assert.match(reviewer.if ?? "", /source_action != 'exact_review_command_acknowledgement'/);
  assert.match(
    upload.if ?? "",
    /direct-exact-review-publication\.outputs\.accepted != 'true' \|\| steps\.finalize-direct-exact-review-lifecycle\.outcome != 'success'/,
  );
  assert.equal(upload.with?.["retention-days"], 90);
  assert.match(queuePublication.run ?? "", /control_plane_signed_post/);
  assert.match(
    queuePublication.run ?? "",
    /payload="\$\(node dist\/repair\/exact-review-queue-request\.js enqueue publication\)"/,
  );
  assert.equal(queuePublication.env?.CLAIM_DECISION, "${{ steps.live-item.outputs.decision }}");
  assert.equal(
    generationResult.env?.ADMISSION_RETRY,
    "${{ steps.live-item.outputs.admission_retry }}",
  );
  assert.match(generationResult.env?.RETRY_KIND ?? "", /live-item\.outputs\.retry_kind/);
  assert.match(generationResult.env?.RETRY_AT ?? "", /live-item\.outputs\.retry_at/);
  assert.equal(
    generationResult.env?.DIRECT_PUBLICATION_FAILURE_KIND,
    "${{ steps.prepare-direct-exact-review-publication.outputs.failure_kind }}",
  );
  assert.equal(
    generationResult.env?.DIRECT_PUBLICATION_RETRY_AT,
    "${{ steps.prepare-direct-exact-review-publication.outputs.retry_at }}",
  );
  assert.equal(
    generationResult.env?.COMMAND_TERMINAL_STATE,
    "${{ steps.mark-re-review-command-in-progress.outputs.terminal_state || 'false' }}",
  );
  assert.equal(
    generationResult.env?.COMMAND_AUTHORITY_SUPERSEDED,
    "${{ steps.command-status-fence.outputs.superseded == 'true' || steps.mark-re-review-command-in-progress.outputs.queue_superseded == 'true' }}",
  );
  assert.match(generationResult.run ?? "", /COMMAND_AUTHORITY_SUPERSEDED.*outcome=success/s);
  assert.match(
    generationResult.run ?? "",
    /DIRECT_PUBLICATION_FAILURE_KIND.*github_rate_limit.*PUBLICATION_QUEUE_OUTCOME.*!=.*success[\s\S]*retry_kind=throttle[\s\S]*retry_at="\$DIRECT_PUBLICATION_RETRY_AT"/,
  );
  assert.match(generationResult.run ?? "", /ADMISSION_RETRY.*true.*-z.*retry_kind/s);
  assert.match(generationResult.run ?? "", /ADMISSION_RETRY.*true[\s\S]*outcome=success/);
  assert.match(generationResult.run ?? "", /requeue_latest=true/);
  assert.match(generationResult.run ?? "", /echo "retry_kind=\$retry_kind"/);
  assert.match(generationResult.run ?? "", /echo "retry_at=\$retry_at"/);
  const runGenerationResult = (overrides: Record<string, string>) => {
    const root = mkdtempSync(`${tmpPrefix}exact-review-generation-result-`);
    const outputPath = join(root, "github-output");
    try {
      execFileSync("bash", ["-c", generationResult.run ?? ""], {
        env: {
          ...process.env,
          ADMISSION_RETRY: "false",
          RETRY_KIND: "",
          RETRY_AT: "",
          DIRECT_PUBLICATION_FAILURE_KIND: "",
          DIRECT_PUBLICATION_RETRY_AT: "",
          TARGET_ENABLED: "true",
          LIVE_OUTCOME: "success",
          COMMAND_TERMINAL_STATE: "false",
          COMMAND_AUTHORITY_SUPERSEDED: "false",
          REVIEW_OUTCOME: "success",
          REVIEW_SUPERSEDED: "false",
          RESERVATION_STATUS: "",
          PUBLICATION_QUEUE_OUTCOME: "failure",
          DIRECT_PUBLICATION_ACCEPTED: "false",
          DIRECT_PUBLICATION_SUPERSEDED: "false",
          DIRECT_LIFECYCLE_OUTCOME: "failure",
          DIRECT_LIFECYCLE_REQUEUE: "false",
          GITHUB_OUTPUT: outputPath,
          ...overrides,
        },
      });
      return Object.fromEntries(
        readFileSync(outputPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const directRetryAt = "2026-08-06T00:00:00.000Z";
  assert.deepEqual(runGenerationResult({ COMMAND_TERMINAL_STATE: "true" }), {
    outcome: "success",
    requeue_latest: "false",
    direct_lifecycle_requeue: "false",
    retry_kind: "",
    retry_at: "",
  });
  assert.deepEqual(runGenerationResult({ COMMAND_AUTHORITY_SUPERSEDED: "true" }), {
    outcome: "success",
    requeue_latest: "false",
    direct_lifecycle_requeue: "false",
    retry_kind: "",
    retry_at: "",
  });
  assert.deepEqual(
    runGenerationResult({
      DIRECT_PUBLICATION_FAILURE_KIND: "github_rate_limit",
      DIRECT_PUBLICATION_RETRY_AT: directRetryAt,
      PUBLICATION_QUEUE_OUTCOME: "success",
    }),
    {
      outcome: "success",
      requeue_latest: "false",
      direct_lifecycle_requeue: "false",
      retry_kind: "",
      retry_at: "",
    },
  );
  assert.deepEqual(
    runGenerationResult({
      DIRECT_PUBLICATION_FAILURE_KIND: "github_rate_limit",
      DIRECT_PUBLICATION_RETRY_AT: directRetryAt,
      PUBLICATION_QUEUE_OUTCOME: "failure",
    }),
    {
      outcome: "failure",
      requeue_latest: "false",
      direct_lifecycle_requeue: "false",
      retry_kind: "throttle",
      retry_at: directRetryAt,
    },
  );
  assert.equal(
    step(reviewer, "Export exact review generation result").env?.DIRECT_LIFECYCLE_OUTCOME,
    "${{ steps.finalize-direct-exact-review-lifecycle.outcome }}",
  );
  assert.equal(
    generationResult.env?.DIRECT_LIFECYCLE_REQUEUE,
    "${{ steps.finalize-direct-exact-review-lifecycle.outputs.direct_lifecycle_requeue || 'false' }}",
  );
  assert.match(
    step(reviewer, "Export exact review generation result").run ?? "",
    /DIRECT_LIFECYCLE_OUTCOME.*success/s,
  );
  assert.match(generationResult.run ?? "", /direct_lifecycle_requeue=\$DIRECT_LIFECYCLE_REQUEUE/);
  assert.match(complete.if ?? "", /finalize-direct-exact-review-lifecycle\.outcome == 'success'/);
  assert.equal(
    complete.env?.DIRECT_PUBLICATION_ACCEPTED,
    "${{ steps.direct-exact-review-publication.outputs.accepted }}",
  );
  assert.equal(
    complete.env?.DIRECT_PUBLICATION_SUPERSEDED,
    "${{ steps.direct-exact-review-publication.outputs.superseded }}",
  );
  assert.equal(
    complete.env?.DIRECT_LIFECYCLE_OUTCOME,
    "${{ steps.finalize-direct-exact-review-lifecycle.outcome }}",
  );
  assert.equal(
    complete.env?.DIRECT_LIFECYCLE_REQUEUE,
    "${{ steps.exact-review-generation-result.outputs.direct_lifecycle_requeue }}",
  );
  // The completion and direct lifecycle bodies are behavior-tested in
  // test/repair/exact-review-queue-request.test.ts.
  assert.match(complete.run ?? "", /payload="\$\(node "\$request" complete body\)"/);
  assert.match(complete.env?.PRIMARY_OUTCOME ?? "", /exact-review-generation-result/);
  assert.match(complete.env?.REQUEUE_LATEST ?? "", /exact-review-generation-result/);
  assert.equal(
    complete.env?.RETRY_AT,
    "${{ steps.exact-review-generation-result.outputs.retry_at }}",
  );
  assert.equal(
    complete.env?.RETRY_KIND,
    "${{ steps.exact-review-generation-result.outputs.retry_kind }}",
  );
  assert.equal(
    complete.env?.REVIEW_FAILURE_REASON,
    "${{ steps.review-exact-event-item.outputs.failure_reason || '' }}",
  );
  assert.equal(
    complete.env?.REVIEW_FAILURE_STAGE,
    "${{ steps.review-exact-event-item.outputs.failure_stage || '' }}",
  );
  assert.equal(
    complete.env?.REVIEW_FAILURE_REASON_CODE,
    "${{ steps.review-exact-event-item.outputs.failure_reason_code || '' }}",
  );
  assert.equal(
    complete.env?.REVIEW_FAILURE_RETRYABLE,
    "${{ steps.review-exact-event-item.outputs.failure_retryable || '' }}",
  );
  assert.match(deferHeldReview.if ?? "", /reserve-exact-review-lease\.outputs\.status == 'held'/);
  assert.match(deferHeldReview.run ?? "", /retry deferred/);
  assert.match(failGeneration.if ?? "", /reserve-exact-review-lease\.outputs\.status != 'held'/);
  assert.match(
    failGeneration.if ?? "",
    /reserve-exact-review-lease\.outputs\.status != 'superseded'/,
  );
  assert.match(failGeneration.if ?? "", /review-exact-event-item\.outputs\.superseded != 'true'/);
  assert.match(failGeneration.if ?? "", /complete-exact-review-queue\.outcome != 'success'/);
  assert.equal(
    markUnsuccessful.env?.REVIEW_FAILURE_REASON,
    "${{ steps.review-exact-event-item.outputs.failure_reason || '' }}",
  );
  assert.match(
    markUnsuccessful.run ?? "",
    /incomplete_source[\s\S]*will not retry this unchanged revision/,
  );
  assert.match(markUnsuccessful.run ?? "", /findings[\s\S]*will not retry this unchanged revision/);
  assert.match(
    markUnsuccessful.run ?? "",
    /source_incompatible[\s\S]*will not retry this unchanged revision; update or rebase/,
  );
  assert.match(
    failGeneration.if ?? "",
    /exact-review-generation-result\.outputs\.retry_kind == ''/,
  );
  assert.match(releaseGeneration.if ?? "", /reserve-exact-review-lease\.outputs\.status != 'held'/);
  assert.match(releaseGeneration.if ?? "", /terminal_state != 'true'/);
  assert.match(markUnsuccessful.if ?? "", /terminal_state != 'true'/);
  assert.match(markUnsuccessful.if ?? "", /review-exact-event-item\.outputs\.superseded != 'true'/);
  assert.match(
    markUnsuccessful.if ?? "",
    /release-review-complete-status-fence\.outputs\.superseded != 'true'/,
  );
  assert.match(markUnsuccessful.run ?? "", /--refuse-terminal-state/);
  assert.match(markUnsuccessful.run ?? "", /--require-queue-authority-fence/);
  assert.match(markUnsuccessful.run ?? "", /internal\/exact-review\/heartbeat/);
  assert.ok(
    (markUnsuccessful.run ?? "").indexOf("internal/exact-review/heartbeat") <
      (markUnsuccessful.run ?? "").indexOf('state="Failed"'),
  );
  assert.match(markUnsuccessful.run ?? "", /lease_superseded.*exit 0/s);
  assert.match(releaseGeneration.run ?? "", /content == "eyes"/);
  for (const cleanup of [releaseGeneration, step(reviewer, "Mark unsuccessful re-review")]) {
    for (const kind of ["github_rate_limit", "github_transient"]) {
      assert.match(
        cleanup.if ?? "",
        new RegExp(`prepare-direct-exact-review-publication\\.outputs\\.failure_kind != '${kind}'`),
      );
    }
  }
  assert.ok(reviewer.steps.indexOf(upload) < reviewer.steps.indexOf(complete));

  assert.equal(publisher.needs, undefined);
  assert.match(publisher.if ?? "", /source_action == 'exact_review_artifact_publish'/);
  assert.match(
    step(publisher, "Claim durable exact review publication").run ?? "",
    /internal\/exact-review\/claim/,
  );
  assert.equal(publisher.concurrency, undefined);
  assert.equal(publisher.permissions?.actions, "write");
  const publicationContext = step(publisher, "Claim durable exact review publication");
  assert.match(
    publicationContext.run ?? "",
    /producerDecision\.commandStatusMarker \|\| producerDecision\.statusCommentId/,
  );
  assert.match(publicationContext.run ?? "", /directLifecycleRecovery/);
  assert.match(publicationContext.run ?? "", /directLifecycleRecoveryReady/);
  assert.match(
    publicationContext.run ?? "",
    /const publicationLeaseRevision = Number\(publication\?\.leaseRevision\);/,
  );
  assert.match(publicationContext.run ?? "", /publicationLeaseRevision === leaseRevision/);
  assert.match(publicationContext.run ?? "", /direct_lifecycle_plan/);
  assert.match(publicationContext.run ?? "", /direct_lifecycle_receipt_outcome/);
  assert.match(publicationContext.run ?? "", /deferredPublication/);
  assert.match(
    publicationContext.run ?? "",
    /response\.item_key === directItemKey\s*&&\s*publication\?\.itemKey === directItemKey/,
  );

  const download = step(publisher, "Download exact review artifact bundle");
  const validate = step(publisher, "Validate exact review artifact bundle");
  const foldLiveProof = step(publisher, "Fold exact live proof into the review artifact");
  const legacyArtifact = step(publisher, "Identify legacy tuple-less exact artifact");
  const targetWriteStep = step(publisher, "Create target write token");
  const stateSetup = publisher.steps.find((candidate) => candidate.uses?.endsWith("/setup-state"));
  assert.ok(stateSetup);
  assert.equal(
    stateSetup.with?.["records-item-number"],
    "${{ steps.publication-context.outputs.item_number }}",
  );
  const publisherCheckout = publisher.steps.find(
    (candidate) => candidate.uses === "actions/checkout@v7" && candidate.if,
  );
  assert.ok(publisherCheckout);
  assert.equal(publisherCheckout.with?.ref, "main");
  assert.match(publisherCheckout.if ?? "", /direct_lifecycle_recovery != 'true'/);
  assert.equal(download.uses, "actions/download-artifact@v8");
  assert.match(download.if ?? "", /direct_lifecycle_recovery != 'true'/);
  assert.equal(download["continue-on-error"], true);
  assert.equal(download.with?.name, "${{ steps.publication-context.outputs.artifact_name }}");
  assert.equal(
    download.with?.["run-id"],
    "${{ steps.publication-context.outputs.producer_run_id }}",
  );
  assert.match(validate.run ?? "", /repair:exact-review-bundle validate/);
  assert.match(validate.if ?? "", /direct_lifecycle_recovery != 'true'/);
  assert.equal(validate["continue-on-error"], true);
  assert.equal(foldLiveProof.id, "fold-exact-live-proof");
  assert.equal(foldLiveProof["continue-on-error"], true);
  const foldFixtureRoot = mkdtempSync(`${tmpPrefix}exact-live-proof-fold-`);
  const fakeBin = join(foldFixtureRoot, "bin");
  mkdirSync(fakeBin);
  const fakeNode = join(fakeBin, "node");
  writeFileSync(
    fakeNode,
    '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_NODE_STDOUT"\nexit "${FAKE_NODE_STATUS:-0}"\n',
    "utf8",
  );
  chmodSync(fakeNode, 0o755);
  try {
    for (const [index, scenario] of [
      {
        name: "published success",
        stdout: '{"status":"published","results":[]}',
        commandStatus: 0,
        expectedStatus: 0,
        expectedResult: "published",
      },
      {
        name: "invalid artifact",
        stdout: '{"status":"invalid_artifact"}',
        commandStatus: 1,
        expectedStatus: 1,
        expectedResult: "invalid_artifact",
      },
      {
        name: "retryable failure",
        stdout: '{"status":"retryable_failure"}',
        commandStatus: 1,
        expectedStatus: 1,
        expectedResult: "retryable_failure",
      },
      {
        name: "nonzero junk",
        stdout: "not-json",
        commandStatus: 1,
        expectedStatus: 1,
        expectedResult: "retryable_failure",
      },
      {
        name: "zero-exit junk",
        stdout: "not-json",
        commandStatus: 0,
        expectedStatus: 1,
        expectedResult: "retryable_failure",
      },
    ].entries()) {
      const outputPath = join(foldFixtureRoot, `github-output-${index}`);
      const execution = spawnSync("bash", ["-c", foldLiveProof.run ?? ""], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_NODE_STATUS: String(scenario.commandStatus),
          FAKE_NODE_STDOUT: scenario.stdout,
          GITHUB_OUTPUT: outputPath,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
        },
      });
      assert.equal(execution.status, scenario.expectedStatus, scenario.name);
      assert.equal(
        readFileSync(outputPath, "utf8").trim(),
        `result=${scenario.expectedResult}`,
        scenario.name,
      );
    }
  } finally {
    rmSync(foldFixtureRoot, { recursive: true, force: true });
  }
  assert.match(legacyArtifact.run ?? "", /review_lease_owner/);
  assert.match(legacyArtifact.run ?? "", /review_lease_comment_id/);
  assert.doesNotMatch(create.run ?? "", /repair:exact-review-bundle -- create/);
  assert.doesNotMatch(validate.run ?? "", /repair:exact-review-bundle -- validate/);
  assert.ok(publisher.steps.indexOf(validate) < publisher.steps.indexOf(targetWriteStep));
  assert.ok(publisher.steps.indexOf(validate) < publisher.steps.indexOf(stateSetup));
  for (const guardedStep of [
    legacyArtifact,
    step(publisher, "Stage validated exact review artifact"),
    targetWriteStep,
    stateSetup,
    step(publisher, "Publish event result and apply safe close"),
  ]) {
    assert.match(guardedStep.if ?? "", /fold-exact-live-proof\.outcome == 'success'/);
    assert.doesNotMatch(guardedStep.if ?? "", /validate-exact-review-bundle/);
  }
  assert.match(stateSetup.if ?? "", /legacy-exact-artifact\.outputs\.legacy_tupleless != 'true'/);
  assert.match(stateSetup.if ?? "", /direct_lifecycle_recovery != 'true'/);

  const replayDirect = step(publisher, "Replay committed direct lifecycle handoff");
  assert.match(replayDirect.if ?? "", /direct_lifecycle_recovery == 'true'/);
  assert.match(replayDirect.run ?? "", /router_deferred_coverage/);
  assert.match(replayDirect.run ?? "", /router_not_required/);
  assert.match(replayDirect.run ?? "", /repair-comment-router\.yml/);
  assert.match(replayDirect.run ?? "", /"\$request" lifecycle router-receipt/);
  assert.match(replayDirect.run ?? "", /"\$request" lifecycle terminal-disposition/);
  assert.match(replayDirect.run ?? "", /direct_requeue=true/);
  assert.doesNotMatch(replayDirect.run ?? "", /internal\/exact-review\/enqueue/);
  assert.doesNotMatch(replayDirect.run ?? "", /repair:publish-event-result/);
  assert.doesNotMatch(replayDirect.run ?? "", /repair:update-command-status/);
  assert.doesNotMatch(replayDirect.run ?? "", /lifecycle\/command-ack/);

  const publish = step(publisher, "Publish event result and apply safe close");
  assert.match(publish.run ?? "", /live_state=.*gh api/);
  assert.match(publish.run ?? "", /LIVE_TERMINAL_NOOP.*LIVE_TERMINAL_MISSING/);
  assert.match(publish.run ?? "", /LIVE_GUARDED_OPEN/);
  assert.match(publish.run ?? "", /live_locked=.*jq -r '\.locked == true'/);
  assert.match(publish.run ?? "", /live_locked.*true[\s\S]*guarded_open=true/);
  assert.match(publish.run ?? "", /open\)[\s\S]*?requeue_latest=true/);
  assert.match(publish.run ?? "", /test -f "artifacts\/event\/\$ITEM_NUMBER\.md"/);
  assert.match(publish.run ?? "", /repair:publish-event-result/);
  assert.match(publish.run ?? "", /failure_kind=github_rate_limit/);
  assert.match(publish.run ?? "", /failure_kind=github_transient/);
  assert.match(publish.run ?? "", /HTTP 429/);
  assert.doesNotMatch(publish.run ?? "", /HTTP \(403\|429\)/);
  assert.match(publish.run ?? "", /PIPESTATUS\[0\]/);
  assert.equal(publish.env?.EXACT_EVENT_PUBLICATION, "true");
  assert.equal(
    publisher.steps.some((candidate) => candidate.name === "Route synced ClawSweeper verdict"),
    false,
  );
  const deferredRoute = step(publisher, "Queue deferred exact verdict router");
  assert.match(deferredRoute.if ?? "", /publish-event-result\.outcome == 'success'/);
  assert.match(deferredRoute.if ?? "", /routing_deferred == 'true'/);
  assert.match(deferredRoute.run ?? "", /repair-comment-router\.yml/);
  assert.equal(
    deferredRoute.env?.ITEM_NUMBER,
    "${{ steps.publication-context.outputs.item_number }}",
  );
  assert.match(deferredRoute.run ?? "", /-f item_numbers="\$ITEM_NUMBER"/);
  const drift = step(publisher, "Queue fresh review after source drift");
  assert.match(drift.if ?? "", /requeue_latest == 'true'/);
  assert.match(drift.if ?? "", /legacy-exact-artifact\.outputs\.legacy_tupleless == 'true'/);
  assert.match(drift.run ?? "", /control_plane_signed_post /);
  assert.match(drift.run ?? "", /internal\/exact-review\/enqueue/);
  assert.match(
    drift.run ?? "",
    /payload="\$\(node dist\/repair\/exact-review-queue-request\.js enqueue source-drift\)"/,
  );
  assert.match(drift.run ?? "", /\.queued == true or \.deduped == true or \.shed == true/);
  assert.match(drift.run ?? "", /Source-drift recovery shed by exact-review queue backpressure/);
  const reaction = step(publisher, "React to target item completion");
  assert.match(reaction.if ?? "", /requeue_latest != 'true'/);
  assert.doesNotMatch(reaction.if ?? "", /publication-context.*live_guarded_open/);
  assert.equal(
    publisher.steps.some((candidate) => candidate.name === "Publish exact review action ledger"),
    false,
  );
  const publishResult = step(publisher, "Export exact review publication result");
  const publishComplete = step(publisher, "Complete durable exact review publication");
  const activeLeaseWaiting = step(publisher, "Mark active lease retry waiting");
  assert.equal(
    publisher.steps.some(
      (candidate) => candidate.name === "Probe GitHub pressure after publication failure",
    ),
    false,
  );
  const releaseTerminal = step(publisher, "Release terminal review leases");
  const releaseUnsuccessful = step(
    publisher,
    "Release superseded or unsuccessful publisher-owned review lease",
  );
  assert.doesNotMatch(releaseTerminal.if ?? "", /publication-context.*live_terminal_noop/);
  assert.match(releaseTerminal.if ?? "", /publish-event-result.*terminal_noop/);
  assert.match(releaseUnsuccessful.run ?? "", /\.user\.login == \\"clawsweeper\[bot\]\\"/);
  assert.match(releaseTerminal.run ?? "", /clawsweeper-command-review-lease/);
  assert.match(releaseUnsuccessful.run ?? "", /clawsweeper-command-review-lease/);
  assert.match(releaseUnsuccessful.run ?? "", /clawsweeper-command-/);
  assert.match(releaseUnsuccessful.run ?? "", /continue/);
  assert.match(releaseUnsuccessful.run ?? "", /content == "eyes"/);
  assert.match(releaseUnsuccessful.if ?? "", /completion_kind == 'superseded'/);
  assert.doesNotMatch(releaseUnsuccessful.if ?? "", /completion_kind == 'deferred'/);
  for (const kind of ["github_rate_limit", "github_transient"]) {
    assert.match(
      releaseUnsuccessful.if ?? "",
      new RegExp(`publish-event-result\\.outputs\\.failure_kind != '${kind}'`),
    );
  }
  assert.match(publishResult.env?.PRIOR_JOB_STATUS ?? "", /job\.status/);
  assert.match(publishResult.env?.LEGACY_TUPLELESS ?? "", /legacy-exact-artifact/);
  assert.match(publishResult.env?.FAILURE_KIND ?? "", /publish-event-result/);
  assert.doesNotMatch(publishResult.env?.FAILURE_KIND ?? "", /publication-pressure/);
  assert.match(publishResult.env?.DOWNLOAD_OUTCOME ?? "", /download-exact-review-bundle/);
  assert.match(publishResult.env?.VALIDATE_OUTCOME ?? "", /validate-exact-review-bundle/);
  assert.match(publishResult.env?.LIVE_PROOF_RESULT ?? "", /fold-exact-live-proof/);
  assert.match(publishResult.env?.PUBLISH_COMPLETION_KIND ?? "", /publish-event-result/);
  assert.match(publishResult.env?.PUBLISH_RETRY_AT ?? "", /publish-event-result/);
  assert.match(publishResult.env?.DIRECT_RECOVERY_OUTCOME ?? "", /replay-direct-lifecycle/);
  assert.match(publishResult.env?.DIRECT_RECOVERY_DIRECT_REQUEUE ?? "", /replay-direct-lifecycle/);
  assert.match(publishResult.run ?? "", /DIRECT_RECOVERY_OUTCOME/);
  assert.match(publishResult.run ?? "", /direct_requeue=/);
  assert.match(publishResult.run ?? "", /REQUEUE_LATEST.*SOURCE_DRIFT_OUTCOME/);
  assert.match(publishResult.run ?? "", /LEGACY_TUPLELESS.*SOURCE_DRIFT_OUTCOME/);
  assert.match(publishResult.run ?? "", /completion_kind=superseded/);
  assert.match(publishResult.run ?? "", /completion_kind=deferred/);
  assert.match(publishResult.run ?? "", /completion_kind=refresh_required/);
  assert.match(publishResult.run ?? "", /reason_code=close_coverage_retry/);
  assert.match(publishResult.run ?? "", /reason_code=close_coverage_deferred/);
  assert.match(publishResult.run ?? "", /reason_code=review_lease_active/);
  assert.match(publishResult.run ?? "", /reason_code=review_lease_active[\s\S]*?outcome=success/);
  assert.match(publishResult.run ?? "", /retry_at="\$PUBLISH_RETRY_AT"/);
  assert.match(
    publishResult.run ?? "",
    /reason_code="\$FAILURE_KIND"\s+retry_at="\$PUBLISH_RETRY_AT"/,
  );
  assert.match(
    publishResult.run ?? "",
    /completion_kind" != "superseded".*completion_kind" != "deferred".*completion_kind" != "refresh_required".*completion_kind" != "retryable_failure"/,
  );
  assert.match(publishResult.run ?? "", /reason_code=artifact_unavailable/);
  assert.match(publishResult.run ?? "", /reason_code=invalid_artifact/);
  assert.match(
    publishResult.run ?? "",
    /LIVE_PROOF_RESULT.*invalid_artifact[\s\S]*completion_kind=refresh_required[\s\S]*reason_code=invalid_artifact/,
  );
  const runPublicationResult = (
    liveProofResult: string,
    overrides: Record<string, string> = {},
  ) => {
    const publicationResultRoot = mkdtempSync(`${tmpPrefix}live-proof-result-`);
    const publicationResultOutput = join(publicationResultRoot, "github-output");
    try {
      execFileSync("bash", ["-c", publishResult.run ?? ""], {
        env: {
          ...process.env,
          PRIOR_JOB_STATUS: "failure",
          PUBLISH_OUTCOME: "",
          TERMINAL_NOOP: "",
          TERMINAL_MISSING: "",
          TERMINAL_CLOSED: "",
          GUARDED_OPEN: "",
          POLICY_NOOP: "",
          REQUEUE_LATEST: "",
          LEGACY_TUPLELESS: "",
          SOURCE_DRIFT_OUTCOME: "",
          DEFERRED_ROUTE_OUTCOME: "",
          FAILURE_KIND: "",
          DOWNLOAD_OUTCOME: "success",
          VALIDATE_OUTCOME: "success",
          LIVE_PROOF_RESULT: liveProofResult,
          PUBLISH_COMPLETION_KIND: "",
          PUBLISH_REASON_CODE: "",
          PUBLISH_RETRY_AT: "",
          ERROR_FINGERPRINT: "",
          STATE_WRITER_JSON: "",
          DIRECT_RECOVERY_OUTCOME: "",
          DIRECT_RECOVERY_COMPLETION_KIND: "",
          DIRECT_RECOVERY_REASON_CODE: "",
          DIRECT_RECOVERY_REQUEUE_LATEST: "",
          DIRECT_RECOVERY_DIRECT_REQUEUE: "",
          REVIEW_ONLY: "false",
          ...overrides,
          GITHUB_OUTPUT: publicationResultOutput,
        },
      });
      return Object.fromEntries(
        readFileSync(publicationResultOutput, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
      );
    } finally {
      rmSync(publicationResultRoot, { recursive: true, force: true });
    }
  };
  assert.deepEqual(runPublicationResult("invalid_artifact"), {
    outcome: "success",
    completion_kind: "refresh_required",
    reason_code: "invalid_artifact",
    requeue_latest: "",
    direct_requeue: "false",
  });
  assert.deepEqual(runPublicationResult("retryable_failure"), {
    outcome: "failure",
    completion_kind: "retryable_failure",
    reason_code: "unknown_failure",
    requeue_latest: "",
    direct_requeue: "false",
  });
  // A direct lifecycle recovery skips the artifact publication. Its replayed
  // result is the completion, and the queue accepts a direct requeue only on a
  // published completion.
  const directRecovery = {
    PRIOR_JOB_STATUS: "success",
    PUBLISH_OUTCOME: "skipped",
    DOWNLOAD_OUTCOME: "skipped",
    VALIDATE_OUTCOME: "skipped",
    DIRECT_RECOVERY_OUTCOME: "success",
    DIRECT_RECOVERY_REQUEUE_LATEST: "false",
  };
  for (const [directRequeue, completionKind, reasonCode] of [
    ["true", "published", "publication_applied"],
    ["false", "published", "publication_applied"],
    ["false", "superseded", "remote_newer_tuple"],
  ]) {
    assert.deepEqual(
      runPublicationResult("", {
        ...directRecovery,
        DIRECT_RECOVERY_COMPLETION_KIND: completionKind!,
        DIRECT_RECOVERY_REASON_CODE: reasonCode!,
        DIRECT_RECOVERY_DIRECT_REQUEUE: directRequeue!,
      }),
      {
        outcome: "success",
        completion_kind: completionKind,
        reason_code: reasonCode,
        requeue_latest: "",
        direct_requeue: directRequeue,
      },
      `${completionKind} direct_requeue=${directRequeue}`,
    );
  }
  assert.doesNotMatch(publishResult.run ?? "", /LIVE_TERMINAL_NOOP/);
  assert.match(publishComplete.run ?? "", /internal\/exact-review\/complete/);
  assert.match(publishComplete.env?.FAILURE_KIND ?? "", /exact-review-publication-result/);
  assert.match(publishComplete.env?.RETRY_AT ?? "", /exact-review-publication-result/);
  assert.match(
    publishComplete.env?.DIRECT_LIFECYCLE_REQUEUE ?? "",
    /exact-review-publication-result/,
  );
  assert.ok(publisher.steps.indexOf(publishResult) < publisher.steps.indexOf(publishComplete));
  assert.ok(publisher.steps.indexOf(publishComplete) < publisher.steps.indexOf(activeLeaseWaiting));
  assert.match(activeLeaseWaiting.if ?? "", /reason_code == 'review_lease_active'/);
  assert.match(
    activeLeaseWaiting.if ?? "",
    /complete-exact-review-publication\.outcome == 'success'/,
  );
  assert.match(activeLeaseWaiting.run ?? "", /--state "Waiting"/);
});

// Recovery reviews do not need the command router. Other sources keep their router lifecycle.
test("direct publication picks the router lifecycle from the claimed source action", async () => {
  const root = mkdtempSync(`${tmpPrefix}direct-publication-lifecycle-`);
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  const posted: Array<{ lifecycle?: { kind: string } }> = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body));
    return Response.json({ ok: true, accepted: true });
  }) as unknown as typeof fetch;
  const publish = async (sourceAction: string, expected: "routable" | "deferred") => {
    const outcome = join(root, "outcome.json");
    const output = join(root, "output");
    writeFileSync(
      outcome,
      JSON.stringify({
        kind: "eligible",
        plan: {
          identity: { itemKey: "openclaw/openclaw#7", revision: 1, claimGeneration: 1 },
          operations: [],
          totalBytes: 0,
        },
        disposition: {
          requeueLatestExpected: false,
          terminalMissingExpected: false,
          terminalClosedExpected: false,
          routableSyncExpected: expected === "routable",
          deferredCloseCoverageExpected: expected === "deferred",
        },
      }),
    );
    writeFileSync(output, "");
    posted.length = 0;
    process.env = {
      PATH: originalEnv.PATH,
      EXACT_REVIEW_DIRECT_PUBLICATION_ENABLED: "1",
      EXACT_REVIEW_DIRECT_MUTATION_OUTPUT: outcome,
      EXACT_REVIEW_DIRECT_SOURCE_ACTION: sourceAction,
      EXACT_REVIEW_DIRECT_REVISION: "1",
      EXACT_REVIEW_QUEUE_URL: "https://queue.test",
      CLAWSWEEPER_WEBHOOK_SECRET: "secret",
      GITHUB_SHA: "a".repeat(40),
      GITHUB_OUTPUT: output,
    };
    await runExactReviewDirectPublicationFromEnv();
    return { output: readFileSync(output, "utf8"), lifecycle: posted[0]?.lifecycle?.kind };
  };
  try {
    assert.equal((await publish("opened", "routable")).lifecycle, "router");
    assert.equal((await publish("opened", "deferred")).lifecycle, "router_deferred_coverage");
    assert.equal(
      (await publish("failed_review_shard_recovery", "deferred")).lifecycle,
      "router_not_required",
    );
    const missingSource = await publish("", "routable");
    assert.equal(missingSource.lifecycle, undefined);
    assert.match(missingSource.output, /^reason=invalid_direct_source_action$/m);
  } finally {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test("scheduled review shards retire automatic live proof without removing historical publication", () => {
  type Step = {
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string | number | boolean>;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  assert.ok(
    workflow.jobs["event-review-publish"]!.steps.some(
      (candidate) => candidate.name === "Fold exact live proof into the review artifact",
    ),
  );
});

test("exact event publication derives lifecycle receipt and final command acknowledgement from the projection", () => {
  type Step = {
    name?: string;
    id?: string;
    if?: string;
    uses?: string;
    with?: Record<string, string | number | boolean>;
    env?: Record<string, string>;
    run?: string;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { if?: string; steps: Step[] }>;
  };
  const steps = workflow.jobs["event-review-publish"]!.steps;
  const step = (name: string) => {
    const value = steps.find((candidate) => candidate.name === name);
    assert.ok(value, `missing step: ${name}`);
    return value;
  };
  const router = step("Queue deferred exact verdict router");
  const canonical = step("Record fallback canonical exact review lifecycle receipt");
  assert.match(canonical.if ?? "", /remote_tuple_verified == 'true'/);
  assert.match(
    canonical.run ?? "",
    /lifecycle canonical-receipt \\\n\s*--outcome accepted --receipt-id-prefix fallback\)/,
  );
  assert.match(canonical.run ?? "", /internal\/exact-review\/lifecycle\/canonical-receipt/);
  assert.ok(steps.indexOf(canonical) < steps.indexOf(router));
  assert.equal(
    router.env?.FENCE_KEY,
    "${{ steps.publication-context.outputs.publisher_item_key }}",
  );
  assert.equal(
    router.env?.REVISION,
    "${{ steps.publication-context.outputs.publisher_lease_revision }}",
  );
  assert.match(router.run ?? "", /internal\/exact-review\/lifecycle\/router-receipt/);
  assert.match(router.run ?? "", /lifecycle router-receipt \\\n\s*--receipt-id-prefix router\)/);

  const deferredCloseProof = step("Record deferred close-proof exact review lifecycle receipt");
  assert.match(deferredCloseProof.if ?? "", /completion_kind == 'deferred'/);
  assert.match(deferredCloseProof.if ?? "", /reason_code == 'close_coverage_deferred'/);
  assert.match(
    deferredCloseProof.run ?? "",
    /lifecycle router-receipt \\\n\s*--outcome durable --receipt-id-prefix router-proof\)/,
  );
  assert.match(deferredCloseProof.run ?? "", /internal\/exact-review\/lifecycle\/router-receipt/);

  const noRouter = step("Record no-router exact review lifecycle receipt");
  assert.match(noRouter.if ?? "", /failed_review_shard_recovery/);
  assert.match(
    noRouter.run ?? "",
    /lifecycle router-receipt \\\n\s*--outcome not_required --receipt-id-prefix router-not-required\)/,
  );
  assert.match(noRouter.run ?? "", /internal\/exact-review\/lifecycle\/router-receipt/);

  const deferredDispatch = step("Dispatch deferred high-confidence bug implementation");
  assert.match(deferredDispatch.run ?? "", /dispatch-issue-implementation-candidates\.mjs/);
  assert.ok(steps.indexOf(canonical) < steps.indexOf(deferredDispatch));
  assert.ok(steps.indexOf(router) < steps.indexOf(deferredDispatch));
  assert.ok(steps.indexOf(noRouter) < steps.indexOf(deferredDispatch));

  // The publication completion body is behavior-tested in
  // test/repair/exact-review-queue-request.test.ts.
  const complete = step("Complete durable exact review publication");
  assert.match(complete.run ?? "", /payload="\$\(node "\$request" complete publication\)"/);
  const finalizer = workflow.jobs["event-review-terminal-finalization"]!;
  const finalizationCheckout = finalizer.steps.find(
    (candidate) => candidate.uses?.startsWith("actions/checkout@") && candidate.if,
  );
  assert.equal(finalizationCheckout?.with?.filter, undefined);
  assert.equal(finalizationCheckout?.with?.["fetch-depth"], 1);
  const finalizationClaim = finalizer.steps.find(
    (candidate) => candidate.name === "Claim committed terminal finalization",
  );
  const acknowledgement = finalizer.steps.find(
    (candidate) => candidate.name === "Begin fenced terminal acknowledgement",
  );
  const statusEdit = finalizer.steps.find(
    (candidate) => candidate.name === "Update final command status once",
  );
  const observedReceipt = finalizer.steps.find(
    (candidate) => candidate.name === "Record verified terminal acknowledgement receipt",
  );
  const retry = finalizer.steps.find(
    (candidate) => candidate.name === "Requeue unobserved terminal acknowledgement",
  );
  const lockedSkip = finalizer.steps.find(
    (candidate) => candidate.name === "Complete locked terminal acknowledgement skip",
  );
  assert.ok(
    finalizationClaim && acknowledgement && statusEdit && observedReceipt && lockedSkip && retry,
  );
  assert.match(finalizer.if ?? "", /exact_review_command_acknowledgement/);
  assert.match(finalizationClaim.run ?? "", /terminal_finalization/);
  assert.match(finalizationClaim.run ?? "", /lifecycle_projection/);
  assert.match(finalizationClaim.run ?? "", /lifecycle_fence_key/);
  assert.match(finalizationClaim.run ?? "", /lifecycle_revision/);
  assert.match(finalizationClaim.run ?? "", /response\.item_key !== process\.env\.ITEM_KEY/);
  assert.doesNotMatch(finalizationClaim.run ?? "", /expectedItemKey/);
  // The queue request command owns the safe claim conflicts.
  assert.match(
    finalizationClaim.run ?? "",
    /RESPONSE="\$response" node "\$request" claim conflict/,
  );
  assert.match(
    finalizationClaim.run ?? "",
    /Skipping terminal finalization because lease claim lost safely/,
  );
  assert.match(acknowledgement.run ?? "", /terminal-finalization\/attempt/);
  assert.match(statusEdit.if ?? "", /terminal-acknowledgement\.outputs\.allowed == 'true'/);
  assert.match(statusEdit.run ?? "", /--require-mutation/);
  assert.match(statusEdit.run ?? "", /--locked-conversation-terminal-skip/);
  assert.match(statusEdit.run ?? "", /--verify-terminal-status-receipt/);
  assert.match(statusEdit.run ?? "", /command-ack\/failed/);
  assert.equal(
    statusEdit.env?.FENCE_KEY,
    "${{ steps.finalization-context.outputs.lifecycle_fence_key }}",
  );
  assert.equal(
    statusEdit.env?.REVISION,
    "${{ steps.finalization-context.outputs.lifecycle_revision }}",
  );
  assert.match(observedReceipt.if ?? "", /terminal_status_verified == 'true'/);
  assert.equal(
    observedReceipt.env?.FENCE_KEY,
    "${{ steps.finalization-context.outputs.lifecycle_fence_key }}",
  );
  assert.equal(
    observedReceipt.env?.REVISION,
    "${{ steps.finalization-context.outputs.lifecycle_revision }}",
  );
  assert.equal(
    observedReceipt.env?.STATUS_COMMENT_ID,
    "${{ steps.finalization-context.outputs.status_comment_id }}",
  );
  assert.match(observedReceipt.run ?? "", /lifecycle\/command-ack\/observed/);
  assert.match(
    observedReceipt.run ?? "",
    /exact-review-queue-request\.js lifecycle command-ack-observed \\\n\s*--status-marker "\$STATUS_MARKER" --status-comment-id "\$STATUS_COMMENT_ID" \\\n\s*--command-comment-id "\$COMMAND_COMMENT_ID" --completion-comment-id "\$COMPLETION_COMMENT_ID" \\\n\s*--completed-at "\$COMPLETION_COMPLETED_AT" --completion-outcome "\$completion_outcome"\)/,
  );
  assert.match(
    observedReceipt.run ?? "",
    /if \[ "\$STATUS_STATE" = "Failed" \]; then\s+completion_outcome="failure"/,
  );
  assert.equal(
    observedReceipt.env?.COMPLETION_COMPLETED_AT,
    "${{ steps.update-final-command-status.outputs.completion_completed_at }}",
  );
  assert.match(observedReceipt.run ?? "", /acknowledgement_state == "observed"/);
  assert.match(lockedSkip.if ?? "", /locked_conversation == 'true'/);
  assert.match(lockedSkip.if ?? "", /missing_status_comment == 'true'/);
  assert.match(lockedSkip.run ?? "", /terminal-finalization\/skip/);
  assert.match(
    lockedSkip.run ?? "",
    /terminal-finalization skip \\\n\s*--attempt-id "\$ATTEMPT_ID" --reason "\$skip_reason"/,
  );
  assert.match(lockedSkip.run ?? "", /skip_reason="missing_status_comment"/);
  assert.match(lockedSkip.run ?? "", /expected_state="skipped_missing_comment"/);
  assert.match(lockedSkip.run ?? "", /acknowledgement_state == \$state/);
  assert.equal(
    lockedSkip.env?.MISSING_STATUS_COMMENT,
    "${{ steps.update-final-command-status.outputs.missing_status_comment }}",
  );
  assert.match(retry.run ?? "", /terminal-finalization\/retry/);
  assert.match(retry.if ?? "", /observe-verified-terminal-acknowledgement\.outcome != 'success'/);
  assert.match(
    retry.if ?? "",
    /!\(\(steps\.update-final-command-status\.outputs\.locked_conversation == 'true' \|\| steps\.update-final-command-status\.outputs\.missing_status_comment == 'true'\) && steps\.complete-locked-terminal-acknowledgement\.outcome == 'success'\)/,
  );
  assert.match(retry.run ?? "", /response_status/);
  assert.match(retry.run ?? "", /lease_not_active/);
  assert.match(
    statusEdit?.run ?? "",
    /rate limit exceeded\|secondary rate limit\|HTTP 429/,
    "throttled terminal status updates must be marked for the failure sentinel",
  );
  assert.match(statusEdit?.run ?? "", /throttled=true/);
  const failSentinel = finalizer.steps.find(
    (candidate) => candidate.name === "Fail failed terminal acknowledgement",
  );
  assert.match(
    failSentinel?.if ?? "",
    /update-final-command-status\.outcome == 'failure' && steps\.update-final-command-status\.outputs\.throttled != 'true'/,
    "a throttled update must not red the run — the requeue step already re-arms the driver",
  );
});

// The claim binds the run to the requested queue tuple. Later steps read only the claim outputs.
test("exact event claim accepts only the requested queue tuple", () => {
  type Step = { id?: string; name?: string; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = workflow.jobs["event-review-apply"]!.steps;
  const claimIndex = steps.findIndex((step) => step.id === "claim-exact-review-queue");
  assert.ok(claimIndex >= 0);
  for (const step of steps.slice(claimIndex + 1)) {
    assert.doesNotMatch(JSON.stringify(step), /github\.event\.client_payload/, step.name);
  }
  const root = mkdtempSync(`${tmpPrefix}exact-review-claim-`);
  try {
    writeFileSync(
      join(root, "control-plane-curl.sh"),
      `control_plane_curl() {
  local out=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --data) printf '%s' "$2" > "$CLAIM_REQUEST"; shift ;;
      --output) out="$2"; shift ;;
    esac
    shift
  done
  printf '%s' "$CLAIM_RESPONSE" > "$out"
  printf '200'
}
`,
    );
    // The claim step runs the command copy that the bootstrap downloads.
    copyFileSync(
      "src/repair/exact-review-queue-request.ts",
      join(root, "exact-review-queue-request.mts"),
    );
    const decision = {
      targetRepo: "openclaw/openclaw",
      itemNumber: 7,
      itemKind: "issue",
      sourceEvent: "issues",
      sourceAction: "opened",
    };
    const claim = (response: Record<string, unknown>) => {
      const output = join(root, "output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", steps[claimIndex]!.run ?? ""], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          GITHUB_OUTPUT: output,
          GITHUB_RUN_ID: "10",
          GITHUB_RUN_ATTEMPT: "1",
          QUEUE_URL: "https://queue.test",
          QUEUE_LEASE_ID: "lease-1",
          ITEM_KEY: "openclaw/openclaw#7",
          QUEUE_LEASE_REVISION: "3",
          DISPATCH_PAYLOAD: JSON.stringify({
            target_repo: "openclaw/openclaw",
            item_number: 7,
            item_kind: "issue",
            source_event: "issues",
            source_action: "opened",
          }),
          CLAIM_REQUEST: join(root, "request.json"),
          CLAIM_RESPONSE: JSON.stringify(response),
        },
      });
      const outputs = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      return { status: result.status, stderr: result.stderr, outputs };
    };

    const owned = {
      claimed: true,
      protocol_version: 2,
      item_key: "openclaw/openclaw#7",
      lease_revision: 3,
      claim_generation: 2,
      repeat_revision: false,
      decision,
    };
    const accepted = claim(owned);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "request.json"), "utf8")), {
      lease_id: "lease-1",
      item_key: "openclaw/openclaw#7",
      lease_revision: 3,
      run_id: "10",
      run_attempt: 1,
    });
    assert.equal(accepted.outputs.claimed, "true");
    assert.equal(accepted.outputs.claim_generation, "2");
    assert.deepEqual(JSON.parse(accepted.outputs.decision), decision);

    // During a rolling deploy the worker can still answer with protocol 1.
    const legacy = claim({ claimed: true });
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(legacy.outputs.protocol_version, "1");
    assert.deepEqual(JSON.parse(legacy.outputs.decision), {
      ...decision,
      targetBranch: "main",
      supersedesInProgress: false,
    });

    for (const mismatch of [
      { ...owned, lease_revision: 4 },
      { ...owned, item_key: "openclaw/openclaw#8", decision: { ...decision, itemNumber: 8 } },
    ]) {
      const rejected = claim(mismatch);
      assert.equal(rejected.status, 1);
      assert.equal(rejected.outputs.claimed, "false");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact event review heartbeats its queue lease while Codex runs", () => {
  type Step = { name?: string; env?: Record<string, string>; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const review = workflow.jobs["event-review-apply"]!.steps.find(
    (candidate) => candidate.name === "Review exact event item",
  );
  assert.ok(review);
  assert.match(review.env?.EXACT_REVIEW_ITEM_KEY ?? "", /claim-exact-review-queue/);
  assert.match(review.env?.EXACT_REVIEW_LEASE_ID ?? "", /claim-exact-review-queue/);
  assert.match(review.env?.EXACT_REVIEW_LEASE_REVISION ?? "", /claim-exact-review-queue/);
  // The Codex-adjacent review step must never receive the shared webhook secret;
  // the heartbeat authenticates by lease tuple like /claim and /complete.
  assert.equal(review.env?.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
  assert.match(
    review.run ?? "",
    /heartbeat_payload="\$\(node dist\/repair\/exact-review-queue-request\.js heartbeat --phase review\)"/,
  );
  assert.match(
    review.run ?? "",
    /startup_payload="\$\(node dist\/repair\/exact-review-queue-request\.js heartbeat --phase review --generation-start\)"/,
  );
  assert.match(
    review.run ?? "",
    /finalizing_payload="\$\(node dist\/repair\/exact-review-queue-request\.js heartbeat --phase finalizing\)"/,
  );
  assert.doesNotMatch(review.run ?? "", /x-clawsweeper-exact-review-signature/);
  assert.doesNotMatch(review.run ?? "", /CLAWSWEEPER_WEBHOOK_SECRET/);
  assert.match(review.run ?? "", /internal\/exact-review\/heartbeat/);
  assert.match(review.run ?? "", /^\s*sleep 60\s*$/m);
  assert.match(review.run ?? "", /heartbeat_payload=.*\|\| return 1/s);
  assert.doesNotMatch(review.run ?? "", /test -n "\$CLAWSWEEPER_WEBHOOK_SECRET"/);
  assert.match(review.run ?? "", /trap cleanup_heartbeat EXIT/);
  assert.match(review.run ?? "", /kill "\$heartbeat_pid" 2>\/dev\/null \|\| true/);
  assert.match(review.run ?? "", /setsid timeout --kill-after=30s/);
  assert.match(review.run ?? "", /review_pgid=\$review_pid/);
  assert.match(review.run ?? "", /kill -TERM -- "-\$review_pgid"/);
  assert.match(review.run ?? "", /kill -KILL -- "-\$review_pgid"/);
  assert.match(review.run ?? "", /wait_for_review_group/);

  const publisher = workflow.jobs["event-review-publish"]!;
  assert.equal(
    publisher.steps.some((step) => step.run?.includes("internal/exact-review/heartbeat")),
    false,
  );
});

test("exact-review startup ownership check charges generation start on the lease heartbeat", () => {
  type Step = { name?: string; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const run =
    workflow.jobs["event-review-apply"]!.steps.find(
      (candidate) => candidate.name === "Review exact event item",
    )?.run ?? "";
  const prepare = run.slice(
    run.indexOf("prepare_heartbeat() {"),
    run.indexOf("\nstart_heartbeat() {"),
  );
  const start = run.indexOf("verify_startup_authority() {");
  const verify = run.slice(start, run.indexOf("\nadmission_args=()", start));
  assert.ok(prepare.endsWith("}") && start >= 0 && verify.endsWith("}"));
  // Both generation paths verify ownership immediately before Codex starts.
  assert.equal(run.split(/^\s*verify_startup_authority\s*$/m).length - 1, 2);

  for (const scenario of ["owned", "superseded"] as const) {
    const root = mkdtempSync(tmpPrefix);
    try {
      symlinkSync(join(process.cwd(), "dist"), join(root, "dist"), "dir");
      const output = join(root, "output");
      const sent = join(root, "sent.json");
      execFileSync(
        "bash",
        [
          "-e",
          "-u",
          "-c",
          `
        control_plane_curl() {
          local body="" out=""
          while [ "$#" -gt 0 ]; do
            case "$1" in
              --data-binary) body="$2"; shift ;;
              --output) out="$2"; shift ;;
            esac
            shift
          done
          printf '%s' "$body" > "$MOCK_SENT"
          printf '%s' "$MOCK_BODY" > "$out"
          printf '%s' "$MOCK_HTTP_STATUS"
        }
        ${prepare}
        prepare_heartbeat
        ${verify}
        verify_startup_authority
        echo verified >> "$GITHUB_OUTPUT"
      `,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            MOCK_SENT: sent,
            MOCK_HTTP_STATUS: scenario === "owned" ? "200" : "409",
            MOCK_BODY: scenario === "owned" ? '{"ok":true}' : '{"error":"lease_superseded"}',
            QUEUE_URL: "http://127.0.0.1",
            EXACT_REVIEW_ITEM_KEY: "openclaw/openclaw#1",
            EXACT_REVIEW_LEASE_ID: "lease-1",
            EXACT_REVIEW_LEASE_REVISION: "1",
            EXACT_REVIEW_CLAIM_GENERATION: "1",
            EXACT_REVIEW_SOURCE_HEAD_SHA: "",
            GITHUB_RUN_ID: "10",
            GITHUB_RUN_ATTEMPT: "1",
          },
        },
      );
      assert.deepEqual(JSON.parse(readText(sent)), {
        item_key: "openclaw/openclaw#1",
        lease_id: "lease-1",
        lease_revision: 1,
        claim_generation: 1,
        run_id: "10",
        run_attempt: 1,
        phase: "review",
        generation_start: true,
      });
      if (scenario === "owned") assert.equal(readText(output), "verified\n");
      else assert.match(readText(output), /^superseded=true$/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("exact-review lease competition skips only known conflicts and gates both owners", () => {
  type Step = { name?: string; uses?: string; if?: string; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };

  for (const [jobName, claimId] of [
    ["event-review-apply", "claim-exact-review-queue"],
    ["event-review-publish", "publication-context"],
  ]) {
    const steps = workflow.jobs[jobName]!.steps.slice(1);
    const claim = steps[0]!;
    const claimRun = claim.run ?? "";
    const gate = `steps.${claimId}.outputs.claimed == 'true'`;

    assert.match(claimRun, /printf 'claimed=false\\ndecision=\{\}\\n'/, jobName);
    assert.match(claimRun, /--write-out '%\{http_code\}'/, jobName);
    assert.match(claimRun, /if \[ "\$status" = "409" \]/, jobName);
    // The queue request command owns the safe claim conflicts of both jobs.
    assert.match(claimRun, /RESPONSE="\$response" node "\$request" claim conflict/, jobName);
    assert.match(claimRun, /if \[ "\$status" != "200" \]/, jobName);
    assert.match(claimRun, /if \[\[ "\$status" != 5\* \]\]/, jobName);
    assert.match(claimRun, /returned an invalid success payload/, jobName);
    assert.doesNotMatch(claimRun, /curl --fail/, jobName);

    for (const step of steps.slice(1).filter((candidate) => candidate.if !== "${{ false }}")) {
      assert.match(step.if ?? "", new RegExp(gate.replaceAll(".", "\\.")), step.name ?? step.uses);
    }
  }
});

// The reconcile workflows hold the webhook secret. Their GitHub token can only read.
test("exact-review reconcile workflows keep a read-only GitHub token", () => {
  type Workflow = {
    permissions?: Record<string, string>;
    jobs: Record<string, { permissions?: Record<string, string> }>;
  };
  for (const name of ["exact-review-reconcile.yml", "exact-review-reconcile-run.yml"]) {
    const workflow = YAML.parse(readText(`.github/workflows/${name}`)) as Workflow;
    assert.deepEqual(workflow.permissions, {}, name);
    for (const job of Object.values(workflow.jobs)) {
      for (const [scope, access] of Object.entries(job.permissions ?? {})) {
        assert.equal(access, "read", `${name}: ${scope}`);
      }
    }
  }
});

// Runs a workflow step with a fake pnpm. Returns the paths and the rebase strategy of each
// publish-main call.
function publishMainCalls(run: string, env: Record<string, string>) {
  const root = mkdtempSync(`${tmpPrefix}publish-main-calls-`);
  try {
    const log = join(root, "calls");
    writeFileSync(log, "");
    execFileSync(
      "bash",
      [
        "-e",
        "-c",
        `pnpm() { node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' "$PNPM_LOG" "$@"; }\n${run}`,
      ],
      { cwd: root, env: { ...process.env, ...env, PNPM_LOG: log } },
    );
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const args = JSON.parse(line) as string[];
        return {
          paths: args.filter((_, index) => args[index - 1] === "--path"),
          strategy: args[args.indexOf("--rebase-strategy") + 1],
        };
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Record tuples publish with a normal rebase from a captured baseline. Status files publish
// apart with "theirs", so a status publish can never overwrite a record tuple.
test("audit publication keeps record tuples apart from status files", () => {
  type Step = { name?: string; run?: string; env?: Record<string, string> };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const step = (name: string) => {
    const value = workflow.jobs["audit-dashboard"]!.steps.find(
      (candidate) => candidate.name === name,
    );
    assert.ok(value, name);
    return value;
  };
  const refresh = step("Refresh Audit Health");
  const commit = step("Commit Audit Health");
  assert.ok(commit.env?.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR);
  assert.equal(
    refresh.env?.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR,
    commit.env.CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR,
  );
  const calls = publishMainCalls(commit.run ?? "", { TARGET_REPO: "openclaw/openclaw" });
  assert.deepEqual(calls[0], { paths: ["records/openclaw-openclaw"], strategy: "normal" });
  assert.ok(calls.length > 1);
  for (const call of calls.slice(1)) {
    assert.equal(call.strategy, "theirs");
    assert.equal(
      call.paths.some((path) => path.startsWith("records")),
      false,
    );
  }
});

// Proof Codex runs with read-only tokens. The apply job holds the write tokens and never runs
// Codex. Neither job keeps checkout credentials.
test("apply proof keeps Codex away from the apply write tokens", () => {
  type Step = {
    name?: string;
    uses?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  };
  type Job = { permissions?: Record<string, string>; steps: Step[] };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, Job>;
  };
  const proof = workflow.jobs["apply-proof"]!;
  const apply = workflow.jobs["apply-existing"]!;
  for (const [scope, access] of Object.entries(proof.permissions ?? {})) {
    assert.equal(access, "read", scope);
  }
  assert.ok(proof.steps.some((step) => step.uses === "./.github/actions/setup-codex"));
  for (const step of proof.steps) {
    assert.doesNotMatch(step.uses ?? "", /create-(?:target-write|state)-token/, step.name);
  }
  for (const step of apply.steps) {
    assert.notEqual(step.uses, "./.github/actions/setup-codex", step.name);
    assert.equal(step.env?.OPENAI_API_KEY, undefined, step.name);
  }
  for (const step of [...proof.steps, ...apply.steps]) {
    if (step.uses?.startsWith("actions/checkout@")) {
      assert.equal(step.with?.["persist-credentials"], false);
    }
  }
  const proofState = proof.steps.find((step) => step.uses === "./.github/actions/setup-state");
  assert.equal(proofState?.with?.["persist-credentials"], "false");
});

test("comment-only apply preparation never scans the full target repository", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Array<{ name?: string; if?: string; run?: string }> }>;
  };
  const steps = workflow.jobs["apply-proof"]!.steps;
  const reconcile = steps.find((step) => step.name === "Reconcile read-only proof inputs");
  const applyReconcile = workflow.jobs["apply-existing"]!.steps.find(
    (step) => step.name === "Reconcile before apply preselect",
  );
  const select = steps.find((step) => step.name === "Select bounded coverage proof work");
  assert.ok(reconcile?.if, "proof reconciliation must explicitly exclude comment-only runs");
  assert.equal(applyReconcile?.if, reconcile.if, "apply preselect must use the same skip gate");
  assert.ok(select?.run, "proof selection must recognize scheduled comment-only maintenance");

  const expression = reconcile.if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const shouldReconcile = new Function("github", `return (${expression});`) as (
    github: Record<string, unknown>,
  ) => boolean;
  const dispatch = (syncCommentsOnly: string, itemNumbers = "") => ({
    event_name: "workflow_dispatch",
    event: {
      schedule: "",
      inputs: { apply_sync_comments_only: syncCommentsOnly, apply_item_numbers: itemNumbers },
    },
  });
  const schedule = (cron: string) => ({
    event_name: "schedule",
    event: { schedule: cron, inputs: {} },
  });

  assert.equal(shouldReconcile(dispatch("true", "__cursor__")), false);
  assert.equal(shouldReconcile(dispatch("true", "10,20")), false);
  assert.equal(shouldReconcile(dispatch("false", "__cursor__")), false);
  assert.equal(shouldReconcile(schedule("6,21,36,51 * * * *")), false);
  assert.equal(shouldReconcile(dispatch("false")), true);
  assert.equal(shouldReconcile(schedule("3 * * * *")), true);
  assert.match(select.run, /github\.event\.schedule \|\| ''/);
  assert.match(select.run, /6,21,36,51 \* \* \* \*/);
  assert.match(select.run, /sync_comments_only="true"/);
});

test("comment-only apply reconciliation scopes only selected items", () => {
  const reconcileArgs = (itemNumbers: string, syncCommentsOnly: boolean) =>
    execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          'TARGET_REPO="openclaw/openclaw"',
          `item_numbers="${itemNumbers}"`,
          `sync_comments_only=${syncCommentsOnly}`,
          "sync_open_pr_batch=false",
          "prepare_apply_reconciliation_args",
          'printf "%s\\n" "${reconcile_args[@]}"',
        ].join("\n"),
      ],
      { encoding: "utf8" },
    )
      .trimEnd()
      .split("\n");
  const baseArgs = ["--target-repo", "openclaw/openclaw", "--skip-closed-at"];

  assert.deepEqual(reconcileArgs("119890", true), [
    ...baseArgs,
    "--item-numbers",
    "119890",
    "--only-item-numbers",
  ]);
  assert.deepEqual(reconcileArgs("119890", false), [...baseArgs, "--item-numbers", "119890"]);
  assert.deepEqual(reconcileArgs("", true), baseArgs);
});

test("reconcile publication expands only exact changed record tuples", () => {
  const reconcileJson = JSON.stringify({
    changedItemNumbers: [7, 42],
    changedRecordFiles: ["7.md", "openclaw-openclaw-42.md"],
  });
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$@"; }',
        'TARGET_REPO="OpenClaw/OpenClaw"',
        'publish_reconciled_records "persist reconciliation" "$RECONCILE_JSON"',
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, RECONCILE_JSON: reconcileJson } },
  );
  assert.deepEqual(output.trim().split("\n"), [
    "normal",
    "persist reconciliation",
    "records/openclaw-openclaw/items/7.md",
    "records/openclaw-openclaw/closed/7.md",
    "records/openclaw-openclaw/plans/7.md",
    "records/openclaw-openclaw/decision-packets/7.json",
    "records/openclaw-openclaw/items/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/closed/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/plans/openclaw-openclaw-42.md",
    "records/openclaw-openclaw/decision-packets/42.json",
  ]);

  const emptyOutput = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "unexpected publish\\n"; return 1; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_reconciled_records "persist reconciliation" \'{"changedItemNumbers":[],"changedRecordFiles":[]}\'',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(emptyOutput.trim(), "Reconcile changed no durable record tuples.");
});

test("persist reconciliation publishes against its exact captured canonical baseline", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "pnpm() {",
        "  local previous='' baseline='' argument",
        '  for argument in "$@"; do',
        '    if [ "$previous" = "--canonical-record-baseline-dir" ]; then baseline="$argument"; fi',
        '    previous="$argument"',
        "  done",
        '  test -n "$baseline"',
        '  mkdir -p "$baseline/records/openclaw-openclaw/items"',
        '  printf "before\\n" > "$baseline/records/openclaw-openclaw/items/42.md"',
        '  printf \'{"changedItemNumbers":[42],"changedRecordFiles":["42.md"]}\\n\'',
        "}",
        "publish_reconciled_records() {",
        '  test -f "$CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR/records/openclaw-openclaw/items/42.md"',
        '  printf "baseline=%s\\n" "$CLAWSWEEPER_CANONICAL_RECORD_BASELINE_DIR"',
        "}",
        "load_reconciliation_deferred_items() { :; }",
        'TARGET_REPO="openclaw/openclaw"',
        'persist_reconciliation --target-repo "$TARGET_REPO"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  const baseline = /^baseline=(.+)$/m.exec(output)?.[1];
  assert.ok(baseline);
  assert.equal(existsSync(baseline), false);
});

test("reconcile publication batches large corrected tuple sets below exec argument limits", () => {
  const changedRecordFiles = Array.from({ length: 128 }, (_, index) => `${index + 1}.md`);
  const reconcileJson = JSON.stringify({ changedItemNumbers: [], changedRecordFiles });
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "call=%s kind=%s deferred=%s\\n" "$#" "$CLAWSWEEPER_CANONICAL_PUBLICATION_KIND" "$CLAWSWEEPER_RECONCILE_DEFERRED_PATH"; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_reconciled_records "persist reconciliation" "$RECONCILE_JSON"',
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, RECONCILE_JSON: reconcileJson } },
  );

  assert.deepEqual(output.trim().split("\n"), [
    "call=202 kind=reconcile deferred=.artifacts/apply-reconcile-deferred.jsonl",
    "call=202 kind=reconcile deferred=.artifacts/apply-reconcile-deferred.jsonl",
    "call=114 kind=reconcile deferred=.artifacts/apply-reconcile-deferred.jsonl",
  ]);
});

test("apply checkpoints split record tuples from auxiliary state", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$@"; }',
        'TARGET_REPO="OpenClaw/OpenClaw"',
        'publish_changes "apply checkpoint" records apply-report.json results/sweep-status results/apply-cursors',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(output.trim().split("\n"), [
    "normal",
    "apply checkpoint",
    "records/openclaw-openclaw",
    "theirs",
    "apply checkpoint",
    "apply-report.json",
    "results/sweep-status",
    "results/apply-cursors",
  ]);

  const failedOutput = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$1"; [ "$1" != normal ]; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_changes "apply checkpoint" records apply-report.json || true',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(failedOutput.trim(), "normal");

  const auxiliaryFailure = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes_with_strategy() { printf "%s\\n" "$1"; [ "$1" != theirs ]; }',
        'TARGET_REPO="openclaw/openclaw"',
        'publish_changes "apply checkpoint" records apply-report.json results/apply-cursors 2>&1',
        'printf "exit=%s\\n" "$?"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  assert.deepEqual(auxiliaryFailure.trim().split("\n"), [
    "normal",
    "theirs",
    "::warning title=Operational state publish failed::Canonical work remains valid; continuing after best-effort Git bookkeeping failed: apply checkpoint",
    "exit=0",
  ]);
});

test("best-effort apply status publishes one sparse-safe file without noisy restore", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'publish_changes() { printf "publish=%s\\npath=%s\\n" "$1" "$2"; return 1; }',
        'git() { if [ "$1" = restore ]; then printf "unexpected restore\\n"; fi; return 1; }',
        'TARGET_REPO="OpenClaw/OpenClaw"',
        'publish_status "apply status"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.deepEqual(output.trim().split("\n"), [
    "publish=apply status",
    "path=results/sweep-status/openclaw-openclaw.json",
    "Best-effort status update failed: apply status",
  ]);
});

test("apply workflow rejects malformed or oversized coverage proof artifact trees", () => {
  const root = mkdtempSync(tmpPrefix);
  const validate = (maxFiles = 2, maxFileBytes = 64, maxTotalBytes = 128) =>
    execFileSync(
      "bash",
      [
        "-lc",
        `source scripts/apply-workflow-helpers.sh\nvalidate_coverage_proof_tree "$PROOF_DIR" ${maxFiles} ${maxFileBytes} ${maxTotalBytes}`,
      ],
      { encoding: "utf8", env: { ...process.env, PROOF_DIR: root } },
    );
  const writeManifest = (selectedItems = "10,30") =>
    execFileSync(
      "bash",
      [
        "-lc",
        'source scripts/apply-workflow-helpers.sh\nwrite_coverage_proof_manifest "$PROOF_DIR" openclaw/openclaw "$SELECTED_ITEMS"',
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PROOF_DIR: root, SELECTED_ITEMS: selectedItems },
      },
    );

  try {
    writeFileSync(join(root, "10-20.proof.json"), "{}\n");
    writeFileSync(join(root, "30-40.proof.json"), "{}\n");
    writeManifest();
    assert.equal(validate(), "");

    writeFileSync(join(root, "50-60.proof.json"), "{}\n");
    writeManifest("10,30,50");
    assert.throws(() => validate(), /maximum is 2/);
    rmSync(join(root, "50-60.proof.json"));
    writeManifest();

    writeFileSync(join(root, "unexpected.json"), "{}\n");
    assert.throws(() => validate(3), /Unexpected coverage proof filename/);
    rmSync(join(root, "unexpected.json"));

    mkdirSync(join(root, "nested"));
    assert.throws(() => validate(), /Unexpected non-file coverage proof artifact/);
    rmSync(join(root, "nested"), { recursive: true });

    writeFileSync(join(root, "10-20.proof.json"), "x".repeat(65));
    assert.throws(() => validate(), /exceeds 64 bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage proof manifest preserves an empty reduced-hydration artifact", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          'write_coverage_proof_manifest "$PROOF_DIR" openclaw/openclaw "107006,109946"',
          'validate_coverage_proof_tree "$PROOF_DIR" 8 262144 2097152',
        ].join("\n"),
      ],
      { encoding: "utf8", env: { ...process.env, PROOF_DIR: root } },
    );
    assert.deepEqual(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")), {
      schemaVersion: 1,
      targetRepo: "openclaw/openclaw",
      selectedItems: [107006, 109946],
      proofCount: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A final status retry may only rewrite the status file. Record tuples use their own checkpoint.
test("apply final status retry publishes only the target status file", () => {
  type Step = { name?: string; id?: string; run?: string };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = workflow.jobs["apply-existing"]!.steps;
  const retry = steps.find((step) => step.name === "Retry final apply status publication");
  assert.ok(retry?.run);
  const env = { APPLY_TARGET_REPO: "openclaw/openclaw" };
  assert.deepEqual(publishMainCalls(retry.run, env), [
    { paths: ["results/sweep-status/openclaw-openclaw.json"], strategy: "theirs" },
  ]);
  assert.deepEqual(publishMainCalls(retry.run, { ...env, APPLY_NOOP: "true" }), []);

  // GitHub rejects a run script near 21,000 characters. Keep a margin.
  const applyRun = steps.find((step) => step.id === "apply-existing-run")?.run ?? "";
  assert.ok(applyRun.length < 20_000, `apply run script is ${applyRun.length} characters`);
});

test("comment synchronization splits oversized explicit requests into durable checkpoints", () => {
  const oversizedItems = Array.from({ length: 41 }, (_, index) => index + 1).join(",");
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "comment_sync_processed_limit=40",
        "sync_batch_size=75",
        "sync_comments_only=false",
        "item_numbers=",
        "prepare_comment_sync_batch",
        'printf "close_batch=%s\\n" "$sync_batch_size"',
        "sync_comments_only=true",
        "item_numbers=1",
        "sync_open_pr_batch=false",
        "prepare_comment_sync_batch",
        'printf "comment_batch=%s\\n" "$sync_batch_size"',
        'item_numbers="$OVERSIZED_ITEMS"',
        "prepare_comment_sync_batch",
        'printf "selected=%s\\n" "$item_numbers"',
        'printf "remaining=%s\\n" "$comment_sync_pending_items"',
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, OVERSIZED_ITEMS: oversizedItems } },
  );

  assert.match(output, /^close_batch=75$/m);
  assert.match(output, /^comment_batch=40$/m);
  assert.match(output, /^selected=1,2,3,4,5,6,7,8,9,10,/m);
  assert.match(output, /^selected=.*39,40$/m);
  assert.match(output, /^remaining=41$/m);
});

test("comment synchronization normalizes only valid positive explicit item numbers", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "comment_sync_processed_limit=40",
        "sync_batch_size=40",
        "sync_comments_only=true",
        "sync_open_pr_batch=false",
        'item_numbers="3, 0, 02, -4, 2, 1.5, invalid, 001,,"',
        "prepare_comment_sync_batch",
        'printf "selected=%s\\n" "$item_numbers"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^selected=1,2,3$/m);
});

test("comment synchronization rejects explicit requests without valid item numbers", () => {
  assert.throws(
    () =>
      execFileSync(
        "bash",
        [
          "-lc",
          [
            "set -euo pipefail",
            "source scripts/apply-workflow-helpers.sh",
            "comment_sync_processed_limit=40",
            "sync_batch_size=40",
            "sync_comments_only=true",
            "sync_open_pr_batch=false",
            'item_numbers="0,-4,1.5,invalid,,"',
            "prepare_comment_sync_batch",
          ].join("\n"),
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    (error: Error & { stderr?: Buffer | string }) =>
      /contains no valid positive item numbers/.test(String(error.stderr)),
  );
});

test("scheduled comment sync broadens only its own maintenance filters", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "sync_open_pr_batch=true",
        "sync_comments_only=true",
        "scheduled_comment_sync=false",
        "apply_kind=issue",
        "comment_sync_min_age_days=9",
        "normalize_comment_sync_mode",
        'printf "manual=%s|%s\\n" "$apply_kind" "$comment_sync_min_age_days"',
        "scheduled_comment_sync=true",
        "normalize_comment_sync_mode",
        'printf "scheduled=%s|%s\\n" "$apply_kind" "$comment_sync_min_age_days"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^manual=issue\|9$/m);
  assert.match(output, /^scheduled=all\|0$/m);
});

test("custom all-item sync never overwrites the shared automatic cursor", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "comment_sync_processed_limit=40",
        "sync_comments_only=true",
        "sync_open_pr_batch=true",
        "scheduled_comment_sync=false",
        "target_slug=openclaw-openclaw",
        "apply_kind=all",
        "comment_sync_min_age_days=0",
        "item_numbers=",
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "sync_batch_size=1",
        "min_age_days=30",
        "prepare_comment_sync_batch",
        'printf "custom=%s|%s\\n" "$cursor_path" "$sync_batch_size"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "sync_batch_size=40",
        "min_age_days=0",
        "min_age_minutes=30",
        "prepare_comment_sync_batch",
        'printf "minute=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "min_age_minutes=15",
        "prepare_comment_sync_batch",
        'printf "minute-fifteen=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "min_age_minutes=",
        "min_age_days=30",
        "prepare_comment_sync_batch",
        'printf "day-thirty=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "min_age_days=60",
        "prepare_comment_sync_batch",
        'printf "day-sixty=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "min_age_days=0",
        "apply_close_reasons=duplicate_or_superseded",
        "stale_min_age_days=1",
        "close_delay_ms=500",
        "checkpoint_size=10",
        "limit=40",
        "prepare_comment_sync_batch",
        'printf "policy=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "apply_close_reasons=all",
        "stale_min_age_days=60",
        "close_delay_ms=2000",
        "checkpoint_size=40",
        "apply_kind=pull_request",
        "prepare_comment_sync_batch",
        'printf "pull-request=%s\\n" "$cursor_path"',
        "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
        "apply_kind=all",
        "prepare_comment_sync_batch",
        'printf "automatic=%s\\n" "$cursor_path"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(
    output,
    /^custom=results\/comment-sync-cursors\/openclaw-openclaw-all-age0-policy-[a-f\d]{16}\.json\|1$/m,
  );
  assert.match(
    output,
    /^minute=results\/comment-sync-cursors\/openclaw-openclaw-all-age0-policy-[a-f\d]{16}\.json$/m,
  );
  const policyPath = (label: string) => output.match(new RegExp(`^${label}=(.+)$`, "m"))?.[1];
  assert.notEqual(policyPath("minute"), policyPath("minute-fifteen"));
  assert.notEqual(policyPath("day-thirty"), policyPath("day-sixty"));
  assert.match(
    output,
    /^policy=results\/comment-sync-cursors\/openclaw-openclaw-all-age0-policy-[a-f\d]{16}\.json$/m,
  );
  assert.match(
    output,
    /^pull-request=results\/comment-sync-cursors\/openclaw-openclaw-pull_request-age0\.json$/m,
  );
  assert.match(output, /^automatic=results\/comment-sync-cursors\/openclaw-openclaw\.json$/m);
});

test("cursor synchronization replaces a zero-item operator limit with its bounded default", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        "comment_sync_processed_limit=40",
        "sync_batch_size=0",
        "sync_comments_only=true",
        "sync_open_pr_batch=true",
        "item_numbers=10",
        "prepare_comment_sync_batch",
        'printf "batch=%s\\n" "$sync_batch_size"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^batch=40$/m);
});

test("scheduled all-item comment sync remains bounded to one cursor window", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: issue\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  try {
    const output = runCommentSyncShell(root, [
      "comment_sync_processed_limit=40",
      "sync_batch_size=40",
      "sync_comments_only=true",
      "sync_open_pr_batch=true",
      "scheduled_comment_sync=true",
      "continue_apply=false",
      'TARGET_REPO="openclaw/openclaw"',
      "target_slug=openclaw-openclaw",
      "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
      "apply_kind=pull_request",
      "comment_sync_min_age_days=7",
      "item_numbers=",
      "normalize_comment_sync_mode",
      "prepare_comment_sync_batch",
      'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
      'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
      'printf "selected=%s\\n" "$item_numbers"',
      'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "printf '[]' > report.json",
      "complete_comment_sync_batch report.json trace.json",
      'printf "continue=%s\\nkind=%s\\ncursor=%s\\n" "$continue_apply" "$apply_kind" "$(jq -r .next_after_number "$cursor_path")"',
    ]);

    assert.match(output, /^selected=1,2,3,/m);
    assert.match(output, /^continue=false$/m);
    assert.match(output, /^kind=all$/m);
    assert.match(output, /^cursor=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("background and scheduled maintenance advance the same immediate all-item cursor", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: issue\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  try {
    const output = runCommentSyncShell(root, [
      "comment_sync_processed_limit=40",
      "sync_batch_size=40",
      "sync_comments_only=true",
      "sync_open_pr_batch=true",
      "scheduled_comment_sync=false",
      "continue_apply=false",
      'TARGET_REPO="openclaw/openclaw"',
      "target_slug=openclaw-openclaw",
      "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
      "apply_kind=all",
      "comment_sync_min_age_days=0",
      "item_numbers=",
      "prepare_comment_sync_batch",
      'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
      'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
      'next_cursor=$(awk -F= \'$1 == "next_cursor" { print $2 }\' <<< "$batch")',
      'printf "background-cursor=%s\\nbackground-selected=%s\\n" "$cursor_path" "$item_numbers"',
      'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "printf '[]' > report.json",
      "complete_comment_sync_batch report.json trace.json",
      'printf "background-continue=%s\\n" "$continue_apply"',
      "sync_open_pr_batch=true",
      "scheduled_comment_sync=true",
      "continue_apply=false",
      "item_numbers=",
      "normalize_comment_sync_mode",
      "prepare_comment_sync_batch",
      'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
      'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
      'next_cursor=$(awk -F= \'$1 == "next_cursor" { print $2 }\' <<< "$batch")',
      'printf "scheduled-cursor=%s\\nscheduled-selected=%s\\nscheduled-age=%s\\n" "$cursor_path" "$item_numbers" "$comment_sync_min_age_days"',
      'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "complete_comment_sync_batch report.json trace.json",
      'printf "scheduled-continue=%s\\nfinal-cursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
    ]);

    assert.match(
      output,
      /^background-cursor=results\/comment-sync-cursors\/openclaw-openclaw\.json$/m,
    );
    assert.match(output, /^background-selected=1,2,3,/m);
    assert.match(output, /^background-continue=false$/m);
    assert.match(
      output,
      /^scheduled-cursor=results\/comment-sync-cursors\/openclaw-openclaw\.json$/m,
    );
    assert.match(output, /^scheduled-selected=41$/m);
    assert.match(output, /^scheduled-age=0$/m);
    assert.match(output, /^scheduled-continue=false$/m);
    assert.match(output, /^final-cursor=41$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncursored default comment sync preserves the same cross-repository continuation cursor", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    for (const targetRepo of ["openclaw/openclaw", "openclaw/clawhub"]) {
      const targetSlug = targetRepo.replace("/", "-");
      const records = join(root, "records", targetSlug, "items");
      mkdirSync(records, { recursive: true });
      for (let number = 1; number <= 41; number += 1) {
        writeFileSync(
          join(records, `${targetSlug}-${number}.md`),
          `---\nrepository: ${targetRepo}\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
        );
      }
    }

    const output = runCommentSyncShell(root, [
      "for TARGET_REPO in openclaw/openclaw openclaw/clawhub; do",
      '  target_slug="$(printf "%s" "$TARGET_REPO" | tr / -)"',
      "  comment_sync_processed_limit=40",
      "  sync_batch_size=40",
      "  sync_comments_only=true",
      "  sync_open_pr_batch=false",
      "  scheduled_comment_sync=false",
      "  continue_apply=false",
      "  apply_kind=all",
      "  comment_sync_min_age_days=0",
      "  min_age_days=0",
      "  min_age_minutes=",
      "  apply_close_reasons=all",
      "  stale_min_age_days=60",
      "  close_delay_ms=2000",
      "  checkpoint_size=80",
      '  if [ "$checkpoint_size" -gt 40 ]; then checkpoint_size=40; fi',
      "  limit=40",
      "  item_numbers=",
      '  cursor_path="results/comment-sync-cursors/${target_slug}.json"',
      "  prepare_comment_sync_batch",
      '  printf "%s initial=%s\\n" "$TARGET_REPO" "$cursor_path"',
      '  jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "  printf '[]' > report.json",
      "  complete_comment_sync_batch report.json trace.json",
      '  printf "%s continue=%s cursor=%s\\n" "$TARGET_REPO" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
      '  if [ "$continue_apply" = "true" ]; then',
      "    item_numbers=",
      "    sync_open_pr_batch=true",
      '    cursor_path="results/comment-sync-cursors/${target_slug}.json"',
      "    prepare_comment_sync_batch",
      '    batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
      '    printf "%s resumed=%s initial-cursor=%s next=%s\\n" "$TARGET_REPO" "$cursor_path" "$comment_sync_initial_cursor" "$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")"',
      "  fi",
      "done",
    ]);

    assert.match(
      output,
      /^openclaw\/openclaw initial=results\/comment-sync-cursors\/openclaw-openclaw\.json$/m,
    );
    assert.match(output, /^openclaw\/openclaw continue=false cursor=40$/m);
    assert.match(
      output,
      /^openclaw\/clawhub initial=results\/comment-sync-cursors\/openclaw-clawhub\.json$/m,
    );
    assert.match(output, /^openclaw\/clawhub continue=true cursor=40$/m);
    assert.match(
      output,
      /^openclaw\/clawhub resumed=results\/comment-sync-cursors\/openclaw-clawhub\.json initial-cursor=40 next=41$/m,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom mutation-policy comment sync retains its own cursor and continuation", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  try {
    const output = runCommentSyncShell(root, [
      "mkdir -p .artifacts",
      "comment_sync_processed_limit=40",
      "sync_batch_size=40",
      "sync_comments_only=true",
      "sync_open_pr_batch=true",
      "scheduled_comment_sync=false",
      "continue_apply=false",
      'TARGET_REPO="openclaw/openclaw"',
      "target_slug=openclaw-openclaw",
      "cursor_path=results/comment-sync-cursors/openclaw-openclaw.json",
      "apply_kind=all",
      "comment_sync_min_age_days=0",
      "apply_close_reasons=duplicate_or_superseded",
      "stale_min_age_days=1",
      "item_numbers=",
      "prepare_comment_sync_batch",
      'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
      'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
      'next_cursor=$(awk -F= \'$1 == "next_cursor" { print $2 }\' <<< "$batch")',
      'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "printf '[]' > report.json",
      "complete_comment_sync_batch report.json trace.json",
      'printf "custom-cursor=%s\\ncontinue=%s\\nnext=%s\\npersisted=%s\\n" "$cursor_path" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
    ]);

    assert.match(
      output,
      /^custom-cursor=results\/comment-sync-cursors\/openclaw-openclaw-all-age0-policy-[a-f\d]{16}\.json$/m,
    );
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^persisted=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("urgent records do not falsely wrap a customized comment-sync cursor", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  const cursors = join(root, "results", "comment-sync-cursors");
  const now = new Date().toISOString();
  mkdirSync(records, { recursive: true });
  mkdirSync(cursors, { recursive: true });
  writeFileSync(join(cursors, "openclaw-clawhub.json"), '{"next_after_number":20}\n');
  writeFileSync(
    join(records, "5.md"),
    `---\nrepository: openclaw/clawhub\ntype: issue\nreview_status: complete\nlocal_checkout_access: verified\nlocal_checkout_access_source: runner_preflight_v1\nitem_snapshot_hash: abc123\naction_taken: kept_open\nreviewed_at: ${now}\n---\n`,
  );
  for (let number = 21; number <= 61; number += 1) {
    writeFileSync(
      join(records, `${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\nreviewed_at: 2025-01-01T00:00:00Z\nreview_comment_id: 9000\nreview_comment_url: https://github.com/openclaw/clawhub/pull/${number}#issuecomment-9000\nreview_comment_sha256: ${"a".repeat(64)}\nreview_comment_synced_at: ${now}\n---\n`,
    );
  }
  try {
    const output = runCommentSyncShell(root, [
      "mkdir -p .artifacts",
      "comment_sync_processed_limit=40",
      "sync_batch_size=40",
      "sync_comments_only=true",
      "sync_open_pr_batch=true",
      "scheduled_comment_sync=false",
      "continue_apply=false",
      'TARGET_REPO="openclaw/clawhub"',
      "target_slug=openclaw-clawhub",
      "cursor_path=results/comment-sync-cursors/openclaw-clawhub.json",
      "apply_kind=all",
      "comment_sync_min_age_days=0",
      "item_numbers=",
      "prepare_comment_sync_batch",
      'batch="$(pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path")"',
      'item_numbers=$(awk -F= \'$1 == "item_numbers" { print $2 }\' <<< "$batch")',
      'next_cursor=$(awk -F= \'$1 == "next_cursor" { print $2 }\' <<< "$batch")',
      'printf "selected=%s\\n" "$item_numbers"',
      'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "printf '[]' > report.json",
      "complete_comment_sync_batch report.json trace.json",
      'printf "continue=%s\\nnext=%s\\npersisted=%s\\n" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
    ]);

    assert.match(output, /^selected=21,5,22,/m);
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^persisted=59$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncursored synchronization continues repositories without scheduled maintenance", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  try {
    const output = runCommentSyncShell(root, [
      "comment_sync_processed_limit=40",
      "sync_batch_size=40",
      "sync_comments_only=true",
      "sync_open_pr_batch=false",
      "continue_apply=false",
      'TARGET_REPO="openclaw/clawhub"',
      "target_slug=openclaw-clawhub",
      "apply_kind=all",
      "item_numbers=",
      "prepare_comment_sync_batch",
      'printf "selected=%s\\n" "$item_numbers"',
      'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "printf '[]' > report.json",
      "complete_comment_sync_batch report.json trace.json",
      'printf "continue=%s\\nnext=%s\\ncursor=%s\\n" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
    ]);

    assert.match(output, /^continue=true$/m);
    assert.match(output, /^selected=1,2,3,/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^cursor=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual OpenClaw issue synchronization continues beyond scheduled PR coverage", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 41; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: issue\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  const sharedCursor = join(root, "results", "comment-sync-cursors", "openclaw-openclaw.json");
  mkdirSync(dirname(sharedCursor), { recursive: true });
  writeFileSync(sharedCursor, '{"next_after_number":50}\n');

  try {
    const output = runCommentSyncShell(root, [
      "comment_sync_processed_limit=40",
      "sync_batch_size=40",
      "sync_comments_only=true",
      "sync_open_pr_batch=false",
      "scheduled_comment_sync=false",
      "continue_apply=false",
      'TARGET_REPO="openclaw/openclaw"',
      "target_slug=openclaw-openclaw",
      "apply_kind=issue",
      "comment_sync_min_age_days=9",
      "item_numbers=",
      "prepare_comment_sync_batch",
      'printf "selected=%s\\n" "$item_numbers"',
      'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "printf '[]' > report.json",
      "complete_comment_sync_batch report.json trace.json",
      'printf "continue=%s\\nnext=%s\\ncursor=%s\\n" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
    ]);

    assert.match(output, /^continue=true$/m);
    assert.match(output, /^selected=1,2,3,/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^cursor=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscheduled cursor synchronization continues lower-numbered records after wraparound", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (const number of [5, 21]) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  const scopedCursor = join(root, "results", "comment-sync-cursors", "openclaw-clawhub.json");
  mkdirSync(dirname(scopedCursor), { recursive: true });
  writeFileSync(scopedCursor, '{"next_after_number":20}\n');

  try {
    const output = runCommentSyncShell(root, [
      "comment_sync_processed_limit=40",
      "sync_batch_size=40",
      "sync_comments_only=true",
      "sync_open_pr_batch=false",
      "scheduled_comment_sync=false",
      "continue_apply=false",
      'TARGET_REPO="openclaw/clawhub"',
      "target_slug=openclaw-clawhub",
      "apply_kind=all",
      "comment_sync_min_age_days=0",
      "item_numbers=",
      "prepare_comment_sync_batch",
      'printf "selected=%s\\n" "$item_numbers"',
      'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "printf '[]' > report.json",
      "complete_comment_sync_batch report.json trace.json",
      'printf "continue=%s\\nnext=%s\\ncursor=%s\\n" "$continue_apply" "$item_numbers" "$(jq -r .next_after_number "$cursor_path")"',
    ]);

    assert.match(output, /^selected=21$/m);
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^next=__cursor__$/m);
    assert.match(output, /^cursor=21$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscheduled wrapped synchronization drains every bounded window and then stops", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 7; number += 1) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  const policyFingerprint = createHash("sha256")
    .update(`${["all", "60", "2000", "40", "40", "2", "0", ""].join("\n")}\n`)
    .digest("hex")
    .slice(0, 16);
  const scopedCursor = join(
    root,
    "results",
    "comment-sync-cursors",
    `openclaw-clawhub-all-age0-policy-${policyFingerprint}.json`,
  );
  mkdirSync(dirname(scopedCursor), { recursive: true });
  writeFileSync(scopedCursor, '{"next_after_number":5}\n');

  try {
    const output = runCommentSyncShell(root, [
      "comment_sync_processed_limit=2",
      "sync_batch_size=2",
      "sync_comments_only=true",
      "sync_open_pr_batch=false",
      "scheduled_comment_sync=false",
      "continue_apply=false",
      'TARGET_REPO="openclaw/clawhub"',
      "target_slug=openclaw-clawhub",
      "apply_kind=all",
      "comment_sync_min_age_days=0",
      "item_numbers=",
      "prepare_comment_sync_batch",
      "while :; do",
      '  printf "window=%s\\n" "$item_numbers"',
      '  jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
      "  printf '[]' > report.json",
      "  continue_apply=false",
      "  complete_comment_sync_batch report.json trace.json",
      '  if [ "$continue_apply" != "true" ]; then break; fi',
      "  item_numbers=",
      "  sync_open_pr_batch=true",
      "  prepare_comment_sync_batch",
      '  pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path" > next.env',
      "  item_numbers=$(awk -F= '$1 == \"item_numbers\" { print $2 }' next.env)",
      "  next_cursor=$(awk -F= '$1 == \"next_cursor\" { print $2 }' next.env)",
      "  trim_comment_sync_cycle_batch",
      "done",
      'printf "continue=%s\\ncursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
    ]);

    assert.match(output, /^window=6,7$/m);
    assert.match(output, /^window=1,2$/m);
    assert.match(output, /^window=3,4$/m);
    assert.match(output, /^window=5$/m);
    assert.doesNotMatch(output, /^window=5,6$/m);
    assert.match(output, /^continue=false$/m);
    assert.match(output, /^cursor=5$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped cursor synchronization continues past newer out-of-cycle urgent records", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  const cursorPath = join(root, "results", "comment-sync-cursors", "openclaw-clawhub.json");
  mkdirSync(records, { recursive: true });
  mkdirSync(dirname(cursorPath), { recursive: true });
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  const syncedAt = "2026-08-01T00:00:00Z";
  for (let number = 41; number <= 100; number += 1) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      [
        "---",
        "repository: openclaw/clawhub",
        "type: pull_request",
        "review_status: complete",
        "local_checkout_access: verified",
        "local_checkout_access_source: runner_preflight_v1",
        "item_snapshot_hash: abc123",
        "action_taken: kept_open",
        `review_comment_id: ${9_000 + number}`,
        `review_comment_url: https://github.com/openclaw/clawhub/pull/${number}#issuecomment-${9_000 + number}`,
        `review_comment_sha256: ${"a".repeat(64)}`,
        `reviewed_at: ${syncedAt}`,
        `review_comment_synced_at: ${syncedAt}`,
        "---",
        "",
      ].join("\n"),
    );
  }
  writeFileSync(
    join(records, "openclaw-clawhub-150.md"),
    [
      "---",
      "repository: openclaw/clawhub",
      "type: pull_request",
      "review_status: complete",
      "local_checkout_access: verified",
      "local_checkout_access_source: runner_preflight_v1",
      "item_snapshot_hash: abc123",
      "action_taken: kept_open",
      "reviewed_at: 2026-08-02T00:00:00Z",
      "---",
      "",
    ].join("\n"),
  );
  writeFileSync(
    cursorPath,
    JSON.stringify({ next_after_number: 40, cycle_start_after_number: 100, cycle_wrapped: true }),
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=false",
          "continue_apply=false",
          "TARGET_REPO=openclaw/clawhub",
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          "comment_sync_min_age_days=0",
          'cursor_path="$CURSOR_PATH"',
          "item_numbers=",
          "prepare_comment_sync_batch",
          'pnpm run --silent workflow -- comment-sync-batch --target-repo "$TARGET_REPO" --apply-kind "$apply_kind" --batch-size "$sync_batch_size" --cursor-path "$cursor_path" > batch.env',
          "item_numbers=$(awk -F= '$1 == \"item_numbers\" { print $2 }' batch.env)",
          "next_cursor=$(awk -F= '$1 == \"next_cursor\" { print $2 }' batch.env)",
          "trim_comment_sync_cycle_batch",
          'printf "selected=%s\\n" "$item_numbers"',
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\ncursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          CURSOR_PATH: cursorPath,
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^selected=41,42,/m);
    assert.match(output, /^selected=.*78,79$/m);
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^cursor=79$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped cursor state never widens an explicit comment-sync selection", () => {
  const root = mkdtempSync(tmpPrefix);
  const cursor = join(root, "cursor.json");
  writeFileSync(
    cursor,
    '{"next_after_number":2,"cycle_start_after_number":5,"cycle_wrapped":true}\n',
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          'cursor_path="$CURSOR_PATH"',
          "item_numbers=99",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\n" "$item_numbers"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CURSOR_PATH: cursor,
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
        },
      },
    );

    assert.match(output, /^selected=99$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrapped cursor resets when every remaining boundary record disappears", () => {
  const root = mkdtempSync(tmpPrefix);
  const cursor = join(root, "cursor.json");
  writeFileSync(
    cursor,
    '{"next_after_number":2,"cycle_start_after_number":5,"cycle_wrapped":true}\n',
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=true",
          'cursor_path="$CURSOR_PATH"',
          "item_numbers=6,7",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\nwrapped=%s\\nhas_cycle=%s\\n" "$item_numbers" "$comment_sync_cycle_wrapped" "$(jq -r \'has("cycle_wrapped")\' "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          CURSOR_PATH: cursor,
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
        },
      },
    );

    assert.match(output, /^selected=6,7$/m);
    assert.match(output, /^wrapped=false$/m);
    assert.match(output, /^has_cycle=false$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscheduled cursor synchronization stops after its final full batch", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 40; number += 1) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          "continue_apply=false",
          'TARGET_REPO="openclaw/clawhub"',
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'jq -n --arg selected "$item_numbers" \'{schema_version:1,examined_item_numbers:($selected|split(",")|map(tonumber))}\' > trace.json',
          "printf '[]' > report.json",
          "complete_comment_sync_batch report.json trace.json",
          'printf "continue=%s\\ncursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^continue=false$/m);
    assert.match(output, /^cursor=40$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncursored comment synchronization selects and continues the full eligible inventory", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-openclaw", "items");
  mkdirSync(records, { recursive: true });
  for (let number = 1; number <= 1002; number += 1) {
    writeFileSync(
      join(records, `openclaw-openclaw-${number}.md`),
      `---\nrepository: openclaw/openclaw\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: ${number === 1002 ? "retry_pr_close_coverage_proof" : "kept_open"}\n---\n`,
    );
  }
  writeFileSync(
    join(records, "openclaw-openclaw-1003.md"),
    "---\nrepository: openclaw/openclaw\ntype: pull_request\nreview_status: failed\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n",
  );
  writeFileSync(
    join(records, "openclaw-openclaw-1004.md"),
    "---\nrepository: openclaw/openclaw\ntype: pull_request\nreview_status: complete\naction_taken: kept_open\n---\n",
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "comment_sync_processed_limit=40",
          "sync_batch_size=40",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          'TARGET_REPO="openclaw/openclaw"',
          "target_slug=openclaw-openclaw",
          "apply_kind=all",
          "item_numbers=",
          "prepare_comment_sync_batch",
          'printf "selected=%s\\ncursor_path=%s\\n" "$item_numbers" "$cursor_path"',
          'mkdir -p "$(dirname "$cursor_path")"',
          'printf \'{"next_after_number":980}\\n\' > "$cursor_path"',
          "item_numbers=",
          "sync_open_pr_batch=false",
          "prepare_comment_sync_batch",
          'printf "resumed=%s\\n" "$item_numbers"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^selected=1,2,3,/m);
    assert.match(output, /^selected=.*39,40$/m);
    assert.match(output, /^resumed=981,982,/m);
    assert.match(output, /^resumed=.*1001,1002,1003$/m);
    assert.doesNotMatch(output, /^resumed=.*1004/m);
    assert.match(output, /results\/comment-sync-cursors\/openclaw-openclaw\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment synchronization checkpoints only completed records after a runtime yield", () => {
  const root = mkdtempSync(tmpPrefix);
  const completeReport = join(root, "complete.json");
  const partialReport = join(root, "partial.json");
  const untouchedReport = join(root, "untouched.json");
  const completeTrace = join(root, "complete-trace.json");
  const partialTrace = join(root, "partial-trace.json");
  const untouchedTrace = join(root, "untouched-trace.json");
  const invalidTrace = join(root, "invalid-trace.json");
  const cursorPath = join(root, "comment-sync-cursor.json");
  writeFileSync(completeReport, JSON.stringify([{ number: 50, action: "review_comment_synced" }]));
  writeFileSync(
    partialReport,
    JSON.stringify([
      { number: 10, action: "review_comment_synced" },
      { number: 20, action: "skipped_stale_review_comment_sync" },
      { number: 30, action: "skipped_runtime_budget" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  writeFileSync(
    untouchedReport,
    JSON.stringify([
      { number: 10, action: "skipped_runtime_budget" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  writeFileSync(
    completeTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20, 30, 40, 50] }),
  );
  writeFileSync(
    partialTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20] }),
  );
  writeFileSync(untouchedTrace, JSON.stringify({ schema_version: 1, examined_item_numbers: [] }));
  writeFileSync(invalidTrace, JSON.stringify({ schema_version: 1, examined_item_numbers: [30] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          'TARGET_REPO="openclaw/openclaw"',
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "comment_sync_pending_items=",
          "continue_apply=false",
          "item_numbers=10,20,30,40,50",
          "next_cursor=50",
          'complete_comment_sync_batch "$COMPLETE_REPORT" "$COMPLETE_TRACE"',
          'printf "complete=%s|count=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count"',
          "next_cursor=50",
          'complete_comment_sync_batch "$PARTIAL_REPORT" "$PARTIAL_TRACE"',
          'printf "partial=%s|count=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count"',
          "next_cursor=50",
          'complete_comment_sync_batch "$UNTOUCHED_REPORT" "$UNTOUCHED_TRACE"',
          'printf "untouched=%s|next=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$next_cursor"',
          'if complete_comment_sync_batch "$PARTIAL_REPORT" "$INVALID_TRACE" 2>/dev/null; then echo missing_prefix_published; else echo missing_prefix_rejected; fi',
          'printf "missing_prefix_cursor=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          COMPLETE_REPORT: completeReport,
          PARTIAL_REPORT: partialReport,
          UNTOUCHED_REPORT: untouchedReport,
          COMPLETE_TRACE: completeTrace,
          PARTIAL_TRACE: partialTrace,
          UNTOUCHED_TRACE: untouchedTrace,
          INVALID_TRACE: invalidTrace,
          CURSOR_PATH: cursorPath,
        },
      },
    );

    assert.match(output, /^complete=50\|count=5$/m);
    assert.match(output, /^partial=20\|count=2$/m);
    assert.match(output, /^untouched=20\|next=$/m);
    assert.match(output, /^missing_prefix_published$/m);
    assert.match(output, /^missing_prefix_cursor=20$/m);
    assert.doesNotMatch(output, /^missing_prefix_rejected$/m);
    assert.doesNotMatch(output, /^partial=30$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment sync advances a completed frontier before a budget-clipped urgent tail", () => {
  const root = mkdtempSync(tmpPrefix);
  const cursorPath = join(root, "comment-sync-cursor.json");
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  writeFileSync(cursorPath, JSON.stringify({ next_after_number: 105854 }));
  writeFileSync(
    reportPath,
    JSON.stringify([
      { number: 105870, action: "kept_open" },
      { number: 87267, action: "skipped_runtime_budget" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  writeFileSync(
    tracePath,
    JSON.stringify({
      schema_version: 1,
      examined_item_numbers: [105870],
    }),
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          'TARGET_REPO="openclaw/openclaw"',
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=true",
          "comment_sync_initial_cursor=105854",
          "item_numbers=87267,95788,97566,105342,105870",
          "next_cursor=105870",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "advanced=%s|count=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count"',
          'pnpm run workflow -- write-comment-sync-cursor --cursor-path "$cursor_path" --next-cursor 105854 --target-repo "$TARGET_REPO"',
          "item_numbers=87267,95788,97566,105342,105870",
          "next_cursor=105870",
          'printf \'{"schema_version":1,"examined_item_numbers":[]}\' > clipped-trace.json',
          'complete_comment_sync_batch "$REPORT_PATH" clipped-trace.json',
          'printf "clipped=%s|count=%s|next=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count" "$next_cursor"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          CURSOR_PATH: cursorPath,
          REPORT_PATH: reportPath,
          TRACE_PATH: tracePath,
        },
      },
    );

    assert.match(output, /^advanced=105870\|count=1$/m);
    assert.match(output, /^clipped=105854\|count=0\|next=$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comment synchronization advances past records archived during scoped reconciliation", () => {
  const root = mkdtempSync(tmpPrefix);
  const targetSlug = "openclaw-clawhub";
  const recordsDir = join(root, "records", targetSlug);
  const cursorPath = join(root, "results", "comment-sync-cursors", `${targetSlug}.json`);
  const tracePath = join(root, "trace.json");
  const reportPath = join(root, "report.json");
  mkdirSync(join(recordsDir, "items"), { recursive: true });
  mkdirSync(join(recordsDir, "closed"), { recursive: true });
  mkdirSync(dirname(cursorPath), { recursive: true });
  mkdirSync(join(root, ".artifacts"), { recursive: true });
  writeFileSync(join(recordsDir, "closed", `${targetSlug}-10.md`), "closed\n");
  for (const number of [20, 30]) {
    writeFileSync(
      join(recordsDir, "items", `${targetSlug}-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [20] }));
  writeFileSync(reportPath, JSON.stringify([{ number: 20, action: "review_comment_synced" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          "TARGET_REPO=openclaw/clawhub",
          "target_slug=openclaw-clawhub",
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=false",
          "sync_batch_size=40",
          "apply_kind=all",
          "comment_sync_initial_cursor=0",
          "continue_apply=false",
          "item_numbers=10,20",
          "next_cursor=20",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "cursor=%s\\ncount=%s\\ncontinue=%s\\n" "$(jq -r .next_after_number "$cursor_path")" "$comment_sync_cursor_advance_count" "$continue_apply"',
          "continue_apply=false",
          "item_numbers=5,20",
          "next_cursor=20",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "unknown_count=%s\\nunknown_next=%s\\n" "$comment_sync_cursor_advance_count" "$next_cursor"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          CURSOR_PATH: cursorPath,
          TRACE_PATH: tracePath,
          REPORT_PATH: reportPath,
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
        },
      },
    );

    assert.match(output, /^cursor=20$/m);
    assert.match(output, /^count=2$/m);
    assert.match(output, /^continue=true$/m);
    assert.match(output, /^unknown_count=0$/m);
    assert.match(output, /^unknown_next=$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("urgent synchronization never advances past unfinished lower-numbered records", () => {
  const root = mkdtempSync(tmpPrefix);
  const cursorPath = join(root, "comment-sync-cursor.json");
  const urgentTrace = join(root, "urgent-trace.json");
  const partialTrace = join(root, "partial-trace.json");
  const reorderedUrgentTrace = join(root, "reordered-urgent-trace.json");
  const reorderedCompleteTrace = join(root, "reordered-complete-trace.json");
  const reportPath = join(root, "report.json");
  writeFileSync(cursorPath, JSON.stringify({ next_after_number: 100 }));
  writeFileSync(urgentTrace, JSON.stringify({ schema_version: 1, examined_item_numbers: [1000] }));
  writeFileSync(
    partialTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [1000, 110] }),
  );
  writeFileSync(
    reorderedUrgentTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [120] }),
  );
  writeFileSync(
    reorderedCompleteTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [120, 110] }),
  );
  writeFileSync(reportPath, JSON.stringify([{ number: 1000, action: "review_comment_synced" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          "TARGET_REPO=openclaw/openclaw",
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "scheduled_comment_sync=true",
          "comment_sync_initial_cursor=100",
          "item_numbers=1000,110,120",
          "next_cursor=120",
          'complete_comment_sync_batch "$REPORT_PATH" "$URGENT_TRACE"',
          'printf "urgent-only=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
          "item_numbers=1000,110,120",
          "next_cursor=120",
          'complete_comment_sync_batch "$REPORT_PATH" "$PARTIAL_TRACE"',
          'printf "urgent-and-first=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
          'pnpm run workflow -- write-comment-sync-cursor --cursor-path "$cursor_path" --next-cursor 100 --target-repo "$TARGET_REPO"',
          "item_numbers=120,110",
          "next_cursor=120",
          'complete_comment_sync_batch "$REPORT_PATH" "$REORDERED_URGENT_TRACE"',
          'printf "reordered-urgent-only=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
          "item_numbers=120,110",
          "next_cursor=120",
          'complete_comment_sync_batch "$REPORT_PATH" "$REORDERED_COMPLETE_TRACE"',
          'printf "reordered-complete=%s\\n" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          CURSOR_PATH: cursorPath,
          REPORT_PATH: reportPath,
          URGENT_TRACE: urgentTrace,
          PARTIAL_TRACE: partialTrace,
          REORDERED_URGENT_TRACE: reorderedUrgentTrace,
          REORDERED_COMPLETE_TRACE: reorderedCompleteTrace,
        },
      },
    );

    assert.match(output, /^urgent-only=100$/m);
    assert.match(output, /^urgent-and-first=110$/m);
    assert.match(output, /^reordered-urgent-only=100$/m);
    assert.match(output, /^reordered-complete=120$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit comment synchronization stops an unproductive continuation before it can loop", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 0, action: "skipped_runtime_budget" }]));
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          "sync_open_pr_batch=false",
          "comment_sync_pending_items=",
          "continue_apply=false",
          "item_numbers=42",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "continue=%s\\nremaining=%s\\n" "$continue_apply" "$item_numbers"',
        ].join("\n"),
      ],
      { encoding: "utf8", env: { ...process.env, REPORT_PATH: reportPath, TRACE_PATH: tracePath } },
    );

    assert.match(output, /^continue=false$/m);
    assert.match(output, /^remaining=42$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cursor-based comment synchronization never continues after operational publication fails", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  const cursorPath = join(root, "comment-sync-cursor.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 10, action: "review_comment_synced" }]));
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [10] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          'TARGET_REPO="openclaw/openclaw"',
          'cursor_path="$CURSOR_PATH"',
          "sync_open_pr_batch=true",
          "comment_sync_pending_items=",
          "continue_apply=false",
          "item_numbers=10,20",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'publish_changes_with_strategy() { [ "$1" = normal ]; }',
          'publish_changes "test cursor publication" records results/comment-sync-cursors',
          'printf "continue=%s\\ncursor=%s\\n" "$continue_apply" "$(jq -r .next_after_number "$cursor_path")"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          REPORT_PATH: reportPath,
          TRACE_PATH: tracePath,
          CURSOR_PATH: cursorPath,
        },
      },
    );

    assert.match(output, /^continue=false$/m);
    assert.match(output, /^cursor=10$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscheduled cursor synchronization never continues after cursor publication fails", () => {
  const root = mkdtempSync(tmpPrefix);
  const records = join(root, "records", "openclaw-clawhub", "items");
  mkdirSync(records, { recursive: true });
  for (const number of [10, 20]) {
    writeFileSync(
      join(records, `openclaw-clawhub-${number}.md`),
      `---\nrepository: openclaw/clawhub\ntype: pull_request\nreview_status: complete\nitem_snapshot_hash: abc123\naction_taken: kept_open\n---\n`,
    );
  }
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 10, action: "review_comment_synced" }]));
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [10] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node "$WORKFLOW_UTILS_PATH" "$@"; }',
          'source "$APPLY_HELPER_PATH"',
          'TARGET_REPO="openclaw/clawhub"',
          "target_slug=openclaw-clawhub",
          "apply_kind=all",
          'cursor_path="results/comment-sync-cursors/openclaw-clawhub.json"',
          "sync_open_pr_batch=true",
          "sync_batch_size=1",
          "comment_sync_pending_items=",
          "continue_apply=false",
          "item_numbers=10",
          "mkdir -p .artifacts",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "before=%s\\n" "$continue_apply"',
          'publish_changes_with_strategy() { [ "$1" = normal ]; }',
          'publish_changes "test cursor publication" records results/comment-sync-cursors',
          'printf "after=%s\\n" "$continue_apply"',
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_BIN_DIR: dirname(process.execPath),
          APPLY_HELPER_PATH: join(process.cwd(), "scripts/apply-workflow-helpers.sh"),
          WORKFLOW_UTILS_PATH: join(process.cwd(), "dist/repair/workflow-utils.js"),
          REPORT_PATH: reportPath,
          TRACE_PATH: tracePath,
        },
      },
    );

    assert.match(output, /^before=true$/m);
    assert.match(output, /^after=false$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit item continuation survives unrelated cursor bookkeeping failure", () => {
  const output = execFileSync(
    "bash",
    [
      "-lc",
      [
        "source scripts/apply-workflow-helpers.sh",
        'TARGET_REPO="openclaw/clawhub"',
        "sync_open_pr_batch=false",
        "continue_apply=true",
        'publish_changes_with_strategy() { [ "$1" = normal ]; }',
        'publish_changes "test cursor publication" records results/comment-sync-cursors',
        'printf "continue=%s\\n" "$continue_apply"',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );

  assert.match(output, /^continue=true$/m);
});

test("explicit comment synchronization preserves all unfinished items after a runtime yield", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "report.json");
  const tracePath = join(root, "trace.json");
  const selected = Array.from({ length: 43 }, (_, index) => index + 1).join(",");
  writeFileSync(
    reportPath,
    JSON.stringify([
      { number: 1, action: "review_comment_synced" },
      { number: 2, action: "review_comment_synced" },
      { number: 3, action: "skipped_runtime_budget" },
      { number: 0, action: "skipped_runtime_budget" },
    ]),
  );
  writeFileSync(tracePath, JSON.stringify({ schema_version: 1, examined_item_numbers: [1, 2] }));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          "comment_sync_processed_limit=40",
          "sync_batch_size=43",
          "sync_comments_only=true",
          "sync_open_pr_batch=false",
          "continue_apply=false",
          'item_numbers="$SELECTED_ITEMS"',
          "prepare_comment_sync_batch",
          'complete_comment_sync_batch "$REPORT_PATH" "$TRACE_PATH"',
          'printf "continue=%s\\nremaining=%s\\ncount=%s\\n" "$continue_apply" "$item_numbers" "$comment_sync_cursor_advance_count"',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SELECTED_ITEMS: selected,
          REPORT_PATH: reportPath,
          TRACE_PATH: tracePath,
        },
      },
    );

    assert.match(output, /^continue=true$/m);
    assert.match(output, /^remaining=3,4,5,/m);
    assert.match(output, /^remaining=.*40,41,42,43$/m);
    assert.match(output, /^count=2$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow does not queue runtime-yield continuation without cursor progress", () => {
  const root = mkdtempSync(tmpPrefix);
  const reportPath = join(root, "apply-report.json");
  writeFileSync(reportPath, JSON.stringify([{ number: 0, action: "skipped_runtime_budget" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "pnpm() { printf '1\\n'; }",
          "source scripts/apply-workflow-helpers.sh",
          "continue_apply=false",
          "auto_selected_apply_batch=true",
          "cursor_advance_count=0",
          'if automatic_apply_runtime_reached "$REPORT_PATH"; then status=yielded; else status=no_yield; fi',
          'printf \'%s|%s\\n\' "$status" "$continue_apply"',
          "continue_apply=false",
          "cursor_advance_count=1",
          'if automatic_apply_runtime_reached "$REPORT_PATH"; then status=yielded; else status=no_yield; fi',
          'printf \'%s|%s\\n\' "$status" "$continue_apply"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          REPORT_PATH: reportPath,
        },
      },
    );

    assert.deepEqual(
      output
        .trim()
        .split("\n")
        .filter((line) => line.includes("|")),
      ["yielded|false", "yielded|true"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply checkpoint publishes a clean token-budget stop and a later run resumes", () => {
  const root = mkdtempSync(tmpPrefix);
  const stoppedReport = join(root, "stopped.json");
  const resumedReport = join(root, "resumed.json");
  writeFileSync(
    stoppedReport,
    JSON.stringify([
      {
        number: 0,
        action: "skipped_runtime_budget",
        reason: "apply token budget reached at 4300000ms since epoch",
      },
    ]),
  );
  writeFileSync(resumedReport, JSON.stringify([{ number: 42, action: "closed" }]));

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          "source scripts/apply-workflow-helpers.sh",
          "CLAWSWEEPER_APPLY_TOKEN_MINTED_AT_MS=1000000",
          "initialize_apply_token_budget",
          'printf "deadline=%s\\n" "$CLAWSWEEPER_APPLY_TOKEN_DEADLINE_MS"',
          'if apply_token_budget_reached "$STOPPED_REPORT"; then apply_token_budget_stop_summary 7 12; fi',
          'if apply_token_budget_reached "$RESUMED_REPORT"; then echo stopped-again; else echo resumed; fi',
        ].join("\n"),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, STOPPED_REPORT: stoppedReport, RESUMED_REPORT: resumedReport },
      },
    );
    assert.match(output, /deadline=4300000/);
    assert.match(
      output,
      /apply stopped at token budget: processed=7 remaining=~12; next run continues/,
    );
    assert.match(output, /resumed/);
    assert.doesNotMatch(output, /stopped-again/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply workflow drops a coverage-proof tail only after exact trace examination", () => {
  const root = mkdtempSync(tmpPrefix);
  const fastOnlyTrace = join(root, "fast-only.json");
  const firstProofTrace = join(root, "proof-first.json");
  const secondProofTrace = join(root, "proof-second.json");
  writeFileSync(
    fastOnlyTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [10, 20] }),
  );
  writeFileSync(
    firstProofTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [30] }),
  );
  writeFileSync(
    secondProofTrace,
    JSON.stringify({ schema_version: 1, examined_item_numbers: [40] }),
  );

  try {
    const output = execFileSync(
      "bash",
      [
        "-lc",
        [
          'export PATH="$NODE_BIN_DIR:$PATH"',
          'pnpm() { while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ "$#" -gt 0 ] && shift; node dist/repair/workflow-utils.js "$@"; }',
          "source scripts/apply-workflow-helpers.sh",
          "auto_selected_apply_batch=true",
          "item_numbers=10,20,30,40",
          "coverage_proof_item_numbers=30,40",
          'item_numbers_arg=(--item-numbers "$item_numbers")',
          'drop_bounded_coverage_proof_tail "$FAST_ONLY_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
          'drop_bounded_coverage_proof_tail "$FIRST_PROOF_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
          'drop_bounded_coverage_proof_tail "$SECOND_PROOF_TRACE"',
          'printf \'%s|%s|%s\\n\' "$item_numbers" "$coverage_proof_item_numbers" "${item_numbers_arg[*]}"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAST_ONLY_TRACE: fastOnlyTrace,
          FIRST_PROOF_TRACE: firstProofTrace,
          SECOND_PROOF_TRACE: secondProofTrace,
          NODE_BIN_DIR: dirname(process.execPath),
        },
      },
    );
    assert.deepEqual(output.trim().split("\n"), [
      "10,20,30,40|30,40|--item-numbers 10,20,30,40",
      "10,20,40|40|--item-numbers 10,20,40",
      "10,20||--item-numbers 10,20",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fanout inventory tokens can read repository metadata only.
test("target fanout inventory tokens read only repository metadata", () => {
  type Step = { name?: string; uses?: string; with?: Record<string, string> };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const tokens = workflow.jobs["target-fanout"]!.steps.filter((step) =>
    step.uses?.startsWith("actions/create-github-app-token@"),
  );
  assert.ok(tokens.length > 0);
  for (const token of tokens) {
    assert.deepEqual(
      Object.entries(token.with ?? {}).filter(([key]) => key.startsWith("permission-")),
      [["permission-metadata", "read"]],
      token.name,
    );
  }
});

test("public OpenClaw reads use workflow tokens without moving mutation identity", () => {
  type Step = {
    name?: string;
    id?: string;
    env?: Record<string, string>;
    run?: string;
    with?: Record<string, string>;
  };
  type Workflow = { jobs: Record<string, { steps: Step[] }> };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as Workflow;
  const find = (job: string, name: string) => {
    const selected = workflow.jobs[job]?.steps.find(
      (candidate) => candidate.name === name || candidate.id === name,
    );
    assert.ok(selected, `${job}: ${name}`);
    return selected;
  };

  const exactReview = find("event-review-apply", "Review exact event item");
  assert.equal(exactReview.env?.GH_TOKEN, "${{ steps.target-read-token.outputs.token }}");
  assert.equal(
    find("event-review-publish", "Confirm terminal item remains closed").env?.GH_TOKEN,
    "${{ steps.publication-context.outputs.target_repo == 'openclaw/openclaw' && github.token || steps.target-write-token.outputs.token }}",
  );
  assert.equal(
    find("apply-existing", "Reconcile before apply preselect").env?.GH_TOKEN,
    "${{ steps.target.outputs.target_repo == 'openclaw/openclaw' && github.token || steps.target-write-token.outputs.token }}",
  );

  const auditSelection = find("audit-dashboard", "Select target read token");
  assert.equal(auditSelection.env?.PRIMARY_TOKEN, "${{ github.token }}");
  assert.equal(
    auditSelection.env?.APP_FALLBACK_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.match(auditSelection.run ?? "", /Using workflow token for public audit reads/);
  assert.match(auditSelection.run ?? "", /Using ClawSweeper App token fallback for audit reads/);

  for (const [job, name, expression] of [
    [
      "event-review-apply",
      "Deliver GitHub effects and prepare direct state mutation",
      "${{ steps.target.outputs.target_repo == 'openclaw/openclaw' && github.token || '' }}",
    ],
    [
      "event-review-publish",
      "Publish event result and apply safe close",
      "${{ steps.publication-context.outputs.target_repo == 'openclaw/openclaw' && github.token || '' }}",
    ],
    [
      "apply-existing",
      "Apply unchanged proposed decisions with checkpoints",
      "${{ steps.target.outputs.target_repo == 'openclaw/openclaw' && github.token || '' }}",
    ],
  ] as const) {
    const selected = find(job, name);
    assert.equal(selected.env?.GH_TOKEN, "${{ steps.target-write-token.outputs.token }}");
    assert.equal(selected.env?.CLAWSWEEPER_PUBLIC_GH_TOKEN, expression);
  }
  const applyProof = find("apply-proof", "Generate bound close coverage proofs");
  assert.equal(
    exactReview.env?.CLAWSWEEPER_PROOF_INSPECTION_TOKEN,
    "${{ steps.target-read-token.outputs.token }}",
  );
  assert.equal(
    applyProof.env?.CLAWSWEEPER_PROOF_INSPECTION_TOKEN,
    "${{ steps.proof-inspection-token.outputs.token }}",
  );
  assert.equal(applyProof.env?.GH_TOKEN, "${{ github.token }}");
  const proofInspectionToken = find("apply-proof", "Create target proof inspection token");
  assert.equal(proofInspectionToken.with?.["permission-contents"], "read");
  assert.equal(proofInspectionToken.with?.["permission-issues"], "read");
  assert.equal(proofInspectionToken.with?.["permission-pull-requests"], "read");
});

test(
  "read-only checkout mode restores file modes and leaves git metadata writable",
  {
    skip:
      process.platform === "win32" ? "exact POSIX mode bits are not portable on Windows" : false,
  },
  () => {
    const root = mkdtempSync(tmpPrefix);
    try {
      const target = join(root, "target");
      const nested = join(target, "src");
      const gitDir = join(target, ".git");
      mkdirSync(nested, { recursive: true });
      mkdirSync(gitDir, { recursive: true });
      const sourceFile = join(nested, "app.ts");
      const executableFile = join(target, "tool.sh");
      const gitConfig = join(gitDir, "config");
      writeFileSync(sourceFile, "export const value = 1;\n");
      writeFileSync(executableFile, "#!/bin/sh\n");
      writeFileSync(gitConfig, "[core]\n");
      chmodSync(target, 0o755);
      chmodSync(nested, 0o750);
      chmodSync(sourceFile, 0o640);
      chmodSync(executableFile, 0o755);
      chmodSync(gitDir, 0o700);
      chmodSync(gitConfig, 0o600);

      const snapshots = makeTreeReadOnlyForTest(target);
      assert.equal(statSync(target).mode & 0o777, 0o555);
      assert.equal(statSync(nested).mode & 0o777, 0o555);
      assert.equal(statSync(sourceFile).mode & 0o777, 0o444);
      assert.equal(statSync(executableFile).mode & 0o777, 0o555);
      assert.equal(statSync(gitDir).mode & 0o777, 0o700);
      assert.equal(statSync(gitConfig).mode & 0o777, 0o600);

      restoreTreeModesForTest(snapshots);
      assert.equal(statSync(target).mode & 0o777, 0o755);
      assert.equal(statSync(nested).mode & 0o777, 0o750);
      assert.equal(statSync(sourceFile).mode & 0o777, 0o640);
      assert.equal(statSync(executableFile).mode & 0o777, 0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("exact-review target checkout restores the hourly cache and saves it before review", () => {
  type Step = {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, string>;
    "continue-on-error"?: boolean;
  };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = workflow.jobs["event-review-apply"]!.steps;
  const position = (predicate: (step: Step) => boolean, label: string) => {
    const index = steps.findIndex(predicate);
    assert.notEqual(index, -1, label);
    return index;
  };
  const keyIndex = position((step) => step.id === "target-git-cache-key", "cache key");
  const restoreIndex = position((step) => step.id === "target-git-cache", "cache restore");
  const checkoutIndex = position((step) => step.name === "Check out target repository", "checkout");
  const saveIndex = position((step) => step.id === "target-git-cache-save", "cache save");
  const pruneIndex = position(
    (step) => step.name === "Prune superseded target repository caches",
    "cache prune",
  );
  const codexSourceIndex = position(
    (step) => step.uses === "./.github/actions/setup-openclaw-codex-source",
    "Codex source",
  );
  const reviewIndex = position((step) => step.name === "Review exact event item", "review");
  assert.ok(keyIndex < restoreIndex && restoreIndex < checkoutIndex && checkoutIndex < saveIndex);
  assert.ok(saveIndex < pruneIndex && pruneIndex < codexSourceIndex && pruneIndex < reviewIndex);

  const [key, restore, checkout, save, prune] = [
    keyIndex,
    restoreIndex,
    checkoutIndex,
    saveIndex,
    pruneIndex,
  ].map((index) => steps[index]!);
  for (const gated of [key, restore]) assert.equal(gated.if, checkout.if);
  assert.equal(restore.uses, "actions/cache/restore@v6");
  assert.equal(restore.with?.key, "${{ steps.target-git-cache-key.outputs.key }}");
  assert.equal(
    restore.with?.["restore-keys"],
    "${{ steps.target-git-cache-key.outputs.day_prefix }}",
  );
  assert.equal(save.uses, "actions/cache/save@v6");
  assert.equal(save.with?.key, restore.with?.key);
  assert.equal(save.with?.path, restore.with?.path);
  assert.equal(save["continue-on-error"], true);
  assert.equal(
    save.if,
    "${{ steps.claim-exact-review-queue.outputs.claimed == 'true' && steps.target-checkout.outputs.cache_ready == 'true' && steps.target-git-cache.outputs.cache-hit != 'true' }}",
  );
  assert.equal(
    prune.if,
    "${{ steps.claim-exact-review-queue.outputs.claimed == 'true' && steps.target-git-cache-save.outcome == 'success' }}",
  );
  assert.equal(prune["continue-on-error"], true);
  assert.equal(checkout.id, "target-checkout");
  assert.match(
    checkout.run ?? "",
    /if \[ -z "\$CACHE_MATCHED_KEY" \]; then\s+rm -rf -- "\$cache_dir"/,
  );
  assert.match(checkout.run ?? "", /bash scripts\/review-target-checkout\.sh /);
  for (const step of steps) {
    for (const value of Object.values(step.with ?? {})) {
      assert.doesNotMatch(String(value), /-git-.*github\.run_id/, "no per-run git cache keys");
    }
  }

  const root = mkdtempSync(tmpPrefix);
  try {
    // Hourly key inside a day-scoped restore prefix inside a branch-scoped prune prefix.
    const keyOutput = join(root, "key-output");
    writeFileSync(keyOutput, "");
    const resolved = spawnSync("bash", ["-c", key.run!], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: keyOutput,
        RUNNER_OS: "Linux",
        TARGET_SLUG: "openclaw-openclaw",
        TARGET_BRANCH: "main",
      },
      encoding: "utf8",
    });
    assert.equal(resolved.status, 0, resolved.stderr);
    const outputs = Object.fromEntries(
      readFileSync(keyOutput, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
    assert.equal(outputs.prefix, "openclaw-openclaw-review-target-git-v1-Linux-main-");
    assert.match(outputs.key!, /^openclaw-openclaw-review-target-git-v1-Linux-main-\d{8}-\d{2}$/);
    assert.equal(outputs.day_prefix, outputs.key!.replace(/\d{2}$/, ""));

    // Prune keeps the two newest entries of this branch and never touches a
    // longer branch name that shares the prefix.
    const bin = join(root, "bin");
    const deletions = join(root, "deletions");
    mkdirSync(bin);
    writeFileSync(
      join(root, "caches.json"),
      JSON.stringify({
        actions_caches: [
          { id: 6, key: `${outputs.prefix}20260928-05` },
          { id: 5, key: `${outputs.prefix}foo-20260928-05` },
          { id: 4, key: `${outputs.prefix}20260928-04` },
          { id: 3, key: `${outputs.prefix}20260928-03` },
          { id: 2, key: `${outputs.prefix}foo-20260928-01` },
          { id: 1, key: `${outputs.prefix}20260927-23` },
        ],
      }),
    );
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bash\nif [[ " $* " == *" --method DELETE "* ]]; then echo "$*" >> '${deletions}'; exit 0; fi\ncat '${join(root, "caches.json")}'\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const pruned = spawnSync("bash", ["-c", prune.run!], {
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: "openclaw/clawsweeper",
        CACHE_PREFIX: outputs.prefix,
      },
      encoding: "utf8",
    });
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.deepEqual(readFileSync(deletions, "utf8").trim().split("\n"), [
      "api --method DELETE repos/openclaw/clawsweeper/actions/caches/3",
      "api --method DELETE repos/openclaw/clawsweeper/actions/caches/1",
    ]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("batch publication updates the durable comment once across replay", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const itemsDir = join(root, "items");
    const closedDir = join(root, "closed");
    const plansDir = join(root, "plans");
    const reportPath = join(root, "apply-report.json");
    const statePath = join(root, "comments.json");
    const logPath = join(root, "gh.log");
    const number = 125204;
    const reviewedAt = "2026-08-17T10:30:00.000Z";
    mkdirSync(itemsDir, { recursive: true });
    mkdirSync(plansDir, { recursive: true });
    const review = reportWithSyncedReviewComment(
      workPlanCandidateReport({
        repository: "openclaw/openclaw",
        number,
        title: "Hot intake publication regression",
        reviewed_at: reviewedAt,
        item_created_at: "2026-08-17T10:08:36.000Z",
        item_updated_at: reviewedAt,
        item_snapshot_hash: "reviewed-snapshot-125204",
        labels: JSON.stringify([]),
      }),
      number,
    );
    writeFileSync(
      join(itemsDir, `${number}.md`),
      review.report.replaceAll(
        `https://github.com/openclaw/clawsweeper/issues/${number}`,
        `https://github.com/openclaw/openclaw/issues/${number}`,
      ),
      "utf8",
    );
    writeFileSync(
      statePath,
      JSON.stringify([
        {
          id: 9000 + number,
          html_url: `https://github.com/openclaw/openclaw/issues/${number}#issuecomment-${9000 + number}`,
          created_at: "2026-08-17T10:31:00.000Z",
          updated_at: "2026-08-17T10:31:00.000Z",
          user: { login: "clawsweeper[bot]" },
          body: review.comment.replace("queue_fix_pr", "stale_publication"),
        },
      ]),
      "utf8",
    );
    writeFileSync(logPath, "", "utf8");

    const ghMock = `
const { appendFileSync, readFileSync, writeFileSync } = require("fs");
const logPath = ${JSON.stringify(logPath)};
const statePath = ${JSON.stringify(statePath)};
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--repo" ? rawArgs.slice(2) : rawArgs;
appendFileSync(logPath, JSON.stringify(args) + "\\n");
const path = args.includes("-i") ? args[args.indexOf("-i") + 1] : args[1] || "";
const comments = JSON.parse(readFileSync(statePath, "utf8"));
if (args[0] === "api" && /\\/issues\\/${number}$/.test(path)) {
  console.log(JSON.stringify({
    number: ${number},
    title: "Hot intake publication regression",
    body: "A recently created issue needs a review.",
    html_url: "https://github.com/openclaw/openclaw/issues/${number}",
    created_at: "2026-08-17T10:08:36.000Z",
    updated_at: ${JSON.stringify(reviewedAt)},
    closed_at: null,
    state: "open",
    locked: false,
    active_lock_reason: null,
    author_association: "CONTRIBUTOR",
    user: { login: "reporter" },
    labels: [],
    comments: comments.length,
    pull_request: null
  }));
} else if (args[0] === "api" && /\\/issues\\/${number}\\/timeline(?:\\?|$)/.test(path)) {
  console.log(JSON.stringify(args.includes("--slurp") ? [[]] : []));
} else if (args[0] === "api" && /\\/issues\\/${number}\\/comments(?:\\?|$)/.test(path)) {
  if (args.includes("--method") && args.includes("POST")) {
    const input = args[args.indexOf("--input") + 1];
    const body = JSON.parse(readFileSync(input, "utf8")).body;
    const comment = {
      id: 5315045852,
      html_url: "https://github.com/openclaw/openclaw/issues/${number}#issuecomment-5315045852",
      created_at: "2026-08-17T10:47:02.000Z",
      updated_at: "2026-08-17T10:47:02.000Z",
      user: { login: "clawsweeper[bot]" },
      body
    };
    writeFileSync(statePath, JSON.stringify([comment]), "utf8");
    console.log(JSON.stringify(comment));
  } else {
    console.log(JSON.stringify(args.includes("--slurp") ? [comments] : comments));
  }
} else if (args[0] === "api" && /\\/issues\\/comments\\/${9000 + number}$/.test(path) && args.includes("PATCH")) {
  const input = args[args.indexOf("--input") + 1];
  const body = JSON.parse(readFileSync(input, "utf8")).body;
  const comment = { ...comments[0], body, updated_at: "2026-08-17T10:47:02.000Z" };
  writeFileSync(statePath, JSON.stringify([comment]), "utf8");
  console.log(JSON.stringify(comment));
} else if (args[0] === "issue" && args[1] === "view") {
  console.log(JSON.stringify({ closedByPullRequestsReferences: [] }));
} else if (args[0] === "api" && /\\/collaborators\\/reporter\\/permission$/.test(path)) {
  console.log(JSON.stringify({ permission: "read", role_name: "read" }));
} else if (args[0] === "label" && args[1] === "create") {
  console.log(JSON.stringify({ name: args[2] }));
} else if (args[0] === "issue" && args[1] === "edit") {
  console.log("");
} else {
  console.error("unexpected gh args", JSON.stringify(args));
  process.exit(1);
}
`;
    withMockGh(root, ghMock, () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        runApplyDecisionsForTest({
          targetRepo: "openclaw/openclaw",
          itemsDir,
          closedDir,
          plansDir,
          reportPath,
          extraArgs: ["--sync-comments-only", "--item-numbers", String(number)],
        });
      }
    });

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const publications = calls.filter(
      (args) => args[0] === "api" && (args.includes("POST") || args.includes("PATCH")),
    );
    assert.equal(
      publications.length,
      1,
      `selected sync publishes once across a replay: ${readFileSync(reportPath, "utf8")}`,
    );
    const [published] = JSON.parse(readFileSync(statePath, "utf8")) as Array<{ body: string }>;
    assert.match(published?.body ?? "", /clawsweeper-review item=125204/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit target fanout waits in bounded waves without changing cadence or selection", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as Record<string, any>;
  const fanout = workflow.jobs["target-fanout"];
  const dispatch = fanout.steps.find((step: any) => step.name === "Dispatch selected targets");
  assert.match(dispatch.env.FANOUT_MODE, /'37 \*\/6 \* \* \*' && 'audit'/);
  assert.match(dispatch.env.FANOUT_LIMIT, /'37 \*\/6 \* \* \*' && '12'/);
  assert.match(fanout["timeout-minutes"], /'37 \*\/6 \* \* \*' && 240 \|\| 30/);
});

test("hot fleet fanout stays at twenty minutes and normal backfill offers every twenty minutes", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    on: { schedule: Array<{ cron: string }> };
  };
  const schedules = workflow.on.schedule.map(({ cron }) => cron);

  assert.ok(schedules.includes("4/20 * * * *"));
  assert.ok(!schedules.includes("4/5 * * * *"));
  assert.ok(schedules.includes("*/5 * * * *"));
  assert.ok(schedules.includes("2/5 * * * *"));
  // Fleet normal fanout and the direct openclaw/openclaw normal planner each
  // offer every 20 minutes on distinct cron strings.
  assert.ok(schedules.includes("14/20 * * * *"));
  assert.ok(schedules.includes("9/20 * * * *"));
  for (const retired of ["41 * * * *", "1 * * * *", "1/5 * * * *", "41/10 * * * *"]) {
    assert.ok(!schedules.includes(retired), retired);
  }
  assert.equal(new Set(schedules).size, schedules.length);
  assert.ok(schedules.includes("37 */6 * * *"));
});

test("review git info follows the checked-out target branch", () => {
  const root = mkdtempSync(`${tmpPrefix}review-target-branch-`);
  try {
    const origin = join(root, "origin");
    const checkout = join(root, "checkout");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    mkdirSync(origin);
    git(origin, "init", "--quiet", "--initial-branch", "main");
    for (const branch of ["main", "release/2026"]) {
      if (branch !== "main") git(origin, "checkout", "--quiet", "-b", branch);
      git(
        origin,
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        branch,
      );
    }
    git(root, "clone", "--quiet", "--branch", "release/2026", origin, checkout);
    const runtime = createReviewRuntime({
      run: (command: string, args: string[], options: { cwd: string }) =>
        execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }).trim(),
      ghJson: () => [],
    } as unknown as Parameters<typeof createReviewRuntime>[0]);
    const info = runtime.gitInfo(checkout);
    assert.equal(info.targetBranch, "release/2026");
    assert.equal(info.mainSha, git(origin, "rev-parse", "release/2026"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// GitHub accepts at most 25 workflow_dispatch inputs.
test("sweep workflow_dispatch input count stays under GitHub limit", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  };
  const count = Object.keys(workflow.on.workflow_dispatch.inputs).length;
  assert.ok(count <= 25, `workflow_dispatch has ${count} inputs`);
});

test("manual review docs name only declared sweep inputs", () => {
  const readme = readText("README.md");
  const scheduler = readText("docs/scheduler.md");
  const guidanceSections = [
    readme.slice(
      readme.indexOf("- Manual runs can select"),
      readme.indexOf("  capacity and pacing as scheduled feeds;"),
    ),
    scheduler.slice(
      scheduler.indexOf("supports `target_repo`"),
      scheduler.indexOf("Per-run `batch_size`"),
    ),
  ];
  const requiredInputs = ["item_number", "item_numbers"];
  const schedulerInputs = ["target_repo", "hot_intake"];
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  };
  const declaredInputs = new Set(Object.keys(workflow.on.workflow_dispatch.inputs));

  for (const guidance of guidanceSections) {
    assert.doesNotMatch(guidance, /`item_count`/);
    for (const input of requiredInputs) {
      assert.match(guidance, new RegExp(`\`${input}\``));
    }
    for (const [, documentedInput] of guidance.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
      assert.equal(
        declaredInputs.has(documentedInput),
        true,
        `${documentedInput} must remain a declared workflow input`,
      );
    }
  }
  for (const input of schedulerInputs) {
    assert.match(guidanceSections[1] ?? "", new RegExp(`\`${input}\``));
  }
});

// Automatic retries publish review comments only. The publisher must not let apply close the item.
test("review-only publication runs apply in comment-sync mode with no close budget", () => {
  const root = mkdtempSync(`${tmpPrefix}review-only-publication-`);
  try {
    const code = join(root, "code");
    mkdirSync(join(code, "dist"), { recursive: true });
    writeFileSync(
      join(code, "dist/clawsweeper.js"),
      `
const fs = require("node:fs");
const path = require("node:path");
const [command, ...args] = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (command === "apply-artifacts") {
  fs.mkdirSync(value("--items-dir"), { recursive: true });
  fs.copyFileSync(path.join(value("--artifact-dir"), "74.md"), path.join(value("--items-dir"), "74.md"));
} else {
  fs.writeFileSync(process.env.APPLY_ARGS, JSON.stringify([command, ...args]));
  process.exitCode = 23;
}
`,
    );
    const applyArgs = (reviewOnly: string) => {
      const work = join(root, `work-${reviewOnly}`);
      const artifacts = join(work, "artifacts/event");
      const argsPath = join(root, `apply-${reviewOnly}.json`);
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(
        join(artifacts, "74.md"),
        "---\nnumber: 74\nrepository: openclaw/openclaw\ntype: issue\nreviewed_at: 2026-09-07T00:00:00Z\ndecision: keep_open\n---\nReport\n",
      );
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), "dist/repair/publish-event-result.js")],
        {
          cwd: work,
          env: {
            PATH: process.env.PATH,
            TARGET_REPO: "openclaw/openclaw",
            ITEM_NUMBER: "74",
            EXACT_REVIEW_WORK_ROOT: work,
            CLAWSWEEPER_CODE_ROOT: code,
            REVIEW_ONLY: reviewOnly,
            APPLY_ARGS: argsPath,
          },
          encoding: "utf8",
          timeout: 10_000,
        },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const args = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
      assert.equal(args[0], "apply-decisions");
      return args;
    };
    const reviewOnly = applyArgs("true");
    assert.ok(reviewOnly.includes("--sync-comments-only"));
    assert.ok(reviewOnly.includes("--suppress-automation-markers"));
    assert.equal(reviewOnly[reviewOnly.indexOf("--limit") + 1], "0");
    const ordinary = applyArgs("false");
    assert.equal(ordinary.includes("--sync-comments-only"), false);
    assert.equal(ordinary[ordinary.indexOf("--limit") + 1], "1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A disabled ClawHub target must not start a target sweep.
test("target sweep dispatches preserve disabled ClawHub guard", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { if?: string }>;
  };
  assert.match(
    workflow.jobs.plan?.if ?? "",
    /github\.event_name == 'repository_dispatch' && github\.event\.client_payload\.target_repo == 'openclaw\/clawhub' && vars\.CLAWSWEEPER_ENABLE_CLAWHUB != '1'/,
  );
});

test("review backstops preserve resolved apply scope and recent lane activity", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const step = workflow.jobs["apply-existing"].steps.find(
    (candidate: { name?: string }) => candidate.name === "Queue review backstops",
  );
  assert.ok(step?.run);
  const run = step.run.replaceAll("${{ github.repository }}", "openclaw/clawsweeper");
  const applyRun = workflow.jobs["apply-existing"].steps.find(
    (candidate: { id?: string }) => candidate.id === "apply-existing-run",
  ).run as string;
  const inventoryStart = applyRun.indexOf(
    'if [ "$sync_comments_only" != "true" ] && [ -z "$item_numbers" ]; then',
    applyRun.indexOf("summarize_apply_candidate_quality"),
  );
  const idleEnd = applyRun.indexOf("\npnpm run status", inventoryStart);
  assert.ok(inventoryStart >= 0 && idleEnd > inventoryStart);
  const idleOwner = applyRun.slice(inventoryStart, idleEnd);
  const helpers = readText("scripts/apply-workflow-helpers.sh");
  const root = mkdtempSync(`${tmpPrefix}scoped-review-backstop-`);
  const calls = join(root, "calls");
  const recent = (displayTitle: string, databaseId: number) => ({
    databaseId,
    workflowPath: ".github/workflows/sweep.yml",
    displayTitle,
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const hot = recent("Review hot ClawSweeper items", 1);
  const normal = recent("Review ClawSweeper items", 2);
  const cases = [
    {
      name: "selected comments-only apply",
      scope: "false",
      commentsOnly: "true",
      items: "158071",
      recent: [],
      expected: [],
    },
    {
      name: "targeted close apply",
      scope: "false",
      commentsOnly: "false",
      items: "158071",
      recent: [],
      expected: [],
    },
    { name: "missing scope", scope: undefined, recent: [], expected: [] },
    { name: "automatic close backstop", scope: "true", recent: [], expected: ["true", "false"] },
    {
      name: "automatic close with empty inventory",
      idle: true,
      scope: undefined,
      recent: [],
      expected: ["true", "false"],
    },
    { name: "recent hot lane", scope: "true", recent: [hot], expected: ["false"] },
    { name: "recent normal lane", scope: "true", recent: [normal], expected: ["true"] },
    { name: "both lanes recent", scope: "true", recent: [hot, normal], expected: [] },
  ];
  try {
    for (const scenario of cases) {
      writeFileSync(calls, "");
      execFileSync(
        "bash",
        [
          "-e",
          "-u",
          "-c",
          `
pnpm() {
  printf 'pnpm %s\\n' "$*" >> "$BACKSTOP_CALLS"
  case "$*" in
    'run --silent workflow -- proposed-item-inventory '*) printf 'item_numbers=\\napply_ready_count=0\\ncandidate_counts_json={}\\n' ;;
    'run status '*) return 0 ;;
    'run --silent workflow -- limit review_shards.hot_intake_default') printf '5\\n' ;;
    'run --silent workflow -- limit review_shards.normal_default') printf '7\\n' ;;
    *) return 97 ;;
  esac
}
gh() {
  printf 'gh %s\\n' "$*" >> "$BACKSTOP_CALLS"
  case "$1" in
    api) printf '%s' "$BACKSTOP_RECENT_RUNS" ;;
    workflow) [ "$2" = run ] && [ "$3" = sweep.yml ] ;;
    *) return 98 ;;
  esac
}
${
  scenario.idle
    ? `(
${helpers}
write_apply_health() { :; }
publish_status() { :; }
auto_selected_apply_batch=false
sync_comments_only=false
item_numbers=
limit=40
checkpoint_size=40
close_processed_limit=600
min_age_days=0
min_age_minutes=
apply_kind=all
apply_close_reasons=implemented
stale_min_age_days=60
close_delay_ms=2000
progress_every=10
comment_sync_min_age_days=7
apply_cursor_path=cursor.json
candidate_quality_detail=
mkdir -p .artifacts/apply-reports
${idleOwner}
)
. "$GITHUB_ENV"
: > "$BACKSTOP_CALLS"`
    : ""
}
${run}`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            BACKSTOP_CALLS: calls,
            GITHUB_ENV: join(root, "github-env"),
            TARGET_REPO: "openclaw/openclaw",
            GITHUB_REPOSITORY: "openclaw/clawsweeper",
            GITHUB_RUN_ID: "123",
            BACKSTOP_RECENT_RUNS: scenario.recent.map((entry) => JSON.stringify(entry)).join("\n"),
            ...(scenario.scope === undefined ? {} : { APPLY_AUTO_SELECTED_BATCH: scenario.scope }),
            APPLY_SYNC_COMMENTS_ONLY: scenario.commentsOnly ?? "false",
            APPLY_ITEM_NUMBERS: scenario.items ?? "",
          },
        },
      );
      const observed = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);
      if (scenario.scope !== "true" && !scenario.idle) {
        assert.deepEqual(observed, [], `${scenario.name} must not read limits or call GitHub`);
        continue;
      }
      assert.equal(observed.filter((call) => call.startsWith("pnpm ")).length, 0, scenario.name);
      assert.equal(observed.filter((call) => call.startsWith("gh api ")).length, 1, scenario.name);
      const dispatches = observed.filter((call) => call.startsWith("gh workflow run "));
      assert.deepEqual(
        dispatches.map((call) => /-f hot_intake=(true|false)/.exec(call)?.[1]),
        scenario.expected,
        scenario.name,
      );
      for (const dispatch of dispatches) {
        assert.match(dispatch, /-f apply_existing=false -f hot_intake=/);
        assert.match(dispatch, /-f target_repo=openclaw\/openclaw/);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable cursor sync coalesces safely without discarding targeted batches", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    concurrency: { group: string };
    jobs: Record<string, { concurrency: { group: string; "cancel-in-progress": boolean } }>;
  };
  const applyJob = workflow.jobs["apply-existing"]!;
  const expression = workflow.concurrency.group.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const format = (template: string, ...values: string[]) =>
    template.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)] ?? "");
  const evaluateExpression = new Function(
    "github",
    "format",
    "vars",
    `return (${expression});`,
  ) as (
    github: Record<string, unknown>,
    formatter: typeof format,
    variables: Record<string, string>,
  ) => string;
  const evaluate = (
    github: Record<string, unknown>,
    formatter: typeof format,
    variables: Record<string, string> = { CLAWSWEEPER_AUTO_CLOSE_REASONS: "all" },
  ) => evaluateExpression(github, formatter, variables);
  const event = (
    runId: number,
    itemNumbers: string,
    scheduled = false,
    kind = "all",
    minimumAge = "0",
    applyLimit = "40",
    minimumItemAge = "0",
    minimumItemAgeMinutes = "",
    closeReasons = "",
    staleMinimumAge = "60",
    closeDelay = "2000",
    checkpointSize = "40",
  ) => ({
    event_name: scheduled ? "schedule" : "workflow_dispatch",
    run_id: runId,
    event: {
      schedule: scheduled ? "6,21,36,51 * * * *" : "",
      inputs: {
        target_repo: "openclaw/openclaw",
        apply_existing: scheduled ? "" : "true",
        apply_sync_comments_only: scheduled ? "" : "true",
        apply_item_numbers: itemNumbers,
        apply_kind: kind,
        apply_comment_sync_min_age_days: minimumAge,
        apply_limit: applyLimit,
        apply_min_age_days: minimumItemAge,
        apply_min_age_minutes: minimumItemAgeMinutes,
        apply_close_reasons: closeReasons,
        apply_stale_min_age_days: staleMinimumAge,
        apply_close_delay_ms: closeDelay,
        apply_checkpoint_size: checkpointSize,
        item_number: "",
        item_numbers: "",
        hot_intake: "",
        audit_dashboard: "",
      },
      client_payload: { target_repo: "", queue_lease_id: "", item_number: "" },
    },
  });

  assert.equal(
    evaluate(event(1, "__cursor__"), format),
    evaluate(event(2, "__cursor__"), format),
    "durable background cursors must coalesce",
  );
  assert.equal(
    evaluate(event(1, "__cursor__"), format),
    evaluate(event(3, "", true), format),
    "scheduled maintenance must share the durable background cursor",
  );
  for (const targetRepo of ["openclaw/openclaw", "openclaw/clawhub"]) {
    const initial = event(22, "__cursor__");
    const continuation = event(23, "__cursor__", false, "all", "0", "40", "0", "", "all");
    initial.event.inputs.target_repo = targetRepo;
    continuation.event.inputs.target_repo = targetRepo;
    assert.equal(
      evaluate(initial, format),
      evaluate(continuation, format),
      `automatic ${targetRepo} continuations must normalize the default close policy`,
    );
  }
  const customDefault = { CLAWSWEEPER_AUTO_CLOSE_REASONS: "duplicate_or_superseded" };
  assert.equal(
    evaluate(event(24, "__cursor__"), format, customDefault),
    evaluate(
      event(25, "__cursor__", false, "all", "0", "40", "0", "", "duplicate_or_superseded"),
      format,
      customDefault,
    ),
    "configured default close reasons must share their continuation group",
  );
  assert.notEqual(
    evaluate(event(26, "__cursor__"), format, customDefault),
    evaluate(
      event(27, "__cursor__", false, "all", "0", "40", "0", "", "all"),
      format,
      customDefault,
    ),
    "explicit all must remain independent when the configured default is narrower",
  );
  assert.notEqual(
    evaluate(event(4, "101,102"), format),
    evaluate(event(5, "103"), format),
    "explicit issue and PR batches must never cancel each other",
  );
  assert.notEqual(
    evaluate(event(6, "", false, "issue", "9"), format),
    evaluate(event(7, "", false, "pull_request", "0"), format),
    "custom manual selections must never cancel each other",
  );
  assert.notEqual(
    evaluate(event(8, "__cursor__", false, "all", "0", "1"), format),
    evaluate(event(9, "__cursor__"), format),
    "an operator-selected batch limit must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(event(10, "__cursor__", false, "all", "0", "40", "30"), format),
    evaluate(event(11, "__cursor__"), format),
    "an operator-selected item age must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(event(12, "__cursor__", false, "all", "0", "40", "0", "30"), format),
    evaluate(event(13, "__cursor__"), format),
    "an operator-selected minute-level item age must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(
      event(14, "__cursor__", false, "all", "0", "40", "0", "", "duplicate_or_superseded"),
      format,
    ),
    evaluate(event(15, "__cursor__"), format),
    "an operator-selected close reason must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(event(16, "__cursor__", false, "all", "0", "40", "0", "", "", "1"), format),
    evaluate(event(17, "__cursor__"), format),
    "an operator-selected stale-item age must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(event(18, "__cursor__", false, "all", "0", "40", "0", "", "", "60", "0"), format),
    evaluate(event(19, "__cursor__"), format),
    "an operator-selected close delay must not share the automatic cursor group",
  );
  assert.notEqual(
    evaluate(
      event(20, "__cursor__", false, "all", "0", "40", "0", "", "", "60", "2000", "5"),
      format,
    ),
    evaluate(event(21, "__cursor__"), format),
    "an operator-selected checkpoint size must not share the automatic cursor group",
  );
  assert.match(applyJob.concurrency.group, /^clawsweeper-target-apply-/);
  assert.equal(applyJob.concurrency["cancel-in-progress"], false);
});

test("explicit-item planning hydrates exactly the items selected for review", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const steps = workflow.jobs.plan.steps;
  const setup = steps.findIndex((step: { uses?: string }) => step.uses?.endsWith("/setup-pnpm"));
  const parser = steps.findIndex((step: { id?: string }) => step.id === "requested-items");
  const hydration = steps.findIndex((step: { uses?: string }) =>
    step.uses?.endsWith("/setup-state"),
  );
  assert.ok(setup >= 0 && setup < parser && parser < hydration);
  assert.equal(
    YAML.parse(readText(".github/actions/setup-pnpm/action.yml")).inputs["node-version"].default,
    "24",
  );
  const requested = steps.find((step: { id?: string }) => step.id === "requested-items");
  const hydrate = steps.find((step: { uses?: string }) => step.uses?.endsWith("/setup-state"));
  const select = steps.find((step: { id?: string }) => step.id === "select");
  assert.equal(
    hydrate.with["records-item-number"],
    "${{ steps.requested-items.outputs.item_numbers }}",
  );
  assert.equal(select.env.ITEM_NUMBERS, hydrate.with["records-item-number"]);
  const root = mkdtempSync(tmpPrefix);
  try {
    for (const [single, multiple, expected] of [
      ["", "", ""],
      ["133034", "", "133034"],
      ["", "133035,133034,133035", "133034,133035"],
      ["133034", "133035", "133034,133035"],
      ["133034", "router-receipt-123", "133034"],
    ]) {
      const output = join(root, "output");
      writeFileSync(output, "");
      execFileSync("bash", ["-e", "-c", requested.run], {
        env: { ...process.env, ITEM_NUMBER: single, ITEM_NUMBERS: multiple, GITHUB_OUTPUT: output },
      });
      assert.equal(readFileSync(output, "utf8").trim(), `item_numbers=${expected}`);
    }
    const invalid = spawnSync("bash", ["-e", "-c", requested.run], {
      env: {
        ...process.env,
        ITEM_NUMBER: "",
        ITEM_NUMBERS: "none",
        GITHUB_OUTPUT: join(root, "invalid"),
      },
      encoding: "utf8",
    });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /no valid item numbers/);
    assert.equal(existsSync(join(root, "invalid")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const jobId of ["publish-review-action-ledger", "recover-review-failures"]) {
  test(`${jobId} is never presented as model review or review publication in Bay`, async () => {
    const { publicStatusProjection } = await import("../dashboard/worker.ts");
    const job = {
      name:
        jobId === "publish-review-action-ledger"
          ? "Publish optional action ledger"
          : "Apply bounded item recovery",
      steps: [{ name: "Publish immutable action ledger" }],
    };
    const projected = publicStatusProjection({
      schema_version: 1,
      generated_at: "2026-09-08T08:00:00.000Z",
      source: { target_repository_count: 0 },
      fleet: {},
      workers: job.steps.map((entry: { name?: string; uses?: string }) => ({
        name: job.name,
        status: "in_progress",
        current_step: entry.name ?? entry.uses,
        steps: job.steps.map((step: { name?: string; uses?: string }) => ({
          name: step.name ?? step.uses,
        })),
      })),
      automatic_work: [],
      pipeline: [],
      bay: {},
      recent: {},
      diagnostics: { errors: [], error_count: 0 },
    });
    assert.equal(projected.workers.length, job.steps.length);
    for (const worker of projected.workers) {
      assert.ok(!["reviewing", "publishing"].includes(worker.stage));
      assert.equal(worker.status, "in_progress");
    }
  });
}

test("every action-ledger publication authenticates the expected producer job", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps?: Array<{ run?: string }> }>;
  };
  const invocation = "publish-action-events";
  const commandStart = `pnpm run --silent ${invocation} -- \\`;
  const isCanonicalValue = (value: string): boolean => {
    const quote = value[0] === "'" || value[0] === '"' ? value[0] : null;
    if (quote && (value.length < 3 || value.at(-1) !== quote)) return false;
    const word = quote ? value.slice(1, -1) : value;
    return (
      word.length > 0 &&
      word
        .split("")
        .every(
          (character) =>
            (character >= "a" && character <= "z") ||
            (character >= "A" && character <= "Z") ||
            (character >= "0" && character <= "9") ||
            character === "." ||
            character === "/" ||
            character === "_" ||
            character === "-" ||
            (quote !== null && (character === "$" || character === "{" || character === "}")),
        )
    );
  };
  const countOccurrences = (line: string): number => {
    let count = 0;
    let offset = 0;
    while (true) {
      const index = line.indexOf(invocation, offset);
      if (index === -1) return count;
      count += 1;
      offset = index + invocation.length;
    }
  };
  const commandsFromScript = (script: string): Array<Map<string, string>> => {
    const lines = script.split("\n");
    const commands: Array<Map<string, string>> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const occurrences = countOccurrences(line);
      if (occurrences === 0) continue;
      assert.equal(occurrences, 1, "publisher lines must contain one invocation");
      assert.ok(
        [commandStart, `node dist/clawsweeper.js ${invocation} \\`].includes(line.trimStart()),
        "publisher invocations must use the standalone canonical command form",
      );

      const args = new Map<string, string>();
      let continued = true;
      while (continued) {
        index += 1;
        assert.ok(index < lines.length, "publisher command must terminate");
        const argumentLine = lines[index]!.trimStart();
        assert.equal(
          countOccurrences(argumentLine),
          0,
          "publisher commands must not be nested in argument values",
        );
        const terminator = argumentLine.at(-1);
        assert.ok(
          terminator === "\\" || terminator === "|",
          "publisher arguments must end in a continuation or pipeline",
        );
        const argument = argumentLine.slice(0, -1).trimEnd();
        const separator = argument.indexOf(" ");
        assert.ok(separator > 2, "publisher arguments must use --name value");
        const name = argument.slice(0, separator);
        const value = argument.slice(separator + 1).trim();
        assert.ok(
          name.startsWith("--") &&
            name
              .slice(2)
              .split("")
              .every(
                (character) =>
                  (character >= "a" && character <= "z") ||
                  (character >= "0" && character <= "9") ||
                  character === "-",
              ),
          "publisher argument names must be canonical",
        );
        assert.ok(value && isCanonicalValue(value), `${name} must have one shell-safe line value`);
        assert.equal(args.has(name), false, `${name} must not be repeated`);
        args.set(name, value);
        continued = terminator === "\\";
      }
      commands.push(args);
    }
    return commands;
  };
  const commands = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) => commandsFromScript(step.run ?? "")),
  );

  const validCommand = `${commandStart}\n  --state-root . \\\n  --expected-producer-job review |`;
  assert.equal(commandsFromScript(validCommand)[0]!.get("--expected-producer-job"), "review");
  for (const malformed of [
    `# ${validCommand}`,
    `echo ${validCommand}`,
    `timeout 20s ${validCommand}`,
    `${commandStart} \n  --expected-producer-job review |`,
    `${commandStart}\n  --state-root first \\\\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --state-root . # \\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --source-root "$SOURCE_ROOT\\\n  --expected-producer-job fake" \\\n  --state-root . |`,
    `${commandStart}\n  --expected-producer-job review \\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --expected-producer-job "$GITHUB_JOB" --expected-producer-job fake |`,
    `${commandStart}\n  --expected-producer-job # missing |`,
    `${commandStart}\n  --state-root first && \\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --state-root . > \\\n  --expected-producer-job fake |`,
    `${commandStart}\n  --expected-producer-job review \\\n  --state-root .\${IFS}--expected-producer-job\${IFS}fake |`,
    `${commandStart}\n  --source-root "$(pnpm run --silent publish-action-events --)" \\\n  --expected-producer-job review |`,
    `pnpm run --silent publish-action-events \\\n  -- \\\n  --state-root . |`,
  ]) {
    assert.throws(() => commandsFromScript(malformed));
  }
  assert.equal(commands.length, 3);
  const expectedProducerJobs = new Set(['"$GITHUB_JOB"', "apply-proof"]);
  assert.ok(
    commands.every((command) =>
      expectedProducerJobs.has(command.get("--expected-producer-job") ?? ""),
    ),
  );
  assert.ok(commands.some((command) => command.get("--expected-producer-job") === "apply-proof"));
});

test("exact review publication enqueue passes only on a 2xx status with a queued, deduped or superseded body", () => {
  type WorkflowStep = { name?: string; id?: string; run?: string };
  type WorkflowJob = { steps: WorkflowStep[] };
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, WorkflowJob>;
  };
  const publicationEnqueue = workflow.jobs["event-review-apply"]?.steps.find(
    (candidate) => candidate.id === "queue-exact-review-publication",
  );
  assert.ok(publicationEnqueue, "missing queue-exact-review-publication step");
  // The curl stub writes the status line, the body and --write-out like curl.
  // With --fail and a status of 400 or more, it prints no body and exits 22.
  // The jq shim gives the jq 1.6 result for empty input without --slurp: exit
  // 0, even with -e. The runner jq exits 4 there, so without the shim this
  // test could not see a step that trusts an empty body.
  const fixture = [
    "sleep() { :; }",
    "curl() {",
    '  local output="" headers="" write_out="" fail=false',
    '  while [ "$#" -gt 0 ]; do',
    '    case "$1" in',
    '      --output) shift; output="$1" ;;',
    '      --dump-header) shift; headers="$1" ;;',
    '      --write-out) shift; write_out="$1" ;;',
    "      --fail) fail=true ;;",
    "    esac",
    "    shift",
    "  done",
    '  if [ "$MOCK_STATUS" = "000" ]; then printf "%s" "${write_out:+000}"; return 7; fi',
    '  printf "HTTP/1.1 %s\\r\\nretry-after: 0\\r\\n\\r\\n" "$MOCK_STATUS" > "$headers"',
    '  if [ "$fail" = true ] && [ "$MOCK_STATUS" -ge 400 ]; then return 22; fi',
    '  if [ -n "$output" ]; then printf "%s" "$MOCK_BODY" > "$output"; else printf "%s" "$MOCK_BODY"; fi',
    '  if [ -n "$write_out" ]; then printf "%s" "$MOCK_STATUS"; fi',
    "}",
    "jq() {",
    "  local input slurp=false argument",
    '  for argument in "$@"; do',
    '    case "$argument" in -s|--slurp) slurp=true ;; esac',
    "  done",
    '  if [ "$#" -gt 0 ] && [ -f "${!#}" ]; then input="$(<"${!#}")"; set -- "${@:1:$#-1}"; else input="$(cat)"; fi',
    '  if [ "$slurp" = false ] && [ -z "${input//[[:space:]]/}" ]; then return 0; fi',
    '  printf "%s" "$input" | command jq "$@"',
    "}",
  ].join("\n");
  const superseded = {
    ok: true,
    deduped: true,
    superseded: true,
    publication_revision: 1,
    superseded_by_revision: 5,
  };
  for (const [status, body, passes, name] of [
    ["202", { ok: true, queued: true }, true, "queued"],
    ["202", { ok: true, deduped: true }, true, "deduped"],
    ["202", superseded, true, "superseded"],
    ["202", "", false, "2xx without a body"],
    ["200", "not json", false, "2xx with a body that is not JSON"],
    ["202", { ok: false, queued: true }, false, "2xx that is not ok"],
    ["202", { ok: true, shed: true }, false, "2xx shed"],
    ["400", { error: "invalid_exact_review_item" }, false, "400"],
    ["409", superseded, false, "409 with a superseded body"],
    ["503", "", false, "503 after the retries"],
    ["000", "", false, "no connection"],
  ] as const) {
    const result = spawnSync("bash", ["-c", `${fixture}\n${publicationEnqueue.run}`], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: "a".repeat(40),
        ARTIFACT_NAME: "exact-review-42-1",
        CLAIM_DECISION: JSON.stringify({ targetRepo: "openclaw/openclaw", itemNumber: 7 }),
        CLAIM_GENERATION: "2",
        ITEM_KEY: "openclaw/openclaw#7",
        LEASE_REVISION: "3",
        QUEUE_LEASE_REVISION: "3",
        LIVE_GUARDED_OPEN: "false",
        LIVE_PROCEEDED: "true",
        LIVE_TERMINAL_MISSING: "false",
        LIVE_TERMINAL_NOOP: "false",
        PROTOCOL_VERSION: "2",
        QUEUE_URL: "https://queue.invalid",
        CLAWSWEEPER_WEBHOOK_SECRET: "fixture-secret",
        MOCK_STATUS: status,
        MOCK_BODY: typeof body === "string" ? body : JSON.stringify(body),
      },
    });
    assert.equal(result.error, undefined, name);
    assert.equal(result.status === 0, passes, `${name}: ${result.stderr}`);
    assert.equal(
      result.stdout.includes(
        "::notice::Exact-review publication revision 1 was superseded by revision 5; the newer publisher owns final delivery.",
      ),
      name === "superseded",
      name,
    );
  }
});

test("apply drift requeue selects source-drift skips before unverified-checkout keeps", () => {
  const root = mkdtempSync(tmpPrefix);
  try {
    const reportPath = join(root, "apply-report.json");
    writeFileSync(
      reportPath,
      JSON.stringify([
        { number: 101, action: "skipped_changed_since_review", reason: "updated_at changed" },
        { number: 102, action: "kept_open", reason: "review lacks verified local checkout access" },
        { number: 103, action: "kept_open", reason: "no close proposal" },
        { number: 104, action: "skipped_changed_since_review", reason: "snapshot changed" },
        { number: 101, action: "skipped_changed_since_review", reason: "updated_at changed" },
        { number: 105, action: "kept_open", reason: "review lacks verified local checkout access" },
        { number: 0, action: "skipped_runtime_budget", reason: "budget" },
        { number: 106, action: "closed", reason: "implemented on main" },
      ]),
      "utf8",
    );

    const selected = execFileSync(
      process.execPath,
      [
        "dist/repair/workflow-utils.js",
        "apply-requeue-review-item-numbers",
        "--report",
        reportPath,
        "--limit",
        "3",
      ],
      { encoding: "utf8" },
    );
    assert.equal(selected, "101,104,102");

    const unlimited = execFileSync(
      process.execPath,
      [
        "dist/repair/workflow-utils.js",
        "apply-requeue-review-item-numbers",
        "--report",
        reportPath,
        "--limit",
        "10",
      ],
      { encoding: "utf8" },
    );
    assert.equal(unlimited, "101,104,102,105");

    const disabled = execFileSync(
      process.execPath,
      [
        "dist/repair/workflow-utils.js",
        "apply-requeue-review-item-numbers",
        "--report",
        reportPath,
        "--limit",
        "0",
      ],
      { encoding: "utf8" },
    );
    assert.equal(disabled, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact oversized PR admission uses the built predicate before reactions, reservation and target setup", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const steps = workflow.jobs["event-review-apply"].steps;
  const live = steps.find((step: any) => step.id === "live-item");
  const review = steps.find((step: any) => step.id === "review-exact-event-item");
  assert.match(live.run, /workflow -- exact-review-admission/);
  assert.match(review.run, /--pr-admission-file/);
  assert.doesNotMatch(review.if, /outputs\.oversized/);
  const reserve = steps.find((step: any) => step.id === "reserve-exact-review-lease");
  assert.doesNotMatch(reserve.if, /oversized/);
  assert.match(reserve.if, /live-item\.outputs\.proceed == 'true'/);
  const commandStatus = steps.find((step: any) => step.id === "mark-re-review-command-in-progress");
  assert.doesNotMatch(commandStatus.if, /oversized/);
  const fence = steps.find((step: any) => step.id === "review-status-fence");
  assert.doesNotMatch(fence.if, /oversized/);
  const oversizedBranch = review.run.slice(
    review.run.indexOf('if [ "$OVERSIZED_PR" = "true" ]; then'),
    review.run.indexOf('codex_timeout_ms="'),
  );
  assert.match(oversizedBranch, /--output-retention debug/);
  assert.match(oversizedBranch, /review_lease_args\[@\]/);
  for (const reservation of ["posted", "held", "superseded", ""]) {
    for (const authorized of [true, false]) {
      const condition = review.if
        .slice(3, -2)
        .replaceAll("steps.claim-exact-review-queue.outputs.claimed", '"true"')
        .replaceAll("steps.live-item.outputs.proceed", '"true"')
        .replaceAll("steps.reserve-exact-review-lease.outputs.status", JSON.stringify(reservation))
        .replaceAll("steps.review-status-fence.outcome", '"success"')
        .replaceAll(
          "steps.review-status-fence.outputs.authorized",
          JSON.stringify(String(authorized)),
        )
        .replaceAll("steps.release-review-status-fence.outputs.authorized", '"true"');
      assert.equal(Function(`return (${condition})`)(), reservation === "posted" && authorized);
    }
  }
  for (const id of [
    "create-exact-review-bundle",
    "direct-setup-state",
    "prepare-direct-exact-review-publication",
  ]) {
    const publication = steps.find((step: any) => step.id === id);
    assert.doesNotMatch(publication.if, /oversized/);
  }
  assert.match(
    steps.find((step: any) => step.id === "prepare-direct-exact-review-publication").run,
    /repair:publish-event-result/,
  );
  for (const step of steps.filter(
    (step: any) =>
      step.name === "React to target item review start" ||
      step.name === "Check out target repository" ||
      [
        "./.github/actions/setup-openclaw-codex-source",
        "./.github/actions/setup-codex",
        "./.github/actions/setup-openclaw",
      ].includes(step.uses),
  )) {
    assert.match(step.if, /outputs\.oversized != 'true'/, step.name ?? step.uses);
  }
});

for (const scenario of [
  "stable",
  "revoked",
  "head-drift",
  "exempt",
  "under-limit",
  "closed",
] as const) {
  test(`oversized exact-event reservation handoff: ${scenario}`, () => {
    const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
    const steps = workflow.jobs["event-review-apply"].steps;
    const run = steps.find((step: any) => step.id === "review-exact-event-item").run as string;
    const finalize = run.slice(
      run.indexOf("mark_finalizing() {"),
      run.indexOf("trap cleanup_heartbeat EXIT"),
    );
    const branch = run
      .slice(
        run.indexOf('if [ "$OVERSIZED_PR" = "true" ]; then'),
        run.indexOf('codex_timeout_ms="'),
      )
      .replaceAll("${{ steps.target.outputs.target_repo }}", "example/project")
      .replaceAll("${{ steps.target.outputs.item_number }}", "1");
    const root = mkdtempSync(tmpPrefix);
    try {
      symlinkSync(join(process.cwd(), "dist"), join(root, "dist"), "dir");
      const admission = join(root, "admission.json");
      const pull = {
        number: 1,
        state: "open",
        additions: 50001,
        deletions: 0,
        changed_files: 1,
        head: { sha: "b".repeat(40) },
        labels: [] as string[],
        updated_at: "2026-09-08T00:00:00Z",
        comments: 0,
      };
      const original = JSON.stringify({ repo: "example/project", pull });
      writeFileSync(admission, original);
      const current = { ...pull, comments: 1, updated_at: "2026-09-08T00:00:01Z" };
      if (scenario === "head-drift") current.head = { sha: "c".repeat(40) };
      if (scenario === "exempt") current.labels = ["size: accepted-large"];
      if (scenario === "under-limit") current.additions = 49999;
      if (scenario === "closed") current.state = "closed";
      const fixture = join(root, "pull.json");
      writeFileSync(fixture, JSON.stringify(current));
      const output = join(root, "output");
      const calls = join(root, "calls");
      execFileSync(
        "bash",
        [
          "-e",
          "-u",
          "-c",
          `
        pnpm() { printf '%s\\n' "$*" > "$MOCK_CALLS"; }
        gh() { cat "$MOCK_PULL"; }
        sleep() { return 0; }
        start_heartbeat() { return 0; }
        verify_startup_authority() { return 0; }
        cleanup_heartbeat() { return 0; }
        control_plane_curl() { printf '%s' "$MOCK_HTTP_STATUS"; }
        finalizing_payload='{}'
        superseded_marker="$TEST_ROOT/superseded"
        admission_args=(--pr-admission-file "$PR_ADMISSION_FILE")
        review_lease_args=(--review-lease-owner "$REVIEW_LEASE_OWNER" --review-lease-comment-id "$REVIEW_LEASE_COMMENT_ID")
        ${finalize}
        ${branch}
        exit 91
      `,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            PR_ADMISSION_FILE: admission,
            MOCK_PULL: fixture,
            MOCK_CALLS: calls,
            MOCK_HTTP_STATUS: scenario === "revoked" ? "409" : "200",
            REVIEW_LEASE_OWNER: "reserved",
            REVIEW_LEASE_COMMENT_ID: "1000",
            TEST_ROOT: root,
            OVERSIZED_PR: "true",
            GITHUB_OUTPUT: output,
            QUEUE_URL: "http://127.0.0.1",
          },
        },
      );
      assert.match(readText(output), /^exit_code=0$/m);
      if (scenario === "stable" || scenario === "revoked") {
        assert.match(
          readText(calls),
          /--review-lease-owner reserved --review-lease-comment-id 1000/,
        );
        const refreshed = JSON.parse(readText(admission));
        assert.deepEqual(refreshed.pull, current);
        assert.ok(Number.isFinite(Date.parse(refreshed.observedAt)));
        if (scenario === "revoked") assert.match(readText(output), /^superseded=true$/m);
        else assert.doesNotMatch(readText(output), /superseded|retry_at/);
      } else {
        assert.equal(existsSync(calls), false);
        assert.equal(readText(admission), original);
        assert.match(readText(output), /^retry_kind=coordination$/m);
        assert.match(readText(output), /^retry_at=/m);
      }
      assert.match(
        steps.find((step: any) => step.id === "create-exact-review-bundle").if,
        /review-exact-event-item\.outputs\.superseded != 'true'/,
      );
      assert.match(
        steps.find((step: any) => step.id === "create-exact-review-bundle").if,
        /review-exact-event-item\.outputs\.retry_at == ''/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("all workflow control-plane curls use the shared helper after download or full checkout", () => {
  for (const file of [
    "sweep.yml",
    "exact-review-reconcile-run.yml",
    "exact-review-dead-letter-reconcile.yml",
  ]) {
    const workflow = YAML.parse(readText(`.github/workflows/${file}`));
    for (const [jobName, job] of Object.entries(workflow.jobs) as [string, any][]) {
      let checkedOut = false;
      let downloaded = false;
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) checkedOut = true;
        const run = step.run ?? "";
        assert.doesNotMatch(run, /\bcurl --/, `${file}: ${step.name}`);
        if (step.name === "Fetch control-plane retry helper") {
          assert.match(
            run,
            /curl -fsSL --retry 3 --retry-all-errors --retry-connrefused "https:\/\/raw\.githubusercontent\.com\/\$\{GITHUB_REPOSITORY\}\/\$\{GITHUB_SHA\}\/scripts\/control-plane-curl\.sh"/,
          );
          assert.match(run, /test -s "\$RUNNER_TEMP\/control-plane-curl\.sh"/);
          assert.match(run, /declare -F control_plane_curl/);
          downloaded = true;
          continue;
        }
        if (!run.includes("control_plane_curl")) continue;
        assert.ok(
          checkedOut || downloaded,
          `${file}: ${jobName} has the helper before its first call`,
        );
        assert.match(
          run,
          checkedOut
            ? /source scripts\/control-plane-curl.sh/
            : /source "\$RUNNER_TEMP\/control-plane-curl.sh"/,
        );
        assert.doesNotMatch(run, /for attempt in 1 2 3; do/);
        const syntax = spawnSync("bash", ["-n"], { input: run, encoding: "utf8" });
        assert.equal(syntax.status, 0, `${step.name}: ${syntax.stderr}`);
      }
    }
  }
});

test("pre-checkout helper bootstrap fails on download errors, empty files, and missing functions", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  const bootstrap = workflow.jobs["event-review-apply"].steps.find(
    (step: any) => step.name === "Fetch control-plane retry helper",
  ).run;
  const root = mkdtempSync(`${tmpPrefix}helper-bootstrap-`);
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const [fixture, expected] of [
      ["exit 22", 22],
      ['while [ "$1" != "-o" ]; do shift; done; : > "$2"', 1],
      ['while [ "$1" != "-o" ]; do shift; done; echo ":" > "$2"', 1],
      ['while [ "$1" != "-o" ]; do shift; done; echo "control_plane_curl() { :; }" > "$2"', 0],
    ] as const) {
      writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\n${fixture}\n`, { mode: 0o755 });
      const result = spawnSync("bash", ["-c", bootstrap], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          RUNNER_TEMP: root,
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          GITHUB_SHA: "synthetic-commit",
        },
      });
      assert.equal(result.status, expected, `${fixture}: ${result.stderr}`);
      assert.equal(existsSync(join(root, ".git")), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("claimed-lease cleanup survives skipped and failed checkouts and uses source after success", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml"));
  for (const [jobName, stepName] of [
    ["event-review-apply", "Complete exact-review queue lease"],
    ["event-review-publish", "Complete durable exact review publication"],
    ["event-review-terminal-finalization", "Requeue unobserved terminal acknowledgement"],
  ]) {
    const steps = workflow.jobs[jobName].steps;
    const checkout = steps.find((step: any) => step.id === "source-checkout");
    assert.ok(checkout.uses.startsWith("actions/checkout@"));
    const cleanup = steps.find((step: any) => step.name === stepName);
    assert.equal(cleanup.env.SOURCE_CHECKOUT_OUTCOME, "${{ steps.source-checkout.outcome }}");
    assert.match(cleanup.if, /always\(\)/);
  }
  const proof = JSON.parse(
    execFileSync(process.execPath, ["scripts/e2e/control-plane-checkout-cleanup.mjs"], {
      encoding: "utf8",
    }),
  );
  assert.equal(proof.ok, true);
  assert.equal(proof.cases.length, 9);
});

// The model-running review step gets only its scoped lease, never the shared webhook secret.
test("exact review step carries the scoped lease tuple but not the shared webhook secret", () => {
  const workflow = YAML.parse(readText(".github/workflows/sweep.yml")) as {
    jobs: Record<string, { steps?: Array<{ id?: string; env?: Record<string, string> }> }>;
  };
  const review = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((step) => step.id === "review-exact-event-item");
  for (const name of [
    "EXACT_REVIEW_ITEM_KEY",
    "EXACT_REVIEW_LEASE_ID",
    "EXACT_REVIEW_LEASE_REVISION",
    "EXACT_REVIEW_CLAIM_GENERATION",
    "QUEUE_URL",
  ]) {
    assert.ok(review?.env?.[name], name);
  }
  assert.equal(review?.env?.CLAWSWEEPER_WEBHOOK_SECRET, undefined);
});
