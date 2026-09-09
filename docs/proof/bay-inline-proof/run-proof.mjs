import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { stableJson } from "../../../src/stable-json.ts";
const origin = process.env.PROOF_ORIGIN || "http://127.0.0.1:8793";
const out = ".artifacts/bay-inline-proof/runtime";
await mkdir(out, { recursive: true });
const checks = [];
const post = async (route, value, status = 200) => {
  const response = await fetch(origin + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
};
const fixtures = [
  { number: 95001, duration: 120000, requested: true },
  { number: 95002, duration: 240000, requested: true, linked: true },
  { number: 95003, duration: 60000, linked: true },
  { number: 95004, duration: 600000, historical: true },
  { number: 95005, duration: 900000, historical: true, legacy: true },
];
for (const fixture of fixtures) {
  const { lease } = await post("/fixture/admit", fixture);
  if (fixture.requested) {
    const proofPlan = { claim: "PRIVATE_PLAN_SENTINEL", actions: [{ type: "send", atMs: 0, text: "PRIVATE_MESSAGE_SENTINEL" }], modelReplies: ["fixture reply"], settings: { streaming: "off", nativeCommands: false }, maxDurationMs: 1000, expectations: ["reply"] };
    const request = { lease, operation: "request", scenario: "telegram-bot-e2e-proof", proofPlan, planSha256: createHash("sha256").update(stableJson(proofPlan)).digest("hex") };
    await post("/fixture/proof", { ...request, lease: { ...lease, claimGeneration: 99 } }, 409);
    const accepted = await post("/fixture/proof", request);
    assert.equal(accepted.dispatch, true);
    assert.ok(Number.isFinite(accepted.participationUpdatedAt));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const duplicate = await post("/fixture/proof", request);
    assert.equal(duplicate.dispatch, false);
    assert.equal(duplicate.participationUpdatedAt, accepted.participationUpdatedAt, "duplicate proof polling must not refresh lifecycle recency");
    if (fixture.number === 95001) {
      const retry = await post("/fixture/retry", { lease });
      assert.equal(retry.privateRequestsCleared, true);
      assert.equal(retry.leaseCleared, true);
      assert.equal(retry.participation, "requested");
      await post("/fixture/proof", request, 409);
    }
  }
  const result = await post("/fixture/finalize", fixture);
  assert.equal(result.participation, fixture.requested ? "requested" : fixture.historical ? "unknown" : "not_requested");
}
checks.push("real DO admission, stale-owner rejection, request dedupe, durable classification after item removal/reconstruction");
const response = await fetch(origin + "/api/status");
assert.equal(response.status, 200);
const status = await response.json();
await writeFile(out + "/public-status.json", JSON.stringify(status, null, 2));
const timings = status.bay.timings;
assert.equal(status.bay.metrics_state, "complete");
assert.deepEqual(timings.inline_proof.requested.overall, { average_ms: 180000, median_ms: 180000, samples: 2 });
assert.deepEqual(timings.inline_proof.not_requested.overall, { average_ms: 60000, median_ms: 60000, samples: 1 });
assert.equal(timings.inline_proof.unknown.overall.samples, 1);
assert.equal(timings.overall.samples, 4);
assert.equal(timings.including_legacy_batch.overall.samples, 5);
assert.equal(timings.including_legacy_batch.inline_proof.unknown.overall.samples, 2);
assert.doesNotMatch(JSON.stringify(status), /PRIVATE_|proofPlan|planSha256|requestId|producerRedemption|fixture-lease/);
checks.push("real public Worker API reports exact full-duration cohort count/median/mean and no private proof material");
const lifecycle = await (await fetch(origin + "/api/durable-lifecycle-bay")).json();
await writeFile(out + "/public-lifecycles.json", JSON.stringify(lifecycle, null, 2));
assert.equal(lifecycle.durable_lifecycle_bay.sample.cards.find((card) => card.item_number === 95001).inline_proof, "requested");
assert.equal(lifecycle.durable_lifecycle_bay.sample.cards.find((card) => card.item_number === 95004).inline_proof, "unknown");
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const mutations = [];
  page.on("request", (request) => { if (request.method() !== "GET") mutations.push(request.url()); });
  const renderedResponse = page.waitForResponse((response) => response.url() === origin + "/api/status");
  await page.goto(origin + "/bay");
  const renderedStatus = await (await renderedResponse).json();
  const sourceCutoff = renderedStatus.bay.timings.window_ended_at;
  assert.ok(Number.isFinite(Date.parse(sourceCutoff)));
  const summary = page.locator("#overall-average");
  await page.waitForFunction(() => document.querySelector("#overall-average").textContent.includes("4 reviews"));
  assert.equal(await page.locator("#inline-proof-filter").inputValue(), "all");
  assert.equal(await page.locator(".journey-chart").getAttribute("data-window-end"), sourceCutoff);
  await page.screenshot({ path: out + "/all.png", fullPage: true });
  await page.selectOption("#inline-proof-filter", "requested");
  assert.match(await summary.innerText(), /2 reviews/);
  assert.match(await summary.innerText(), /3m/);
  assert.equal(await page.locator(".journey-chart").getAttribute("data-window-end"), sourceCutoff);
  await page.screenshot({ path: out + "/requested.png", fullPage: true });
  await page.selectOption("#inline-proof-filter", "not_requested");
  assert.match(await summary.innerText(), /1 review/);
  assert.match(await summary.innerText(), /1m/);
  assert.equal(await page.locator(".journey-chart").getAttribute("data-window-end"), sourceCutoff);
  await page.selectOption("#inline-proof-filter", "unknown");
  assert.match(await summary.innerText(), /1 review/);
  await page.locator("#legacy-proof-toggle").click();
  await page.waitForFunction(() => document.querySelector("#overall-average").textContent.includes("2 reviews"));
  assert.match(await summary.innerText(), /12m/); // Existing compact display rounds >=10m down to minutes.
  await page.screenshot({ path: out + "/unknown-with-legacy.png", fullPage: true });
  await page.selectOption("#inline-proof-filter", "all");
  assert.match(await summary.innerText(), /5 reviews/);
  // Rolling-upgrade response: the timing set exists but participation is absent.
  const historicalStatus = structuredClone(status);
  delete historicalStatus.bay.timings.inline_proof;
  delete historicalStatus.bay.timings.including_legacy_batch.inline_proof;
  await page.route("**/api/status", (route) => route.fulfill({ json: historicalStatus }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#overall-average").textContent.includes("4 reviews"));
  await page.selectOption("#inline-proof-filter", "not_requested");
  assert.match(await summary.innerText(), /Unavailable/);
  assert.doesNotMatch(await summary.innerText(), /No completed reviews/);
  assert.match(await summary.getAttribute("title"), /Inline-proof participation is unavailable/);
  assert.doesNotMatch(await summary.getAttribute("title"), /lifecycle metrics source is unavailable/);
  assert.match(await page.locator("#inline-proof-note").innerText(), /historical absence is unknown/);
  assert.deepEqual(errors, []);
  assert.deepEqual(mutations, []);
  checks.push("actual browser all/requested/known-without/unknown selection and orthogonal legacy filter, without mutation requests");
  await context.tracing.stop({ path: out + "/browser-trace.zip" });
  await context.close();
} finally { await browser.close(); }
await post("/fixture/incomplete-lineage", { number: 95002 });
const incomplete = await (await fetch(origin + "/api/status")).json();
assert.equal(incomplete.bay.timings.overall.samples, 4);
assert.equal(incomplete.bay.timings.inline_proof.requested.overall.samples, 1);
assert.equal(incomplete.bay.timings.inline_proof.unknown.overall.samples, 2);
await post("/fixture/incomplete-lineage", { number: 95002, remove: true });
checks.push("incomplete sibling lineage is unknown, never positive participation");
await post("/fixture/compete", { number: 95002 });
const ambiguous = await (await fetch(origin + "/api/status")).json();
await writeFile(out + "/public-status-ambiguous.json", JSON.stringify(ambiguous, null, 2));
assert.equal(ambiguous.bay.timings.overall.samples, 4);
assert.equal(ambiguous.bay.timings.inline_proof.requested.overall.samples, 1);
assert.deepEqual(ambiguous.bay.timings.inline_proof.unknown.overall, { samples: 2, average_ms: 420000, median_ms: 420000 });
checks.push("competing publication lineage becomes unknown without changing the completion population");
await post("/fixture/malformed", { number: 95003 });
const malformed = await (await fetch(origin + "/api/status")).json();
assert.equal(malformed.bay.timings.overall.samples, 4);
assert.equal(malformed.bay.timings.inline_proof.not_requested.overall.samples, 0);
assert.deepEqual(malformed.bay.timings.inline_proof.unknown.overall, { samples: 3, average_ms: 300000, median_ms: 240000 });
checks.push("malformed same-target publisher leaves all timings intact and participation unknown");
await post("/fixture/corrupt", { number: 95002 });
const corruptProducer = await (await fetch(origin + "/api/status")).json();
assert.equal(corruptProducer.bay.metrics_state, "complete");
assert.equal(corruptProducer.bay.timings.overall.samples, 4);
checks.push("corrupt exact producer JSON does not disable the all-review timing snapshot");
await post("/fixture/corrupt", { number: 95001 });
const corruptEvent = await (await fetch(origin + "/api/status")).json();
assert.equal(corruptEvent.bay.metrics_state, "complete");
assert.equal(corruptEvent.bay.timings.overall.samples, 4);
assert.deepEqual(corruptEvent.bay.timings.inline_proof.unknown.overall, { samples: 4, average_ms: 255000, median_ms: 180000 });
checks.push("corrupt event projection retains all timing arithmetic and changes only participation to unknown");
await post("/fixture/corrupt", { number: 95001, shape: true });
const corruptShape = await (await fetch(origin + "/api/status")).json();
assert.equal(corruptShape.bay.timings.overall.samples, 4);
assert.equal(corruptShape.bay.timings.inline_proof.requested.overall.samples, 0);
assert.deepEqual(corruptShape.bay.timings.inline_proof.unknown.overall, { samples: 4, average_ms: 255000, median_ms: 180000 });
checks.push("valid JSON without lifecycle schema or identity cannot invent requested participation");
await writeFile(out + "/summary.json", JSON.stringify({ source: process.env.SOURCE_SHA, checks, limits: "Local SQLite/workerd with controlled leases, final receipts and historical coverage clock. No live producer execution, credentials, dispatch or deploy." }, null, 2));
console.log(JSON.stringify({ passed: checks.length, checks, output: out }));
