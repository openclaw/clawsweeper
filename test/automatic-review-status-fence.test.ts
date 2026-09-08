import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { proveCompletionSupersession } from "../docs/proof/terminal-review-explanations/completion-supersession.mjs";

function outputs(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function evaluate(template: string, values: Record<string, string>): unknown {
  const expression = template
    .replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
    .replace(/\balways\(\)/g, "true")
    .replace(
      /steps\.([a-z0-9-]+)\.(outputs\.([a-z0-9_]+)|outcome)/g,
      (_match, stepId: string, access: string, output?: string) =>
        JSON.stringify(values[`${stepId}.${output ?? access}`] ?? ""),
    );
  return Function(`"use strict"; return (${expression});`)();
}

test("automatic status fences distinguish stale handoffs from operational failures", () => {
  const steps = YAML.parse(readFileSync(".github/workflows/sweep.yml", "utf8")).jobs[
    "event-review-apply"
  ].steps;
  const generation = steps.find((step) => step.id === "exact-review-generation-result");
  const failure = steps.find((step) => step.name === "Fail unsuccessful exact review generation");
  const root = mkdtempSync(join(tmpdir(), "automatic-status-fence-"));
  const outputPath = join(root, "outputs");
  const generationPath = join(root, "generation");
  const fixture = [
    "curl() {",
    '  while [ "$#" -gt 0 ]; do',
    '    if [ "$1" = "--output" ]; then shift; printf "%s" "$MOCK_BODY" > "$1"; fi',
    "    shift",
    "  done",
    '  printf "%s" "$MOCK_STATUS"',
    "}",
  ].join("\n");
  const cases = [
    { status: "200", error: "", successful: true, superseded: false },
    { status: "409", error: "lease_superseded", successful: true, superseded: true },
    { status: "409", error: "lease_not_active", successful: true, superseded: true },
    {
      status: "409",
      error: "review_acknowledgement_comment_conflict",
      successful: false,
      superseded: false,
    },
    { status: "403", error: "forbidden", successful: false, superseded: false },
    { status: "503", error: "unavailable", successful: false, superseded: false },
  ];
  try {
    for (const id of [
      "review-status-fence",
      "release-review-status-fence",
      "review-complete-status-fence",
      "release-review-complete-status-fence",
    ]) {
      const fence = steps.find((step) => step.id === id);
      assert.ok(fence);
      assert.match(generation.env.REVIEW_SUPERSEDED, new RegExp(`${id}\\.outputs\\.superseded`));
      for (const scenario of cases) {
        writeFileSync(outputPath, "");
        const result = spawnSync("bash", ["-c", `${fixture}\n${fence.run}`], {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            GITHUB_OUTPUT: outputPath,
            GITHUB_RUN_ID: "42",
            GITHUB_RUN_ATTEMPT: "1",
            QUEUE_URL: "https://queue.invalid",
            EXACT_REVIEW_ITEM_KEY: "proof/fence#42",
            EXACT_REVIEW_LEASE_ID: "fixture-lease",
            EXACT_REVIEW_LEASE_REVISION: "1",
            EXACT_REVIEW_CLAIM_GENERATION: "1",
            EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
            REVIEW_ACKNOWLEDGEMENT_COMMENT_ID: "142",
            MOCK_STATUS: scenario.status,
            MOCK_BODY: JSON.stringify({ error: scenario.error }),
          },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status === 0, scenario.successful, result.stderr);
        const actual = outputs(outputPath);
        assert.equal(actual.authorized, scenario.status === "200" ? "true" : "false");
        assert.equal(actual.superseded === "true", scenario.superseded);
        if (!scenario.successful && id.includes("complete")) {
          assert.equal(
            evaluate(failure.if, {
              "claim-exact-review-queue.claimed": "true",
              "direct-exact-review-publication.accepted": "true",
              "complete-exact-review-queue.outcome": "success",
              "exact-review-generation-result.outcome": "success",
              [id + ".outcome"]: "failure",
            }),
            true,
          );
        }
        if (!scenario.superseded) continue;
        const values = {
          "claim-exact-review-queue.claimed": "true",
          "target.target_enabled": "true",
          "live-item.outcome": "success",
          "review-exact-event-item.outcome": id.includes("complete") ? "success" : "skipped",
          "review-exact-event-item.superseded": "false",
          "reserve-exact-review-lease.status": "posted",
          "complete-exact-review-queue.outcome": "failure",
          [`${id}.superseded`]: "true",
        };
        writeFileSync(generationPath, "");
        execFileSync("bash", ["-c", generation.run], {
          env: {
            PATH: process.env.PATH,
            ...Object.fromEntries(
              Object.entries(generation.env).map(([key, value]) => [
                key,
                String(evaluate(String(value), values)),
              ]),
            ),
            GITHUB_OUTPUT: generationPath,
          },
        });
        const generated = outputs(generationPath);
        assert.equal(generated.outcome, "success");
        assert.equal(generated.requeue_latest, "false");
        assert.equal(
          evaluate(failure.if, {
            ...values,
            "exact-review-generation-result.outcome": generated.outcome,
          }),
          false,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion-fence outages fail the workflow without changing successful queue ownership", () => {
  const steps = YAML.parse(readFileSync(".github/workflows/sweep.yml", "utf8")).jobs[
    "event-review-apply"
  ].steps;
  const fence = steps.find((step) => step.id === "review-complete-status-fence");
  const failure = steps.find((step) => step.name === "Fail unsuccessful exact review generation");
  assert.equal(fence["continue-on-error"], true, "publication and queue completion must still run");
  const root = mkdtempSync(join(tmpdir(), "completion-status-fence-"));
  const outputPath = join(root, "outputs");
  const fixture = [
    "curl() {",
    '  while [ "$#" -gt 0 ]; do',
    '    if [ "$1" = "--output" ]; then shift; printf "%s" "$MOCK_BODY" > "$1"; fi',
    "    shift",
    "  done",
    '  printf "%s" "$MOCK_STATUS"',
    '  return "$MOCK_EXIT"',
    "}",
  ].join("\n");
  const cases = [
    { status: "200", error: "", exit: "0", failed: false },
    { status: "409", error: "lease_superseded", exit: "0", failed: false },
    { status: "409", error: "lease_not_active", exit: "0", failed: false },
    { status: "409", error: "review_acknowledgement_comment_conflict", exit: "0", failed: true },
    { status: "403", error: "forbidden", exit: "0", failed: true },
    { status: "503", error: "unavailable", exit: "0", failed: true },
    { status: "000", error: "", exit: "7", failed: true },
  ];
  try {
    for (const scenario of cases) {
      writeFileSync(outputPath, "");
      const result = spawnSync("bash", ["-c", fixture + "\n" + fence.run], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          GITHUB_OUTPUT: outputPath,
          GITHUB_RUN_ID: "42",
          GITHUB_RUN_ATTEMPT: "1",
          QUEUE_URL: "https://queue.invalid",
          EXACT_REVIEW_ITEM_KEY: "proof/fence#42",
          EXACT_REVIEW_LEASE_ID: "fixture-lease",
          EXACT_REVIEW_LEASE_REVISION: "1",
          EXACT_REVIEW_CLAIM_GENERATION: "1",
          EXACT_REVIEW_SOURCE_HEAD_SHA: "a".repeat(40),
          REVIEW_ACKNOWLEDGEMENT_COMMENT_ID: "142",
          MOCK_STATUS: scenario.status,
          MOCK_BODY: JSON.stringify({ error: scenario.error }),
          MOCK_EXIT: scenario.exit,
        },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status !== 0, scenario.failed, result.stderr);
      assert.equal(outputs(outputPath).authorized, scenario.status === "200" ? "true" : "false");
      const values = {
        "claim-exact-review-queue.claimed": "true",
        "review-complete-status-fence.outcome": scenario.failed ? "failure" : "success",
        "direct-exact-review-publication.accepted": "true",
        "complete-exact-review-queue.outcome": "success",
        "reserve-exact-review-lease.status": "posted",
        "review-exact-event-item.outcome": "success",
        "exact-review-generation-result.outcome": "success",
      };
      assert.equal(evaluate(failure.if, values), scenario.failed);
      if (scenario.failed) {
        assert.equal(
          evaluate(failure.env.CLASSIFICATION, values),
          "review_status_delivery_failure",
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new revision during completion status blocks the obsolete artifact and publication path", async () => {
  const result = await proveCompletionSupersession();
  assert.equal(result.release_reason, "lease_superseded");
  assert.equal(result.new_revision_state, "pending");
  assert.equal(result.generation_outcome, "success");
  assert.equal(result.requeue_latest, false);
  assert.equal(result.blocked_steps.length, 8);
});
