import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { changedStatePaths } from "../../dist/repair/state-delta-paths.js";
import { hydrateGitOperationalState } from "../../scripts/hydrate-state.ts";

test("result publication selects exact changes and preserves unrelated remote jobs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-state-delta-"));
  const worktree = path.join(root, "worktree");
  const state = path.join(root, "state");
  for (const base of [worktree, state]) {
    fs.mkdirSync(path.join(base, "results", "openclaw"), { recursive: true });
    fs.mkdirSync(path.join(base, "jobs", "openclaw", "inbox"), { recursive: true });
    fs.writeFileSync(path.join(base, "results", "openclaw", "existing.md"), "same\n");
    fs.writeFileSync(path.join(base, "jobs", "openclaw", "inbox", "unrelated.md"), "keep\n");
  }
  fs.writeFileSync(path.join(worktree, "results", "openclaw", "gitcrawl-42.md"), "new result\n");
  fs.writeFileSync(path.join(worktree, "results", "openclaw", "existing.md"), "updated\n");

  assert.deepEqual(
    changedStatePaths({ worktree, stateRoot: state, roots: ["results", "jobs/openclaw"] }),
    ["results/openclaw/existing.md", "results/openclaw/gitcrawl-42.md"],
  );
});

test("state hydration preserves state-only notification receipts before result diffing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawsweeper-notification-hydrate-"));
  const worktree = path.join(root, "worktree");
  const state = path.join(root, "state");
  const receipt = path.join("notifications", "clawsweeper-event-ledger.json");
  fs.mkdirSync(path.join(state, "notifications"), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(state, receipt), '{"notifications":[{"id":"unrelated"}]}\n');

  hydrateGitOperationalState(state, worktree);
  assert.equal(
    fs.readFileSync(path.join(worktree, receipt), "utf8"),
    fs.readFileSync(path.join(state, receipt), "utf8"),
  );
  assert.deepEqual(changedStatePaths({ worktree, stateRoot: state, roots: ["notifications"] }), []);
});
