// Persisted-state upgrade proof for the deferred request continuation.
//
// Usage:
//   node docs/proof/deferred-request-continuation/upgrade.mjs seed   CODE_ROOT STATE_DIR
//   node docs/proof/deferred-request-continuation/upgrade.mjs verify CODE_ROOT STATE_DIR
//
// CODE_ROOT is a checkout (with node_modules) whose real ExactReviewQueue,
// lifecycle store, file-backed test storage, and maintainer policy are loaded.
// `seed` must run against a fresh STATE_DIR with the previous release; `verify`
// reopens the same SQLite files with another release and prints JSON results.
// No network: GitHub calls are answered by a local stub with a synthetic key.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [phase, codeRoot, stateDir] = process.argv.slice(2);
assert.ok(["seed", "verify"].includes(phase) && codeRoot && stateDir, "usage: PHASE CODE_ROOT DIR");
const load = (file) => import(pathToFileURL(path.join(path.resolve(codeRoot), file)).href);
const { ExactReviewQueue } = await load("dashboard/exact-review-queue.ts");
const { ExactReviewLifecycleProjectionStore } = await load("dashboard/exact-review-lifecycle.ts");
const { MemoryDurableStorage } = await load("test/dashboard-worker-harness.ts");
const { isExplicitReviewRequest } = await load("src/maintainer-review-policy.ts");

const repo = "openclaw/openclaw";
const HELD = 97701;
const REFRESHED = 97702;
const FINALIZED = 790;
const QUEUED = 97704;
const keyFile = path.join(stateDir, "app-key.pem");
if (!existsSync(keyFile)) {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeFileSync(keyFile, privateKey, { mode: 0o600 });
}
const json = (body) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname.endsWith("/installation")) return json({ id: 999 });
  if (url.pathname === "/app/installations/999/access_tokens") return json({ token: "proof" });
  if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
    return json({ full_name: repo, private: false, visibility: "public" });
  }
  if (url.pathname === "/repos/openclaw/clawsweeper/actions/workflows/sweep.yml") {
    return json({ state: "active" });
  }
  if (/\/actions\/runs\/\d+/.test(url.pathname)) return json({ status: "in_progress" });
  if (/\/issues\/\d+$/.test(url.pathname)) {
    return json({ state: "open", updated_at: "2026-09-29T00:00:00Z" });
  }
  if (url.pathname === "/repos/openclaw/clawsweeper/dispatches") {
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected fetch ${url}`);
};
const open = (file) => {
  const storage = new MemoryDurableStorage(path.join(stateDir, file));
  const queue = new ExactReviewQueue(
    { storage },
    {
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23proof",
      CLAWSWEEPER_APP_PRIVATE_KEY: readFileSync(keyFile, "utf8"),
      hostedTargetPredicate: () => true,
      EXACT_REVIEW_DISPATCH_DEBOUNCE_MS: "0",
      EXACT_REVIEW_ACTIVE_ITEM_WINDOW_MS: "0",
      EXACT_REVIEW_QUEUE_MAX_CONCURRENT: "8",
    },
  );
  const post = async (route, body) => {
    const response = await queue.fetch(
      new Request(`https://queue${route}`, { method: "POST", body: JSON.stringify(body) }),
    );
    return { status: response.status, body: await response.json() };
  };
  const items = async () => (await storage.get("exact-review-queue")).items;
  return { storage, queue, post, items };
};
const request = (number, commentId, extra = {}) => ({
  targetRepo: repo,
  targetBranch: "main",
  itemNumber: number,
  itemKind: "issue",
  sourceEvent: "issues",
  sourceAction: "re_review",
  supersedesInProgress: false,
  commandStatusMarker: `<!-- clawsweeper-command-status:${number}:re_review:command-${commentId} -->`,
  statusCommentId: 7000 + commentId,
  sourceCommentId: commentId,
  sourceCommentUpdatedAt: "2026-10-13T16:32:00Z",
  commandBodyDigest: "a".repeat(64),
  commandOrigin: "hosted_webhook",
  sourceCommentVerified: true,
  ...extra,
});
let run = phase === "seed" ? 880_000 : 890_000;
const claim = async (q, key) => {
  const item = (await q.items())[key];
  assert.ok(item?.leaseId, `${key} dispatched`);
  const tuple = {
    item_key: key,
    lease_id: item.leaseId,
    lease_revision: item.leaseRevision,
    run_id: String(run++),
    run_attempt: 1,
  };
  const claimed = await q.post("/claim", tuple);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  return { tuple: { ...tuple, claim_generation: claimed.body.claim_generation }, claimed };
};
// The review job finishes and hands its verdict to a deferred publication,
// which a publisher run then claims and holds.
const heldPublication = async (q, number, commentId) => {
  const key = `${repo}#${number}`;
  assert.equal((await q.post("/enqueue", { delivery_id: `request-${number}`, decision: request(number, commentId) })).status, 202);
  await q.queue.alarm();
  const review = await claim(q, key);
  const producer = review.claimed.body.decision;
  const publication = {
    artifactName: `exact-review-${review.tuple.run_id}-1`,
    producerRunId: review.tuple.run_id,
    producerRunAttempt: 1,
    sourceSha: "a".repeat(40),
    itemKey: key,
    protocolVersion: 2,
    leaseRevision: review.tuple.lease_revision,
    claimGeneration: review.tuple.claim_generation,
    liveProceeded: true,
    liveTerminalNoop: false,
    liveTerminalMissing: false,
    liveGuardedOpen: false,
    producerDecision: producer,
  };
  assert.equal(
    (
      await q.post("/enqueue", {
        delivery_id: `publisher:${review.tuple.run_id}:1`,
        decision: { ...producer, sourceAction: "exact_review_artifact_publish", publication },
      })
    ).status,
    202,
  );
  assert.equal((await q.post("/complete", { ...review.tuple, outcome: "success" })).status, 200);
  await q.queue.alarm();
  const publisher = await claim(q, `${key}@publish:${review.tuple.run_id}:1`);
  return { producer, producerRunId: review.tuple.run_id, publisher: publisher.tuple };
};

if (phase === "seed") {
  assert.ok(!existsSync(path.join(stateDir, "queue.sqlite")), "STATE_DIR must be fresh");
  const q = open("queue.sqlite");
  const held = await heldPublication(q, HELD, 6150293301);
  const refreshed = await heldPublication(q, REFRESHED, 6150293302);
  // A newer request for the refreshed item waits while its old publication is held.
  const newer = request(REFRESHED, 6150293399, { sourceCommentUpdatedAt: "2026-10-13T16:50:00Z" });
  assert.equal((await q.post("/enqueue", { delivery_id: "newer-request", decision: newer })).status, 202);
  const queued = request(QUEUED, 6150293304);
  assert.equal((await q.post("/enqueue", { delivery_id: "queued-request", decision: queued })).status, 202);

  // A pending terminal finalizer at the review key, as a direct publication
  // without a projection leaves it, in its own store.
  const f = open("finalizer.sqlite");
  const oldMarker = `<!-- clawsweeper-command-status:${FINALIZED}:re_review:command-1 -->`;
  const oldDecision = { ...request(FINALIZED, 1), statusCommentId: 7900, commandStatusMarker: oldMarker };
  const finalizerKey = `${repo}#${FINALIZED}`;
  await f.storage.put("exact-review-queue", {
    deliveries: {},
    items: {
      [finalizerKey]: {
        key: finalizerKey,
        decision: {
          ...oldDecision,
          sourceAction: "exact_review_artifact_publish",
          publication: {
            artifactName: "exact-review-7900-1",
            producerRunId: "7900",
            producerRunAttempt: 1,
            sourceSha: "a".repeat(40),
            itemKey: finalizerKey,
            protocolVersion: 2,
            leaseRevision: 4,
            claimGeneration: 1,
            liveProceeded: true,
            liveTerminalNoop: false,
            liveTerminalMissing: false,
            liveGuardedOpen: false,
            producerDecision: oldDecision,
          },
        },
        state: "pending",
        revision: 4,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
        nextAttemptAt: Date.now() - 60_000,
        attempts: 0,
        terminalFinalization: {
          disposition: "review_completed_routed",
          statusState: "Complete",
          statusDetail: "The durable review result and its route handoff completed.",
          projection: { canonicalTargetKey: finalizerKey, fenceKey: finalizerKey, revision: 4 },
        },
      },
    },
  });
  const lifecycle = new ExactReviewLifecycleProjectionStore(f.storage);
  lifecycle.ensureSchemaSync();
  const identity = { canonicalTargetKey: finalizerKey, fenceKey: finalizerKey, revision: 4 };
  lifecycle.recordAdmission({
    ...identity,
    deliveryId: "finalizer-request",
    sourceAction: "re_review",
    commandOriginated: true,
    statusMarker: oldMarker,
    statusCommentId: 7900,
    observedAt: Date.now() - 60_000,
  });
  lifecycle.recordTerminalDisposition({ ...identity, kind: "review_completed_routed", observedAt: Date.now() - 30_000 });
  assert.equal((await f.queue.fetch(new Request("https://queue/stats"))).status, 200);
  writeFileSync(
    path.join(stateDir, "seed.json"),
    JSON.stringify({ held, refreshed, newer, queued, finalizer: { key: finalizerKey, oldMarker } }, null, 2),
  );
  console.log(JSON.stringify({ phase, items: Object.keys(await q.items()).sort(), finalizer: Object.keys(await f.items()) }));
  process.exit(0);
}

const seed = JSON.parse(readFileSync(path.join(stateDir, "seed.json"), "utf8"));
const results = {};
const q = open("queue.sqlite");
const loaded = await q.items();
results.loaded_items = Object.keys(loaded).sort();

// 1. The publisher that held its publication across the upgrade requeues it.
const heldKey = `${repo}#${HELD}`;
const requeue = await q.post("/enqueue", {
  delivery_id: `publisher-source-drift:${seed.held.producerRunId}:1`,
  decision: { ...seed.held.producer, sourceAction: "source_drift_requeue", supersedesInProgress: true },
});
const heldItem = (await q.items())[heldKey];
results.held_publication_requeue = {
  status: requeue.status,
  admission_delivery_id: heldItem?.admissionDeliveryId,
  source_comment_verified: heldItem?.decision.sourceCommentVerified ?? null,
};

// 2. The refreshed publication that the previous release leased completes after
// the upgrade while the newer request waits.
const refreshedKey = `${repo}#${REFRESHED}`;
const refresh = await q.post("/complete", {
  ...seed.refreshed.publisher,
  outcome: "success",
  completion_kind: "refresh_required",
  reason_code: "invalid_artifact",
});
const afterRefresh = await q.items();
const refreshedFence = seed.refreshed.publisher.item_key;
const projection = new ExactReviewLifecycleProjectionStore(q.storage).read(
  refreshedKey,
  refreshedFence,
  seed.refreshed.publisher.lease_revision,
);
results.refresh_with_newer_request = {
  status: refresh.status,
  terminal_finalization: refresh.body.terminal_finalization ?? false,
  queued_source_action: afterRefresh[refreshedKey]?.decision.sourceAction,
  queued_marker_is_newer: afterRefresh[refreshedKey]?.decision.commandStatusMarker === seed.newer.commandStatusMarker,
  refreshed_lifecycle: projection?.terminalDisposition?.kind ?? null,
};

// 3. Every queued review claims normally; the claimed decisions decide whether
// the maintainer policy treats them as explicit requests.
await q.queue.alarm();
const claimedExplicit = {};
for (const [name, number] of [["held_continuation", HELD], ["newer_request", REFRESHED], ["queued_request", QUEUED]]) {
  const claimed = await claim(q, `${repo}#${number}`);
  claimedExplicit[name] = isExplicitReviewRequest(claimed.claimed.body.decision);
}
results.claimed_explicit = claimedExplicit;

// 4. An organic edit reaches the finalizer the previous release left pending.
const f = open("finalizer.sqlite");
const organic = await f.post("/enqueue", {
  delivery_id: "organic-edit",
  decision: {
    targetRepo: repo,
    targetBranch: "main",
    itemNumber: FINALIZED,
    itemKind: "issue",
    sourceEvent: "issues",
    sourceAction: "edited",
    supersedesInProgress: true,
    sourceUpdatedAt: "2026-10-14T00:00:00Z",
  },
});
const finalizerItems = await f.items();
const successor = finalizerItems[seed.finalizer.key];
results.organic_successor_of_finalizer = {
  status: organic.status,
  successor_source_action: successor?.decision.sourceAction,
  successor_command_marker: successor?.decision.commandStatusMarker ?? null,
  successor_verified: successor?.decision.sourceCommentVerified ?? null,
  driver_marker_kept:
    finalizerItems[`terminal-finalization:${seed.finalizer.key}:4`]?.decision.commandStatusMarker ===
    seed.finalizer.oldMarker,
};
const stats = await q.queue.fetch(new Request("https://queue/stats"));
results.stats_status = stats.status;
console.log(JSON.stringify(results, null, 2));
