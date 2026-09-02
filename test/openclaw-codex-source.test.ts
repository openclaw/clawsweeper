import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPENCLAW_CODEX_SOURCE_INCOMPATIBLE_EXIT_CODE,
  openClawCodexSourcePreparationFailureRetryable,
  prepareOpenClawCodexSourceForReview,
} from "../dist/openclaw-codex-source.js";

test("Codex source pin validation accepts only one exact version", (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-codex-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = join(root, "package.json");
  const validator = join(
    process.cwd(),
    ".github",
    "actions",
    "setup-openclaw-codex-source",
    "validate-pin.mjs",
  );
  const run = (content: string) => {
    writeFileSync(manifest, content);
    return spawnSync(process.execPath, [validator, manifest], { encoding: "utf8" });
  };

  for (const value of [undefined, "^0.151.0", "*", "workspace:*", "not-a-version"]) {
    const result = run(JSON.stringify({ dependencies: { "@openai/codex": value } }));
    assert.equal(result.status, OPENCLAW_CODEX_SOURCE_INCOMPATIBLE_EXIT_CODE, String(value));
    assert.equal(result.stdout, "");
  }
  assert.equal(run("{").status, OPENCLAW_CODEX_SOURCE_INCOMPATIBLE_EXIT_CODE);

  const exact = run(JSON.stringify({ dependencies: { "@openai/codex": "0.151.0" } }));
  assert.equal(exact.status, 0);
  assert.equal(exact.stdout, "0.151.0");
});

test("PR review source preparation invokes the workflow-provisioned setup for the current tree", () => {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  prepareOpenClawCodexSourceForReview({
    targetRepo: "openclaw/openclaw",
    reviewDir: "/workspace/artifacts/review-trees/131584",
    env: {
      CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT: "/action/install.sh",
      CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR: "/workspace/openclaw",
      CLAWSWEEPER_OPENCLAW_CODEX_ARTIFACT_DIR: "/workspace/artifacts",
      CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR: "/workspace/openclaw-codex-cache.git",
      CLAWSWEEPER_OPENCLAW_CODEX_SOURCE_URL: "https://github.com/openai/codex.git",
    },
    spawn: (command, args) => {
      calls.push({ command, args: args ?? [] });
      return { status: 0, stderr: "" } as SpawnSyncReturns<string>;
    },
  });
  prepareOpenClawCodexSourceForReview({
    targetRepo: "openclaw/openclaw",
    reviewDir: "/workspace/openclaw",
    env: {
      CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT: "/action/install.sh",
      CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR: "/workspace/openclaw",
      CLAWSWEEPER_OPENCLAW_CODEX_ARTIFACT_DIR: "/workspace/artifacts",
      CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR: "/workspace/openclaw-codex-cache.git",
      CLAWSWEEPER_OPENCLAW_CODEX_SOURCE_URL: "https://github.com/openai/codex.git",
    },
    spawn: (command, args) => {
      calls.push({ command, args: args ?? [] });
      return { status: 0, stderr: "" } as SpawnSyncReturns<string>;
    },
  });

  assert.deepEqual(calls, [
    {
      command: "bash",
      args: [
        "/action/install.sh",
        "openclaw/openclaw",
        "/workspace/openclaw",
        "/workspace/artifacts",
        "/workspace/openclaw-codex-cache.git",
        "https://github.com/openai/codex.git",
        "/workspace/artifacts/review-trees/131584",
      ],
    },
    {
      command: "bash",
      args: [
        "/action/install.sh",
        "openclaw/openclaw",
        "/workspace/openclaw",
        "/workspace/artifacts",
        "/workspace/openclaw-codex-cache.git",
        "https://github.com/openai/codex.git",
        "/workspace/openclaw",
      ],
    },
  ]);
});

test("PR review source preparation is inactive outside provisioned OpenClaw workflows", () => {
  let invoked = false;
  for (const options of [
    { targetRepo: "openclaw/clawhub", env: {} },
    { targetRepo: "openclaw/openclaw", env: {} },
  ]) {
    prepareOpenClawCodexSourceForReview({
      ...options,
      reviewDir: "/workspace/review-tree",
      spawn: () => {
        invoked = true;
        return { status: 0, stderr: "" } as SpawnSyncReturns<string>;
      },
    });
  }
  assert.equal(invoked, false);
});

test("source preparation failures carry safe diagnostic identity", () => {
  assert.throws(
    () =>
      prepareOpenClawCodexSourceForReview({
        targetRepo: "openclaw/openclaw",
        reviewDir: "/workspace/artifacts/review-trees/1338",
        env: {
          CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT: "/action/install.sh",
          CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR: "/workspace/openclaw",
          CLAWSWEEPER_OPENCLAW_CODEX_ARTIFACT_DIR: "/workspace/artifacts",
          CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR: "/workspace/openclaw-codex-cache.git",
        },
        spawn: () => ({ status: 128, stderr: "remote unavailable" }) as SpawnSyncReturns<string>,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { diagnosticStage?: string }).diagnosticStage,
        "source_preparation",
      );
      assert.equal(
        (error as Error & { diagnosticReason?: string }).diagnosticReason,
        "setup_script_failed",
      );
      return true;
    },
  );
});

test("only an incompatible immutable source pin is non-retryable", () => {
  for (const [status, reason, retryable] of [
    [OPENCLAW_CODEX_SOURCE_INCOMPATIBLE_EXIT_CODE, "source_incompatible", false],
    [128, "setup_script_failed", true],
  ] as const) {
    assert.throws(
      () =>
        prepareOpenClawCodexSourceForReview({
          targetRepo: "openclaw/openclaw",
          reviewDir: "/workspace/artifacts/review-trees/70002",
          env: {
            CLAWSWEEPER_OPENCLAW_CODEX_SETUP_SCRIPT: "/action/install.sh",
            CLAWSWEEPER_OPENCLAW_CODEX_TARGET_DIR: "/workspace/openclaw",
            CLAWSWEEPER_OPENCLAW_CODEX_ARTIFACT_DIR: "/workspace/artifacts",
            CLAWSWEEPER_OPENCLAW_CODEX_CACHE_DIR: "/workspace/openclaw-codex-cache.git",
          },
          spawn: () =>
            ({ status, stderr: "source preparation refused" }) as SpawnSyncReturns<string>,
        }),
      (error: unknown) => {
        assert.equal((error as Error & { diagnosticReason?: string }).diagnosticReason, reason);
        assert.equal(openClawCodexSourcePreparationFailureRetryable(error), retryable);
        return true;
      },
    );
  }
});
