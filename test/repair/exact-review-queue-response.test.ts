import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const itemKey = "Example/Project#7";
const decision = {
  targetRepo: "example/project",
  targetBranch: "main",
  itemNumber: 7,
  itemKind: "pull_request",
  sourceEvent: "pull_request",
  sourceAction: "opened",
};
const claim = {
  claimed: true,
  protocol_version: 2,
  item_key: itemKey,
  lease_revision: 3,
  claim_generation: 2,
  repeat_revision: false,
  decision,
};

function parseClaim(command: string, response: unknown, requestedItemKey = itemKey) {
  const root = mkdtempSync(join(tmpdir(), "queue-response-"));
  try {
    const output = join(root, "output");
    const result = spawnSync(
      process.execPath,
      ["src/repair/exact-review-queue-response.ts", command],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          ITEM_KEY: requestedItemKey,
          QUEUE_LEASE_ID: "lease-1",
          QUEUE_LEASE_REVISION: "3",
          RESPONSE: JSON.stringify(response),
        },
      },
    );
    return {
      status: result.status,
      stderr: result.stderr,
      output: result.status === 0 ? readFileSync(output, "utf8") : "",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("review claims preserve the exact lease key across repository casing", () => {
  for (const protocol_version of [1, 2]) {
    const result = parseClaim("review", { ...claim, protocol_version });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^item_key=Example\/Project#7$/m);
    assert.match(result.output, /^lease_revision=3$/m);
    assert.match(result.output, /"targetRepo":"example\/project"/);
  }
});

test("review claims still require the exact request tuple and matching target", () => {
  for (const response of [
    { ...claim, item_key: "example/project#7" },
    { ...claim, lease_revision: 4 },
    { ...claim, decision: { ...decision, itemNumber: 8 } },
    { ...claim, decision: { ...decision, targetRepo: "example/other" } },
  ]) {
    assert.equal(parseClaim("review", response).status, 1);
  }
});

test("direct publication preserves exact producer and publisher lease keys", () => {
  const publication = {
    itemKey,
    leaseRevision: 3,
    claimGeneration: 2,
    protocolVersion: 2,
    producerRunId: "42",
    producerRunAttempt: 1,
    producerDecision: decision,
    directLifecycle: { plan: { kind: "router" }, receiptOutcome: "accepted" },
  };
  const publicationClaim = {
    ...claim,
    decision: { ...decision, sourceAction: "exact_review_artifact_publish", publication },
  };
  const result = parseClaim("publication", publicationClaim);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^item_key=Example\/Project#7$/m);
  assert.match(result.output, /^publisher_item_key=Example\/Project#7$/m);
  assert.match(result.output, /^direct_lifecycle_recovery=true$/m);

  for (const item_key of ["example/project#7", "Example/Project#8"]) {
    assert.equal(parseClaim("publication", { ...publicationClaim, item_key }).status, 1);
  }
  assert.equal(
    parseClaim("publication", {
      ...publicationClaim,
      decision: {
        ...publicationClaim.decision,
        publication: { ...publication, itemKey: "example/project#7" },
      },
    }).status,
    1,
  );
});
