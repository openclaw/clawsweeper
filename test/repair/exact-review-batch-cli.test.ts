import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

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
