import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [origin, expected, output] = process.argv.slice(2);
assert.ok(["before", "after"].includes(expected), "Expected before or after proof mode");
assert.ok(output, "Output directory is required");
const base = new URL(origin);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Local proof only");
const get = async (path) => {
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, 200, path);
  return { response, body: await response.json() };
};
const reset = async (scenario) => {
  const response = await fetch(new URL("/fixture/reset", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scenario }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).persistence, "StatusStore Durable Object");
};
const summarize = ({ response, body }) => {
  assert.equal(response.headers.get("x-clawsweeper-cache"), "fresh");
  assert.equal(JSON.stringify(body).includes("PRIVATE_UI_FIXTURE_SENTINEL"), false);
  const queue = body.exact_review_queue;
  return {
    collection: queue.collection,
    parked: queue.lanes.review.parked,
    parked_reasons: queue.lanes.review.parked_reasons,
    manual_publication: queue.manual_publication,
    sampled_cards: queue.bay_projection.activity.items.length,
    timing_samples: body.bay.timings.overall.samples,
  };
};
const health = (await get("/api/health")).body;
await reset("normal");
const traversals = [];
for (let index = 0; index < 3; index++) {
  const snapshot = summarize(await get("/api/status"));
  traversals.push(snapshot);
  assert.equal(snapshot.sampled_cards, 12);
  assert.equal(snapshot.timing_samples, 4);
  assert.equal(snapshot.parked, 2);
  if (expected === "after") {
    assert.equal(snapshot.collection.state, "complete");
    assert.equal(snapshot.parked_reasons.source_incompatible, 1);
    assert.equal(snapshot.parked_reasons.unknown, 1);
    assert.deepEqual(snapshot.manual_publication, {
      policy: "record_comment_only",
      enabled: false,
    });
  } else {
    assert.equal(snapshot.collection.state, index === 0 ? "complete" : "unknown");
    if (index > 0) assert.equal(snapshot.collection.reason, "malformed");
    assert.equal(snapshot.parked_reasons.source_incompatible, undefined);
    assert.equal(snapshot.parked_reasons.unknown, undefined);
  }
}
await reset("malformed");
const malformed = summarize(await get("/api/status"));
assert.deepEqual(malformed.collection, { state: "unknown", reason: "malformed" });
// Leave the same server ready for the companion real-browser proof.
await reset("normal");
await get("/api/status");
await get("/api/status");
const report = {
  status: "PASS",
  expected,
  service: health.service,
  generated_at: new Date().toISOString(),
  provider: process.env.BAY_PROOF_PROVIDER || "local-host",
  lease: process.env.BAY_PROOF_LEASE || null,
  image: process.env.BAY_PROOF_IMAGE || null,
  traversals,
  malformed,
  limits: [
    "Synthetic queue and timing input; production Worker HTTP routing, cache serialization, and StatusStore Durable Object storage.",
    "No live GitHub, dispatch, publication, or queue mutation; browser rendering is verified separately.",
  ],
};
mkdirSync(output, { recursive: true });
const path = resolve(output, `${expected}.json`);
writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, expected, artifact: path }));
