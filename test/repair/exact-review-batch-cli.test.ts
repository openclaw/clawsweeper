import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("batch claim emits arbitrary target metadata after Worker admission", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-target-"));
  try {
    const member = batchMember("openclaw/private-tool#800@publish:8000:1", 800);
    member.decision.targetRepo = "openclaw/private-tool";
    const wireMember = {
      item_key: member.itemKey,
      revision: member.revision,
      claim_generation: member.claimGeneration,
      decision: member.decision,
    };
    const manifestPath = join(root, "manifest.json");
    const outputPath = join(root, "github-output");
    const preloadPath = join(root, "fetch-preload.cjs");
    writeFileSync(
      preloadPath,
      `const member = ${JSON.stringify(wireMember)};
const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/publication-batches/claim")) {
    return response({ claimed: true, batch: { batch_id: "batch-target-proof", lease_owner: "proof-worker", lease_expires_at: "2026-08-25T16:00:00.000Z", items: [member] }, configured_batch_size: 1, batch_wait_ms: 0 });
  }
  if (String(url).endsWith("/publication-batches/fetch")) {
    return response({ batch: { batch_id: "batch-target-proof", lease_owner: "proof-worker", lease_expires_at: "2026-08-25T16:00:00.000Z", items: [member] }, items: [member], superseded: 0 });
  }
  throw new Error("unexpected mock fetch target: " + url);
};
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "claim"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
          EXACT_REVIEW_BATCH_ID: "batch-target-proof",
          EXACT_REVIEW_BATCH_LEASE_OWNER: "proof-worker",
          EXACT_REVIEW_BATCH_MAX_ITEMS: "1",
          EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
          GITHUB_OUTPUT: outputPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(manifestPath), true);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).items.length, 1);
    const outputs = readFileSync(outputPath, "utf8");
    assert.match(outputs, /^claimed=true$/m);
    assert.match(outputs, /^batch_id=batch-target-proof$/m);
    assert.match(outputs, /^item_count=1$/m);
    assert.match(outputs, /^manifest=.*manifest\.json$/m);
    assert.match(outputs, /^target_owner=openclaw$/m);
    assert.match(outputs, /^target_repositories=private-tool$/m);
    assert.match(outputs, /^records_repo_slugs=openclaw-private-tool$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch commit records an invalid member permanently while publishing its healthy peer", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-"));
  try {
    const healthy = batchMember("openclaw/openclaw#801@publish:8010:1", 801);
    const invalid = batchMember("openclaw/openclaw#802@publish:8020:1", 802);
    const healthyOutcome = join(root, "healthy.json");
    const invalidOutcome = join(root, "invalid.json");
    const manifestPath = join(root, "manifest.json");
    const receiptPath = join(root, "receipt.json");
    const postsPath = join(root, "posts.json");
    writeFileSync(
      healthyOutcome,
      JSON.stringify({ kind: "eligible", plan: mutationPlan(healthy) }),
    );
    writeFileSync(
      invalidOutcome,
      JSON.stringify({
        kind: "eligible",
        plan: {
          ...mutationPlan(invalid),
          publication: {
            canonicalTargetKey: "openclaw/openclaw#999",
            fenceKey: invalid.itemKey,
          },
        },
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        batchId: "batch-cli-proof",
        leaseOwner: "proof-worker",
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        configuredBatchSize: 2,
        batchWaitMs: 0,
        items: [
          { ...healthy, outcomePath: healthyOutcome },
          { ...invalid, outcomePath: invalidOutcome },
        ],
      }),
    );
    const preloadPath = join(root, "fetch-preload.cjs");
    writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.EXACT_REVIEW_BATCH_MANIFEST, "utf8"));
const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const wireItems = manifest.items.map((item) => ({ item_key: item.itemKey, revision: item.revision, claim_generation: item.claimGeneration, decision: item.decision }));
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith("/publication-batches/fetch")) {
    return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: wireItems }, items: wireItems, superseded: 0 });
  }
  if (target.endsWith("/publication-batches/heartbeat")) {
    return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: wireItems } });
  }
  if (target.endsWith("/publication-batch-results")) {
    const posts = fs.existsSync(process.env.BATCH_CLI_POSTS) ? JSON.parse(fs.readFileSync(process.env.BATCH_CLI_POSTS, "utf8")) : [];
    posts.push(JSON.parse(init.body));
    fs.writeFileSync(process.env.BATCH_CLI_POSTS, JSON.stringify(posts));
    return response({ ok: true, accepted: true, deduped: false, superseded: false });
  }
  throw new Error("unexpected mock fetch target: " + target);
};
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "commit"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
          EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
          EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
          BATCH_CLI_POSTS: postsPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      publishedItemKeys: string[];
      outcomes: Array<{
        canonicalTargetKey: string;
        fenceKey: string;
        outcome: string;
        errorFingerprint?: string;
      }>;
    };
    assert.deepEqual(receipt.publishedItemKeys, [healthy.itemKey]);
    assert.match(receipt.outcomes[0]?.errorFingerprint ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(receipt.outcomes, [
      {
        canonicalTargetKey: "openclaw/openclaw#802",
        fenceKey: invalid.itemKey,
        outcome: "permanent",
        reasonCode: "tuple_protocol_invalid",
        errorFingerprint: receipt.outcomes[0]?.errorFingerprint,
        revision: 1,
        claimGeneration: 1,
      },
      {
        canonicalTargetKey: "openclaw/openclaw#801",
        fenceKey: healthy.itemKey,
        outcome: "accepted",
        revision: 1,
        claimGeneration: 1,
      },
    ]);
    assert.deepEqual(JSON.parse(readFileSync(postsPath, "utf8")), [
      {
        canonicalTargetKey: "openclaw/openclaw#801",
        fenceKey: healthy.itemKey,
        revision: 1,
        identity: {
          canonicalTargetKey: "openclaw/openclaw#801",
          fenceKey: healthy.itemKey,
          itemKey: healthy.itemKey,
          revision: 1,
          claimGeneration: 1,
        },
        operations: mutationPlan(healthy).operations,
        totalBytes: 1,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch completion terminalizes a superseded member without a publication mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-superseded-"));
  try {
    const member = batchMember("openclaw/openclaw#804@publish:8040:1", 804);
    const outcomePath = join(root, "superseded.json");
    const manifestPath = join(root, "manifest.json");
    const receiptPath = join(root, "receipt.json");
    const completionPath = join(root, "completion.json");
    const postsPath = join(root, "posts.json");
    const preloadPath = join(root, "fetch-preload.cjs");
    writeFileSync(outcomePath, JSON.stringify({ kind: "superseded" }));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        batchId: "batch-superseded-proof",
        leaseOwner: "proof-worker",
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        configuredBatchSize: 1,
        batchWaitMs: 0,
        items: [{ ...member, outcomePath }],
      }),
    );
    writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.EXACT_REVIEW_BATCH_MANIFEST, "utf8"));
const wireItems = manifest.items.map((item) => ({ item_key: item.itemKey, revision: item.revision, claim_generation: item.claimGeneration, decision: item.decision }));
const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith("/publication-batches/fetch")) {
    return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: wireItems }, items: wireItems, superseded: 0 });
  }
  if (target.endsWith("/publication-batches/heartbeat")) {
    return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: wireItems } });
  }
  if (target.endsWith("/publication-batch-results")) {
    fs.appendFileSync(process.env.BATCH_CLI_POSTS, init.body + "\\n");
    return response({ ok: true, accepted: true, deduped: false, superseded: false });
  }
  if (target.endsWith("/publication-batches/complete")) {
    fs.writeFileSync(process.env.BATCH_CLI_COMPLETION, init.body);
    return response({ accepted: 1, skipped: 0, batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: [] } });
  }
  throw new Error("unexpected mock fetch target: " + target);
};
`,
    );
    const env = {
      ...process.env,
      CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
      EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
      EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
      EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
      BATCH_CLI_COMPLETION: completionPath,
      BATCH_CLI_POSTS: postsPath,
    };
    const commitResult = spawnSync(
      process.execPath,
      ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "commit"],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    assert.equal(commitResult.status, 0, commitResult.stderr);
    assert.equal(readFileSync(postsPath, { encoding: "utf8", flag: "a+" }), "");
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")).outcomes, [
      {
        canonicalTargetKey: "openclaw/openclaw#804",
        fenceKey: member.itemKey,
        outcome: "superseded",
        revision: 1,
        claimGeneration: 1,
      },
    ]);

    const completeResult = spawnSync(
      process.execPath,
      ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "complete"],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    assert.equal(completeResult.status, 0, completeResult.stderr);
    assert.deepEqual(JSON.parse(readFileSync(completionPath, "utf8")).items, [
      {
        item_key: member.itemKey,
        revision: member.revision,
        claim_generation: member.claimGeneration,
        terminal_outcome: "superseded",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const publicationFailureCases = [
  {
    name: "network errors",
    scenario: "network",
    publicationOutcome: "retryable",
    reasonCode: "state_contention",
    terminalOutcome: "retryable_failure",
  },
  {
    name: "HTTP 429 responses",
    scenario: "429",
    publicationOutcome: "retryable",
    reasonCode: "state_contention",
    terminalOutcome: "retryable_failure",
  },
  {
    name: "HTTP 503 responses",
    scenario: "503",
    publicationOutcome: "retryable",
    reasonCode: "state_contention",
    terminalOutcome: "retryable_failure",
  },
  {
    name: "HTTP 400 responses",
    scenario: "400",
    publicationOutcome: "permanent",
    reasonCode: "tuple_protocol_invalid",
    terminalOutcome: "permanent_failure",
  },
  {
    name: "HTTP 413 responses",
    scenario: "413",
    publicationOutcome: "permanent",
    reasonCode: "tuple_protocol_invalid",
    terminalOutcome: "permanent_failure",
  },
  {
    name: "direct publication fence ownership failures",
    scenario: "fence_not_owned",
    publicationOutcome: "retryable",
    reasonCode: "unknown_failure",
    terminalOutcome: "retryable_failure",
  },
] as const;

for (const failureCase of publicationFailureCases) {
  test(`batch publication maps ${failureCase.name} through completion`, () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-publication-failure-"));
    try {
      const member = batchMember("openclaw/openclaw#805@publish:8050:1", 805);
      const outcomePath = join(root, "eligible.json");
      const manifestPath = join(root, "manifest.json");
      const receiptPath = join(root, "receipt.json");
      const completionPath = join(root, "completion.json");
      const preloadPath = join(root, "fetch-preload.cjs");
      writeFileSync(
        outcomePath,
        JSON.stringify({
          kind: "eligible",
          plan: mutationPlan(member),
          postEffectsComplete: true,
        }),
      );
      writeFileSync(
        manifestPath,
        JSON.stringify({
          batchId: `batch-publication-${failureCase.scenario}`,
          leaseOwner: "proof-worker",
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
          configuredBatchSize: 1,
          batchWaitMs: 0,
          items: [{ ...member, outcomePath }],
        }),
      );
      writeFileSync(
        preloadPath,
        `const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.EXACT_REVIEW_BATCH_MANIFEST, "utf8"));
const wireItems = manifest.items.map((item) => ({ item_key: item.itemKey, revision: item.revision, claim_generation: item.claimGeneration, decision: item.decision }));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.setTimeout = (callback, _delay, ...args) => {
  queueMicrotask(() => callback(...args));
  return 0;
};
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith("/publication-batches/fetch")) {
    return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: wireItems }, items: wireItems, superseded: 0 });
  }
  if (target.endsWith("/publication-batches/heartbeat")) {
    return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: wireItems } });
  }
  if (target.endsWith("/publication-batch-results")) {
    if (process.env.BATCH_CLI_SCENARIO === "network") throw new Error("network unavailable");
    const status = process.env.BATCH_CLI_SCENARIO === "fence_not_owned" ? 409 : Number(process.env.BATCH_CLI_SCENARIO);
    const error = process.env.BATCH_CLI_SCENARIO === "fence_not_owned" ? "direct_publication_fence_not_owned" : "http_" + status;
    return response({ error }, status);
  }
  if (target.endsWith("/publication-batches/complete")) {
    fs.writeFileSync(process.env.BATCH_CLI_COMPLETION, init.body);
    return response({
      accepted: 1,
      skipped: 0,
      batch: {
        batch_id: manifest.batchId,
        lease_owner: manifest.leaseOwner,
        lease_expires_at: "2026-08-01T00:00:00.000Z",
        items: [],
      },
    });
  }
  throw new Error("unexpected mock fetch target: " + target);
};
`,
      );
      const env = {
        ...process.env,
        CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
        EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
        EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
        EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
        BATCH_CLI_COMPLETION: completionPath,
        BATCH_CLI_SCENARIO: failureCase.scenario,
      };
      const commitResult = spawnSync(
        process.execPath,
        ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "commit"],
        { cwd: process.cwd(), encoding: "utf8", env },
      );
      assert.equal(commitResult.status, 0, commitResult.stderr);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        outcomes: Array<{
          outcome: string;
          reasonCode: string;
          errorFingerprint: string;
        }>;
      };
      assert.equal(receipt.outcomes.length, 1);
      assert.equal(receipt.outcomes[0]?.outcome, failureCase.publicationOutcome);
      assert.equal(receipt.outcomes[0]?.reasonCode, failureCase.reasonCode);
      assert.match(receipt.outcomes[0]?.errorFingerprint ?? "", /^[a-f0-9]{64}$/);

      const completeResult = spawnSync(
        process.execPath,
        ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "complete"],
        { cwd: process.cwd(), encoding: "utf8", env },
      );
      assert.equal(completeResult.status, 0, completeResult.stderr);
      assert.deepEqual(JSON.parse(readFileSync(completionPath, "utf8")).items, [
        {
          item_key: member.itemKey,
          revision: member.revision,
          claim_generation: member.claimGeneration,
          terminal_outcome: failureCase.terminalOutcome,
          reason_code: failureCase.reasonCode,
          error_fingerprint: receipt.outcomes[0]?.errorFingerprint,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("batch publication fingerprints distinct direct-plan rejection details separately", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-publication-details-"));
  try {
    const member = batchMember("openclaw/openclaw#806@publish:8060:1", 806);
    const outcomePath = join(root, "eligible.json");
    const manifestPath = join(root, "manifest.json");
    const preloadPath = join(root, "fetch-preload.cjs");
    writeFileSync(
      outcomePath,
      JSON.stringify({
        kind: "eligible",
        plan: mutationPlan(member),
        postEffectsComplete: true,
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        batchId: "batch-publication-rejection-details",
        leaseOwner: "proof-worker",
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        configuredBatchSize: 1,
        batchWaitMs: 0,
        items: [{ ...member, outcomePath }],
      }),
    );
    writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.EXACT_REVIEW_BATCH_MANIFEST, "utf8"));
const wireItems = manifest.items.map((item) => ({ item_key: item.itemKey, revision: item.revision, claim_generation: item.claimGeneration, decision: item.decision }));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.setTimeout = (callback, _delay, ...args) => {
  queueMicrotask(() => callback(...args));
  return 0;
};
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.endsWith("/publication-batches/fetch")) {
    return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: wireItems }, items: wireItems, superseded: 0 });
  }
  if (target.endsWith("/publication-batches/heartbeat")) {
    return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-01T00:00:00.000Z", items: wireItems } });
  }
  if (target.endsWith("/publication-batch-results")) {
    return response({ error: "invalid_direct_publication_plan", fallback_required: true, detail: process.env.BATCH_CLI_DETAIL }, 400);
  }
  throw new Error("unexpected mock fetch target: " + target);
};
`,
    );

    const fingerprintFor = (detail: string, suffix: string) => {
      const receiptPath = join(root, `receipt-${suffix}.json`);
      const result = spawnSync(
        process.execPath,
        ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "commit"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
            EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
            EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
            EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
            BATCH_CLI_DETAIL: detail,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        outcomes: Array<{ errorFingerprint: string }>;
      };
      const fingerprint = receipt.outcomes[0]?.errorFingerprint ?? "";
      assert.match(fingerprint, /^[a-f0-9]{64}$/);
      return fingerprint;
    };

    const invalidRevision = fingerprintFor("invalid direct publication revision", "revision");
    const outsidePath = fingerprintFor(
      "direct publication path is outside openclaw-openclaw#806",
      "path",
    );
    assert.notEqual(invalidRevision, outsidePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch completion forwards one quota circuit and marks collapsed members unattempted", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-quota-"));
  try {
    const attempted = batchMember("openclaw/openclaw#811@publish:8110:1", 811);
    const collapsed = batchMember("openclaw/openclaw#812@publish:8120:1", 812);
    const attemptedOutcome = join(root, "attempted.json");
    const collapsedOutcome = join(root, "collapsed.json");
    const manifestPath = join(root, "manifest.json");
    const receiptPath = join(root, "receipt.json");
    const completionPath = join(root, "completion.json");
    const observationsPath = join(root, "github-rate-limits.jsonl");
    const metricsPath = join(root, "github-request-metrics.jsonl");
    const preloadPath = join(root, "fetch-preload.cjs");
    const retryAt = "2026-08-10T15:00:00.000Z";
    writeFileSync(
      attemptedOutcome,
      JSON.stringify({
        kind: "retryable_failure",
        reasonCode: "github_rate_limit",
        rateLimitScope: "repository_actions",
        retryAt,
        attempted: true,
      }),
    );
    writeFileSync(
      collapsedOutcome,
      JSON.stringify({
        kind: "retryable_failure",
        reasonCode: "github_rate_limit",
        rateLimitScope: "repository_actions",
        retryAt,
        attempted: false,
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        batchId: "batch-quota-collapse",
        leaseOwner: "proof-worker",
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        configuredBatchSize: 2,
        batchWaitMs: 0,
        items: [
          { ...attempted, outcomePath: attemptedOutcome },
          { ...collapsed, outcomePath: collapsedOutcome },
        ],
      }),
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({
        batchId: "batch-quota-collapse",
        publishedItemKeys: [],
        outcomes: [],
      }),
    );
    writeFileSync(
      observationsPath,
      `${JSON.stringify({
        scope: "repository_actions",
        observed_at: "2026-08-10T14:50:00.000Z",
        retry_at: retryAt,
        provenance: "rate_limit_status",
        authoritative: true,
      })}\n`,
    );
    writeFileSync(
      metricsPath,
      `${JSON.stringify({
        scope: "repository_actions",
        category: "item_metadata",
        mode: "read",
        outcome: "throttle",
        repeat_revision: false,
        count: 1,
      })}\n`,
    );
    writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.EXACT_REVIEW_BATCH_MANIFEST, "utf8"));
const wireItems = manifest.items.map((item) => ({ item_key: item.itemKey, revision: item.revision, claim_generation: item.claimGeneration, decision: item.decision }));
globalThis.fetch = async (url, init) => {
  const target = String(url);
  const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  if (target.endsWith("/publication-batches/fetch")) return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-10T16:00:00.000Z", items: wireItems }, items: wireItems, superseded: 0 });
  if (target.endsWith("/publication-batches/complete")) {
    fs.writeFileSync(process.env.BATCH_CLI_COMPLETION, init.body);
    return response({ accepted: 2, skipped: 0, telemetry_accepted: true, batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-10T16:00:00.000Z", items: [] } });
  }
  throw new Error("unexpected mock fetch target: " + target);
};
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "complete"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
          EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
          EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
          CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observationsPath,
          CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH: metricsPath,
          BATCH_CLI_COMPLETION: completionPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const completion = JSON.parse(readFileSync(completionPath, "utf8"));
    assert.deepEqual(completion.items, [
      {
        item_key: attempted.itemKey,
        revision: attempted.revision,
        claim_generation: attempted.claimGeneration,
        terminal_outcome: "retryable_failure",
        reason_code: "github_rate_limit",
        pool_class: "repository_actions",
        retry_at: retryAt,
      },
      {
        item_key: collapsed.itemKey,
        revision: collapsed.revision,
        claim_generation: collapsed.claimGeneration,
        terminal_outcome: "retryable_failure",
        reason_code: "github_rate_limit",
        pool_class: "repository_actions",
        retry_at: retryAt,
        attempted: false,
      },
    ]);
    assert.equal(completion.github_rate_limit_observations.length, 1);
    assert.deepEqual(completion.github_request_metrics, [
      {
        scope: "repository_actions",
        category: "item_metadata",
        mode: "read",
        outcome: "throttle",
        repeat_revision: false,
        count: 1,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const command of ["complete", "release"] as const) {
  test(`batch ${command} preserves a target-app circuit on a fallback completion`, () => {
    const root = mkdtempSync(join(tmpdir(), `clawsweeper-batch-cli-${command}-scope-`));
    try {
      const member = batchMember(`openclaw/openclaw#814@publish:8140:1`, 814);
      const manifestPath = join(root, "manifest.json");
      const receiptPath = join(root, "receipt.json");
      const completionPath = join(root, "completion.json");
      const observationsPath = join(root, "github-rate-limits.jsonl");
      const preloadPath = join(root, "fetch-preload.cjs");
      const retryAt = new Date(Date.now() + 60_000).toISOString();
      writeFileSync(
        manifestPath,
        JSON.stringify({
          batchId: `batch-${command}-target-app-scope`,
          leaseOwner: "proof-worker",
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
          configuredBatchSize: 1,
          batchWaitMs: 0,
          items: [{ ...member, outcomePath: join(root, "missing-outcome.json") }],
        }),
      );
      writeFileSync(
        receiptPath,
        JSON.stringify({
          batchId: `batch-${command}-target-app-scope`,
          publishedItemKeys: [],
          outcomes: [],
        }),
      );
      writeFileSync(
        observationsPath,
        `${JSON.stringify({
          scope: "target_app",
          target_owner: "scope-proof",
          observed_at: new Date().toISOString(),
          retry_at: retryAt,
          provenance: "retry_after",
          authoritative: true,
        })}\n`,
      );
      writeFileSync(
        preloadPath,
        `const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.env.EXACT_REVIEW_BATCH_MANIFEST, "utf8"));
const wireItems = manifest.items.map((item) => ({ item_key: item.itemKey, revision: item.revision, claim_generation: item.claimGeneration, decision: item.decision }));
const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith("/publication-batches/fetch")) return response({ batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-10T16:00:00.000Z", items: wireItems }, items: wireItems, superseded: 0 });
  if (target.endsWith("/publication-batches/complete")) {
    fs.writeFileSync(process.env.BATCH_CLI_COMPLETION, init.body);
    return response({ accepted: 1, skipped: 0, telemetry_accepted: true, batch: { batch_id: manifest.batchId, lease_owner: manifest.leaseOwner, lease_expires_at: "2026-08-10T16:00:00.000Z", items: [] } });
  }
  throw new Error("unexpected mock fetch target: " + target);
};
`,
      );
      const result = spawnSync(
        process.execPath,
        ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", command],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
            EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
            EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
            EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
            CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observationsPath,
            BATCH_CLI_COMPLETION: completionPath,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const completion = JSON.parse(readFileSync(completionPath, "utf8"));
      assert.deepEqual(completion.items, [
        {
          item_key: member.itemKey,
          revision: member.revision,
          claim_generation: member.claimGeneration,
          terminal_outcome: "retryable_failure",
          reason_code: "github_rate_limit",
          pool_class: "target_app",
          retry_at: retryAt,
          attempted: false,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("batch completion forwards telemetry appended after an earlier acknowledgement", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-late-telemetry-"));
  try {
    const member = batchMember("openclaw/openclaw#813@publish:8130:1", 813);
    const outcomePath = join(root, "outcome.json");
    const manifestPath = join(root, "manifest.json");
    const receiptPath = join(root, "receipt.json");
    const completionPath = join(root, "completion.jsonl");
    const observationsPath = join(root, "github-rate-limits.jsonl");
    const metricsPath = join(root, "github-request-metrics.jsonl");
    const preloadPath = join(root, "fetch-preload.cjs");
    const firstRetryAt = "2026-08-10T15:00:00.000Z";
    const lateRetryAt = "2026-08-10T15:30:00.000Z";
    writeFileSync(
      outcomePath,
      JSON.stringify({
        kind: "retryable_failure",
        reasonCode: "github_rate_limit",
        retryAt: firstRetryAt,
      }),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify({
        batchId: "batch-late-telemetry",
        leaseOwner: "proof-worker",
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        configuredBatchSize: 1,
        batchWaitMs: 0,
        items: [{ ...member, outcomePath }],
      }),
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({ batchId: "batch-late-telemetry", publishedItemKeys: [], outcomes: [] }),
    );
    writeFileSync(
      observationsPath,
      `${JSON.stringify({ scope: "repository_actions", observed_at: "2026-08-10T14:50:00.000Z", retry_at: firstRetryAt, provenance: "rate_limit_status", authoritative: true })}\n`,
    );
    writeFileSync(
      metricsPath,
      `${JSON.stringify({ scope: "repository_actions", category: "artifact_download", mode: "read", outcome: "throttle", repeat_revision: false, count: 1 })}\n`,
    );
    writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/publication-batches/fetch")) {
    return new Response(JSON.stringify({ batch: { batch_id: "batch-late-telemetry", lease_owner: "proof-worker", lease_expires_at: "2026-08-10T16:00:00.000Z", items: [] }, items: [], superseded: 0 }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (!String(url).endsWith("/publication-batches/complete")) throw new Error("unexpected mock fetch target: " + url);
  fs.appendFileSync(process.env.BATCH_CLI_COMPLETION, init.body + "\\n");
  return new Response(JSON.stringify({ accepted: 1, skipped: 0, telemetry_accepted: true, batch: { batch_id: "batch-late-telemetry", lease_owner: "proof-worker", lease_expires_at: "2026-08-10T16:00:00.000Z", items: [] } }), { status: 200, headers: { "content-type": "application/json" } });
};
`,
    );
    const runCompletion = () =>
      spawnSync(
        process.execPath,
        ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "complete"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
            EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
            EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
            EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
            CLAWSWEEPER_GITHUB_RATE_LIMIT_OBSERVATION_PATH: observationsPath,
            CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH: metricsPath,
            BATCH_CLI_COMPLETION: completionPath,
          },
        },
      );
    const first = runCompletion();
    assert.equal(first.status, 0, first.stderr);
    appendFileSync(
      observationsPath,
      `${JSON.stringify({ scope: "target_app", target_owner: "late-owner", observed_at: "2026-08-10T15:05:00.000Z", retry_at: lateRetryAt, provenance: "retry_after", authoritative: true })}\n`,
    );
    appendFileSync(
      metricsPath,
      `${JSON.stringify({ scope: "target_app", category: "workflow_dispatch", mode: "mutation_or_private_read", outcome: "throttle", repeat_revision: false, count: 1 })}\n`,
    );
    const second = runCompletion();
    assert.equal(second.status, 0, second.stderr);
    const completions = readFileSync(completionPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(completions.length, 2);
    assert.deepEqual(completions[1].github_rate_limit_observations, [
      {
        scope: "target_app",
        target_owner: "late-owner",
        observed_at: "2026-08-10T15:05:00.000Z",
        retry_at: lateRetryAt,
        provenance: "retry_after",
        authoritative: true,
      },
    ]);
    assert.deepEqual(completions[1].github_request_metrics, [
      {
        scope: "target_app",
        category: "workflow_dispatch",
        mode: "mutation_or_private_read",
        outcome: "throttle",
        repeat_revision: false,
        count: 1,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("router request metrics retain successful repeated-revision state", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-router-metric-"));
  try {
    const manifestPath = join(root, "manifest.json");
    const metricsPath = join(root, "github-request-metrics.jsonl");
    writeFileSync(manifestPath, "{}");
    const result = spawnSync(
      process.execPath,
      ["dist/repair/exact-review-batch-cli.js", "request-metric"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
          EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
          CLAWSWEEPER_GITHUB_REQUEST_METRICS_PATH: metricsPath,
          EXACT_REVIEW_GITHUB_RATE_LIMIT_SCOPE: "repository_actions",
          EXACT_REVIEW_GITHUB_REQUEST_OUTCOME: "success",
          EXACT_REVIEW_GITHUB_REQUEST_REPEAT: "true",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(metricsPath, "utf8")), {
      scope: "repository_actions",
      category: "workflow_dispatch",
      mode: "mutation_or_private_read",
      outcome: "success",
      repeat_revision: true,
      count: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch release retains a committed eligible member until lifecycle post-effects complete", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-release-"));
  try {
    const member = batchMember("openclaw/openclaw#803@publish:8030:1", 803);
    const outcomePath = join(root, "eligible.json");
    const manifestPath = join(root, "manifest.json");
    const receiptPath = join(root, "receipt.json");
    const completionPath = join(root, "completion.json");
    const preloadPath = join(root, "fetch-preload.cjs");
    writeFileSync(outcomePath, JSON.stringify({ kind: "eligible", plan: mutationPlan(member) }));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        batchId: "batch-release-proof",
        leaseOwner: "proof-worker",
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        configuredBatchSize: 1,
        batchWaitMs: 0,
        items: [{ ...member, outcomePath }],
      }),
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({
        batchId: "batch-release-proof",
        publishedItemKeys: [member.itemKey],
        outcomes: [],
      }),
    );
    writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  if (!String(url).endsWith("/publication-batches/complete")) throw new Error("unexpected mock fetch target: " + url);
  fs.writeFileSync(process.env.BATCH_CLI_COMPLETION, init.body);
  return response({
    accepted: 1,
    skipped: 0,
    batch: {
      batch_id: "batch-release-proof",
      lease_owner: "proof-worker",
      lease_expires_at: "2026-08-01T00:00:00.000Z",
      items: [],
    },
  });
};
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "release"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
          EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
          EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
          BATCH_CLI_COMPLETION: completionPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const completion = JSON.parse(readFileSync(completionPath, "utf8")) as {
      items: Array<{ terminal_outcome: string; reason_code: string }>;
    };
    assert.deepEqual(completion.items, [
      {
        item_key: member.itemKey,
        revision: member.revision,
        claim_generation: member.claimGeneration,
        terminal_outcome: "retryable_failure",
        reason_code: "workflow_cancelled",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch release preserves a permanent canonical receipt before lifecycle post-effects", () => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-batch-cli-permanent-"));
  try {
    const member = batchMember("openclaw/openclaw#804@publish:8040:1", 804);
    const outcomePath = join(root, "eligible.json");
    const manifestPath = join(root, "manifest.json");
    const receiptPath = join(root, "receipt.json");
    const completionPath = join(root, "completion.json");
    const preloadPath = join(root, "fetch-preload.cjs");
    const fingerprint = "a".repeat(64);
    writeFileSync(outcomePath, JSON.stringify({ kind: "eligible", plan: mutationPlan(member) }));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        batchId: "batch-permanent-proof",
        leaseOwner: "proof-worker",
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        configuredBatchSize: 1,
        batchWaitMs: 0,
        items: [{ ...member, outcomePath }],
      }),
    );
    writeFileSync(
      receiptPath,
      JSON.stringify({
        batchId: "batch-permanent-proof",
        publishedItemKeys: [],
        outcomes: [
          {
            canonicalTargetKey: "openclaw/openclaw#804",
            fenceKey: member.itemKey,
            revision: member.revision,
            claimGeneration: member.claimGeneration,
            outcome: "permanent",
            reasonCode: "tuple_protocol_invalid",
            errorFingerprint: fingerprint,
          },
        ],
      }),
    );
    writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
const response = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url, init) => {
  if (!String(url).endsWith("/publication-batches/complete")) throw new Error("unexpected mock fetch target: " + url);
  fs.writeFileSync(process.env.BATCH_CLI_COMPLETION, init.body);
  return response({
    accepted: 1,
    skipped: 0,
    batch: {
      batch_id: "batch-permanent-proof",
      lease_owner: "proof-worker",
      lease_expires_at: "2026-08-01T00:00:00.000Z",
      items: [],
    },
  });
};
`,
    );
    const result = spawnSync(
      process.execPath,
      ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", "release"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
          EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
          EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
          EXACT_REVIEW_BATCH_RECEIPT: receiptPath,
          BATCH_CLI_COMPLETION: completionPath,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(completionPath, "utf8")).items, [
      {
        item_key: member.itemKey,
        revision: member.revision,
        claim_generation: member.claimGeneration,
        terminal_outcome: "permanent_failure",
        reason_code: "tuple_protocol_invalid",
        error_fingerprint: fingerprint,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function batchMember(itemKey: string, itemNumber: number) {
  return {
    itemKey,
    revision: 1,
    claimGeneration: 1,
    decision: {
      targetRepo: "openclaw/openclaw",
      itemNumber,
    },
  };
}

function mutationPlan(member: ReturnType<typeof batchMember>) {
  const canonicalTargetKey = `openclaw/openclaw#${member.decision.itemNumber}`;
  return {
    identity: {
      itemKey: member.itemKey,
      revision: member.revision,
      claimGeneration: member.claimGeneration,
    },
    publication: {
      canonicalTargetKey,
      fenceKey: member.itemKey,
    },
    operations: [
      {
        path: `records/openclaw-openclaw/items/${member.decision.itemNumber}.md`,
        deleted: false,
        mode: "100644",
        bytes: 1,
        contentBase64: "eA==",
      },
    ],
    totalBytes: 1,
  };
}

for (const [route, endpoint] of [
  ["enqueue", "/internal/exact-review/enqueue"],
  ["router-receipt", "/internal/exact-review/lifecycle/router-receipt"],
  ["terminal-disposition", "/internal/exact-review/lifecycle/terminal-disposition"],
]) {
  for (const [scenario, statuses, exitCode, expectedAttempts] of [
    ["fails after the first 500 in a recovery sequence", [500, 200], 1, 1],
    ["fails after the first 500 in a repeated failure sequence", [500, 500, 500], 1, 1],
    ["fails immediately on 409", [409], 1, 1],
  ]) {
    test(`batch post-effect ${route} ${scenario}`, () => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-post-effect-"));
      try {
        const payloadPath = join(root, "payload.json");
        const postsPath = join(root, "posts.jsonl");
        const preloadPath = join(root, "fetch-preload.cjs");
        const payload = '{ "receipt_id": "stable-fixture", "kind": "policy_noop" }\n';
        writeFileSync(payloadPath, payload);
        writeFileSync(
          preloadPath,
          `
const fs = require("node:fs");
const statuses = ${JSON.stringify(statuses)};
let index = 0;
Math.random = () => 0;
globalThis.fetch = async (url, init) => {
  fs.appendFileSync(${JSON.stringify(postsPath)}, JSON.stringify({ url, body: init.body, headers: init.headers }) + "\\n");
  const status = statuses[index++];
  if (!status) throw new Error("unexpected extra request");
  return new Response(JSON.stringify(status === 200 ? { ok: true, queued: true } : { error: "exact_review_queue_unavailable" }), { status });
};
`,
        );
        const result = spawnSync(
          process.execPath,
          [
            "--require",
            preloadPath,
            "dist/repair/exact-review-batch-cli.js",
            "post-effect",
            "--route",
            route,
            "--payload",
            payloadPath,
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 10_000,
            env: {
              ...process.env,
              CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
              EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
            },
          },
        );
        const posts = existsSync(postsPath)
          ? readFileSync(postsPath, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [];
        assert.equal(posts.length, expectedAttempts, result.stderr);
        assert.equal(result.status, exitCode, result.stderr);
        assert.equal(result.stdout, "");
        assert.ok(posts.every((post) => post.url === `https://queue.example.test${endpoint}`));
        assert.ok(posts.every((post) => post.body === payload));
        assert.ok(
          posts.every((post) => JSON.stringify(post.headers) === JSON.stringify(posts[0].headers)),
        );
        assert.ok(
          posts.every(
            (post) =>
              post.headers["x-clawsweeper-exact-review-signature"] ===
              `sha256=${createHmac("sha256", "proof-secret").update(payload).digest("hex")}`,
          ),
        );
        assert.doesNotMatch(result.stderr, /proof-secret|stable-fixture|sha256=/);
        if (statuses[0] === 500) {
          assert.match(result.stderr, /HTTP 500/);
          assert.doesNotMatch(result.stderr, /Batch queue retry/);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const scenario of [
  {
    name: "rejects exhausted 5xx after server TTL with runner five minutes behind",
    response: 500,
    leaseMs: 20_000,
    attemptMs: 7_000,
    clockSkewMs: -300_000,
    source: "server",
  },
  {
    name: "tolerates exhausted 5xx within server TTL with runner five minutes ahead",
    response: 500,
    leaseMs: 240_000,
    clockSkewMs: 300_000,
    source: "server",
    tolerated: true,
  },
  {
    name: "rejects local fallback even with an ample lease",
    response: 500,
    leaseMs: 1_200_000,
    source: "local",
  },
  {
    name: "rejects local fallback older than one safety margin",
    response: 500,
    leaseMs: 1_200_000,
    source: "local",
    confirmationAgeMs: 180_001,
  },
  {
    name: "rejects local fallback that ages past the margin during retries",
    response: 500,
    leaseMs: 1_200_000,
    source: "local",
    confirmationAgeMs: 179_000,
  },
  {
    name: "tolerates exhausted 5xx with ample lease",
    response: 500,
    leaseMs: 1_200_000,
    tolerated: true,
  },
  {
    name: "tolerates network failure with ample lease",
    response: "network",
    leaseMs: 1_200_000,
    tolerated: true,
  },
  {
    name: "tolerates timeout with ample lease",
    response: "timeout",
    leaseMs: 1_200_000,
    tolerated: true,
  },
  { name: "fails on 5xx inside the safety margin", response: 500, leaseMs: 180_000 },
  { name: "fails on 5xx at the safety margin after retries", response: 500, leaseMs: 183_000 },
  { name: "fails on 409 despite ample lease", response: 409, leaseMs: 1_200_000 },
  { name: "fails on 401 despite ample lease", response: 401, leaseMs: 1_200_000 },
  { name: "fails on invalid success despite ample lease", response: "invalid", leaseMs: 1_200_000 },
  { name: "fails on expired lease", response: 500, leaseMs: -1 },
  { name: "honors a larger safety margin", response: 500, leaseMs: 1_200_000, safetyMs: "1500000" },
  {
    name: "honors a smaller safety margin",
    response: 500,
    leaseMs: 120_000,
    safetyMs: "60000",
    tolerated: true,
  },
  {
    name: "keeps strict heartbeat failures fatal",
    response: 500,
    leaseMs: 1_200_000,
    strict: true,
  },
  { name: "refreshes the confirmed lease on success", response: 200, leaseMs: 1_200_000 },
]) {
  test(`batch heartbeat lease tolerance ${scenario.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-heartbeat-tolerance-"));
    try {
      const manifestPath = join(root, "manifest.json");
      const preloadPath = join(root, "fetch-preload.cjs");
      const requestsPath = join(root, "requests.jsonl");
      const baseTime = Date.UTC(2026, 8, 3);
      const localTime = baseTime + (scenario.clockSkewMs ?? 0);
      const confirmationAgeMs = scenario.confirmationAgeMs ?? 0;
      const manifest = {
        batchId: "lease-proof",
        leaseOwner: "proof-worker",
        leaseExpiresAt: new Date(baseTime + scenario.leaseMs).toISOString(),
        leaseTtlMs: scenario.leaseMs + confirmationAgeMs,
        leaseTtlSource: scenario.source ?? "server",
        leaseConfirmedAtLocal: localTime - confirmationAgeMs,
        configuredBatchSize: 1,
        batchWaitMs: 0,
        items: [],
      };
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(
        preloadPath,
        `
const { appendFileSync } = require("node:fs");
const baseTime = ${baseTime};
let attempts = 0;
Date.now = () => ${localTime} + attempts * ${scenario.attemptMs ?? 1_000};
Math.random = () => 0;
globalThis.fetch = async (url) => {
  appendFileSync(${JSON.stringify(requestsPath)}, JSON.stringify({ url: String(url), attempt: ++attempts }) + "\\n");
  const response = ${JSON.stringify(scenario.response)};
  if (response === "network") throw new TypeError("private transport details");
  if (response === "timeout") throw new DOMException("private timeout details", "TimeoutError");
  if (response === "invalid") return new Response("not json", { status: 200 });
  if (response !== 200) return Response.json({ error: "exact_review_queue_unavailable" }, { status: response });
  return Response.json({ batch: { batch_id: "lease-proof", lease_owner: "proof-worker", items: [], lease_expires_at: new Date(baseTime + 1800000).toISOString() } });
};
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--require",
          preloadPath,
          "dist/repair/exact-review-batch-cli.js",
          "heartbeat",
          ...(scenario.strict ? [] : ["--tolerate-until-lease"]),
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
            EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
            EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
            EXACT_REVIEW_BATCH_HEARTBEAT_SAFETY_MS: scenario.safetyMs ?? "180000",
          },
        },
      );
      const requests = existsSync(requestsPath)
        ? readFileSync(requestsPath, "utf8").trim().split("\n")
        : [];
      const retryable = [500, "network", "timeout"].includes(scenario.response);
      assert.equal(requests.length, scenario.leaseMs < 0 ? 0 : retryable ? 3 : 1, result.stderr);
      assert.equal(
        result.status,
        scenario.tolerated || scenario.response === 200 ? 0 : 1,
        result.stderr,
      );
      const stored = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (scenario.response === 200) {
        assert.equal(stored.leaseExpiresAt, new Date(baseTime + 1_800_000).toISOString());
        assert.deepEqual(JSON.parse(result.stdout), { ok: true, batch_id: manifest.batchId });
      } else {
        assert.deepEqual(stored, manifest);
        if (scenario.tolerated) {
          assert.equal(result.stdout.trim().split("\n").length, 1);
          assert.deepEqual(JSON.parse(result.stdout), {
            ok: false,
            tolerated: true,
            remaining_ms: scenario.leaseMs - 3_000,
            reason:
              scenario.response === 500
                ? "HTTP_500"
                : scenario.response === "network"
                  ? "network_error"
                  : "timeout",
          });
        } else {
          assert.equal(result.stdout, "");
        }
      }
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /proof-secret|private transport details|private timeout details/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const source of ["server", "local"]) {
  test(`batch claim, heartbeat, and observe persist the confirmed ${source} TTL`, () => {
    const root = mkdtempSync(join(tmpdir(), "clawsweeper-lease-expiry-"));
    try {
      const manifestPath = join(root, "manifest.json");
      const preloadPath = join(root, "fetch-preload.cjs");
      const baseTime = Date.UTC(2026, 8, 2);
      writeFileSync(
        preloadPath,
        `
const baseTime = ${baseTime};
const localTime = baseTime - 300000 + (process.env.CONFIRMATION_ADVANCE_MS ? 1000 : 0);
Date.now = () => localTime;
Math.random = () => 0;
let attempt = 0;
globalThis.fetch = async (url, init) => {
  const command = process.argv[2];
  const batch = { batch_id: "lease-proof", lease_owner: "proof-worker", items: [], lease_expires_at: new Date(baseTime + (command === "claim" ? 60000 : command === "heartbeat" ? 120000 : 180000)).toISOString() };
  if (${JSON.stringify(source)} === "server") batch.server_time = new Date(baseTime + (process.env.CONFIRMATION_ADVANCE_MS ? 1000 : 0)).toISOString();
  if (String(url).endsWith("/claim")) return Response.json({ claimed: true, batch, configured_batch_size: 1, batch_wait_ms: 0 });
  if (String(url).endsWith("/fetch")) return Response.json({ batch, items: [], superseded: 0 });
  if (String(url).endsWith("/heartbeat")) {
    if (++attempt === 1) return new Response("exact_review_queue_unavailable", { status: 500 });
    return Response.json({ batch });
  }
  throw new Error("unexpected request");
};
`,
      );
      for (const [command, expectedExpiry, advanceMs] of [
        ["claim", 60_000, 0],
        ["heartbeat", 120_000, 0],
        ["observe", 180_000, 0],
        ["observe", 180_000, 1_000],
      ]) {
        const result = spawnSync(
          process.execPath,
          ["--require", preloadPath, "dist/repair/exact-review-batch-cli.js", command],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            timeout: 5_000,
            env: {
              ...process.env,
              CLAWSWEEPER_WEBHOOK_SECRET: "proof-secret",
              EXACT_REVIEW_QUEUE_URL: "https://queue.example.test",
              EXACT_REVIEW_BATCH_ID: "lease-proof",
              EXACT_REVIEW_BATCH_LEASE_OWNER: "proof-worker",
              EXACT_REVIEW_BATCH_MAX_ITEMS: "1",
              EXACT_REVIEW_BATCH_MANIFEST: manifestPath,
              EXACT_REVIEW_BATCH_OBSERVATION: "preparation_started",
              GITHUB_OUTPUT: join(root, "github-output"),
              CONFIRMATION_ADVANCE_MS: advanceMs ? String(advanceMs) : "",
            },
          },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          JSON.parse(readFileSync(manifestPath, "utf8")).leaseExpiresAt,
          new Date(baseTime + expectedExpiry).toISOString(),
        );
        const saved = JSON.parse(readFileSync(manifestPath, "utf8"));
        assert.equal(
          saved.leaseTtlMs,
          expectedExpiry + (source === "local" ? 300_000 : 0) - advanceMs,
        );
        assert.equal(saved.leaseTtlSource, source);
        assert.equal(saved.leaseConfirmedAtLocal, baseTime - 300_000 + advanceMs);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
