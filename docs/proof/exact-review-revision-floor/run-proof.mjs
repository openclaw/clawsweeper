// workerd/SQLite before/after proof: an exact-review item that is re-admitted
// after its queue row was deleted must not reuse a revision whose direct
// publication receipt is still retained.
// Usage: node docs/proof/exact-review-revision-floor/run-proof.mjs BASE_SRC HEAD_SRC TOOLS_DIR OUTPUT_JSON
// Both source dirs are bundled through esbuild stdin; nothing is written into them.
// TOOLS_DIR must contain wrangler@4.107.0 (miniflare, workerd, esbuild).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const [baseSource, headSource, tools, output] = process.argv.slice(2);
assert.ok(baseSource && headSource && tools && output, "expected BASE_SRC HEAD_SRC TOOLS OUTPUT");
const require = createRequire(path.join(tools, "package.json"));
const { Miniflare } = require("miniflare");
const { build } = require("esbuild");
const START = Date.parse("2030-01-01T00:00:00.000Z");
const MINUTE = 60_000;
const SECRET = "revision-floor-proof-secret";
const SOURCE_FILES = [
  "dashboard/exact-review-queue.ts",
  "dashboard/exact-review-command-intake.ts",
  "dashboard/exact-review-direct-publication.ts",
  "dashboard/exact-review-lifecycle.ts",
  "dashboard/worker.ts",
  "dashboard/wrangler.toml",
];

const entry = `
import { ExactReviewQueue } from "./dashboard/exact-review-queue.ts";
import worker from "./dashboard/worker.ts";
let clock = ${START};
Date.now = () => clock;
export class ProofQueue extends ExactReviewQueue {
  constructor(ctx, env) {
    super(ctx, { ...env, hostedTargetPredicate: () => true, hostedPublicTargetProbe: async () => "public" });
  }
  // Wall-clock alarms never fire for the 2030 clock; the harness drives them.
  async alarm() {}
  async fetch(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (url.pathname === "/proof/clock") {
      clock = Number(url.searchParams.get("at"));
      return Response.json({ clock });
    }
    if (url.pathname === "/proof/alarm") {
      await super.alarm();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/proof/item") {
      const item = this.readStateSync().items[key];
      return Response.json(item
        ? { state: item.state, revision: item.revision, source_action: item.decision.sourceAction }
        : null);
    }
    if (url.pathname === "/proof/tuples") {
      const rows = (sql, ...args) => Array.from(this.storage.sql.exec(sql, ...args));
      const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));
      return Response.json({
        direct_receipts: rows(
          "SELECT revision, state FROM exact_review_direct_publication_plans WHERE item_key = ? ORDER BY revision",
          key,
        ),
        lifecycle_revisions: rows(
          "SELECT revision FROM exact_review_lifecycle_projection_v1 WHERE fence_key = ? ORDER BY revision",
          key,
        ).map((row) => row.revision),
        durable_counter: tables.has("exact_review_item_revisions")
          ? (rows("SELECT last_revision FROM exact_review_item_revisions WHERE item_key = ?", key.toLowerCase())[0]?.last_revision ?? null)
          : null,
      });
    }
    return super.fetch(request);
  }
}
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Direct publication goes through the real signed Worker route.
    if (url.pathname.startsWith("/internal/")) return worker.fetch(request, env, ctx);
    return env.EXACT_REVIEW_QUEUE.get(env.EXACT_REVIEW_QUEUE.idFromName("global")).fetch(request);
  },
};
`;

function gitIdentity(source) {
  try {
    return {
      head: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      working_tree_dirty: Boolean(
        execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" }).trim(),
      ),
    };
  } catch {
    return { head: null, working_tree_dirty: null };
  }
}

function wranglerVars(text) {
  const start = text.indexOf("\n[vars]\n");
  assert.ok(start >= 0, "wrangler.toml has no [vars] section");
  const vars = {};
  for (const line of text.slice(start + "\n[vars]\n".length).split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = /^([A-Z0-9_]+) = "([^"]*)"$/.exec(line.trim());
    if (match && match[1].startsWith("EXACT_REVIEW_")) vars[match[1]] = match[2];
  }
  return vars;
}

// Synthetic GitHub: App token exchange, workflow state, open targets,
// repository_dispatch capture, and batch-publisher workflow dispatches.
// Anything else is recorded as unexpected.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
let dispatches = [];
let batchPublisherDispatches = 0;
const unexpected = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://fixture");
  let body = {};
  let code = 200;
  if (url.pathname.endsWith("/installation")) body = { id: 999 };
  else if (url.pathname === "/app/installations/999/access_tokens") {
    body = { token: "synthetic-installation-token", expires_at: "2100-01-01T00:00:00Z" };
  } else if (url.pathname.endsWith("/actions/workflows/sweep.yml")) body = { state: "active" };
  else if (/\/(issues|pulls)\/\d+$/.test(url.pathname)) body = { state: "open" };
  else if (url.pathname === "/repos/openclaw/clawsweeper/dispatches" && request.method === "POST") {
    let text = "";
    for await (const chunk of request) text += chunk;
    dispatches.push(JSON.parse(text).client_payload);
    code = 204;
  } else if (
    url.pathname ===
      "/repos/openclaw/clawsweeper/actions/workflows/exact-review-batch-publish.yml/dispatches" &&
    request.method === "POST"
  ) {
    for await (const _chunk of request);
    batchPublisherDispatches += 1;
    code = 204;
  } else {
    unexpected.push(`${request.method} ${url.pathname}`);
    code = 501;
  }
  response.writeHead(code, { "content-type": "application/json" });
  response.end(code === 204 ? undefined : JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const fixture = `127.0.0.1:${server.address().port}`;

async function bundleFor(source) {
  const result = await build({
    stdin: { contents: entry, resolveDir: source, sourcefile: "proof-entry.ts", loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    // Both checkouts share one lockfile; resolve bare imports from the install
    // of the checkout that runs this harness, so the sources stay untouched.
    nodePaths: [path.resolve(import.meta.dirname, "../../../node_modules")],
  });
  return result.outputFiles[0].text;
}

function runtime(script, vars, persist) {
  return new Miniflare({
    name: "exact-review-revision-floor-proof",
    modules: true,
    script,
    compatibilityDate: "2026-07-08",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { EXACT_REVIEW_QUEUE: { className: "ProofQueue", useSQLite: true } },
    ...(persist ? { durableObjectsPersist: persist } : {}),
    bindings: {
      ...vars,
      EXACT_REVIEW_PUBLICATION_BATCHING_ENABLED: "1",
      CLAWSWEEPER_WEBHOOK_SECRET: SECRET,
      GITHUB_API_URL: `http://${fixture}`,
      CLAWSWEEPER_APP_CLIENT_ID: "Iv23fixture",
      CLAWSWEEPER_APP_PRIVATE_KEY: privateKey,
    },
    outboundService: { external: { address: fixture, http: {} } },
  });
}

function client(mf) {
  let now = START;
  const raw = async (p, body, headers = {}) => {
    const response = await mf.dispatchFetch(`https://queue${p}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const call = async (p, body) => (await raw(p, body)).body;
  const api = {
    get now() {
      return now;
    },
    async at(ms) {
      now = ms;
      await call(`/proof/clock?at=${ms}`);
    },
    async advance(ms) {
      await api.at(now + ms);
    },
    enqueue: (deliveryId, decision) => call("/enqueue", { delivery_id: deliveryId, decision }),
    item: (key) => call(`/proof/item?key=${encodeURIComponent(key)}`),
    tuples: (key) => call(`/proof/tuples?key=${encodeURIComponent(key)}`),
    // Debounce, then let the real alarm dispatch through the synthetic GitHub.
    async dispatchAndClaim(key, runId) {
      dispatches = [];
      await api.advance(10 * MINUTE);
      await call("/proof/alarm");
      const payload = dispatches.find((entry) => entry?.queue_claim?.item_key === key);
      assert.ok(payload, `no dispatch for ${key}: ${JSON.stringify(dispatches)}`);
      const claim = {
        lease_id: payload.queue_lease_id,
        item_key: key,
        lease_revision: payload.queue_claim.lease_revision,
        run_id: runId,
        run_attempt: 1,
      };
      const claimed = await raw("/claim", claim);
      assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
      assert.equal(claimed.body.claimed, true, JSON.stringify(claimed.body));
      return { ...claim, claim_generation: claimed.body.claim_generation };
    },
    async publishDirectly(claim, content) {
      const [repo, number] = claim.item_key.split("#");
      const bytes = Buffer.from(content);
      const plan = {
        canonicalTargetKey: claim.item_key,
        fenceKey: claim.item_key,
        revision: claim.lease_revision,
        sourceSha: "c".repeat(40),
        identity: {
          canonicalTargetKey: claim.item_key,
          fenceKey: claim.item_key,
          revision: claim.lease_revision,
          claimGeneration: claim.claim_generation,
        },
        operations: [
          {
            path: `records/${repo.replace("/", "-").toLowerCase()}/items/${number}.md`,
            deleted: false,
            mode: "100644",
            bytes: bytes.byteLength,
            contentBase64: bytes.toString("base64"),
          },
        ],
        totalBytes: bytes.byteLength,
        lifecycle: { kind: "router_not_required" },
      };
      const body = JSON.stringify(plan);
      const signature = createHmac("sha256", SECRET).update(body).digest("hex");
      const response = await raw("/internal/exact-review/publication-results", body, {
        "x-clawsweeper-exact-review-signature": `sha256=${signature}`,
      });
      return {
        status: response.status,
        accepted: response.body.accepted ?? null,
        error: response.body.error ?? null,
        detail: response.body.detail ?? null,
      };
    },
    // The sweep workflow's completion after an accepted direct publication.
    complete: (claim, extra = {}) =>
      raw("/complete", {
        ...claim,
        outcome: "success",
        completion_kind: "published",
        reason_code: "publication_applied",
        ...extra,
      }),
    raw,
    call,
  };
  return api;
}

const issueDecision = (repo, number, sourceAction, extra = {}) => ({
  targetRepo: repo,
  targetBranch: "main",
  itemNumber: number,
  itemKind: "issue",
  sourceEvent: "issues",
  sourceAction,
  supersedesInProgress: sourceAction === "edited",
  ...extra,
});

const publicationDecision = (repo, number, runId, leaseRevision) => {
  const producerDecision = issueDecision(repo, number, "opened");
  return {
    ...producerDecision,
    sourceAction: "exact_review_artifact_publish",
    publication: {
      artifactName: `exact-review-${runId}-1`,
      producerRunId: runId,
      producerRunAttempt: 1,
      sourceSha: "a".repeat(40),
      itemKey: `${repo}#${number}`,
      protocolVersion: 2,
      leaseRevision,
      claimGeneration: 1,
      liveProceeded: true,
      liveTerminalNoop: false,
      liveTerminalMissing: false,
      liveGuardedOpen: false,
      producerDecision,
    },
  };
};

// Headline: publish directly, complete (the queue row is deleted), re-admit,
// claim the new revision, and publish a different review directly again.
async function directReadmission(q, repo, number, runBase, readmit = issueDecision) {
  const key = `${repo}#${number}`;
  await q.enqueue(`open-${number}`, issueDecision(repo, number, "opened"));
  const first = await q.dispatchAndClaim(key, `${runBase}1`);
  const firstPublication = await q.publishDirectly(first, `first review of ${number}`);
  const firstCompletion = await q.complete(first);
  const deletedAfterCompletion = (await q.item(key)) === null;
  const readmission = await q.enqueue(`readmit-${number}`, readmit(repo, number, "edited"));
  const readmitted = await q.item(key);
  const second = await q.dispatchAndClaim(key, `${runBase}2`);
  const secondPublication = await q.publishDirectly(second, `second review of ${number}`);
  return {
    item: key.replace(/#\d+$/, "#N"),
    first_revision: first.lease_revision,
    first_publication: firstPublication,
    first_completion: firstCompletion.body,
    queue_row_deleted_after_completion: deletedAfterCompletion,
    readmission_queued: readmission.queued === true,
    readmitted_revision: readmitted?.revision ?? null,
    claimed_revision: second.lease_revision,
    second_publication: secondPublication,
    tuples: await q.tuples(key),
  };
}

const commandReadmit = (repo, number) =>
  issueDecision(repo, number, "legacy_dispatch", {
    commandStatusMarker: `<!-- clawsweeper-command-status:${number}:re_review:${"d".repeat(40)} -->`,
    statusCommentId: number * 10 + 7,
  });

async function scenarios(q) {
  const result = {};
  result.direct_readmission = await directReadmission(q, "openclaw/openclaw", 108801, "1088010");
  result.mixed_case_direct_readmission = await directReadmission(
    q,
    "openclaw/Peekaboo",
    364,
    "3640",
  );

  // Refresh recovery recreates the producer item after its publication row is gone.
  const refreshKey = "openclaw/openclaw#108802";
  await q.enqueue("refresh-open", issueDecision("openclaw/openclaw", 108802, "opened"));
  await q.enqueue("refresh-edit", issueDecision("openclaw/openclaw", 108802, "edited"));
  const producer = await q.dispatchAndClaim(refreshKey, "10880201");
  const published = await q.enqueue(
    "refresh-publication",
    publicationDecision("openclaw/openclaw", 108802, "10880201", producer.lease_revision),
  );
  const producerCompletion = await q.raw("/complete", { ...producer, outcome: "success" });
  const batch = await q.call("/publication-batches/claim", {
    claim_id: "refresh-batch",
    lease_owner: "refresh-worker",
    max_items: 1,
  });
  const member = batch.batch.items[0];
  const refreshed = await q.call("/publication-batches/complete", {
    batch_id: batch.batch.batch_id,
    lease_owner: "refresh-worker",
    items: [
      {
        item_key: member.item_key,
        revision: member.revision,
        claim_generation: member.claim_generation,
        terminal_outcome: "refresh_required",
        reason_code: "invalid_artifact",
      },
    ],
  });
  const recreated = await q.item(refreshKey);
  const recovery = await q.dispatchAndClaim(refreshKey, "10880202");
  const republished = await q.enqueue(
    "refresh-republication",
    publicationDecision("openclaw/openclaw", 108802, "10880202", recovery.lease_revision),
  );
  result.artifact_refresh = {
    producer_revision: producer.lease_revision,
    publication_queued: published.queued === true,
    producer_completion: producerCompletion.body,
    batch_refresh_accepted: refreshed.accepted,
    recreated: recreated,
    recovery_claimed_revision: recovery.lease_revision,
    republication: {
      queued: republished.queued === true,
      superseded: republished.superseded === true,
      deduped: republished.deduped === true,
    },
  };

  // Controls.
  await q.enqueue("fresh-open", issueDecision("openclaw/openclaw", 108803, "opened"));
  result.control_fresh_item_revision = (await q.item("openclaw/openclaw#108803"))?.revision;
  const head = await q.enqueue(
    "head-publication",
    publicationDecision("openclaw/openclaw", 108804, "10880401", 12),
  );
  await q.enqueue("head-open", issueDecision("openclaw/openclaw", 108804, "opened"));
  result.control_publication_head = {
    publication_queued: head.queued === true,
    head_source_revision: 12,
    admitted_revision: (await q.item("openclaw/openclaw#108804"))?.revision ?? null,
  };
  result.control_command_readmission = await directReadmission(
    q,
    "openclaw/openclaw",
    108805,
    "1088050",
    commandReadmit,
  );
  return result;
}

const receipt = {
  claim:
    "A re-admitted exact-review item never reuses a revision that a retained direct-publication receipt, lifecycle projection, or refreshed publication head already owns.",
  runtime:
    "workerd / SQLite Durable Object (Miniflare); real signed Worker direct-publication route; synthetic 2030 clock; synthetic GitHub fixture on loopback",
  node: process.version,
  workerd: require("workerd/package.json").version,
  miniflare: require("miniflare/package.json").version,
  variants: {},
};
const persist = mkdtempSync(path.join(os.tmpdir(), "revision-floor-proof-"));
try {
  const bundles = {};
  for (const [label, source] of [
    ["before", baseSource],
    ["after", headSource],
  ]) {
    const read = (file) => readFileSync(path.join(source, file));
    const vars = wranglerVars(read("dashboard/wrangler.toml").toString("utf8"));
    bundles[label] = { script: await bundleFor(source), vars };
    const mf = runtime(bundles[label].script, vars);
    try {
      await mf.ready;
      receipt.variants[label] = {
        source: "<checkout>",
        ...gitIdentity(source),
        source_sha256: Object.fromEntries(
          SOURCE_FILES.map((file) => [file, createHash("sha256").update(read(file)).digest("hex")]),
        ),
        scenarios: await scenarios(client(mf)),
      };
    } finally {
      await mf.dispose();
    }
  }

  // Upgrade: the base build publishes two items directly and deletes their
  // rows. Eight days later a third accept prunes the mixed-case item's
  // receipt, leaving only its GitHub-cased lifecycle projection. The head build
  // then re-admits both items from that persisted SQLite state.
  const retainedKey = "openclaw/openclaw#108806";
  const prunedKey = "openclaw/Peekaboo#365";
  const baseRuntime = runtime(bundles.before.script, bundles.before.vars, persist);
  const upgrade = { base_build: {}, head_build: {} };
  let resumeAt;
  try {
    await baseRuntime.ready;
    const q = client(baseRuntime);
    await q.enqueue("upgrade-open-365", issueDecision("openclaw/Peekaboo", 365, "opened"));
    const pruned = await q.dispatchAndClaim(prunedKey, "3650001");
    upgrade.base_build.mixed_case = {
      revision: pruned.lease_revision,
      publication: await q.publishDirectly(pruned, "review of 365 written by the base build"),
      completion: (await q.complete(pruned)).body,
    };
    await q.advance(8 * 24 * 60 * MINUTE);
    await q.enqueue("upgrade-open", issueDecision("openclaw/openclaw", 108806, "opened"));
    const retained = await q.dispatchAndClaim(retainedKey, "10880601");
    upgrade.base_build.retained = {
      revision: retained.lease_revision,
      publication: await q.publishDirectly(retained, "review written by the base build"),
      completion: (await q.complete(retained)).body,
      tuples: await q.tuples(retainedKey),
    };
    upgrade.base_build.mixed_case.tuples_after_retention = await q.tuples(prunedKey);
    resumeAt = q.now;
  } finally {
    await baseRuntime.dispose();
  }
  const headRuntime = runtime(bundles.after.script, bundles.after.vars, persist);
  try {
    await headRuntime.ready;
    const q = client(headRuntime);
    await q.at(resumeAt);
    for (const [key, repo, number, runId] of [
      [retainedKey, "openclaw/openclaw", 108806, "10880602"],
      [prunedKey, "openclaw/Peekaboo", 365, "3650002"],
    ]) {
      await q.enqueue(`upgrade-readmit-${number}`, issueDecision(repo, number, "edited"));
      const readmitted = await q.item(key);
      const claim = await q.dispatchAndClaim(key, runId);
      upgrade.head_build[key === retainedKey ? "retained" : "mixed_case"] = {
        readmitted_revision: readmitted?.revision ?? null,
        publication: await q.publishDirectly(
          claim,
          `review of ${number} written by the head build`,
        ),
        tuples: await q.tuples(key),
      };
    }
  } finally {
    await headRuntime.dispose();
  }
  receipt.upgrade_base_state_then_head = upgrade;
  receipt.batch_publisher_dispatches = batchPublisherDispatches;
  receipt.unexpected_github_requests = unexpected;
  receipt.limits =
    "Synthetic inputs, 2030 clock and GitHub fixture; hosted-target probes are injected as public. The proof drives the queue's own alarm, dispatch, claim, completion, publication-batch and signed direct-publication routes, but not the sweep workflow, the review model, or the deferred batch publisher that production falls back to after a rejected direct publication. No production state, GitHub writes or inference.";
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n");
  // Controls must match across builds; the head build must clear every floor.
  const { before, after } = receipt.variants;
  const command = (variant) => {
    const { readmitted_revision, claimed_revision, second_publication } =
      variant.scenarios.control_command_readmission;
    return { readmitted_revision, claimed_revision, second_publication };
  };
  assert.equal(after.scenarios.control_fresh_item_revision, 1);
  assert.equal(before.scenarios.control_fresh_item_revision, 1);
  assert.deepEqual(
    after.scenarios.control_publication_head,
    before.scenarios.control_publication_head,
  );
  assert.deepEqual(command(after), command(before));
  for (const name of ["direct_readmission", "mixed_case_direct_readmission"]) {
    const scenario = after.scenarios[name];
    assert.ok(scenario.readmitted_revision > scenario.first_revision, name);
    assert.equal(scenario.second_publication.accepted, true, name);
  }
  const refresh = after.scenarios.artifact_refresh;
  assert.ok(refresh.recreated.revision > refresh.producer_revision, "refresh revision");
  assert.equal(refresh.republication.queued, true, "refresh republication");
  for (const half of Object.values(receipt.upgrade_base_state_then_head.head_build)) {
    assert.equal(half.publication.accepted, true, "upgrade publication");
  }
  assert.deepEqual(unexpected, [], "unexpected GitHub fixture route");
  const brief = (variant) => ({
    head: variant.head,
    dirty: variant.working_tree_dirty,
    direct: {
      readmitted: variant.scenarios.direct_readmission.readmitted_revision,
      second: variant.scenarios.direct_readmission.second_publication,
    },
    mixed_case: {
      readmitted: variant.scenarios.mixed_case_direct_readmission.readmitted_revision,
      second: variant.scenarios.mixed_case_direct_readmission.second_publication,
    },
    refresh: {
      recreated: variant.scenarios.artifact_refresh.recreated,
      republication: variant.scenarios.artifact_refresh.republication,
    },
    fresh: variant.scenarios.control_fresh_item_revision,
    head_floor: variant.scenarios.control_publication_head,
    command: {
      readmitted: variant.scenarios.control_command_readmission.readmitted_revision,
      second: variant.scenarios.control_command_readmission.second_publication,
    },
  });
  console.log(
    JSON.stringify(
      {
        before: brief(receipt.variants.before),
        after: brief(receipt.variants.after),
        upgrade: receipt.upgrade_base_state_then_head,
        unexpected,
      },
      null,
      1,
    ),
  );
} finally {
  rmSync(persist, { recursive: true, force: true });
  server.closeAllConnections();
  server.close();
}
