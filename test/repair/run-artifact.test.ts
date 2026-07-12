import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { resolveRunArtifact } from "../../dist/repair/run-artifact.js";

const digest1 = "1".repeat(64);
const digest2 = "2".repeat(64);

test("reruns select the latest trusted producer attempt instead of the consumer attempt", () => {
  assert.deepEqual(
    resolveRunArtifact({
      artifacts: [
        artifact(101, 1, digest1),
        artifact(102, 2, digest2),
        artifact(103, 4, "3".repeat(64)),
      ],
      prefix: "clawsweeper-repair-execution",
      runId: "9001",
      currentAttempt: 3,
    }),
    {
      id: 102,
      name: "clawsweeper-repair-execution-9001-2",
      producerAttempt: 2,
      digest: digest2,
    },
  );
});

test("trusted producer outputs pin an exact artifact id and digest", () => {
  assert.equal(
    resolveRunArtifact({
      artifacts: [artifact(101, 1, digest1), artifact(102, 2, digest2)],
      prefix: "clawsweeper-repair-execution",
      runId: "9001",
      currentAttempt: 3,
      expectedArtifactId: "101",
      expectedArtifactDigest: `sha256:${digest1}`,
    }).id,
    101,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 1, digest1)],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
        expectedArtifactId: "101",
        expectedArtifactDigest: digest2,
      }),
    /digest does not match/,
  );
});

test("artifact resolution rejects expired, ambiguous, and untrusted candidates", () => {
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [{ ...artifact(101, 1, digest1), expired: true }],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
        expectedArtifactId: "101",
      }),
    /expired/,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [artifact(101, 2, digest1), artifact(102, 2, digest1)],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
      }),
    /ambiguous/,
  );
  assert.throws(
    () =>
      resolveRunArtifact({
        artifacts: [{ ...artifact(101, 1, digest1), digest: null }],
        prefix: "clawsweeper-repair-execution",
        runId: "9001",
        currentAttempt: 3,
      }),
    /missing a trusted digest/,
  );
});

test("repair workflow resolves producer artifacts by trusted id across rerun attempts", () => {
  const workflow = fs.readFileSync(".github/workflows/repair-cluster-worker.yml", "utf8");
  const downloadBlocks = [
    ...workflow.matchAll(
      /uses: actions\/download-artifact@v8\n\s+with:\n([\s\S]*?)(?=\n\s{6}- (?:name|uses):|\n\n)/g,
    ),
  ];
  assert.equal(downloadBlocks.length, 6);
  for (const block of downloadBlocks) {
    assert.match(block[1]!, /artifact-ids: \$\{\{ steps\.[^.]+\.outputs\.artifact_id \}\}/);
    assert.match(block[1]!, /github-token: \$\{\{ github\.token \}\}/);
    assert.match(block[1]!, /run-id: \$\{\{ github\.run_id \}\}/);
    assert.doesNotMatch(block[1]!, /name:|github\.run_attempt/);
  }
  assert.equal(
    [...workflow.matchAll(/pnpm run repair:resolve-run-artifact/g)].length,
    downloadBlocks.length,
  );
  for (const prefix of [
    "clawsweeper-repair-worker",
    "clawsweeper-repair-authorized",
    "clawsweeper-repair-execution",
    "clawsweeper-repair-validation",
  ]) {
    assert.match(workflow, new RegExp(`--prefix ${prefix}`));
  }
  assert.match(workflow, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
  assert.match(workflow, /artifact_id: \$\{\{ steps\.upload_execution\.outputs\.artifact-id \}\}/);
});

function artifact(id: number, attempt: number, digest: string) {
  return {
    id,
    name: `clawsweeper-repair-execution-9001-${attempt}`,
    digest: `sha256:${digest}`,
    expired: false,
  };
}
