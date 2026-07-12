import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { tmpPrefix } from "./helpers.ts";

test("review runtime artifact carries the TypeScript compiler service", () => {
  const fixture = mkdtempSync(tmpPrefix);
  const output = join(fixture, "runtime");
  const nativePackageName = `typescript-${process.platform}-${process.arch}`;
  const nativeCompiler = join(
    output,
    "node_modules",
    "@typescript",
    nativePackageName,
    "lib",
    process.platform === "win32" ? "tsc.exe" : "tsc",
  );

  try {
    execFileSync(process.execPath, ["scripts/prepare-review-runtime.mjs", "--output", output], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    assert.equal(
      JSON.parse(readFileSync(join(output, "node_modules", "typescript", "package.json"), "utf8"))
        .name,
      "typescript",
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          join(output, "node_modules", "@typescript", nativePackageName, "package.json"),
          "utf8",
        ),
      ).name,
      `@typescript/${nativePackageName}`,
    );
    assert.equal(existsSync(nativeCompiler), true);
    if (process.platform !== "win32") {
      assert.notEqual(statSync(nativeCompiler).mode & 0o111, 0);
    }

    writeFileSync(join(output, "package.json"), '{"type":"module"}\n');
    const smokePath = join(output, "semantic-smoke.mjs");
    writeFileSync(
      smokePath,
      `
import { createReviewSemanticRecord } from "./dist/review-semantic-cache.js";

const record = createReviewSemanticRecord({
  item: { repo: "openclaw/openclaw", number: 1, kind: "pull_request" },
  context: {
    issue: { title: "Cache" },
    comments: [],
    timeline: [],
    pullRequest: { base: { ref: "main", sha: "a".repeat(40) } },
    pullFiles: [{
      filename: "src/cache.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\\n-const value = 1;\\n+const value = 2;",
    }],
    pullCommits: [],
    pullReviewComments: [],
    pullChecks: {
      complete: true,
      checkRuns: [],
      checkRunsTruncated: false,
      statuses: [],
      statusesTruncated: false,
    },
    counts: {
      pullFiles: 1,
      pullFilesHydrated: 1,
      pullFilesTruncated: false,
      pullCommitsTruncated: false,
    },
  },
  git: { mainSha: "b".repeat(40), latestRelease: null },
  structuralContextRevision: "c".repeat(64),
  reviewPolicy: "policy",
  reviewModel: "model",
});

if (!record.eligible) throw new Error(record.eligibilityReason);
`,
    );
    chmodSync(smokePath, 0o755);
    execFileSync(process.execPath, [smokePath], {
      cwd: output,
      env: { ...process.env, NODE_PATH: "" },
      stdio: "pipe",
    });
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
