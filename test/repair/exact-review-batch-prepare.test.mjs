import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";

import { runBoundedPool } from "../../scripts/prepare-exact-review-batch.mjs";
import {
  packExactReviewBundle,
  unpackExactReviewBundle,
} from "../../scripts/exact-review-artifact-cache.mjs";

test("bounded preparation pool respects the configured concurrency", async () => {
  let active = 0;
  let peak = 0;
  const result = await runBoundedPool([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.equal(peak, 2);
  assert.equal(result.peak, 2);
  assert.deepEqual(result.results, [2, 4, 6, 8, 10]);
});

test("artifact cache archive round-trips exact file bytes deterministically", () => {
  const root = mkdtempSync(join(tmpdir(), "exact-review-artifact-archive-"));
  const source = join(root, "source");
  const restored = join(root, "restored");
  try {
    mkdirSync(join(source, "review"), { recursive: true });
    mkdirSync(join(source, "metadata"), { recursive: true });
    writeFileSync(join(source, "review", "42.md"), Buffer.from([0, 1, 2, 10, 255]));
    writeFileSync(join(source, "metadata", "bundle.json"), '{"version":2}\n');
    const first = packExactReviewBundle(source);
    const second = packExactReviewBundle(source);
    assert.deepEqual(first, second);
    unpackExactReviewBundle(first, restored);
    assert.deepEqual(
      readFileSync(join(restored, "review", "42.md")),
      Buffer.from([0, 1, 2, 10, 255]),
    );
    assert.equal(
      readFileSync(join(restored, "metadata", "bundle.json"), "utf8"),
      '{"version":2}\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("artifact cache archive rejects corrupted bytes before writing a bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "exact-review-artifact-corrupt-"));
  const source = join(root, "source");
  const restored = join(root, "restored");
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "bundle.txt"), "authoritative bytes\n");
    const archive = packExactReviewBundle(source);
    archive[archive.length - 1] ^= 0xff;
    assert.throws(() => unpackExactReviewBundle(archive, restored), /file digest mismatch/);
    assert.equal(readFileSync(source + "/bundle.txt", "utf8"), "authoritative bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("batch preparation publishes without invoking the retired live-proof CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "exact-review-invalid-live-proof-"));
  const workspace = join(root, "workspace");
  const workerRoot = join(root, "worker");
  const bin = join(root, "bin");
  const outcomePath = join(workspace, ".artifacts", "exact-review-batch", "outcomes", "item.json");
  const itemPath = join(root, "item.json");
  const secret = "synthetic-test-secret";
  const requests = [];
  const server = createServer((req, res) => {
    if (req.url === "/internal/exact-review/artifact-cache/receipt/lookup") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hit: false }));
      return;
    }
    if (req.url.startsWith("/internal/state/blobs/")) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "fixture_cache_unavailable" }));
      return;
    }
    assert.equal(req.method, "GET");
    assert.match(
      req.url,
      /^\/internal\/state\/records\/openclaw-openclaw\/(items|closed|plans|decision-packets)\/42$/,
    );
    assert.equal(
      req.headers["x-clawsweeper-exact-review-signature"],
      `sha256=${createHmac("sha256", secret).update("").digest("hex")}`,
    );
    requests.push(req.url);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "record_not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    mkdirSync(join(workspace, "dist", "repair"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const output = process.argv[process.argv.indexOf("--dir") + 1];
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "bundle.json"), "{}");
`,
      "utf8",
    );
    chmodSync(join(bin, "gh"), 0o755);
    writeFileSync(
      join(workspace, "dist", "repair", "exact-review-bundle-cli.js"),
      "process.exitCode = 0;\n",
      "utf8",
    );
    writeFileSync(
      join(workspace, "dist", "clawsweeper.js"),
      'console.log(JSON.stringify({ status: "invalid_artifact" })); process.exitCode = 1;\n',
      "utf8",
    );
    writeFileSync(
      join(workspace, "dist", "repair", "publish-event-result.js"),
      'require("node:fs").writeFileSync(process.env.EXACT_REVIEW_BATCH_MUTATION_OUTPUT, JSON.stringify({ kind: "fixture_published" }));\n',
      "utf8",
    );
    writeFileSync(
      itemPath,
      JSON.stringify({
        outcomePath: ".artifacts/exact-review-batch/outcomes/item.json",
        itemKey: "openclaw/openclaw#42@publish:123:1",
        revision: 1,
        claimGeneration: 1,
        decision: {
          targetRepo: "openclaw/openclaw",
          targetBranch: "main",
          itemNumber: 42,
          itemKind: "pull_request",
          publication: {
            artifactName: "exact-review-123-1",
            producerRunId: 123,
            producerRunAttempt: 1,
            sourceSha: "a".repeat(40),
            itemKey: "openclaw/openclaw#42",
            protocolVersion: 2,
            leaseRevision: 1,
            claimGeneration: 1,
            liveProceeded: true,
            liveTerminalNoop: false,
            liveTerminalMissing: false,
            liveGuardedOpen: false,
            producerDecision: {
              targetRepo: "openclaw/openclaw",
              targetBranch: "main",
              itemNumber: 42,
              itemKind: "pull_request",
              sourceEvent: "pull_request",
              sourceAction: "opened",
            },
          },
        },
      }),
      "utf8",
    );

    const child = spawn(
      process.execPath,
      ["scripts/prepare-exact-review-batch.mjs", "worker", itemPath, workerRoot, workspace],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH || ""}`,
          GITHUB_REPOSITORY: "openclaw/clawsweeper",
          REPO_TOKEN: "test-token",
          EXACT_REVIEW_QUEUE_URL: `http://127.0.0.1:${server.address().port}`,
          CLAWSWEEPER_WEBHOOK_SECRET: secret,
        },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(status, 0, stderr);
    assert.equal(requests.length, 4);
    assert.deepEqual(JSON.parse(readFileSync(outcomePath, "utf8")), {
      kind: "fixture_published",
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
