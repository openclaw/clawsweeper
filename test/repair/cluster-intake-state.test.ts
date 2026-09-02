import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLUSTER_INTAKE_SCHEMA,
  CLUSTER_WORKFLOW_DISPATCH_MAX_PAYLOAD_BYTES,
  acceptClusterIntakeIntent,
  clusterAcceptedIntentDigest,
  clusterDispatchAuthenticationTag,
  clusterIntakeLedger,
  clusterWorkflowDispatchInputs,
  markClusterIntakeDispatchClaimed,
  markClusterIntakeDispatched,
  mergeClusterIntakeLedger,
  mergeClusterSelectorDecisionLedger,
  verifyClusterLedgerEntryAcceptedIntent,
} from "../../dist/repair/cluster-intake-state.js";
import {
  dispatchClusterIntakes,
  observeClusterDispatch,
  recoverPendingClusterIntakes,
  reserveClusterCapacity,
} from "../../dist/repair/cluster-intake-dispatch.js";
import { restoreClusterIntakeJob } from "../../dist/repair/restore-cluster-intake-job.js";

const dispatchSecret = "cluster-dispatch-test-secret";
const receiptSecret = "cluster-accepted-intent-test-secret";

function mockGhBinEnv(bin: string): NodeJS.ProcessEnv {
  return {
    GH_BIN: process.execPath,
    GH_BIN_ARGS: JSON.stringify([path.join(bin, "gh.mjs")]),
  };
}

function writeGhMock(bin: string, source: string) {
  fs.writeFileSync(path.join(bin, "gh.mjs"), source, { mode: 0o755 });
}

function ghExit(status: number) {
  return `process.exit(${status});\n`;
}

function ghCallLog(calls: string) {
  return [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");`,
  ].join("\n");
}

function ghEvent(events: string, event: string) {
  return [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(events)}, ${JSON.stringify(`${event}\n`)});`,
  ].join("\n");
}

function ghFailsOnCall(counter: string, calls: string, failedCall: number) {
  return [
    'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
    `const counter = ${JSON.stringify(counter)};`,
    'const count = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;',
    "writeFileSync(counter, `${count}\\n`);",
    `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");`,
    `process.exit(count === ${failedCall} ? 1 : 0);`,
  ].join("\n");
}

function ghObservation(runs: string, jobs: string) {
  return [
    "const args = process.argv.slice(2);",
    `process.stdout.write(args.includes("list") ? ${JSON.stringify(`${runs}\n`)} : ${JSON.stringify(`${jobs}\n`)});`,
  ].join("\n");
}

function receiptProposal() {
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
    selector_summary: { evaluated: 2, rejected: 1, reason_counts: { model_rejected: 1 } },
    selector_decision: {
      rationale: "The cluster is narrow, current, and has a concrete validation path.",
      assessments: [
        {
          cluster_id: 42,
          decision: "selected",
          rationale: "The two live reports describe one reproducible defect.",
          candidate_refs: [420, 421],
          cluster_refs: [420, 421],
        },
        {
          cluster_id: 43,
          decision: "rejected",
          rationale: "The related report is already fixed on main.",
          candidate_refs: [430],
          cluster_refs: [430, 431],
        },
      ],
    },
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

function dispatchAuthenticationFields(job: ReturnType<typeof intent>["jobs"][number]) {
  return {
    jobPath: job.path,
    jobDigest: job.digest,
    dispatchKey: job.dispatch_key,
    mode: "autonomous",
    runner: "blacksmith-4vcpu-ubuntu-2404",
    executionRunner: "blacksmith-16vcpu-ubuntu-2404",
    plannerSandbox: "read-only",
    model: "internal",
    dryRun: "false",
  };
}

function intent(clusterId = 42, storeSha = "a".repeat(64)) {
  const content = `---
repo: openclaw/openclaw
cluster_id: gitcrawl-${clusterId}-telegram-upload
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
  - #${clusterId * 10}
candidates:
  - #${clusterId * 10}
  - #${clusterId * 10 + 1}
cluster_refs:
  - #${clusterId * 10}
  - #${clusterId * 10 + 1}
security_policy: central_security_only
security_sensitive: false
allow_instant_close: false
allow_fix_pr: true
allow_merge: false
allow_post_merge_close: true
require_fix_before_close: true
---

# Cluster ${clusterId}
`;
  return acceptClusterIntakeIntent(
    {
      schema: CLUSTER_INTAKE_SCHEMA,
      target_repo: "openclaw/openclaw",
      repo_slug: "openclaw-openclaw",
      store_sha256: storeSha,
      store_exported_at: "2026-07-26T00:00:00Z",
      manifest_path: "gitcrawl-store/data/openclaw__openclaw.sync.db.manifest.json",
      run_url: "https://github.com/openclaw/clawsweeper/actions/runs/1",
      accepted_at: "2026-07-26T00:01:00Z",
      runner: "blacksmith-4vcpu-ubuntu-2404",
      execution_runner: "blacksmith-16vcpu-ubuntu-2404",
      model: "internal",
      selector_summary: { evaluated: 1, rejected: 0, reason_counts: {} },
      selector_decision: {
        rationale: "The cluster is narrow, current, and has a concrete validation path.",
        assessments: [
          {
            cluster_id: clusterId,
            decision: "selected",
            rationale: "The live reports describe one reproducible defect.",
            candidate_refs: [clusterId * 10, clusterId * 10 + 1],
            cluster_refs: [clusterId * 10, clusterId * 10 + 1],
          },
        ],
      },
      jobs: [
        {
          cluster_id: clusterId,
          path: `jobs/openclaw/inbox/gitcrawl-${clusterId}-telegram-upload.md`,
          content,
          digest: createHash("sha256").update(content).digest("hex"),
          dispatch_key: `cluster-intake:openclaw-openclaw:${clusterId}`,
        },
      ],
    },
    receiptSecret,
  );
}

function unsignedIntent(value: ReturnType<typeof intent>) {
  return {
    ...value,
    jobs: value.jobs.map(
      ({
        accepted_intent_digest: _acceptedIntentDigest,
        accepted_intent_receipt: _receipt,
        ...job
      }) => job,
    ),
  };
}

function resignIntent(value: ReturnType<typeof intent>) {
  return acceptClusterIntakeIntent(unsignedIntent(value), receiptSecret);
}

function writeDurableIntents(root: string, intents: ReturnType<typeof intent>[]): string {
  const ledgerPath = path.join(root, "results", "cluster-repair-intake");
  fs.mkdirSync(ledgerPath, { recursive: true });
  fs.writeFileSync(
    path.join(ledgerPath, "openclaw-openclaw.json"),
    `${JSON.stringify(mergeClusterIntakeLedger(undefined, intents))}\n`,
  );
  for (const value of intents) {
    for (const job of value.jobs) {
      const target = path.join(root, job.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, job.content);
    }
  }
  return ledgerPath;
}

test("duplicate intake is idempotent and a completed dispatch never regresses", () => {
  const value = intent();
  const first = mergeClusterIntakeLedger(undefined, [value]);
  const dispatched = markClusterIntakeDispatched(first, value.jobs, "2026-07-26T00:02:00Z");
  const replayed = mergeClusterIntakeLedger(`${JSON.stringify(dispatched)}\n`, [value, value]);
  assert.equal(Object.keys(replayed.clusters).length, 1);
  assert.equal(replayed.clusters["42"].status, "dispatched");
  assert.equal(replayed.stores.length, 1);
});

test("durable selector decisions preserve rejected clusters even when no job is selected", () => {
  const proposal = {
    ...receiptProposal(),
    selector_summary: { evaluated: 1, rejected: 1, reason_counts: { model_rejected: 1 } },
    selector_decision: {
      rationale: "The only cluster is already fixed on main.",
      assessments: [
        {
          cluster_id: 43,
          decision: "rejected" as const,
          rationale: "The reported behavior is covered by the current implementation.",
          candidate_refs: [430],
          cluster_refs: [430, 431],
        },
      ],
    },
    jobs: [],
  };
  const accepted = acceptClusterIntakeIntent(proposal, receiptSecret);
  const ledger = mergeClusterIntakeLedger(undefined, [accepted]);
  const selectorLedger = mergeClusterSelectorDecisionLedger(undefined, [accepted]);

  assert.equal(ledger.stores[0].outcome, "selector_rejected");
  assert.equal(Object.hasOwn(ledger.stores[0], "selector_decision"), false);
  assert.deepEqual(selectorLedger?.stores[0].selector_decision, proposal.selector_decision);
});

test("selector decision sidecars merge stale snapshots without losing unrelated decisions", () => {
  const first = intent(42, "a".repeat(64));
  const second = intent(43, "b".repeat(64));
  const initial = mergeClusterSelectorDecisionLedger(undefined, [first]);
  assert(initial);
  const merged = mergeClusterSelectorDecisionLedger(JSON.stringify(initial), [second, first]);

  assert.deepEqual(
    merged?.stores.flatMap((store) =>
      store.selector_decision.assessments.map((assessment) => assessment.cluster_id),
    ),
    [42, 43],
  );
});

test("selector decisions must match selected job identities and references", () => {
  const wrongCluster = receiptProposal();
  wrongCluster.selector_decision.assessments[0].cluster_id = 44;
  assert.throws(
    () => acceptClusterIntakeIntent(wrongCluster, receiptSecret),
    /does not match selected jobs/,
  );

  const wrongReferences = receiptProposal();
  wrongReferences.selector_decision.assessments[0].candidate_refs = [420];
  assert.throws(
    () => acceptClusterIntakeIntent(wrongReferences, receiptSecret),
    /does not match selected job references/,
  );
});

test("a cluster with one live candidate and closed context passes durable acceptance", () => {
  const proposal = receiptProposal();
  proposal.jobs[0].content = proposal.jobs[0].content.replace(
    "candidates:\n  - #420\n  - #421",
    "candidates:\n  - #420",
  );
  proposal.jobs[0].digest = createHash("sha256").update(proposal.jobs[0].content).digest("hex");
  proposal.selector_decision.assessments[0].candidate_refs = [420];

  assert.doesNotThrow(() => acceptClusterIntakeIntent(proposal, receiptSecret));
});

test("claiming a newer store preserves completed outcomes for older stores", () => {
  const first = intent(42, "a".repeat(64));
  const secondDraft = intent(43, "b".repeat(64));
  secondDraft.store_exported_at = "2026-07-26T01:00:00Z";
  secondDraft.accepted_at = "2026-07-26T01:01:00Z";
  const second = resignIntent(secondDraft);
  const merged = mergeClusterIntakeLedger(undefined, [first, second]);
  const completed = markClusterIntakeDispatched(merged, first.jobs, "2026-07-26T01:02:00Z");
  const claimed = markClusterIntakeDispatchClaimed(completed, second.jobs, "2026-07-26T01:03:00Z");
  assert.equal(
    claimed.stores.find((store) => store.store_sha256 === first.store_sha256)?.outcome,
    "dispatched",
  );
  assert.equal(
    claimed.stores.find((store) => store.store_sha256 === second.store_sha256)?.outcome,
    "dispatch_claimed",
  );
});

test("an older store replay cannot rewind the processed-store marker", () => {
  const older = intent(42, "a".repeat(64));
  const newerDraft = intent(43, "b".repeat(64));
  newerDraft.store_exported_at = "2026-07-26T01:00:00Z";
  newerDraft.accepted_at = "2026-07-26T01:01:00Z";
  const newer = resignIntent(newerDraft);
  const current = mergeClusterIntakeLedger(undefined, [older, newer]);
  const replayed = mergeClusterIntakeLedger(`${JSON.stringify(current)}\n`, [older]);
  assert.equal(replayed.last_processed_store_sha256, newer.store_sha256);
  assert.equal(replayed.last_processed_store_exported_at, newer.store_exported_at);
  assert.equal(replayed.run_url, newer.run_url);
  assert.equal(replayed.updated_at, newer.accepted_at);
});

test("a newer store cannot overwrite or redispatch an already accepted cluster", () => {
  const current = mergeClusterIntakeLedger(undefined, [intent()]);
  const replacementDraft = intent(42, "b".repeat(64));
  replacementDraft.jobs[0].path = "jobs/openclaw/inbox/gitcrawl-42-renamed.md";
  const replacement = resignIntent(replacementDraft);
  const merged = mergeClusterIntakeLedger(`${JSON.stringify(current)}\n`, [replacement]);
  assert.equal(merged.clusters["42"].job, current.clusters["42"].job);
  assert.equal(merged.stores.at(-1).outcome, "duplicate_skipped");
  assert.deepEqual(merged.stores.at(-1).generated_jobs, []);
});

test("same-path conflicting intents keep only the ledger-accepted digest", () => {
  const accepted = intent(42, "a".repeat(64));
  const conflictingDraft = intent(42, "b".repeat(64));
  conflictingDraft.jobs[0].content = conflictingDraft.jobs[0].content.replace(
    "# Cluster 42",
    "# Cluster 42 changed by a later snapshot",
  );
  conflictingDraft.jobs[0].digest = createHash("sha256")
    .update(conflictingDraft.jobs[0].content)
    .digest("hex");
  const conflicting = resignIntent(conflictingDraft);
  const ledger = mergeClusterIntakeLedger(undefined, [accepted, conflicting]);
  assert.equal(ledger.clusters["42"].digest, accepted.jobs[0].digest);
  assert.equal(ledger.stores.at(-1)?.outcome, "duplicate_skipped");
});

test("oversize durable jobs are rejected before workflow dispatch", () => {
  const value = intent();
  const content = "x".repeat(32 * 1024 + 1);
  assert.throws(
    () =>
      acceptClusterIntakeIntent(
        {
          ...unsignedIntent(value),
          jobs: [
            {
              ...unsignedIntent(value).jobs[0],
              content,
              digest: createHash("sha256").update(content).digest("hex"),
            },
          ],
        },
        receiptSecret,
      ),
    /invalid cluster intake job fence/,
  );
});

test("every accepted job fits a complete workflow dispatch independently", () => {
  const first = intent(42);
  const second = intent(43);
  const firstUnsigned = unsignedIntent(first);
  const secondUnsigned = unsignedIntent(second);
  const padToLimit = (job: (typeof firstUnsigned.jobs)[number]) => {
    const content = `${job.content}${"x".repeat(32 * 1024 - Buffer.byteLength(job.content))}`;
    return { ...job, content, digest: createHash("sha256").update(content).digest("hex") };
  };
  const accepted = acceptClusterIntakeIntent(
    {
      ...firstUnsigned,
      selector_decision: null,
      jobs: [padToLimit(firstUnsigned.jobs[0]), padToLimit(secondUnsigned.jobs[0])],
    },
    receiptSecret,
  );
  assert(Buffer.byteLength(JSON.stringify(accepted)) > CLUSTER_WORKFLOW_DISPATCH_MAX_PAYLOAD_BYTES);
  for (const job of accepted.jobs) {
    const inputs = clusterWorkflowDispatchInputs(job, {
      runner: accepted.runner,
      executionRunner: accepted.execution_runner,
      model: accepted.model,
      jobAuth: `sha256=${"0".repeat(64)}`,
    });
    assert(
      Buffer.byteLength(JSON.stringify({ ref: "r".repeat(255), inputs })) <=
        CLUSTER_WORKFLOW_DISPATCH_MAX_PAYLOAD_BYTES,
    );
  }
});

test("durable intake binds embedded job semantics to its target and fail-closed policy", () => {
  const value = intent();
  for (const replacement of [
    ["repo: openclaw/openclaw", "repo: attacker/elsewhere"],
    ["allow_merge: false", "allow_merge: true"],
    ["security_sensitive: false", "security_sensitive: true"],
  ]) {
    const content = value.jobs[0].content.replace(replacement[0], replacement[1]);
    assert.throws(
      () =>
        acceptClusterIntakeIntent(
          {
            ...unsignedIntent(value),
            jobs: [
              {
                ...unsignedIntent(value).jobs[0],
                content,
                digest: createHash("sha256").update(content).digest("hex"),
              },
            ],
          },
          receiptSecret,
        ),
      /(?:semantic policy mismatch|security_sensitive jobs are out of scope)/,
    );
  }
});

test("dispatch recovery retries pending intent and completed dispatch is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-dispatch-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const value = intent();
  const ledgerPath = writeDurableIntents(root, [value]);
  const gh = path.join(bin, "gh.mjs");
  fs.writeFileSync(gh, ghExit(1), { mode: 0o755 });
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  const capacity = () => ({ active: 0, max_live_workers: 2 });
  assert.throws(() => dispatchClusterIntakes([value], root, env, capacity), /dispatch failed/);
  // The claim is persisted before the workflow_dispatch side effect, so a
  // failed dispatch leaves a durable claim for recovery instead of silently
  // reverting to pending.
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8")).clusters[
      "42"
    ].status,
    "dispatch_claimed",
  );

  const calls = path.join(root, "calls.txt");
  fs.writeFileSync(gh, ghCallLog(calls), { mode: 0o755 });
  assert.deepEqual(
    dispatchClusterIntakes([value], root, env, capacity, () => ({
      action: "dispatch",
      run: null,
    })),
    {
      updatedLedgers: ["results/cluster-repair-intake/openclaw-openclaw.json"],
      pending: true,
    },
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8")).clusters[
      "42"
    ].status,
    "dispatch_claimed",
  );
  assert.deepEqual(
    dispatchClusterIntakes([value], root, env, capacity, () => ({
      action: "recover",
      run: { databaseId: 123, url: "https://github.com/openclaw/clawsweeper/actions/runs/123" },
    })),
    {
      updatedLedgers: ["results/cluster-repair-intake/openclaw-openclaw.json"],
      pending: false,
    },
  );
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  assert.match(fs.readFileSync(calls, "utf8"), /dispatch_key=cluster-intake:openclaw-openclaw:42/);
  assert.match(fs.readFileSync(calls, "utf8"), /job_auth=sha256=[a-f0-9]{64}/);
});

test("cluster dispatch retains pending intent while worker capacity is full", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-capacity-"));
  const value = intent();
  const ledgerPath = writeDurableIntents(root, [value]);
  assert.deepEqual(
    dispatchClusterIntakes(
      [value],
      root,
      { ...process.env, CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret },
      () => ({
        active: 2,
        max_live_workers: 2,
      }),
    ),
    { updatedLedgers: [], pending: true },
  );
  const ledger = JSON.parse(
    fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8"),
  );
  assert.equal(ledger.clusters["42"].status, "dispatch_pending");
});

test("one materializer run reserves capacity before Actions exposes new workers", () => {
  const capacity = reserveClusterCapacity(() => ({ active: 0, max_live_workers: 2 }));
  assert.deepEqual(capacity({ requested: 1 }), { active: 0, max_live_workers: 2 });
  assert.deepEqual(capacity({ requested: 2 }), { active: 1, max_live_workers: 2 });
  assert.deepEqual(capacity({ requested: 1 }), { active: 2, max_live_workers: 2 });
});

test("cluster dispatch persists an available subset and recovers the remainder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-subset-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const first = intent(42, "a".repeat(64));
  const second = intent(43, "b".repeat(64));
  const ledgerPath = writeDurableIntents(root, [first, second]);
  const calls = path.join(root, "calls.txt");
  writeGhMock(bin, ghCallLog(calls));
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  const partial = dispatchClusterIntakes([first, second], root, env, () => ({
    active: 1,
    max_live_workers: 2,
  }));
  assert.deepEqual(partial, {
    updatedLedgers: ["results/cluster-repair-intake/openclaw-openclaw.json"],
    pending: true,
  });
  let ledger = JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8"));
  assert.equal(ledger.clusters["42"].status, "dispatch_claimed");
  assert.equal(ledger.clusters["43"].status, "dispatch_pending");

  const recovered = dispatchClusterIntakes(
    [first, second],
    root,
    env,
    () => ({ active: 0, max_live_workers: 2 }),
    () => ({ action: "recover", run: { databaseId: 42 } }),
  );
  assert.equal(recovered.pending, true);
  ledger = JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8"));
  assert.equal(ledger.clusters["42"].status, "dispatched");
  assert.equal(ledger.clusters["43"].status, "dispatch_claimed");
  assert.equal(
    dispatchClusterIntakes(
      [first, second],
      root,
      env,
      () => ({ active: 0, max_live_workers: 2 }),
      () => ({ action: "recover", run: { databaseId: 43 } }),
    ).pending,
    false,
  );
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2);
});

test("simultaneous conflicting snapshots dispatch the ledger-accepted job once", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-conflict-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const acceptedDraft = intent(42, "a".repeat(64));
  acceptedDraft.runner = "accepted-runner";
  acceptedDraft.execution_runner = "accepted-execution-runner";
  const accepted = resignIntent(acceptedDraft);
  const conflictingDraft = intent(42, "b".repeat(64));
  conflictingDraft.jobs[0].path = "jobs/openclaw/inbox/gitcrawl-42-renamed.md";
  conflictingDraft.runner = "conflicting-runner";
  const conflicting = resignIntent(conflictingDraft);
  writeDurableIntents(root, [accepted, conflicting]);
  const calls = path.join(root, "calls.txt");
  writeGhMock(bin, ghCallLog(calls));
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  dispatchClusterIntakes([accepted, conflicting], root, env, () => ({
    active: 0,
    max_live_workers: 2,
  }));
  const call = fs.readFileSync(calls, "utf8");
  assert.equal(call.trim().split("\n").length, 1);
  assert.match(call, /job=jobs\/openclaw\/inbox\/gitcrawl-42-telegram-upload.md/);
  assert.match(call, /runner=accepted-runner/);
  assert.doesNotMatch(call, /renamed|conflicting-runner/);
});

test("a capacity-blocked intake recovers from its durable ledger without the queue row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-ledger-recovery-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const value = intent();
  writeDurableIntents(root, [value]);
  assert.deepEqual(
    dispatchClusterIntakes(
      [value],
      root,
      { ...process.env, CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret },
      () => ({
        active: 2,
        max_live_workers: 2,
      }),
    ),
    { updatedLedgers: [], pending: true },
  );

  const calls = path.join(root, "calls.txt");
  writeGhMock(bin, ghCallLog(calls));
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  assert.deepEqual(
    recoverPendingClusterIntakes(
      root,
      env,
      () => ({ active: 0, max_live_workers: 2 }),
      () => ({ action: "dispatch", run: null }),
    ),
    {
      updatedLedgers: ["results/cluster-repair-intake/openclaw-openclaw.json"],
      pending: true,
    },
  );
  assert.deepEqual(
    recoverPendingClusterIntakes(
      root,
      env,
      () => ({ active: 0, max_live_workers: 2 }),
      () => ({ action: "recover", run: { databaseId: 42 } }),
    ),
    {
      updatedLedgers: ["results/cluster-repair-intake/openclaw-openclaw.json"],
      pending: false,
    },
  );
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
});

test("failed or invisible worker claims retry without terminalizing durable intent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-claim-retry-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const value = intent();
  const ledgerPath = writeDurableIntents(root, [value]);
  const calls = path.join(root, "calls.txt");
  writeGhMock(bin, ghCallLog(calls));
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  const capacity = () => ({ active: 0, max_live_workers: 2 });
  dispatchClusterIntakes([value], root, env, capacity);
  dispatchClusterIntakes([value], root, env, capacity, () => ({ action: "dispatch", run: null }));
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2);
  let ledger = JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8"));
  assert.equal(ledger.clusters["42"].status, "dispatch_claimed");

  assert.deepEqual(
    dispatchClusterIntakes([value], root, env, capacity, () => ({ action: "wait", run: null })),
    { updatedLedgers: [], pending: true },
  );
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2);
  dispatchClusterIntakes([value], root, env, capacity, () => ({
    action: "recover",
    run: { databaseId: 99, url: "https://github.com/openclaw/clawsweeper/actions/runs/99" },
  }));
  ledger = JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8"));
  assert.equal(ledger.clusters["42"].status, "dispatched");
  assert.equal(ledger.clusters["42"].dispatch_run_id, 99);
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 2);
});

test("recovery rediscovers a successful worker when the claim publication was lost", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-lost-claim-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const value = intent();
  const ledgerPath = writeDurableIntents(root, [value]);
  const durablePending = fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8");
  const calls = path.join(root, "calls.txt");
  writeGhMock(bin, ghCallLog(calls));
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  dispatchClusterIntakes([value], root, env, () => ({ active: 0, max_live_workers: 2 }));
  fs.writeFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), durablePending);

  let observedClaimTime = "";
  const recovered = recoverPendingClusterIntakes(
    root,
    env,
    () => ({ active: 0, max_live_workers: 2 }),
    (entry) => {
      observedClaimTime = entry.dispatch_claimed_at ?? "";
      return { action: "recover", run: { databaseId: 123 } };
    },
  );
  assert.equal(observedClaimTime, value.accepted_at);
  assert.deepEqual(recovered, {
    updatedLedgers: ["results/cluster-repair-intake/openclaw-openclaw.json"],
    pending: false,
  });
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  const ledger = JSON.parse(
    fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8"),
  );
  assert.equal(ledger.clusters["42"].status, "dispatched");
});

test("the durable claim is published before the workflow dispatch side effect", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-claim-order-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const value = intent();
  writeDurableIntents(root, [value]);
  const events = path.join(root, "events.txt");
  writeGhMock(bin, ghEvent(events, "dispatch"));
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  const persistedStatuses: string[] = [];
  dispatchClusterIntakes(
    [value],
    root,
    env,
    () => ({ active: 0, max_live_workers: 2 }),
    () => ({ action: "dispatch", run: null }),
    (persistedLedger) => {
      fs.appendFileSync(events, "persist\n");
      persistedStatuses.push(
        JSON.parse(fs.readFileSync(path.join(root, persistedLedger), "utf8")).clusters["42"].status,
      );
    },
  );
  assert.deepEqual(fs.readFileSync(events, "utf8").trim().split("\n"), ["persist", "dispatch"]);
  assert.deepEqual(persistedStatuses, ["dispatch_claimed"]);
});

test("a crash between claim publication and dispatch redispatches exactly one worker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-claim-crash-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const value = intent();
  const ledgerPath = writeDurableIntents(root, [value]);
  const gh = path.join(bin, "gh.mjs");
  // The dispatch side effect never happens, exactly like a runner crash right
  // after the durable claim publication.
  fs.writeFileSync(gh, ghExit(1), { mode: 0o755 });
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  const capacity = () => ({ active: 0, max_live_workers: 2 });
  let persisted = 0;
  assert.throws(
    () =>
      dispatchClusterIntakes(
        [value],
        root,
        env,
        capacity,
        () => ({ action: "dispatch", run: null }),
        () => {
          persisted += 1;
        },
      ),
    /dispatch failed/,
  );
  assert.equal(persisted, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8")).clusters[
      "42"
    ].status,
    "dispatch_claimed",
  );

  const calls = path.join(root, "calls.txt");
  fs.writeFileSync(gh, ghCallLog(calls), { mode: 0o755 });
  const recovered = recoverPendingClusterIntakes(root, env, capacity, () => ({
    action: "dispatch",
    run: null,
  }));
  assert.deepEqual(recovered, {
    updatedLedgers: ["results/cluster-repair-intake/openclaw-openclaw.json"],
    pending: true,
  });
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
  recoverPendingClusterIntakes(root, env, capacity, () => ({
    action: "recover",
    run: { databaseId: 7 },
  }));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8")).clusters[
      "42"
    ].status,
    "dispatched",
  );
  assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1);
});

test("recovery refuses git state without a verifiable accepted-intent receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-authority-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const value = intent();
  const ledgerPath = writeDurableIntents(root, [value]);
  const calls = path.join(root, "calls.txt");
  writeGhMock(bin, ghCallLog(calls));
  const capacity = () => ({ active: 0, max_live_workers: 2 });
  const observer = () => ({ action: "dispatch" as const, run: null });

  // A receipt minted under a different secret is exactly what fabricated or
  // corrupted git ledger state looks like to the materializer: fail closed
  // before any dispatch instead of blessing it with a fresh signature.
  const wrongSecretEnv = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: "not-the-accepting-secret",
  };
  assert.throws(
    () => recoverPendingClusterIntakes(root, wrongSecretEnv, capacity, observer),
    /accepted-intent receipt verification failed/,
  );
  assert.throws(
    () => dispatchClusterIntakes([value], root, wrongSecretEnv, capacity, observer),
    /accepted-intent receipt verification failed/,
  );
  assert.equal(fs.existsSync(calls), false);

  // A structurally invalid v2 ledger is skipped as unverifiable projection
  // instead of becoming dispatch authority.
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  const ledgerFile = path.join(ledgerPath, "openclaw-openclaw.json");
  const tampered = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  tampered.injected_by_state_writer = true;
  fs.writeFileSync(ledgerFile, `${JSON.stringify(tampered)}\n`);
  assert.deepEqual(recoverPendingClusterIntakes(root, env, capacity, observer), {
    updatedLedgers: [],
    pending: false,
  });
  assert.equal(fs.existsSync(calls), false);
});

test("a later batch dispatch failure does not hide the earlier successful worker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-partial-dispatch-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const first = intent(42, "a".repeat(64));
  const second = intent(43, "b".repeat(64));
  const ledgerPath = writeDurableIntents(root, [first, second]);
  const calls = path.join(root, "calls.txt");
  const counter = path.join(root, "counter.txt");
  writeGhMock(bin, ghFailsOnCall(counter, calls, 2));
  const env = {
    ...process.env,
    ...mockGhBinEnv(bin),
    CLAWSWEEPER_WEBHOOK_SECRET: receiptSecret,
  };
  const capacity = () => ({ active: 0, max_live_workers: 2 });
  assert.throws(
    () => dispatchClusterIntakes([first, second], root, env, capacity),
    /dispatch failed.*cluster 43/,
  );

  const recovered = recoverPendingClusterIntakes(root, env, capacity, (entry) =>
    entry.cluster_id === 42
      ? { action: "recover", run: { databaseId: 42 } }
      : { action: "dispatch", run: null },
  );
  assert.equal(recovered.pending, true);
  let ledger = JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8"));
  assert.equal(ledger.clusters["42"].status, "dispatched");
  assert.equal(ledger.clusters["43"].status, "dispatch_claimed");

  recoverPendingClusterIntakes(root, env, capacity, () => ({
    action: "recover",
    run: { databaseId: 43 },
  }));
  ledger = JSON.parse(fs.readFileSync(path.join(ledgerPath, "openclaw-openclaw.json"), "utf8"));
  assert.equal(ledger.clusters["43"].status, "dispatched");
  const dispatchCalls = fs.readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(dispatchCalls.length, 3);
  assert.equal(dispatchCalls.filter((call) => call.includes("gitcrawl-42-")).length, 1);
  assert.equal(dispatchCalls.filter((call) => call.includes("gitcrawl-43-")).length, 2);
});

test("dispatch observation terminalizes only a successful planning worker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-observation-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const value = intent();
  const ledger = mergeClusterIntakeLedger(undefined, [value]);
  const claimedAt = new Date(Date.now() - 10_000).toISOString();
  const entry = {
    ...ledger.clusters["42"],
    status: "dispatch_claimed" as const,
    dispatch_claimed_at: claimedAt,
  };
  const displayTitle = `repair cluster ${entry.job} [${entry.dispatch_key}]`;
  const runs = JSON.stringify([
    {
      databaseId: 99,
      displayTitle,
      status: "completed",
      conclusion: "success",
      createdAt: new Date(Date.now() - 5_000).toISOString(),
      url: "https://github.com/openclaw/clawsweeper/actions/runs/99",
    },
  ]);
  const successfulJobs = JSON.stringify({
    jobs: [
      { name: "Deduplicate command dispatch receipt", conclusion: "success" },
      { name: "Plan and review cluster", conclusion: "success" },
    ],
  });
  const gh = path.join(bin, "gh.mjs");
  fs.writeFileSync(gh, ghObservation(runs, successfulJobs), { mode: 0o755 });
  const env = { ...process.env, ...mockGhBinEnv(bin) };
  assert.deepEqual(observeClusterDispatch(entry, env), {
    action: "recover",
    run: { ...JSON.parse(runs)[0], dispatch_execution_verified: true },
  });

  const mixedResultRuns = JSON.stringify([
    {
      ...JSON.parse(runs)[0],
      conclusion: "failure",
    },
  ]);
  fs.writeFileSync(gh, ghObservation(mixedResultRuns, successfulJobs), { mode: 0o755 });
  assert.deepEqual(observeClusterDispatch(entry, env), {
    action: "recover",
    run: { ...JSON.parse(mixedResultRuns)[0], dispatch_execution_verified: true },
  });

  const receiptOnlyJobs = JSON.stringify({
    jobs: [
      { name: "Deduplicate command dispatch receipt", conclusion: "success" },
      { name: "Plan and review cluster", conclusion: "skipped" },
    ],
  });
  fs.writeFileSync(gh, ghObservation(runs, receiptOnlyJobs), { mode: 0o755 });
  assert.deepEqual(observeClusterDispatch(entry, env), { action: "wait", run: null });
});

test("worker restores only an authenticated semantically valid durable job", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-restore-"));
  const value = intent();
  const job = value.jobs[0];
  const authenticationTag = clusterDispatchAuthenticationTag(
    dispatchSecret,
    dispatchAuthenticationFields(job),
  );
  const options = {
    root,
    jobPath: job.path,
    payload: Buffer.from(job.content).toString("base64"),
    digest: job.digest,
    dispatchKey: job.dispatch_key,
    authenticationTag,
    authenticationSecret: dispatchSecret,
    allowedOwner: "openclaw",
    mode: "autonomous",
    runner: "blacksmith-4vcpu-ubuntu-2404",
    executionRunner: "blacksmith-16vcpu-ubuntu-2404",
    plannerSandbox: "read-only",
    model: "internal",
    dryRun: "false",
  };
  restoreClusterIntakeJob(options);
  const restored = path.join(root, job.path);
  assert.equal(fs.readFileSync(restored, "utf8"), job.content);
  // Windows does not expose the POSIX mode requested by openSync, but Linux
  // workers must keep restored intake jobs private.
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(restored).mode & 0o777, 0o600);
  }

  // CLAWSWEEPER_ALLOWED_OWNER is a comma/whitespace-separated owner list in
  // production (e.g. "openclaw,steipete"); membership must be honored.
  restoreClusterIntakeJob({ ...options, allowedOwner: "steipete, openclaw" });
  assert.throws(
    () => restoreClusterIntakeJob({ ...options, allowedOwner: "steipete,elsewhere" }),
    /owner is not allowed/,
  );
  assert.throws(
    () => restoreClusterIntakeJob({ ...options, allowedOwner: "" }),
    /owner is not allowed/,
  );

  assert.throws(
    () => restoreClusterIntakeJob({ ...options, dispatchKey: `${job.dispatch_key}-forged` }),
    /authentication failed/,
  );
  assert.throws(
    () => restoreClusterIntakeJob({ ...options, runner: "attacker-runner" }),
    /authentication failed/,
  );
  const unsafeContent = job.content.replace("allow_merge: false", "allow_merge: true");
  const unsafeDigest = createHash("sha256").update(unsafeContent).digest("hex");
  assert.throws(
    () =>
      restoreClusterIntakeJob({
        ...options,
        payload: Buffer.from(unsafeContent).toString("base64"),
        digest: unsafeDigest,
        authenticationTag: clusterDispatchAuthenticationTag(dispatchSecret, {
          ...dispatchAuthenticationFields(job),
          jobDigest: unsafeDigest,
        }),
      }),
    /semantic policy mismatch/,
  );
});

test("worker rejects path and payload substitution even with a valid job digest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-cluster-restore-fence-"));
  const job = intent().jobs[0];
  const authenticationTag = clusterDispatchAuthenticationTag(
    dispatchSecret,
    dispatchAuthenticationFields(job),
  );
  const base = {
    root,
    payload: Buffer.from(job.content).toString("base64"),
    digest: job.digest,
    dispatchKey: job.dispatch_key,
    authenticationTag,
    authenticationSecret: dispatchSecret,
    allowedOwner: "openclaw",
    mode: "autonomous",
    runner: "blacksmith-4vcpu-ubuntu-2404",
    executionRunner: "blacksmith-16vcpu-ubuntu-2404",
    plannerSandbox: "read-only",
    model: "internal",
    dryRun: "false",
  };
  assert.throws(
    () => restoreClusterIntakeJob({ ...base, jobPath: `${job.path}\nforged=1` }),
    /invalid durable cluster intake job path/,
  );
  assert.throws(
    () => restoreClusterIntakeJob({ ...base, jobPath: job.path, payload: `${base.payload}\n` }),
    /payload encoding/,
  );
});

test("accepted-intent receipts bind durable recovery authority", () => {
  const accepted = acceptClusterIntakeIntent(receiptProposal(), receiptSecret);
  const ledger = clusterIntakeLedger(
    JSON.parse(JSON.stringify(mergeClusterIntakeLedger(undefined, [accepted]))),
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
    acceptClusterIntakeIntent(receiptProposal(), receiptSecret),
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

test("selector decision sidecars reject unvalidated persisted shapes", () => {
  const accepted = acceptClusterIntakeIntent(receiptProposal(), receiptSecret);
  const ledger = mergeClusterSelectorDecisionLedger(undefined, [accepted]);
  assert(ledger);
  const malformed = JSON.parse(JSON.stringify(ledger)) as Record<string, unknown>;
  const stores = malformed.stores as Array<Record<string, unknown>>;
  const decision = stores[0].selector_decision as Record<string, unknown>;
  const assessments = decision.assessments as Array<Record<string, unknown>>;
  assessments[0].candidate_refs = [420, 999];

  assert.throws(() => mergeClusterSelectorDecisionLedger(JSON.stringify(malformed), [accepted]));
});
