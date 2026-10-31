// Controlled runtime proof: real queue/SQLite stores -> public Worker -> actual site snapshot.
// No live mutation: external fetch is refused; queue records are isolated scenario fixtures.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ExactReviewQueue, type ExactReviewQueueItem } from "../dashboard/exact-review-queue.ts";
import worker, { publicExactReviewQueueProjection } from "../dashboard/worker.ts";
import { ExactReviewReviewLoopStore } from "../dashboard/exact-review-review-loop.ts";
import { reviewFailureDecisionFingerprint } from "../dashboard/exact-review-observed-failure.ts";
import { MemoryDurableStorage } from "../test/dashboard-worker-harness.ts";

const out = resolve(process.argv[2] ?? ".artifacts/warning-proof");
await mkdir(out, { recursive: true });
// Manifest sync may omit Git metadata for an unpublished commit. In that mode the caller
// supplies a pinned head; the returned source hashes must be checked against that commit.
const suppliedHead = process.argv[3];
if (suppliedHead && !/^[a-f0-9]{40}$/.test(suppliedHead))
  throw new Error("Invalid proof source head");
const now = Date.now();
const repo = "openclaw/clawsweeper";
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Proof refuses external queue network");
};
const storage = new MemoryDurableStorage();
const items: Record<string, ExactReviewQueueItem> = {};
function held(
  number: number,
  reason: "scanner_refused" | "review_retry_exhausted",
  repository = repo,
) {
  const item: ExactReviewQueueItem = {
    key: repository + "#" + number,
    decision: {
      targetRepo: repository,
      targetBranch: "main",
      itemNumber: number,
      itemKind: "pull_request",
      sourceEvent: "pull_request",
      sourceAction: "synchronize",
      supersedesInProgress: false,
    },
    state: "parked",
    parkedReason: reason,
    revision: 4,
    createdAt: now - 60_000,
    updatedAt: now - 15_000,
    nextAttemptAt: now + 3600_000,
    attempts: 2,
    reviewFailureAttempts: 4,
    scannerRefusal: { observedAt: now - 10_000, runId: "100" },
    reviewFailure: {
      stage: reason === "scanner_refused" ? "agent_input_scan" : "provider_or_model",
      reason: reason === "scanner_refused" ? "findings" : "transport_network",
    },
  };
  item.reviewFailureDecisionFingerprint = reviewFailureDecisionFingerprint(item.decision);
  items[item.key] = item;
  return item;
}
for (let i = 0; i < 24; i++) held(2100 + i, "scanner_refused");
held(2198, "scanner_refused", "private-owner/secret");
const retry = held(2128, "review_retry_exhausted");
retry.parkedRecoveryAt = now + 180_000;
const exhausted = held(2129, "review_retry_exhausted");
exhausted.parkedRecoveryAttempts = 3;
for (const revision of [1, 2]) {
  const item = held(2130, "review_retry_exhausted");
  delete items[item.key];
  item.state = "pending";
  delete item.parkedReason;
  item.key += "@publish:" + revision;
  item.revision = revision;
  const producerDecision = structuredClone(item.decision);
  item.decision.sourceAction = "exact_review_artifact_publish";
  item.decision.publication = {
    artifactName: "controlled-publication",
    producerRunId: String(100 + revision),
    producerRunAttempt: 1,
    sourceSha: "a".repeat(40),
    itemKey: repo + "#2130",
    protocolVersion: 2,
    leaseRevision: revision,
    claimGeneration: 1,
    producerDecision,
  } as never;
  items[item.key] = item;
}
await storage.put("exact-review-queue", { items });
const loop = new ExactReviewReviewLoopStore(storage);
for (let target = 0; target < 8; target++) {
  const key = target === 7 ? "private-owner/secret#9" : repo + "#" + (2120 + target);
  for (let claim = 0; claim < 6; claim++)
    loop.recordReviewGenerationSafely(
      key,
      String(1000 + target * 10 + claim),
      (claim % 2) + 1,
      now - 60_000 + claim * 5000,
    );
}
try {
  const queue = new ExactReviewQueue(
    { storage },
    { EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1", EXACT_REVIEW_RUNAWAY_REVIEWS_PER_DAY: "2" },
  );
  const env = {
    PUBLIC_BAY_REPOS: repo,
    EXACT_REVIEW_QUEUE: {
      idFromName: () => "local",
      get: () => ({
        fetch: (request: RequestInfo, init?: RequestInit) =>
          queue.fetch(new Request(request, init)),
      }),
    },
  };
  const response = await worker.fetch(
    new Request("https://clawsweeper.openclaw.ai/api/exact-review-queue"),
    env,
  );
  assert.equal(response.status, 200, await response.clone().text());
  const queueSnapshot = (await response.json()) as any;
  const evidence = queueSnapshot.warning_evidence;
  assert.deepEqual(
    evidence.groups.map((group: any) => group.total),
    [25, 2, 1],
  );
  assert.equal(evidence.groups[0].items.length, 10);
  assert.equal(evidence.repeated_claims.total, 8);
  assert.equal(evidence.repeated_claims.items.length, 7);
  assert.equal(evidence.repeated_claims.items[0].claims, 6);
  assert.equal(evidence.repeated_claims.items[0].recent_claims.length, 5);
  assert.equal(evidence.groups[2].items[0].next_retry_at, null);
  assert.equal(queueSnapshot.lanes.publication.parked_reasons.stale_revision, 1);
  assert.doesNotMatch(
    JSON.stringify(queueSnapshot),
    /private-owner|controlled-publication|run_id|sourceSha/,
  );
  assert.deepEqual(
    publicExactReviewQueueProjection(queueSnapshot, new Set([repo])).warning_evidence,
    evidence,
  );
  const snapshot = JSON.parse(await readFile("dashboard-site/fixtures/dashboard.json", "utf8"));
  snapshot.queue = queueSnapshot;
  const emptyStorage = new MemoryDurableStorage();
  try {
    const emptyQueue = new ExactReviewQueue({ storage: emptyStorage }, {});
    const emptyStats = await (await emptyQueue.fetch(new Request("https://queue/stats"))).json();
    const empty = publicExactReviewQueueProjection(emptyStats, new Set([repo]));
    assert.deepEqual(
      empty.warning_evidence!.groups.map((group) => group.total),
      [0, 0, 0],
    );
    await writeFile(join(out, "empty.json"), JSON.stringify({ ...snapshot, queue: empty }));
  } finally {
    emptyStorage.sql.close();
  }
  const excluded = publicExactReviewQueueProjection(queueSnapshot);
  assert.equal(excluded.warning_evidence!.groups[0].items.length, 0);
  await writeFile(join(out, "excluded.json"), JSON.stringify({ ...snapshot, queue: excluded }));
  const legacy = { ...queueSnapshot };
  delete legacy.warning_evidence;
  const unavailable = publicExactReviewQueueProjection(legacy, new Set([repo]));
  assert.equal(unavailable.warning_evidence, null);
  await writeFile(
    join(out, "unavailable.json"),
    JSON.stringify({ ...snapshot, queue: unavailable }),
  );
  const sourcePaths = [
    "dashboard/exact-review-read-model.ts",
    "dashboard-site/src/components/Layout.astro",
    "dashboard-site/src/components/SegmentBar.astro",
    "dashboard-site/src/components/InfoTip.astro",
    "dashboard-site/src/styles/global.css",
    "dashboard-site/src/components/Card.astro",
    "dashboard-site/src/components/BarList.astro",
    "dashboard-site/src/lib/format.ts",
    "test/dashboard-worker-harness.ts",
    "package.json",
    "pnpm-lock.yaml",
    "dashboard-site/package.json",
    "dashboard-site/pnpm-lock.yaml",
    "dashboard/exact-review-warning-evidence.ts",
    "dashboard/exact-review-review-loop.ts",
    "dashboard/exact-review-queue.ts",
    "dashboard/worker.ts",
    "dashboard-site/src/lib/data.ts",
    "dashboard-site/src/pages/queue.astro",
    "dashboard-site/src/pages/agent.astro",
    "dashboard-site/src/components/WarningEvidence.astro",
    "scripts/proof-warning-drilldowns.ts",
    "scripts/proof-warning-drilldowns-browser.mjs",
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  const bytes = JSON.stringify(snapshot);
  await writeFile(join(out, "dashboard.json"), bytes);
  await writeFile(
    join(out, "producer-trace.json"),
    JSON.stringify(
      {
        head:
          suppliedHead ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        head_binding: suppliedHead
          ? "caller-pinned; verify source_sha256 against committed blobs"
          : "local Git HEAD",
        source_sha256: sourceHashes,
        fixture: "isolated parked queue records and real SQLite claim generation writes",
        commands: [
          "node scripts/proof-warning-drilldowns.ts",
          "Astro build",
          "Playwright browser proof",
        ],
        snapshot_sha256: createHash("sha256").update(bytes).digest("hex"),
        observed: {
          warning_totals: evidence.groups.map((group: any) => ({
            kind: group.kind,
            total: group.total,
            shown: group.items.length,
          })),
          repeated_flagged: 8,
          repeated_public_shown: 7,
          claims_per_target: 6,
          recent_claims_per_target: 5,
        },
        limits:
          "Controlled local queue/storage records, no live GitHub or production mutation; public repository allowlist fixed to openclaw/clawsweeper. No source revision/trigger or workflow URL inferred from claim history.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      result: "queue-to-public-snapshot verified",
      warning_totals: [25, 2, 1],
      repeated_public: 7,
      repeated_total: 8,
    }),
  );
} finally {
  globalThis.fetch = originalFetch;
  storage.sql.close();
}
