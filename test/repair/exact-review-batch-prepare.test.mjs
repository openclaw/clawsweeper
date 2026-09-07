import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

test("batch preparation refreshes deterministic invalid live-proof artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "exact-review-invalid-live-proof-"));
  const workspace = join(root, "workspace");
  const workerRoot = join(root, "worker");
  const bin = join(root, "bin");
  const outcomePath = join(workspace, ".artifacts", "exact-review-batch", "outcomes", "item.json");
  const itemPath = join(root, "item.json");
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

    const result = spawnSync(
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
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(outcomePath, "utf8")), {
      kind: "refresh_required",
      reasonCode: "invalid_artifact",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
