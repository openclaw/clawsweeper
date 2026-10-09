import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReviewPlanningInventory } from "../../../dist/clawsweeper-review-planning-inventory.js";
import { createReportActionRendering } from "../../../dist/clawsweeper-report-actions.js";
import { createCommandOperations } from "../../../dist/clawsweeper-command-operations.js";
import { githubReadModelRequestSync } from "../../../dist/github-webhook-read-model-client.js";

const root = mkdtempSync(path.join(tmpdir(), "pr-kind-proof-"));
const secret = "synthetic-pr-kind-proof-secret";
const repository = "openclaw/clawsweeper";
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const nonce = randomUUID();
mkdirSync(path.join(root, "home"));
const child = spawn("corepack", ["pnpm", "dlx", "--allow-build", "esbuild", "--allow-build", "sharp",
  "--allow-build", "workerd", "wrangler@4.131.1", "dev", "--config",
  "docs/proof/pr-read-model-kind/wrangler.toml", "--local", "--persist-to", path.join(root, "state"),
  "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0", "--var", `PROOF_NONCE:${nonce}`],
{ detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
  PATH: process.env.PATH, HOME: path.join(root, "home"), CI: "1", WRANGLER_SEND_METRICS: "false",
  SHARP_IGNORE_GLOBAL_LIBVIPS: "1",
} });
let diagnostics = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
  diagnostics = (diagnostics + chunk).slice(-8000);
});
const exited = once(child, "exit");
let cleanupPromise;
function signalChildGroup(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function cleanup() {
  return cleanupPromise ??= (async () => {
    signalChildGroup("SIGTERM");
    const forceStop = setTimeout(() => signalChildGroup("SIGKILL"), 5000);
    try { await exited; } finally {
      clearTimeout(forceStop);
      // The wrapper can exit before workerd; kill any remaining owned descendants.
      signalChildGroup("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  })();
}
for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    cleanup().then(() => process.exit(exitCode), (error) => {
      console.error(error);
      process.exit(1);
    });
  });
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error(`local Worker exited: ${diagnostics}`);
    try {
      const response = await fetch(baseUrl + "/__proof/ready", { signal: AbortSignal.timeout(1000) });
      ready = response.ok && (await response.json()).nonce === nonce;
      if (ready) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.ok(ready, `local Worker ready: ${diagnostics}`);
  const denied = await fetch(baseUrl + "/internal/state/github-read-model/item", { method: "POST", body: "{}" });
  assert.equal(denied.status, 401);
  const now = Date.now();
  const raw = (number, updatedAt) => ({ number, title: "Synthetic identity proof", body: "fixture",
    html_url: `https://github.com/${repository}/pull/${number}`, state: "open", user: { login: "fixture" },
    created_at: new Date(now - 2000).toISOString(), updated_at: updatedAt, labels: [],
    head: { sha: "a".repeat(40) }, base: { sha: "b".repeat(40) } });
  const deliver = (event, payload, offset = 0) => send("/__proof/delivery", {
    event, deliveryId: randomUUID(), receivedAt: new Date(now + offset).toISOString(),
    payload: { action: "opened", repository: { full_name: repository }, ...payload },
  });
  deliver("pull_request", { pull_request: raw(77, new Date(now).toISOString()) });
  send("/__proof/head", { sha: "a".repeat(40) });
  const inventory = createReviewPlanningInventory({
    targetRepo: () => repository,
    ghJson: () => assert.fail("fresh item projection must not poll the Issues API"),
    normalizeAuthorAssociation: () => "CONTRIBUTOR",
    githubReadModelRequestSync: (operation, payload) => githubReadModelRequestSync(operation, payload, {
      QUEUE_URL: baseUrl, CLAWSWEEPER_WEBHOOK_SECRET: secret,
    }),
  });
  let issueReads = 0;
  const issueRevision = "d".repeat(64);
  const { currentReviewRevision } = createReportActionRendering({
    targetRepo: () => repository, asRecord: (value) => value,
    ghJson: (args) => {
      assert.deepEqual(args, ["api", `repos/${repository}/pulls/77`]);
      return send("/__proof/head", {});
    },
    collectItemContext: () => { issueReads++; return { sourceRevision: issueRevision }; },
  });
  const { reserveReviewLeaseCommand } = createCommandOperations({
    targetRepo: () => repository, repoFromArgs: () => {}, fetchItem: inventory.fetchItem,
    currentReviewRevision, reviewActionLedger: {},
    exactReviewQueueAuthorityFromEnv: () => ({ itemKey: `${repository}#77`, sourceHeadSha: "a".repeat(40) }),
    postReviewStartStatusComment: (options) => {
      const { posted } = send("/__proof/comment", { headSha: options.headSha, kind: options.item.kind });
      return { status: "posted", lease: { owner: "fixture", commentId: posted.length, headSha: options.headSha } };
    },
  });
  reserveReviewLeaseCommand({ item_number: "77", review_timeout_ms: "600000" });
  assert.deepEqual(send("/__proof/comment", {}).posted, [{ headSha: "a".repeat(40), kind: "pull_request" }]);
  assert.equal(issueReads, 0);
  send("/__proof/head", { sha: "c".repeat(40) });
  reserveReviewLeaseCommand({ item_number: "77", review_timeout_ms: "600000" });
  assert.equal(send("/__proof/comment", {}).posted.length, 1, "drift must not publish");

  send("/__proof/old-row", { repository, number: 77 });
  assert.equal(inventory.fetchItem(77).item.kind, "pull_request");
  assert.equal(currentReviewRevision(inventory.fetchItem(77).item), "c".repeat(40));
  const marker = { url: `https://api.github.com/repos/${repository}/pulls/77` };
  deliver("issue_comment", {
    issue: { ...raw(77, new Date(now + 1000).toISOString()), pull_request: marker },
    comment: { id: 9, updated_at: new Date(now + 1000).toISOString(), body: "ClawSweeper status: review started." },
  }, 1000);
  deliver("pull_request", { pull_request: raw(77, new Date(now + 2000).toISOString()) }, 2000);
  assert.deepEqual(send("/internal/state/github-read-model/item", { repository, number: 77 }).item.pull_request, marker);
  send("/internal/state/github-read-model/repair", { repository, repair_kind: "placeholders", objects: [] });
  const placeholders = send("/internal/state/github-read-model/placeholders", { repository, state: "open" });
  assert.equal(placeholders.usable, true);
  assert.deepEqual(placeholders.candidates[0].item.pull_request, marker);
  const issue = raw(88, new Date(now).toISOString());
  issue.html_url = `https://github.com/${repository}/issues/88`;
  delete issue.head;
  delete issue.base;
  deliver("issues", { issue });
  assert.equal(inventory.fetchItem(88).item.kind, "issue");
  assert.equal(currentReviewRevision(inventory.fetchItem(88).item), issueRevision);
  assert.equal(issueReads, 1);
  const files = ["dashboard/github-webhook-read-model.ts", "src/clawsweeper-review-planning-inventory.ts",
    "src/clawsweeper-report-actions.ts", "src/clawsweeper-command-operations.ts",
    "docs/proof/pr-read-model-kind/run-proof.mjs", "docs/proof/pr-read-model-kind/worker.ts"];
  console.log(JSON.stringify({ source: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceDigests: Object.fromEntries(files.map((file) => [file, createHash("sha256").update(readFileSync(file)).digest("hex")])),
    runtime: "workerd local SQLite + signed HTTP", node: process.version, rawPrHead: "a".repeat(40),
    driftedPrHead: "c".repeat(40), reservations: 1, oldRowKind: "pull_request", markerMetadata: "preserved",
    issueRevision, unsignedRead: "rejected", limit: "synthetic GitHub head and comment receiver; no live publication" }));
} finally {
  await cleanup();
}

function send(route, value) {
  const body = JSON.stringify(value);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return JSON.parse(execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "10",
    "--request", "POST", "--header", "content-type: application/json", "--header",
    `x-clawsweeper-exact-review-signature: sha256=${signature}`, "--data-binary", "@-", baseUrl + route],
  { input: body, encoding: "utf8", timeout: 12000 }));
}
