import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(readFileSync(".github/workflows/sweep.yml", "utf8"));
const mode = workflow.jobs.plan.steps.find((step) => step.id === "mode").run;
for (const scenario of [
  { name: "broad manual", capacity: "7", share: "", expected: "7" },
  { name: "scheduled fanout share", capacity: "7", share: "3", expected: "3" },
  { name: "fanout bounded by capacity", capacity: "7", share: "9", expected: "7" },
  { name: "hard cap", capacity: "200", share: "", expected: "128" },
  { name: "unavailable queue", capacity: "failure", share: "", expected: "50" },
  { name: "invalid capacity", capacity: "bad", share: "", expected: "50" },
  { name: "hot intake", capacity: "4", share: "", hot: true, expected: "4" },
  { name: "explicit items", capacity: "failure", share: "", explicit: true, expected: "1" },
]) {
  test(`queued sweep planning: ${scenario.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "queue-planning-"));
    try {
      const output = join(root, "output"),
        calls = join(root, "calls");
      writeFileSync(calls, "");
      const commands = `pnpm() {
        case "$*" in
          *queue-pressure*) echo pressure >> "$CALLS"; if [ "$CAPACITY" = failure ]; then return 1; fi; printf '{"availableCandidateCapacity":"%s"}' "$CAPACITY" ;;
          *"limit review_shards.hard_cap"*) echo 128 ;;
          *) return 2 ;;
        esac
      }\n${mode}`;
      execFileSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", commands], {
        env: {
          ...process.env,
          CAPACITY: scenario.capacity,
          CALLS: calls,
          GITHUB_OUTPUT: output,
          QUEUE_URL: "https://synthetic.invalid",
          HOT_INTAKE: String(scenario.hot ?? false),
          MANUAL_EXPLICIT: String(scenario.explicit ?? false),
          ALLOCATED_CANDIDATES: scenario.share,
          CODEX_TIMEOUT_MS: "2400000",
        },
      });
      const values = Object.fromEntries(
        readFileSync(output, "utf8")
          .trim()
          .split("\n")
          .map((l) => l.split("=")),
      );
      assert.equal(values.batch_size, scenario.expected);
      assert.equal(values.codex_timeout_ms, "2400000");
      assert.equal(values.max_pages, scenario.hot ? "10" : "250");
      assert.equal(readFileSync(calls, "utf8"), scenario.explicit ? "" : "pressure\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("hosted sweep graph has no direct matrix bypass or retired manual control", () => {
  for (const id of [
    "review",
    "publish",
    "requeue-source-revision-drift",
    "publish-review-action-ledger",
    "recover-review-failures",
  ])
    assert.equal(Object.hasOwn(workflow.jobs, id), false, id);
  for (const name of [
    "batch_size",
    "shard_count",
    "apply_after_review",
    "apply_after_review_close_reasons",
    "apply_after_review_min_age_minutes",
  ])
    assert.equal(Object.hasOwn(workflow.on.workflow_dispatch.inputs, name), false, name);
  for (const name of [
    "target_branch",
    "codex_timeout_ms",
    "additional_prompt",
    "item_number",
    "item_numbers",
    "apply_existing",
  ])
    assert.ok(Object.hasOwn(workflow.on.workflow_dispatch.inputs, name), name);
  for (const job of Object.values(workflow.jobs) as Array<{ needs?: string | string[] }>)
    for (const dependency of [job.needs ?? []].flat())
      assert.ok(Object.hasOwn(workflow.jobs, dependency), dependency);
  assert.ok(workflow.jobs["apply-existing"]);
  assert.ok(workflow.jobs["event-review-publish"]);
});

test("automatic retry dispatch is serialized as automatic queue work with its source pin", () => {
  const intake = workflow.jobs["legacy-event-queue-intake"].steps.find(
    (step) => step.name === "Enqueue legacy event through the durable control plane",
  ).run;
  const scripts = [...intake.matchAll(/node <<'NODE'\n([\s\S]*?)\nNODE\n/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const kind of ["issue", "pull_request"]) {
    const payload = {
      target_repo: "openclaw/gogcli",
      item_number: 1455,
      item_kind: kind,
      source_event: kind === "issue" ? "issues" : "pull_request",
      source_action: "failed_review_shard_recovery",
      codex_timeout_ms: 1200000,
      additional_prompt: "Retry context",
      ...(kind === "issue"
        ? { expected_source_revision: "a".repeat(64) }
        : { source_head_sha: "b".repeat(40) }),
    };
    const result = JSON.parse(
      execFileSync(process.execPath, ["-"], {
        input: scripts[1],
        encoding: "utf8",
        env: {
          ...process.env,
          CLIENT_PAYLOAD: JSON.stringify(payload),
          TARGET_REPO: payload.target_repo,
          TARGET_BRANCH: "main",
          GITHUB_RUN_ID: "1001",
          GITHUB_RUN_ATTEMPT: "1",
        },
      }),
    );
    assert.equal(result.decision.sourceAction, "failed_review_shard_recovery");
    assert.equal(result.decision.itemKind, kind);
    assert.equal(result.decision.publicationPolicy, undefined);
    assert.equal(result.decision.additionalPrompt, "Retry context");
    assert.equal(result.decision.codexTimeoutMs, 1200000);
    assert.equal(
      result.decision.expectedSourceRevision,
      kind === "issue" ? "a".repeat(64) : undefined,
    );
    assert.equal(
      result.decision.sourceHeadSha,
      kind === "pull_request" ? "b".repeat(40) : undefined,
    );
  }
});

test("canonical implementation backfill preserves vision-fit and non-core policy gates", () => {
  const step = workflow.jobs.plan.steps.find(
    (candidate) => candidate.name === "Backfill existing implementation candidates",
  );
  assert.match(step.if, /manual_explicit != 'true'/);
  assert.match(step.if, /AUTO_IMPLEMENT_ISSUES == '1'/);
  assert.match(step.if, /target-read-token.outputs.token != ''/);
  assert.match(step.if, /target_repo != 'openclaw\/clawhub'/);
  assert.match(step.if, /AUTO_IMPLEMENT_VISION_FIT == '1'/);
  assert.match(step.env.CANDIDATE_KIND, /openclaw\/openclaw.*vision_fit.*viable/);
  assert.match(step.env.MAX_DISPATCH, /AUTO_IMPLEMENT_VISION_FIT_MAX_DISPATCH_PER_SWEEP/);
  assert.match(step.run, /--report-dir "records\/\$target_slug\/items"/);
});

test("queue planning retains nested dispatch options before legacy flat fallbacks", () => {
  const modeStep = workflow.jobs.plan.steps.find((step) => step.id === "mode");
  const enqueue = workflow.jobs.plan.steps.find((step) => step.id === "enqueue-scheduled");
  assert.match(
    modeStep.env.CODEX_TIMEOUT_MS,
    /client_payload\.review_options\.codex_timeout_ms \|\| github\.event\.client_payload\.codex_timeout_ms/,
  );
  assert.match(
    enqueue.env.ADDITIONAL_PROMPT,
    /client_payload\.review_options\.additional_prompt \|\| github\.event\.client_payload\.additional_prompt/,
  );
  assert.equal(enqueue.env.CODEX_TIMEOUT_MS, "${{ steps.mode.outputs.codex_timeout_ms }}");
});
