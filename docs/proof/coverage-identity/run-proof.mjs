import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import worker, { ExactReviewQueue } from "../../../dashboard/worker.ts";
import { TestStorage } from "../../../test/exact-review-test-storage.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const origin = "https://clawsweeper.example";
const secret = "synthetic-coverage-proof-secret";
const repo = "fixture/repo";
const slug = "fixture-repo";
const now = Date.now();
const timestamp = new Date(now).toISOString();
const head = "a".repeat(40);
const cases = [];
let blockedNetworkCalls = 0;
const originalFetch = globalThis.fetch;

// The real Worker talks only to the real queue below. No remote service or
// credential is available, and alarms are stored but never dispatched.
globalThis.fetch = async () => {
  blockedNetworkCalls += 1;
  throw new Error("coverage proof forbids outbound network requests");
};

function fixture() {
  const storage = new TestStorage();
  const queue = new ExactReviewQueue({ storage }, {});
  const queueRequests = [];
  const env = {
    CLAWSWEEPER_WEBHOOK_SECRET: secret,
    EXACT_REVIEW_QUEUE: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (request) => {
          queueRequests.push(`${request.method} ${new URL(request.url).pathname}`);
          return queue.fetch(request);
        },
      }),
    },
  };
  async function post(path, payload, signed = true) {
    const body = JSON.stringify(payload);
    const headers = { "content-type": "application/json" };
    if (signed) {
      headers["x-clawsweeper-exact-review-signature"] =
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    }
    return worker.fetch(new Request(`${origin}${path}`, { method: "POST", headers, body }), env);
  }
  async function inventory(value) {
    const response = await post("/internal/review-coverage/inventory", value);
    assert.equal(response.status, 202, await response.clone().text());
    assert.deepEqual(await response.json(), { ok: true, accepted: true });
  }
  async function record(number, { kind = "issue", headSha = "", longHeader = false } = {}) {
    const content = [
      "---", `repo: ${repo}`, `number: ${number}`, `type: ${kind}`,
      `reviewed_at: ${timestamp}`, `pull_head_sha: ${headSha}`, "review_status: complete",
      "local_checkout_access: verified", "local_checkout_access_source: runner_preflight_v1",
      `title: ${longHeader ? "long production-style title ".repeat(300) : "synthetic item"}`,
      "---", "", "Synthetic review body.",
    ].join("\n");
    if (longHeader) assert.ok(content.indexOf("\n---", 4) > 4096);
    const response = await post("/internal/state/records/tuples", {
      deliveryId: `record-tuple:coverage-proof:${number}`,
      key: `${slug}/${number}`,
      operations: [
        { path: `records/${slug}/items/${number}.md`, expectedDigest: null,
          contentBase64: Buffer.from(content).toString("base64") },
        { path: `records/${slug}/closed/${number}.md`, expectedDigest: null },
        { path: `records/${slug}/plans/${number}.md`, expectedDigest: null },
        { path: `records/${slug}/decision-packets/${number}.json`, expectedDigest: null },
      ],
    });
    assert.equal(response.status, 202, await response.clone().text());
  }
  async function coverage() {
    const response = await worker.fetch(new Request(`${origin}/api/review-coverage`), env);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(Object.hasOwn(body, "fleets"), false);
    assert.equal(JSON.stringify(body).includes(repo), false);
    assert.ok(queueRequests.includes("GET /review-coverage"));
    return body;
  }
  return { post, inventory, record, coverage, queueRequests };
}

function census(items, overrides = {}) {
  return {
    generated_at: timestamp,
    repositories: [{
      repo, repo_slug: slug,
      open_issues: items.filter((item) => item.kind === "issue").length,
      open_pull_requests: items.filter((item) => item.kind === "pull_request").length,
      complete: true, items, ...overrides,
    }],
  };
}

function item(number, kind = "issue", labels = []) {
  return { number, kind, labels, updated_at: timestamp,
    ...(kind === "pull_request" ? { head_sha: head } : {}) };
}

function observed(name, body, extra = {}) {
  cases.push({ name, inventory_status: body.inventory_status,
    coverage_status: body.coverage_status, totals: body.totals, ...extra });
}

try {
  const joined = fixture();
  const live = census([item(1), item(2), item(3, "pull_request")]);
  const denied = await joined.post("/internal/review-coverage/inventory", live, false);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "invalid_signature" });
  assert.equal(joined.queueRequests.length, 0, "unsigned intake must not reach the queue");
  await joined.inventory(live);
  await joined.record(1, { longHeader: true });
  await joined.record(99);
  await joined.record(100);
  const result = await joined.coverage();
  assert.equal(result.coverage_status, "complete");
  assert.equal(result.totals.open_records, 3);
  assert.equal(result.totals.tracked_records, 3);
  assert.equal(result.totals.reviewed_recent, 1);
  assert.equal(result.totals.untracked_open, 2);
  assert.equal(result.totals.pending, 2);
  assert.equal(result.totals.record_drift, 2);
  assert.equal(result.totals.coverage_percent, 33.3);
  assert.deepEqual(joined.queueRequests, [
    "POST /review-coverage/inventory", "POST /records/tuples", "POST /records/tuples",
    "POST /records/tuples", "GET /review-coverage",
  ]);
  observed("signed intake -> canonical writes -> live identity join", result, {
    rejected_unsigned_status: denied.status,
    count_only_false_coverage_percent: 100,
    long_header_bytes: "greater than 4096",
    queue_requests: joined.queueRequests,
  });

  const gated = fixture();
  await gated.inventory(census([item(1, "pull_request"), item(2, "issue", ["security"])]));
  await gated.record(1, { kind: "pull_request", headSha: "b".repeat(40) });
  await gated.record(2);
  const gatedResult = await gated.coverage();
  assert.equal(gatedResult.coverage_status, "complete");
  assert.equal(gatedResult.totals.stale, 1);
  assert.equal(gatedResult.totals.excluded, 1);
  assert.equal(gatedResult.totals.reviewed_recent, 0);
  assert.equal(gatedResult.totals.reviewable_records, 1);
  assert.equal(gatedResult.totals.coverage_percent, 0);
  observed("PR head mismatch and live-label exclusion", gatedResult);

  const unknownInputs = [
    ["missing inventory", null, "missing"],
    ["count-only inventory", { generated_at: timestamp,
      repositories: [{ repo, repo_slug: slug, open_issues: 1, open_pull_requests: 0 }] }, "current"],
    ["incomplete inventory", census([], { complete: false, open_issues: 1 }), "current"],
    ["stale inventory", { ...census([item(1)]),
      generated_at: new Date(now - 13 * 60 * 60_000).toISOString() }, "stale"],
    ["future inventory", { ...census([item(1)]),
      generated_at: new Date(now + 60 * 60_000).toISOString() }, "stale"],
  ];
  for (const [name, inventory, status] of unknownInputs) {
    const candidate = fixture();
    if (inventory) await candidate.inventory(inventory);
    await candidate.record(1);
    const body = await candidate.coverage();
    assert.equal(body.inventory_status, status);
    assert.equal(body.coverage_status, "unknown");
    assert.equal(body.totals.coverage_percent, null);
    assert.equal(body.totals.reviewed_recent, 0);
    assert.equal(body.totals.pending, 0);
    observed(name, body);
  }
  assert.equal(blockedNetworkCalls, 0);
  const files = [
    "dashboard/worker.ts", "dashboard/exact-review-queue.ts",
    "dashboard/exact-review-direct-publication.ts", "dashboard/public-observability.ts",
    "src/review-coverage.ts", "src/review-completion.ts", "test/exact-review-test-storage.ts",
    "docs/proof/coverage-identity/run-proof.mjs",
  ];
  console.log(JSON.stringify({
    ok: true, node: process.version, generated_at: new Date().toISOString(),
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    source_sha256: Object.fromEntries(files.map((file) => [file,
      createHash("sha256").update(readFileSync(new URL(`../../../${file}`, import.meta.url))).digest("hex")])),
    storage: "existing TestStorage adapter using node:sqlite in-memory SQLite",
    network_calls: blockedNetworkCalls, cases,
  }, null, 2));
} catch (error) {
  console.error(error);
  console.error("[coverage-identity-proof] FAILED (exit 1)");
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch;
}
