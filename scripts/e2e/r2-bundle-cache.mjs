#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  packExactReviewBundle,
  publishExactReviewArtifact,
  restoreExactReviewArtifact,
  unpackExactReviewBundle,
} from "../exact-review-artifact-cache.mjs";

const baseUrl = requiredEnv("R2_BUNDLE_CACHE_WORKER_URL").replace(/\/+$/, "");
const webhookSecret = requiredEnv("R2_BUNDLE_CACHE_WEBHOOK_SECRET");
const persistTo = resolve(requiredEnv("R2_BUNDLE_CACHE_PERSIST_TO"));
const wranglerConfig = resolve(
  process.env.R2_BUNDLE_CACHE_WRANGLER_CONFIG || "dashboard/wrangler.toml",
);
const bucketName = process.env.R2_BUNDLE_CACHE_BUCKET || "clawsweeper-state-snapshots";
const root = mkdtempSync(join(tmpdir(), "clawsweeper-r2-bundle-proof-"));
const source = join(root, "source");
mkdirSync(join(source, "review"), { recursive: true });
mkdirSync(join(source, "metadata"), { recursive: true });
writeFileSync(
  join(source, "review", "81234.md"),
  "review_lease_owner: github:12001\nreview_lease_comment_id: 91\n",
);
writeFileSync(join(source, "metadata", "bundle.json"), '{"protocolVersion":2}\n');
const authoritativeArchive = packExactReviewBundle(source);
const authoritativeDigest = sha256(authoritativeArchive);
let githubArtifactRequests = 0;

const server = createServer((request, response) => {
  if (request.url !== "/artifact") {
    response.writeHead(404).end();
    return;
  }
  githubArtifactRequests += 1;
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(authoritativeArchive.byteLength),
  });
  response.end(authoritativeArchive);
});

try {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const artifactUrl = `http://127.0.0.1:${address.port}/artifact`;
  const tuple = {
    producer_run_id: "12001",
    producer_run_attempt: 2,
    artifact_name: "exact-review-12001-2",
    canonical_item_key: "openclaw/openclaw#81234",
    lease_revision: 7,
    protocol_version: 2,
  };

  const first = await acquire({ tuple, bundleDir: join(root, "first"), artifactUrl });
  assert.equal(first.source, "github");
  assert.equal(first.githubArtifactRequests, 1);
  assert.equal(first.digest, authoritativeDigest);

  const second = await acquire({ tuple, bundleDir: join(root, "second"), artifactUrl });
  assert.equal(second.source, "r2");
  assert.equal(second.githubArtifactRequests, 0);
  assert.equal(second.digest, first.digest);
  assert.deepEqual(
    readFileSync(join(root, "second", "review", "81234.md")),
    readFileSync(join(source, "review", "81234.md")),
  );

  deleteLocalR2Object(first.objectKey);
  const missingFallback = await acquire({
    tuple,
    bundleDir: join(root, "missing-fallback"),
    artifactUrl,
  });
  assert.equal(missingFallback.source, "github");
  assert.equal(missingFallback.githubArtifactRequests, 1);
  assert.equal(missingFallback.digest, authoritativeDigest);

  const leaseMismatch = await acquire({
    tuple: { ...tuple, lease_revision: tuple.lease_revision + 1 },
    bundleDir: join(root, "lease-mismatch"),
    artifactUrl,
  });
  assert.equal(leaseMismatch.source, "github");
  assert.equal(leaseMismatch.githubArtifactRequests, 1);
  assert.equal(leaseMismatch.digest, authoritativeDigest);

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        workerUrl: baseUrl,
        r2: { bucket: bucketName, semantics: "wrangler-dev-local" },
        first,
        second,
        missingFallback,
        leaseMismatch,
        totals: { githubArtifactRequests },
        counted: {
          repeatBefore: 1,
          repeatAfter: second.githubArtifactRequests,
          repeatReductionPercent: 100,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  rmSync(root, { recursive: true, force: true });
}

async function acquire({ tuple, bundleDir, artifactUrl }) {
  const before = githubArtifactRequests;
  const options = {
    baseUrl,
    webhookSecret,
    tuple,
    bundleDir,
    maxArchiveBytes: 4 * 1024 * 1024,
  };
  try {
    const restored = await restoreExactReviewArtifact(options);
    if (restored.hit) {
      validateBundle(bundleDir);
      return {
        source: "r2",
        digest: restored.digest,
        bytes: restored.bytes,
        objectKey: `artifacts/exact-review/v1/${restored.digest}`,
        githubArtifactRequests: githubArtifactRequests - before,
      };
    }
  } catch {
    rmSync(bundleDir, { recursive: true, force: true });
  }
  const response = await fetch(artifactUrl);
  assert.equal(response.status, 200);
  unpackExactReviewBundle(Buffer.from(await response.arrayBuffer()), bundleDir);
  validateBundle(bundleDir);
  const published = await publishExactReviewArtifact(options);
  return {
    source: "github",
    digest: published.digest,
    bytes: published.bytes,
    objectKey: published.objectKey,
    githubArtifactRequests: githubArtifactRequests - before,
  };
}

function validateBundle(bundleDir) {
  assert.equal(
    readFileSync(join(bundleDir, "review", "81234.md"), "utf8"),
    "review_lease_owner: github:12001\nreview_lease_comment_id: 91\n",
  );
  assert.equal(
    readFileSync(join(bundleDir, "metadata", "bundle.json"), "utf8"),
    '{"protocolVersion":2}\n',
  );
  assert.equal(sha256(packExactReviewBundle(bundleDir)), authoritativeDigest);
}

function deleteLocalR2Object(objectKey) {
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "wrangler@4.127.1",
      "r2",
      "object",
      "delete",
      `${bucketName}/${objectKey}`,
      "--config",
      wranglerConfig,
      "--local",
      "--persist-to",
      persistTo,
      "--force",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new Error(`local R2 eviction failed: ${result.stderr || result.stdout}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
