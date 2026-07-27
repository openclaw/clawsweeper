import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  CLUSTER_INTAKE_SCHEMA,
  acceptClusterIntakeIntent,
  clusterAcceptedIntentDigest,
  clusterIntakeIntent,
  clusterIntakeLedger,
  markClusterIntakeDispatchClaimed,
  markClusterIntakeDispatched,
  mergeClusterIntakeLedger,
  verifyClusterLedgerEntryAcceptedIntent,
} from "../../dist/repair/cluster-intake-state.js";

const receiptSecret = "cluster-accepted-intent-test-secret";

function proposal() {
  const content = `---
repo: openclaw/openclaw
cluster_id: gitcrawl-42-telegram-upload
mode: autonomous
job_intent: repair_cluster
allowed_actions:
  - comment
  - label
  - close
  - fix
  - raise_pr
blocked_actions:
  - force_push
  - bypass_checks
  - merge
require_human_for:
  - security_sensitive
  - failing_checks
  - conflicting_prs
  - unclear_canonical
  - broad_code_delta
canonical:
  - #420
candidates:
  - #420
  - #421
cluster_refs:
  - #420
  - #421
security_policy: central_security_only
security_sensitive: false
allow_instant_close: false
allow_fix_pr: true
allow_merge: false
allow_post_merge_close: true
require_fix_before_close: true
---

# Cluster 42
`;
  return {
    schema: CLUSTER_INTAKE_SCHEMA,
    target_repo: "openclaw/openclaw",
    repo_slug: "openclaw-openclaw",
    store_sha256: "a".repeat(64),
    store_exported_at: "2026-07-26T12:00:00.000Z",
    manifest_path: "gitcrawl-store/data/openclaw__openclaw.sync.db.manifest.json",
    run_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
    accepted_at: "2026-07-26T12:01:00.000Z",
    runner: "blacksmith-4vcpu-ubuntu-2404",
    execution_runner: "blacksmith-16vcpu-ubuntu-2404",
    model: "internal",
    selector_summary: { evaluated: 10, rejected: 9, reason_counts: { stale: 4 } },
    jobs: [
      {
        cluster_id: 42,
        path: "jobs/openclaw/inbox/gitcrawl-42-telegram-upload.md",
        content,
        digest: createHash("sha256").update(content).digest("hex"),
        dispatch_key: "cluster-intake:openclaw-openclaw:42",
      },
    ],
  };
}

function receiptFields(ledger: ReturnType<typeof mergeClusterIntakeLedger>) {
  const entry = ledger.clusters["42"];
  return {
    target_repo: ledger.target_repo,
    store_sha256: entry.store_sha256,
    store_exported_at: entry.store_exported_at,
    manifest_path: entry.manifest_path,
    run_url: entry.run_url,
    accepted_at: entry.accepted_at,
    runner: entry.runner,
    execution_runner: entry.execution_runner,
    model: entry.model,
    cluster_id: entry.cluster_id,
    path: entry.job,
    digest: entry.digest,
    dispatch_key: entry.dispatch_key,
  };
}

test("accepted-intent receipts bind durable recovery authority", () => {
  assert.throws(() => clusterIntakeIntent(proposal()), /accepted-intent digest mismatch/);
  const accepted = acceptClusterIntakeIntent(proposal(), receiptSecret);
  const reparsed = clusterIntakeIntent(JSON.parse(JSON.stringify(accepted)));
  const ledger = clusterIntakeLedger(
    JSON.parse(JSON.stringify(mergeClusterIntakeLedger(undefined, [reparsed]))),
  );
  const entry = ledger.clusters["42"];
  assert.doesNotThrow(() =>
    verifyClusterLedgerEntryAcceptedIntent(receiptSecret, ledger.target_repo, entry),
  );
  const claimed = clusterIntakeLedger(
    markClusterIntakeDispatchClaimed(ledger, accepted.jobs, "2026-07-26T12:02:00.000Z"),
  );
  assert.doesNotThrow(() =>
    clusterIntakeLedger(
      markClusterIntakeDispatched(claimed, accepted.jobs, "2026-07-26T12:03:00.000Z", {
        id: 123,
        url: "https://github.com/openclaw/clawsweeper/actions/runs/123",
      }),
    ),
  );

  const forged = structuredClone(ledger);
  forged.clusters["42"].runner = "attacker-runner";
  forged.clusters["42"].accepted_intent_digest = clusterAcceptedIntentDigest(receiptFields(forged));
  const structurallyValidForgery = clusterIntakeLedger(forged);
  assert.throws(
    () =>
      verifyClusterLedgerEntryAcceptedIntent(
        receiptSecret,
        structurallyValidForgery.target_repo,
        structurallyValidForgery.clusters["42"],
      ),
    /receipt verification failed/,
  );
});

test("v2 cluster intake ledgers reject unvalidated JSON shapes", () => {
  const ledger = mergeClusterIntakeLedger(undefined, [
    acceptClusterIntakeIntent(proposal(), receiptSecret),
  ]);
  assert.deepEqual(clusterIntakeLedger(JSON.parse(JSON.stringify(ledger))), ledger);

  const cases = [
    (value: Record<string, unknown>) => {
      value.unhashed_extension = true;
    },
    (value: Record<string, unknown>) => {
      value.generated_count = "1";
    },
    (value: Record<string, unknown>) => {
      const stores = value.stores as Array<Record<string, unknown>>;
      (stores[0].selector_summary as Record<string, unknown>).evaluated = "10";
    },
    (value: Record<string, unknown>) => {
      const clusters = value.clusters as Record<string, Record<string, unknown>>;
      clusters["42"].dispatch_run_id = 123;
    },
  ];
  for (const mutate of cases) {
    const malformed = JSON.parse(JSON.stringify(ledger)) as Record<string, unknown>;
    mutate(malformed);
    assert.throws(() => clusterIntakeLedger(malformed));
  }
});
