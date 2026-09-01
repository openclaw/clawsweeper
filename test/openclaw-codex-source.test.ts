import assert from "node:assert/strict";
import type { SpawnSyncReturns } from "node:child_process";
import test from "node:test";
import { prepareOpenClawCodexSourceForReview } from "../dist/openclaw-codex-source.js";

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
