import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  gitcrawlStoreDbFileName,
  resolveGitcrawlDbPath,
} from "../../dist/repair/gitcrawl-store.js";

test("gitcrawl store resolver normalizes repositories and preserves path priority", () => {
  const root = path.resolve("/proof/clawsweeper");
  const homeDir = path.resolve("/proof/home");
  const fileName = "openclaw__openclaw.sync.db";
  const siblingStore = path.resolve(root, "../gitcrawl-store/data", fileName);
  const userStore = path.resolve(homeDir, ".config/gitcrawl/stores/gitcrawl-store/data", fileName);
  const legacyStore = path.resolve(homeDir, ".config/gitcrawl/gitcrawl.db");

  assert.equal(gitcrawlStoreDbFileName(" OpenClaw/OpenClaw "), fileName);
  assert.equal(
    resolveGitcrawlDbPath("openclaw/openclaw", " ./explicit.db ", {
      env: { CLAWSWEEPER_GITCRAWL_DB: "/ignored.db" },
    }),
    path.resolve("./explicit.db"),
  );
  assert.equal(
    resolveGitcrawlDbPath("openclaw/openclaw", undefined, {
      env: { CLAWSWEEPER_GITCRAWL_DB: " ./configured.db " },
    }),
    path.resolve("./configured.db"),
  );
  assert.equal(
    resolveGitcrawlDbPath("openclaw/openclaw", undefined, {
      env: {},
      root,
      homeDir,
      existsSync: (candidate) => candidate === siblingStore || candidate === userStore,
    }),
    siblingStore,
  );
  assert.equal(
    resolveGitcrawlDbPath("openclaw/openclaw", undefined, {
      env: {},
      root,
      homeDir,
      existsSync: () => false,
    }),
    legacyStore,
  );
});

test("gitcrawl docs describe external store freshness and model selection", () => {
  const relatedDocs = readFileSync("docs/related-issue-discovery.md", "utf8");
  const repairDocs = readFileSync("docs/repair/README.md", "utf8");
  const limitsDocs = readFileSync("docs/limits.md", "utf8");
  const internalDocs = readFileSync("docs/repair/internal-features.md", "utf8");

  assert.match(relatedDocs, /does not run a gitcrawl fetch\s+or download issues during review/);
  assert.match(relatedDocs, /git pull --ff-only/);
  assert.match(repairDocs, /does not crawl or download\s+issues during repair import/);
  assert.match(repairDocs, /git -C \.\.\/gitcrawl-store pull --ff-only/);
  assert.match(limitsDocs, /selector model compares/);
  assert.match(repairDocs, /selector model compares/);
  assert.match(limitsDocs, /one cluster or rejects the batch/);
  assert.match(repairDocs, /intake runs daily/);
  assert.match(internalDocs, /refreshes `openclaw\/openclaw` every 15\s+minutes/);
});
