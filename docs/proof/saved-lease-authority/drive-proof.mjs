import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
const [origin, mode, output] = process.argv.slice(2);
assert(["baseline", "candidate"].includes(mode));
const trace = [];
const checks = [];
const secret = "saved-lease-isolated-synthetic-secret";
const route = "/internal/exact-review/";
async function post(path, value, signed = true) {
  const body = JSON.stringify(value);
  const res = await fetch(origin + route + path, {
    method: "POST",
    headers: signed
      ? {
          "content-type": "application/json",
          "x-clawsweeper-exact-review-signature":
            "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
        }
      : {},
    body,
  });
  const json = await res.json();
  trace.push({ path, status: res.status, body: json });
  return { status: res.status, json };
}
const fixture = async (value) => {
  const res = await post("publications/list", value);
  assert.equal(res.status, 200);
  return res.json;
};
async function bay() {
  const res = await fetch(origin + "/api/durable-lifecycle-bay");
  assert.equal(res.status, 200);
  const value = (await res.json()).durable_lifecycle_bay;
  assert.equal(value.collection.state, "complete");
  trace.push({ path: "/api/durable-lifecycle-bay", status: res.status, body: value });
  // Re-recording the same terminal may refresh updated_at. Compare the public
  // identities/states and all lane counts, not an expected wall-clock change.
  const cards = value.sample.cards
    .map(({ updated_at: _updatedAt, ...card }) => card)
    .sort((a, b) => a.item_number - b.item_number);
  return { inventory: value.inventory, lanes: value.lanes, sample: { ...value.sample, cards } };
}
let number = 770500;
async function scenario({
  name,
  receipt = "accepted",
  delivered = false,
  change,
  kind = "requeue",
  outcome = "success",
  mismatch,
}) {
  const n = ++number,
    now = Date.now(),
    key = `openclaw/openclaw#${n}`;
  const decision = {
    targetRepo: "openclaw/openclaw",
    targetBranch: "main",
    itemNumber: n,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "opened",
    supersedesInProgress: false,
  };
  const item = {
    key,
    decision,
    leaseDecision: { ...decision },
    state: "leased",
    revision: 4,
    createdAt: now - 60000,
    updatedAt: now - 60000,
    nextAttemptAt: now - 60000,
    attempts: 0,
    leaseId: `lease-${n}`,
    leaseRevision: 4,
    leaseExpiresAt: now + 3600000,
    claimedRunId: String(n),
    claimedRunAttempt: 1,
    claimGeneration: 2,
    claimProtocolVersion: 2,
  };
  await fixture({ proof: "seed", item });
  const plan = {
    canonicalTargetKey: key,
    fenceKey: key,
    revision: 4,
    sourceSha: "c".repeat(40),
    identity: { canonicalTargetKey: key, fenceKey: key, revision: 4, claimGeneration: 2 },
    operations: [
      {
        path: `records/openclaw-openclaw/items/${n}.md`,
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
    ...(kind ? { lifecycle: { kind } } : {}),
  };
  if (receipt !== "accepted") {
    const prior =
      receipt === "deduped"
        ? plan
        : {
            ...plan,
            revision: 5,
            identity: { ...plan.identity, revision: 5 },
            lifecycle: { kind: "policy_noop" },
          };
    assert.equal((await fixture({ proof: "prior", plan: prior })).outcome, "accepted");
  }
  const published = await post("publication-results", plan);
  assert.equal(published.status, 202);
  assert.equal(published.json[receipt], true);
  // The real finalizer records this terminal disposition before it calls /complete.
  if (kind === "requeue" && receipt !== "superseded") {
    const terminal = await post("lifecycle/terminal-disposition", {
      canonical_target_key: key,
      fence_key: key,
      revision: 4,
      kind: "requeue",
    });
    assert.equal(terminal.status, 200);
  }
  if (change === "newer_command") {
    const command = await post("enqueue", {
      delivery_id: `proof-newer-command-${n}`,
      decision: {
        ...decision,
        itemKind: "pull_request",
        sourceEvent: "pull_request",
        sourceAction: "legacy_dispatch",
        commandStatusMarker: `<!-- clawsweeper-command-status:${n}:re_review:0123456789abcdef0123456789abcdef01234567 -->`,
        statusCommentId: n + 1,
        additionalPrompt: "Preserve synthetic newer command",
      },
    });
    assert.equal(command.status, 202);
    assert.equal(command.json.queued, true);
  } else if (change) await fixture({ proof: "authority", key, change });
  if (mismatch === "ambiguous") await fixture({ proof: "authority", key, change: "ambiguous" });
  const before = await fixture({ proof: "inspect", key });
  if (kind)
    assert.equal(
      before.item.leaseDecision?.publication?.directLifecycle?.receiptOutcome,
      change === "missing" ? undefined : receipt,
    );
  const bayBefore = await bay();
  const completion = {
    lease_id: item.leaseId,
    item_key: key,
    lease_revision: 4,
    claim_generation: 2,
    run_id: String(n),
    run_attempt: 1,
    outcome: "success",
    completion_kind: "published",
    reason_code: "publication_applied",
    direct_lifecycle_requeue: true,
    lifecycle_terminal_disposition: "requeue",
  };
  const run = {
    run_id: String(n),
    run_attempt: 1,
    claimed_run_attempt: 1,
    claim_generation: 2,
    outcome,
  };
  if (mismatch === "attempt") {
    run.run_attempt = 2;
    run.claimed_run_attempt = 2;
  }
  if (mismatch === "generation") run.claim_generation = 3;
  const result = await post(
    delivered ? "complete" : "reconcile",
    delivered ? completion : { terminal_runs: [run] },
    mismatch !== "unsigned",
  );
  const invalidCompletion = delivered && receipt === "superseded" && mode === "candidate";
  const ignored = Boolean(mismatch) || invalidCompletion;
  const authority =
    kind === "requeue" &&
    receipt !== "superseded" &&
    (mode === "baseline"
      ? change !== "current_plan"
      : !["missing", "wrong_source"].includes(change));
  const requeue =
    !ignored && (delivered || change === "newer_command" || outcome !== "success" || authority);
  if (mismatch === "unsigned") assert.equal(result.status, 401);
  else if (invalidCompletion) assert.equal(result.status, 400);
  else {
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.json,
      delivered
        ? { ok: true, requeued: true }
        : {
            ok: true,
            reconciled: ignored ? 0 : 1,
            requeued: Number(requeue),
            completed: Number(!ignored && !requeue),
          },
    );
  }
  const after = await fixture({ proof: "inspect", key, expect_pending: requeue });
  assert.equal(after.outbound, 0);
  assert.equal(after.unexpectedAlarms, 0);
  if (ignored) assert.deepEqual(after, before);
  else if (requeue) {
    assert.equal(after.item_count, 1);
    assert.equal(after.item.state, "pending");
    assert.equal(after.item.leaseId, undefined);
    if (change === "newer_command") {
      assert.deepEqual(after.item.decision, before.item.decision);
      assert.equal(after.item.revision, 5);
    } else if (outcome === "success") {
      assert.equal(after.item.revision, 5);
      assert.equal(after.item.decision.sourceAction, "source_drift_requeue");
      assert.equal(after.item.decision.publication, undefined);
      assert.equal(after.item.admissionDeliveryId, `direct-lifecycle-requeue:${key}:4`);
    } else {
      assert.equal(after.item.revision, 4);
      assert.equal(after.item.decision.sourceAction, "exact_review_artifact_publish");
      assert.equal(after.item.attempts, 1);
    }
  } else {
    assert.equal(after.item, null);
    assert.equal(after.item_count, 0);
  }
  // The baseline's superseded /complete incorrectly writes a requeue terminal.
  if (!(delivered && receipt === "superseded" && mode === "baseline")) {
    assert.deepEqual(after.projection?.terminalDisposition, before.projection?.terminalDisposition);
    assert.deepEqual(after.projection?.reviewResults, before.projection?.reviewResults);
    assert.deepEqual(after.projection?.routerReceipts, before.projection?.routerReceipts);
    assert.deepEqual(after.projection?.acknowledgement, before.projection?.acknowledgement);
    assert.deepEqual(after.newer_projection, before.newer_projection);
    assert.deepEqual(after.bay_rows, before.bay_rows);
    assert.deepEqual(await bay(), bayBefore);
  }
  if (requeue && outcome === "success") assert.deepEqual(after.counters, before.counters);
  if (!ignored) {
    const repeated = await post("reconcile", { terminal_runs: [run] });
    assert.deepEqual(repeated.json, { ok: true, reconciled: 0, requeued: 0, completed: 0 });
    assert.equal((await post("complete", completion)).status, 409);
    assert.deepEqual(await fixture({ proof: "inspect", key }), after);
  }
  checks.push({
    name,
    status: "PASS",
    result: result.json,
    item: after.item,
    old_terminal: after.projection?.terminalDisposition,
    counters_before: before.counters,
    counters_after: after.counters,
    bay_rows: after.bay_rows,
  });
  console.log(`${mode}: ${name}: PASS`);
}
try {
  for (const receipt of ["accepted", "deduped"])
    for (const delivered of [false, true])
      await scenario({
        name: `${receipt}-${delivered ? "delivered" : "lost"}`,
        receipt,
        delivered,
      });
  await scenario({ name: "superseded-lost", receipt: "superseded" });
  await scenario({
    name: "superseded-completion-requeue-rejected",
    receipt: "superseded",
    delivered: true,
  });
  await scenario({ name: "no-lifecycle", kind: null });
  for (const change of ["missing", "wrong_source", "current_plan", "newer_command"])
    await scenario({ name: `authority-${change}`, change });
  for (const mismatch of ["attempt", "generation", "ambiguous", "unsigned"])
    await scenario({ name: `ownership-${mismatch}`, mismatch });
  for (const outcome of ["failure", "cancelled"])
    await scenario({ name: `terminal-${outcome}`, outcome });
} finally {
  writeFileSync(output, JSON.stringify({ mode, checks, trace }, null, 2) + "\n");
}
